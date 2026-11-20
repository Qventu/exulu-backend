process.env.NEXTAUTH_SECRET = "test-secret";
// the channel tables exist only with the channels licence; tests switch it per case
const LICENSED = "EXULU_EE_test";
process.env.EXULU_ENTERPRISE_LICENSE = LICENSED;
// the link page the linkRequired reply points to; enabling refuses without it
process.env.CHANNEL_LINK_BASE_URL = "https://kunden.example.de";

import express from "express";
import request from "supertest";

import {
  CODE_ISSUE_LIMIT,
  afterAgentDelete,
  afterAgentWrite,
  GRAPH_HOST,
  deleteChannelsForAgent,
  disableChannelsForAgent,
  registerChannelApi,
  syncChannelsWithGuestAccess,
  type ChannelApiDeps,
} from "./api";
import { readSecrets, sealSecrets } from "./config";
import type { KeyValueStore } from "./link-codes";
import type { AgentChannelRow } from "./types";

// ---------------------------------------------------------------------------
// Fixtures

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PUBLIC_MODE_AGENT = "22222222-2222-4222-8222-222222222222";
const GUEST_OFF_AGENT = "33333333-3333-4333-8333-333333333333";
const FOREIGN_AGENT = "44444444-4444-4444-8444-444444444444";
const OTHER_AGENT = "55555555-5555-4555-8555-555555555555";
const MISSING_AGENT = "66666666-6666-4666-8666-666666666666";

const ACCESS_TOKEN = "EAAG-access-token-very-secret";
const APP_SECRET = "app-secret-very-secret";
const T0 = new Date("2026-11-20T10:00:00Z");

const ADMIN = 1; // owns AGENT_ID etc., role agents: write
const CUSTOMER = 7; // external guest user
const OTHER_CUSTOMER = 8;
const NO_ROLE = 9; // record access but no agents role

const agents: Record<string, any> = {
  [AGENT_ID]: { id: AGENT_ID, created_by: ADMIN, rights_mode: "private", guest_access: true, guest_auth_mode: "regular" },
  [PUBLIC_MODE_AGENT]: { id: PUBLIC_MODE_AGENT, created_by: ADMIN, rights_mode: "private", guest_access: true, guest_auth_mode: "public" },
  [GUEST_OFF_AGENT]: { id: GUEST_OFF_AGENT, created_by: ADMIN, rights_mode: "private", guest_access: false, guest_auth_mode: "regular" },
  [FOREIGN_AGENT]: { id: FOREIGN_AGENT, created_by: 99, rights_mode: "private", guest_access: true, guest_auth_mode: "regular" },
  [OTHER_AGENT]: { id: OTHER_AGENT, created_by: ADMIN, rights_mode: "private", guest_access: true, guest_auth_mode: "regular" },
};

const users: Record<number, any> = {
  [ADMIN]: { id: ADMIN, email: "a@x", role: { id: "r1", name: "admin", agents: "write" } },
  [CUSTOMER]: { id: CUSTOMER, email: "c@x", role: { id: "r2", name: "external" } },
  [OTHER_CUSTOMER]: { id: OTHER_CUSTOMER, email: "o@x", role: { id: "r2", name: "external" } },
  [NO_ROLE]: { id: NO_ROLE, email: "n@x", role: { id: "r3", name: "viewer", agents: "read" } },
};

// ---------------------------------------------------------------------------
// In-memory knex stand-in. No database is available to unit tests in this repo
// (see links.test.ts), so the real SQL is not exercised here; the fake honours
// the unique (agent, type) index the way ON CONFLICT ... DO UPDATE does.

const fakeDb = (seed: Record<string, any[]> = {}) => {
  const tables: Record<string, any[]> = { agent_channels: [], channel_links: [], users: [], ...seed };
  let seq = 0;
  const matches = (r: any, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => (v instanceof Date ? r[k]?.getTime?.() === v.getTime() : r[k] === v));
  const query = (table: string, w: Record<string, unknown> = {}, ins: Record<string, unknown[]> = {}) => {
    const rows = (tables[table] ??= []);
    const sel = () => rows.filter((r) => matches(r, w) && Object.entries(ins).every(([k, vs]) => vs.includes(r[k])));
    const q: any = {
      where: (w2: any) => query(table, { ...w, ...w2 }, ins),
      whereIn: (col: string, vs: unknown[]) => query(table, w, { ...ins, [col]: vs }),
      first: async () => sel()[0],
      orderBy: () => q,
      select: () => q,
      update: async (v: any) => {
        const hit = sel();
        hit.forEach((r) => Object.assign(r, v));
        return hit.length;
      },
      del: async () => {
        const hit = sel();
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return hit.length;
      },
      then: (res: any, rej: any) => Promise.resolve(sel()).then(res, rej),
      insert: (v: any) => ({
        onConflict: (cols: string[]) => ({
          merge: (m: any) => ({
            returning: async () => {
              const existing = rows.find((r) => cols.every((c) => r[c] === v[c]));
              if (existing) return [Object.assign(existing, m)];
              const row = { id: `c0000000-0000-4000-8000-00000000000${++seq}`, ...v };
              rows.push(row);
              return [row];
            },
          }),
        }),
      }),
    };
    return q;
  };
  const db: any = (t: string) => query(t);
  return { db, tables };
};

const fakeKv = () => {
  const data = new Map<string, { v: string; exp?: number }>();
  const kv: KeyValueStore = {
    set: async (k, v, o) => {
      if (o.NX && data.has(k)) return null;
      data.set(k, { v, exp: o.EX });
      return "OK";
    },
    getDel: async (k) => {
      const e = data.get(k);
      data.delete(k);
      return e?.v ?? null;
    },
    del: async (k) => data.delete(k),
    incr: async (k) => {
      const e = data.get(k);
      const n = Number(e?.v ?? 0) + 1;
      data.set(k, { v: String(n), exp: e?.exp });
      return n;
    },
    expire: async (k, s) => {
      const e = data.get(k);
      if (e) e.exp = s;
    },
    get: async (k) => data.get(k)?.v ?? null,
    ttl: async (k) => (data.has(k) ? (data.get(k)!.exp ?? -1) : -2),
  };
  return { kv, data };
};

const channelRow = (over: Partial<AgentChannelRow> = {}): AgentChannelRow => ({
  id: "c1000000-0000-4000-8000-000000000001",
  agent: AGENT_ID,
  type: "whatsapp",
  enabled: true,
  config: { phoneNumberId: "1234567890", displayNumber: "+49 30 1234-567" },
  secrets: sealSecrets({ accessToken: ACCESS_TOKEN, appSecret: APP_SECRET }),
  verify_token: "verify-token-stored-once",
  updatedAt: new Date("2026-11-01T00:00:00Z"),
  ...over,
});

const linkRow = (over: Record<string, unknown> = {}) => ({
  id: "d1000000-0000-4000-8000-000000000001",
  channel: "c1000000-0000-4000-8000-000000000001",
  identity: "whatsapp:+4915112345678",
  user: CUSTOMER,
  linked_at: new Date("2026-11-19T10:00:00Z"),
  expires_at: new Date("2026-11-26T10:00:00Z"),
  revoked_at: null,
  last_seen_at: null,
  ...over,
});

const build = (opts: { seed?: Record<string, any[]>; deps?: Partial<ChannelApiDeps>; store?: KeyValueStore | null } = {}) => {
  const { db, tables } = fakeDb({ users: Object.values(users).map((u) => ({ ...u })), ...opts.seed });
  const { kv, data } = fakeKv();
  const fetchMock = jest.fn();
  const deps: ChannelApiDeps = {
    authenticate: async (req) => {
      const id = Number(req.headers["x-user"]);
      if (!id) return { error: true, code: 401, message: "Not authenticated." };
      return { error: false, user: users[id] };
    },
    getDb: async () => db,
    getStore: async () => (opts.store === undefined ? kv : opts.store),
    loadAgent: async (id) => (agents[id] ? { ...agents[id] } : undefined),
    checkRecordAccess: async (record, _req, user) => String(record.created_by) === String(user?.id),
    entitled: () => true,
    fetch: fetchMock as any,
    now: () => T0,
    backendUrl: () => "https://api.example.de/",
    ...opts.deps,
  };
  const app = express();
  app.use(express.json());
  registerChannelApi(app, deps);
  return { app, tables, data, fetchMock, deps };
};

const adminPath = (agent = AGENT_ID) => `/agents/${agent}/channels/whatsapp`;
const as = (r: request.Test, user: number) => r.set("x-user", String(user));

/** No response body may carry secret material. */
const expectNoSecrets = (body: unknown, extra: string[] = []) => {
  const text = JSON.stringify(body ?? null);
  for (const s of [ACCESS_TOKEN, APP_SECRET, ...extra]) {
    expect(text).not.toContain(s);
  }
};

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

// ---------------------------------------------------------------------------
// Admin authorisation

describe("admin routes: who may call them", () => {
  const routes: [string, (app: any, agent?: string) => request.Test][] = [
    ["GET config", (app, a) => request(app).get(adminPath(a))],
    ["PUT config", (app, a) => request(app).put(adminPath(a)).send({ enabled: false })],
    ["POST test", (app, a) => request(app).post(`${adminPath(a)}/test`)],
    ["GET links", (app, a) => request(app).get(`${adminPath(a)}/links`)],
    ["DELETE link", (app, a) => request(app).delete(`${adminPath(a)}/links/${linkRow().id}`)],
  ];

  it.each(routes)("%s: 401 when not signed in", async (_n, call) => {
    const { app } = build({ seed: { agent_channels: [channelRow()] } });
    const res = await call(app);
    expect(res.status).toBe(401);
  });

  it.each(routes)("%s: 403 without write access on the agent", async (_n, call) => {
    const { app } = build({ seed: { agent_channels: [channelRow({ agent: FOREIGN_AGENT })] } });
    const res = await as(call(app, FOREIGN_AGENT), ADMIN);
    expect(res.status).toBe(403);
  });

  it.each(routes)("%s: 403 for a user without the agents write role, even with record access", async (_n, call) => {
    const { app } = build({
      seed: { agent_channels: [channelRow()] },
      deps: { checkRecordAccess: async () => true },
    });
    const res = await as(call(app), NO_ROLE);
    expect(res.status).toBe(403);
  });

  it.each(routes)("%s: 404 for an unknown agent and for a non-uuid id", async (_n, call) => {
    const { app } = build();
    const missing = await as(call(app, MISSING_AGENT), ADMIN);
    const bad = await as(call(app, "not-a-uuid"), ADMIN);
    expect(missing.status).toBe(404);
    expect(bad.status).toBe(404);
    expect(bad.body).toEqual(missing.body);
  });

  it("a super admin passes without the role", async () => {
    users[50] = { id: 50, email: "s@x", super_admin: true, role: undefined };
    const { app } = build({ deps: { checkRecordAccess: async () => true } });
    const res = await as(request(app).get(adminPath()), 50);
    expect(res.status).toBe(200);
    delete users[50];
  });
});

// ---------------------------------------------------------------------------
// GET

describe("GET /agents/:agentId/channels/whatsapp", () => {
  it("returns null, no webhook URL and the enable verdict before a channel exists", async () => {
    const { app } = build();
    const res = await as(request(app).get(adminPath()), ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: null, webhookUrl: null, canEnable: { ok: true } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns the view and the webhook URL, never secrets or the verify token", async () => {
    const row = channelRow();
    const { app } = build({ seed: { agent_channels: [row] } });
    const res = await as(request(app).get(adminPath()), ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.webhookUrl).toBe(`https://api.example.de/webhooks/whatsapp/${row.id}`);
    expect(res.body.channel).toMatchObject({ id: row.id, enabled: true, hasSecrets: true, needsCredentials: false, configInvalid: false });
    expect(Object.keys(res.body.channel).sort()).toEqual(
      ["agent", "config", "configInvalid", "enabled", "hasSecrets", "id", "needsCredentials", "type"].sort(),
    );
    expectNoSecrets(res.body, [row.secrets!, row.verify_token!]);
  });

  it("a stored row with an invalid config is returned as unusable, not a 500", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow({ config: { phoneNumberId: "" } })] } });
    const res = await as(request(app).get(adminPath()), ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.channel.configInvalid).toBe(true);
    expect(res.body.channel.config.phoneNumberId).toBe("");
  });

  it("reports why the agent cannot carry a channel", async () => {
    const { app } = build();
    const res = await as(request(app).get(adminPath(PUBLIC_MODE_AGENT)), ADMIN);
    expect(res.body.canEnable).toEqual({ ok: false, reason: "guest_mode_not_regular" });
  });
});

// ---------------------------------------------------------------------------
// PUT

const fullConfig = { phoneNumberId: "1234567890", displayNumber: "+49 30 1234-567" };

describe("PUT /agents/:agentId/channels/whatsapp", () => {
  it("returns the verify token once, on create, and keeps it on later writes", async () => {
    const { app, tables } = build();
    const first = await as(request(app).put(adminPath()), ADMIN).send({
      config: fullConfig,
      secrets: { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
    });
    expect(first.status).toBe(200);
    expect(first.body.verifyToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const stored = tables.agent_channels[0];
    expect(stored.verify_token).toBe(first.body.verifyToken);
    expectNoSecrets(first.body, [stored.secrets]);

    const second = await as(request(app).put(adminPath()), ADMIN).send({ enabled: true });
    expect(second.status).toBe(200);
    expect(second.body).not.toHaveProperty("verifyToken");
    expect(tables.agent_channels).toHaveLength(1);
    expect(tables.agent_channels[0].verify_token).toBe(first.body.verifyToken);
    expect(second.body.channel.enabled).toBe(true);
    expectNoSecrets(second.body, [stored.secrets, first.body.verifyToken]);
  });

  it("every write sets updatedAt to now", async () => {
    const { app, tables } = build({ seed: { agent_channels: [channelRow({ enabled: false })] } });
    await as(request(app).put(adminPath()), ADMIN).send({ config: { ...fullConfig, locale: "en" } });
    expect(tables.agent_channels[0].updatedAt).toEqual(T0);
    expect(JSON.parse(tables.agent_channels[0].config)).toMatchObject({ locale: "en" });
  });

  it("enabling without secrets is a 409 needs_credentials", async () => {
    const { app, tables } = build();
    const res = await as(request(app).put(adminPath()), ADMIN).send({ enabled: true, config: fullConfig });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("needs_credentials");
    expect(tables.agent_channels).toHaveLength(0);
  });

  it("enabling on a public-mode agent is a 409 guest_mode_not_regular", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow({ agent: PUBLIC_MODE_AGENT, enabled: false })] } });
    const res = await as(request(app).put(adminPath(PUBLIC_MODE_AGENT)), ADMIN).send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("guest_mode_not_regular");
  });

  it("enabling with guest access off is a 409 guest_access_off", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow({ agent: GUEST_OFF_AGENT, enabled: false })] } });
    const res = await as(request(app).put(adminPath(GUEST_OFF_AGENT)), ADMIN).send({ enabled: true });
    expect(res.body.reason).toBe("guest_access_off");
  });

  it("enabling without the entitlements is a 409 not_entitled, checked first", async () => {
    const { app } = build({ deps: { entitled: () => false } });
    const res = await as(request(app).put(adminPath(PUBLIC_MODE_AGENT)), ADMIN).send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("not_entitled");
  });

  it("enabling without a usable config is a 409 invalid_config", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow({ enabled: false, config: null })] } });
    const res = await as(request(app).put(adminPath()), ADMIN).send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("invalid_config");
  });

  it("enabling without a link page URL is a 409 link_url_not_configured, after the other reasons", async () => {
    const saved = { link: process.env.CHANNEL_LINK_BASE_URL, auth: process.env.NEXTAUTH_URL };
    delete process.env.CHANNEL_LINK_BASE_URL;
    delete process.env.NEXTAUTH_URL;
    try {
      // an earlier reason still wins
      const missingConfig = build({ seed: { agent_channels: [channelRow({ enabled: false, config: null })] } });
      const first = await as(request(missingConfig.app).put(adminPath()), ADMIN).send({ enabled: true });
      expect(first.body.reason).toBe("invalid_config");

      const { app, tables } = build({ seed: { agent_channels: [channelRow({ enabled: false })] } });
      const res = await as(request(app).put(adminPath()), ADMIN).send({ enabled: true });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("link_url_not_configured");
      expect(res.body.detail).toMatch(/CHANNEL_LINK_BASE_URL/);
      expect(tables.agent_channels[0].enabled).toBe(false);

      // NEXTAUTH_URL on the server process is enough
      process.env.NEXTAUTH_URL = "https://newton.example.de";
      const ok = await as(request(app).put(adminPath()), ADMIN).send({ enabled: true });
      expect(ok.status).toBe(200);
    } finally {
      if (saved.link !== undefined) process.env.CHANNEL_LINK_BASE_URL = saved.link;
      else delete process.env.CHANNEL_LINK_BASE_URL;
      if (saved.auth !== undefined) process.env.NEXTAUTH_URL = saved.auth;
      else delete process.env.NEXTAUTH_URL;
    }
  });

  it("disabling needs none of that", async () => {
    const { app, tables } = build({
      seed: { agent_channels: [channelRow({ agent: PUBLIC_MODE_AGENT })] },
      deps: { entitled: () => false },
    });
    const res = await as(request(app).put(adminPath(PUBLIC_MODE_AGENT)), ADMIN).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(tables.agent_channels[0].enabled).toBe(false);
  });

  it("a partial secrets update keeps the other secret; an empty string leaves a secret unchanged", async () => {
    const { app, tables } = build({ seed: { agent_channels: [channelRow()] } });
    const res = await as(request(app).put(adminPath()), ADMIN).send({ secrets: { accessToken: "new-token", appSecret: "" } });
    expect(res.status).toBe(200);
    expect(readSecrets(tables.agent_channels[0])).toEqual({ accessToken: "new-token", appSecret: APP_SECRET });
    expectNoSecrets(res.body, ["new-token"]);
  });

  it("secrets that would stay incomplete are a 400", async () => {
    const { app } = build();
    const res = await as(request(app).put(adminPath()), ADMIN).send({ secrets: { accessToken: ACCESS_TOKEN } });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("secrets.appSecret");
    expectNoSecrets(res.body);
  });

  it.each([
    [{ bogus: 1 }, "bogus"],
    [{ enabled: "yes" }, "enabled"],
    [{ secrets: { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET, extra: "x" } }, "secrets"],
    [{ secrets: { accessToken: 42 } }, "secrets.accessToken"],
    [{ secrets: "x" }, "secrets"],
    [{ config: { phoneNumberId: "", displayNumber: "+49" } }, "phoneNumberId"],
    [{ config: { ...fullConfig, linkTtlDays: 0 } }, "linkTtlDays"],
  ])("rejects %j with 400 naming the field", async (body, field) => {
    const { app, tables } = build();
    const res = await as(request(app).put(adminPath()), ADMIN).send(body);
    expect(res.status).toBe(400);
    expect(res.body.field).toBe(field);
    expect(tables.agent_channels).toHaveLength(0);
  });

  it("rejects a non-object body", async () => {
    const { app } = build();
    const res = await as(request(app).put(adminPath()), ADMIN).set("content-type", "application/json").send("[1]");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Test connection

describe("POST /agents/:agentId/channels/whatsapp/test", () => {
  it("calls the Graph API with the token in the header only, no redirects, with a timeout", async () => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow()] } });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ display_phone_number: "+49 30 1234567", verified_name: "Newlift" }), { status: 200 }),
    );
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.detail).toContain("Newlift");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${GRAPH_HOST}/v25.0/1234567890?fields=display_phone_number,verified_name`);
    expect(url).not.toContain(ACCESS_TOKEN);
    expect(init.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expectNoSecrets(res.body);
  });

  it("reports Meta's error message", async () => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow()] } });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid OAuth access token." } }), { status: 401 }),
    );
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body).toEqual({ ok: false, detail: "Invalid OAuth access token." });
  });

  it("never echoes the token, even if Meta's message contains it", async () => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow()] } });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: `bad token ${ACCESS_TOKEN}` } }), { status: 400 }),
    );
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body.ok).toBe(false);
    expectNoSecrets(res.body);
    expectNoSecrets(logs);
  });

  it("a network error or timeout gives a fixed text, never the exception message", async () => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow()] } });
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED with ${ACCESS_TOKEN}`));
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body.ok).toBe(false);
    expect(res.body.detail).not.toContain("ECONNREFUSED");
    expectNoSecrets(res.body);
    expectNoSecrets(logs);

    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValue(timeout);
    const res2 = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res2.body).toEqual({ ok: false, detail: expect.stringContaining("10") });
  });

  it("a redirect is not followed and counts as a failure", async () => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow()] } });
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://evil.example" } }));
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-numeric phoneNumberId without calling out", async () => {
    const { app, fetchMock } = build({
      seed: { agent_channels: [channelRow({ config: { phoneNumberId: "123/../me", displayNumber: "+49" } })] },
    });
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", new Response("<html>ok</html>", { status: 200 })],
    ["JSON without the fields", new Response(JSON.stringify({ id: "1234567890" }), { status: 200 })],
    ["JSON with only one field", new Response(JSON.stringify({ verified_name: "Newlift" }), { status: 200 })],
  ])("a 2xx that is %s is not a success", async (_n, response) => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow()] } });
    fetchMock.mockResolvedValue(response);
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body).toEqual({ ok: false, detail: "Meta answered, but not with the expected phone number details." });
  });

  it("refuses without credentials without calling out", async () => {
    const { app, fetchMock } = build({ seed: { agent_channels: [channelRow({ secrets: null })] } });
    const res = await as(request(app).post(`${adminPath()}/test`), ADMIN);
    expect(res.body.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404 without a channel", async () => {
    const { app } = build();
    expect((await as(request(app).post(`${adminPath()}/test`), ADMIN)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Admin links

describe("admin links", () => {
  const seed = () => ({
    agent_channels: [channelRow(), channelRow({ id: "c1000000-0000-4000-8000-000000000002", agent: OTHER_AGENT })],
    channel_links: [
      linkRow(),
      linkRow({ id: "d1000000-0000-4000-8000-000000000002", identity: "whatsapp:+4917099998888", user: OTHER_CUSTOMER, revoked_at: new Date("2026-11-19T12:00:00Z") }),
      linkRow({ id: "d1000000-0000-4000-8000-000000000003", channel: "c1000000-0000-4000-8000-000000000002", identity: "whatsapp:+4917011112222" }),
    ],
  });

  it("lists this channel's links with masked identities and their state", async () => {
    const { app } = build({ seed: seed() });
    const res = await as(request(app).get(`${adminPath()}/links`), ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(2);
    expect(res.body.links[0]).toEqual({
      id: "d1000000-0000-4000-8000-000000000001",
      identityMasked: "•••• 5678",
      userId: CUSTOMER,
      linked_at: "2026-11-19T10:00:00.000Z",
      expires_at: "2026-11-26T10:00:00.000Z",
      last_seen_at: null,
      state: "valid",
    });
    expect(res.body.links[1].state).toBe("revoked");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("+4915112345678");
    expect(text).not.toContain("12345678");
  });

  it("an empty list when the agent has no channel", async () => {
    const { app } = build();
    const res = await as(request(app).get(`${adminPath()}/links`), ADMIN);
    expect(res.body).toEqual({ links: [] });
  });

  it("revokes a link of this channel with 204 and audits it", async () => {
    const { app, tables } = build({ seed: seed() });
    const res = await as(request(app).delete(`${adminPath()}/links/d1000000-0000-4000-8000-000000000001`), ADMIN);
    expect(res.status).toBe(204);
    expect(tables.channel_links[0].revoked_at).toEqual(T0);
    expect(tables.channel_links[0].updatedAt).toEqual(T0);
    const audit = logs.find((l) => l.includes("audit"));
    expect(audit).toContain('"event":"revoked"');
    expect(audit).not.toContain("+4915112345678");
  });

  it("a link of another agent's channel is a 404, same as an unknown one", async () => {
    const { app, tables } = build({ seed: seed() });
    const foreign = await as(request(app).delete(`${adminPath()}/links/d1000000-0000-4000-8000-000000000003`), ADMIN);
    const unknown = await as(request(app).delete(`${adminPath()}/links/d1000000-0000-4000-8000-000000000009`), ADMIN);
    const bad = await as(request(app).delete(`${adminPath()}/links/nope`), ADMIN);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(bad.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
    expect(tables.channel_links[2].revoked_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Link code (signed-in customer)

const linkCodePath = (agent = AGENT_ID) => `/public-agents/${agent}/channels/whatsapp/link-code`;

describe("POST /public-agents/:id/channels/whatsapp/link-code", () => {
  it("401 when not signed in", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow()] } });
    expect((await request(app).post(linkCodePath())).status).toBe(401);
  });

  it("404 with one body for a disabled, missing or unknown channel and an unknown agent", async () => {
    const { app } = build({
      seed: { agent_channels: [channelRow({ enabled: false }), channelRow({ id: "c1000000-0000-4000-8000-000000000002", agent: OTHER_AGENT, config: null })] },
    });
    const disabled = await as(request(app).post(linkCodePath()), CUSTOMER);
    const noChannel = await as(request(app).post(linkCodePath(PUBLIC_MODE_AGENT)), CUSTOMER);
    const unknown = await as(request(app).post(linkCodePath(MISSING_AGENT)), CUSTOMER);
    const bad = await as(request(app).post(linkCodePath("x")), CUSTOMER);
    for (const r of [disabled, noChannel, unknown, bad]) expect(r.status).toBe(404);
    expect(new Set([disabled, noChannel, unknown, bad].map((r) => JSON.stringify(r.body))).size).toBe(1);
  });

  it.each([PUBLIC_MODE_AGENT, "password"])(
    "404 (same body) for a still-enabled channel on an agent that cannot carry one (%s)",
    async (which) => {
      const agentId = which === "password" ? OTHER_AGENT : PUBLIC_MODE_AGENT;
      const saved = { ...agents[OTHER_AGENT] };
      if (which === "password") agents[OTHER_AGENT] = { ...saved, guest_auth_mode: "password" };
      try {
        const { app, data } = build({
          seed: { agent_channels: [channelRow({ agent: agentId }), channelRow({ id: "c1000000-0000-4000-8000-000000000003", agent: MISSING_AGENT })] },
        });
        const res = await as(request(app).post(linkCodePath(agentId)), CUSTOMER);
        const unknown = await as(request(app).post(linkCodePath(MISSING_AGENT)), CUSTOMER);
        expect(res.status).toBe(404);
        expect(res.body).toEqual(unknown.body);
        expect(data.size).toBe(0); // no code issued, no counter touched
      } finally {
        agents[OTHER_AGENT] = saved;
      }
    },
  );

  it("404 when not entitled", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow()] }, deps: { entitled: () => false } });
    expect((await as(request(app).post(linkCodePath()), CUSTOMER)).status).toBe(404);
  });

  it("403 when the user fails the channel access check", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow()] } });
    // authenticates, but has no users row (deleted meanwhile): channelAccessAllowed refuses
    users[60] = { id: 60, email: "gone@x", role: { name: "external" } };
    const res = await as(request(app).post(linkCodePath()), 60);
    expect(res.status).toBe(403);
    delete users[60];
  });

  it("403 for an API key scoped to other agents; a key scoped to this agent gets a code", async () => {
    users[61] = { id: 61, type: "api", scope_mode: "agents", agent_ids: [OTHER_AGENT], role: { name: "external" } };
    users[62] = { id: 62, type: "api", scope_mode: "agents", agent_ids: [AGENT_ID], role: { name: "external" } };
    try {
      const { app, data } = build({ seed: { agent_channels: [channelRow()] } });
      const refused = await as(request(app).post(linkCodePath()), 61);
      expect(refused.status).toBe(403);
      expect([...data.keys()].some((k) => k.endsWith(":61"))).toBe(false); // no code, no counter
      expect((await as(request(app).post(linkCodePath()), 62)).status).toBe(200);
    } finally {
      delete users[61];
      delete users[62];
    }
  });

  it("issues a code with a wa.me link of digits and the code, and only the caller's links", async () => {
    const { app } = build({
      seed: {
        agent_channels: [channelRow()],
        channel_links: [
          linkRow(),
          linkRow({ id: "d1000000-0000-4000-8000-000000000002", identity: "whatsapp:+4917099998888", user: OTHER_CUSTOMER }),
          linkRow({ id: "d1000000-0000-4000-8000-000000000004", identity: "whatsapp:+4917000004444", revoked_at: T0 }),
        ],
      },
    });
    const res = await as(request(app).post(linkCodePath()), CUSTOMER);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.body.expiresInSeconds).toBe(600);
    expect(res.body.waUrl).toBe(`https://wa.me/49301234567?text=${encodeURIComponent(res.body.code)}`);
    expect(res.body.links).toEqual([
      { id: "d1000000-0000-4000-8000-000000000001", identityMasked: "•••• 5678", expires_at: "2026-11-26T10:00:00.000Z" },
    ]);
    expect(Object.keys(res.body).sort()).toEqual(["code", "expiresInSeconds", "links", "waUrl"]);
    expectNoSecrets(res.body, ["verify-token-stored-once"]);
    expect(logs.join("\n")).not.toContain(res.body.code);
  });

  it("waUrl is null when the display number has no digits", async () => {
    const { app } = build({
      seed: { agent_channels: [channelRow({ config: { phoneNumberId: "1", displayNumber: "Newlift Service" } })] },
    });
    const res = await as(request(app).post(linkCodePath()), CUSTOMER);
    expect(res.body.waUrl).toBeNull();
  });

  it(`429 after ${CODE_ISSUE_LIMIT} codes`, async () => {
    const { app, data } = build({ seed: { agent_channels: [channelRow()] } });
    for (let i = 0; i < CODE_ISSUE_LIMIT; i++) {
      expect((await as(request(app).post(linkCodePath()), CUSTOMER)).status).toBe(200);
    }
    expect((await as(request(app).post(linkCodePath()), CUSTOMER)).status).toBe(429);
    const counter = [...data.entries()].find(([k]) => k.startsWith("channel-link:issued:"));
    expect(counter?.[1].exp).toBe(600);
    // another user is not affected
    expect((await as(request(app).post(linkCodePath()), OTHER_CUSTOMER)).status).toBe(200);
  });

  it("503 when Redis is unavailable", async () => {
    const { app } = build({ seed: { agent_channels: [channelRow()] }, store: null });
    expect((await as(request(app).post(linkCodePath()), CUSTOMER)).status).toBe(503);
  });

  it("503 when Redis fails mid-request", async () => {
    const fail = async (): Promise<never> => {
      throw new Error("redis down");
    };
    const broken: KeyValueStore = { set: fail, getDel: fail, del: fail, incr: fail, expire: fail, get: fail, ttl: fail };
    const { app } = build({ seed: { agent_channels: [channelRow()] }, store: broken });
    expect((await as(request(app).post(linkCodePath()), CUSTOMER)).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Unlink (signed-in customer)

describe("DELETE /public-agents/:id/channels/whatsapp/links/:linkId", () => {
  const seed = () => ({
    agent_channels: [channelRow(), channelRow({ id: "c1000000-0000-4000-8000-000000000002", agent: OTHER_AGENT })],
    channel_links: [
      linkRow(),
      linkRow({ id: "d1000000-0000-4000-8000-000000000002", identity: "whatsapp:+4917099998888", user: OTHER_CUSTOMER }),
      linkRow({ id: "d1000000-0000-4000-8000-000000000003", channel: "c1000000-0000-4000-8000-000000000002" }),
    ],
  });
  const path = (link: string, agent = AGENT_ID) => `/public-agents/${agent}/channels/whatsapp/links/${link}`;

  it("401 when not signed in", async () => {
    const { app } = build({ seed: seed() });
    expect((await request(app).delete(path("d1000000-0000-4000-8000-000000000001"))).status).toBe(401);
  });

  it("removes the caller's own link with 204 and audits it as unlinked", async () => {
    const { app, tables } = build({ seed: seed() });
    const res = await as(request(app).delete(path("d1000000-0000-4000-8000-000000000001")), CUSTOMER);
    expect(res.status).toBe(204);
    expect(tables.channel_links[0].revoked_at).toEqual(T0);
    expect(logs.find((l) => l.includes("audit"))).toContain('"event":"unlinked"');
  });

  it("another user's link, a link of another agent's channel and an unknown link are all 404", async () => {
    const { app, tables } = build({ seed: seed() });
    const others = await as(request(app).delete(path("d1000000-0000-4000-8000-000000000002")), CUSTOMER);
    const otherChannel = await as(request(app).delete(path("d1000000-0000-4000-8000-000000000003")), CUSTOMER);
    const unknown = await as(request(app).delete(path("d1000000-0000-4000-8000-000000000009")), CUSTOMER);
    const bad = await as(request(app).delete(path("zzz")), CUSTOMER);
    for (const r of [others, otherChannel, unknown, bad]) expect(r.status).toBe(404);
    expect(new Set([others, otherChannel, unknown, bad].map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(tables.channel_links.every((l: any) => l.revoked_at === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Secret sweep over every route

describe("no route ever returns secret material", () => {
  it("after creation, no body contains the token, app secret, sealed secrets or verify token", async () => {
    const { app, tables, fetchMock } = build({ seed: { channel_links: [] } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400 }));
    const created = await as(request(app).put(adminPath()), ADMIN).send({
      enabled: true,
      config: fullConfig,
      secrets: { accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
    });
    expect(created.status).toBe(200);
    const row = tables.agent_channels[0];
    tables.channel_links.push(linkRow({ channel: row.id }));
    const forbidden = [row.secrets, row.verify_token];
    expectNoSecrets(created.body, [row.secrets]);

    const bodies = [
      await as(request(app).get(adminPath()), ADMIN),
      await as(request(app).put(adminPath()), ADMIN).send({ config: fullConfig }),
      await as(request(app).put(adminPath()), ADMIN).send({ enabled: "x" }),
      await as(request(app).put(adminPath()), ADMIN).send({ secrets: { accessToken: "", appSecret: "" } }),
      await as(request(app).post(`${adminPath()}/test`), ADMIN),
      await as(request(app).get(`${adminPath()}/links`), ADMIN),
      await as(request(app).post(linkCodePath()), CUSTOMER),
      await as(request(app).delete(`/public-agents/${AGENT_ID}/channels/whatsapp/links/${linkRow().id}`), CUSTOMER),
      await as(request(app).delete(`${adminPath()}/links/${linkRow().id}`), ADMIN),
    ];
    for (const r of bodies) {
      expect(r.status).toBeLessThan(500);
      expectNoSecrets(r.body, forbidden);
      expectNoSecrets(r.text, forbidden);
    }
    expectNoSecrets(logs, forbidden);
  });
});

// ---------------------------------------------------------------------------
// Auto-disable and clean-up

describe("disableChannelsForAgent / syncChannelsWithGuestAccess / deleteChannelsForAgent", () => {
  it("disableChannelsForAgent flips enabled and bumps updatedAt for that agent only", async () => {
    const { db, tables } = fakeDb({
      agent_channels: [channelRow(), channelRow({ id: "c2", agent: OTHER_AGENT })],
    });
    await disableChannelsForAgent(db, AGENT_ID, T0);
    expect(tables.agent_channels[0]).toMatchObject({ enabled: false, updatedAt: T0 });
    expect(tables.agent_channels[1].enabled).toBe(true);
  });

  it("syncChannelsWithGuestAccess disables only when the agent can no longer carry a channel", async () => {
    const { db, tables } = fakeDb({ agent_channels: [channelRow()] });
    await syncChannelsWithGuestAccess(db, { id: AGENT_ID, guest_access: true, guest_auth_mode: "regular" });
    expect(tables.agent_channels[0].enabled).toBe(true);
    await syncChannelsWithGuestAccess(db, { id: AGENT_ID, guest_access: true, guest_auth_mode: "password" });
    expect(tables.agent_channels[0].enabled).toBe(false);

    tables.agent_channels[0].enabled = true;
    await syncChannelsWithGuestAccess(db, { id: AGENT_ID, guest_access: false, guest_auth_mode: "regular" });
    expect(tables.agent_channels[0].enabled).toBe(false);
  });

  it("deleteChannelsForAgent removes the agent's channels and their links", async () => {
    const { db, tables } = fakeDb({
      agent_channels: [channelRow(), channelRow({ id: "c2", agent: OTHER_AGENT })],
      channel_links: [linkRow(), linkRow({ id: "l2", channel: "c2" })],
    });
    await deleteChannelsForAgent(db, AGENT_ID);
    expect(tables.agent_channels.map((r: any) => r.id)).toEqual(["c2"]);
    expect(tables.channel_links.map((r: any) => r.id)).toEqual(["l2"]);
  });
});

// ---------------------------------------------------------------------------
// Licence gate and the never-throwing wrappers for the agent mutations

const recordingDb = (opts: { fail?: boolean } = {}) => {
  const { db: inner, tables } = fakeDb({
    agent_channels: [channelRow(), channelRow({ id: "c2", agent: OTHER_AGENT })],
    channel_links: [linkRow({ channel: channelRow().id }), linkRow({ id: "l2", channel: "c2" })],
  });
  const queries: string[] = [];
  const db: any = (t: string) => {
    queries.push(t);
    if (opts.fail) throw new Error('relation "agent_channels" does not exist');
    return inner(t);
  };
  return { db, tables, queries };
};

describe("without the channels licence nothing touches the channel tables", () => {
  beforeEach(() => {
    process.env.EXULU_ENTERPRISE_LICENSE = "";
  });
  afterEach(() => {
    process.env.EXULU_ENTERPRISE_LICENSE = LICENSED;
  });

  it("disable, sync, delete and both wrappers make zero queries", async () => {
    const { db, queries } = recordingDb();
    const unpublished = { id: AGENT_ID, guest_access: false, guest_auth_mode: "regular" };
    await disableChannelsForAgent(db, AGENT_ID);
    await syncChannelsWithGuestAccess(db, unpublished);
    await deleteChannelsForAgent(db, AGENT_ID);
    await afterAgentWrite(db, unpublished, { guest_access: false });
    await afterAgentDelete(db, AGENT_ID);
    expect(queries).toEqual([]);
  });
});

describe("afterAgentWrite / afterAgentDelete", () => {
  it("unpublishing disables the agent's channels; deleting removes them with their links", async () => {
    const { db, tables } = recordingDb();
    await afterAgentWrite(db, { id: AGENT_ID, guest_access: false, guest_auth_mode: "regular" }, { guest_access: false });
    expect(tables.agent_channels.map((r: any) => r.enabled)).toEqual([false, true]);
    await afterAgentDelete(db, AGENT_ID);
    expect(tables.agent_channels.map((r: any) => r.id)).toEqual(["c2"]);
    expect(tables.channel_links.map((r: any) => r.id)).toEqual(["l2"]);
  });

  it("an agent write without guest fields makes no query", async () => {
    const { db, queries } = recordingDb();
    await afterAgentWrite(db, { id: AGENT_ID, guest_access: false }, { name: "x" });
    expect(queries).toEqual([]);
  });

  it("a failing table query resolves and logs one safe line with the agent id", async () => {
    const { db } = recordingDb({ fail: true });
    await expect(
      afterAgentWrite(db, { id: AGENT_ID, guest_access: false }, { guest_access: false }),
    ).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(AGENT_ID);
    expect(logs[0]).not.toContain("does not exist");
    await expect(afterAgentDelete(db, AGENT_ID)).resolves.toBeUndefined();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain(AGENT_ID);
    expect(logs[1]).not.toContain("does not exist");
  });
});
