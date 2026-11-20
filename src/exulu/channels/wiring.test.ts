process.env.NEXTAUTH_SECRET = "test-secret";

jest.mock("./pg-pool", () => ({ getChannelPgPool: jest.fn(() => ({ fake: "pool" })) }));

import {
  channelAccessAllowed,
  channelStoreFromRedis,
  createChannelWebhookDeps,
  createDecideDeps,
  type ChannelServerEnv,
  type ChannelStore,
} from "./wiring";
import { runLockKey } from "./run";
import { replyText } from "./texts";
import type { AgentChannelRow, WhatsAppChannelConfig } from "./types";
import type { InboundMessage } from "./decide";

const CHANNEL_ID = "8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

const config: WhatsAppChannelConfig = {
  phoneNumberId: "pn-1",
  displayNumber: "+49 30 1234",
  linkTtlDays: 7,
  sessionIdleHours: 8,
  locale: "de",
  texts: {},
};

const row: AgentChannelRow = {
  id: CHANNEL_ID,
  agent: "agent-1",
  type: "whatsapp",
  enabled: true,
  config,
  secrets: "sealed",
  verify_token: "verify",
  updatedAt: "2026-11-20T00:00:00Z",
};

class FakeStore implements ChannelStore {
  values = new Map<string, string>();
  ttls = new Map<string, number>();
  async set(key: string, value: string, opts: { EX: number; NX?: true }) {
    if (opts.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttls.set(key, opts.EX);
    return "OK";
  }
  async getDel(key: string) {
    const v = this.values.get(key) ?? null;
    this.values.delete(key);
    return v;
  }
  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }
  async incr(key: string) {
    const n = Number(this.values.get(key) ?? "0") + 1;
    this.values.set(key, String(n));
    return n;
  }
  async expire(key: string, seconds: number) {
    this.ttls.set(key, seconds);
    return 1;
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async ttl(key: string) {
    return this.values.has(key) ? (this.ttls.get(key) ?? -1) : -2;
  }
  async eval() {
    return 0;
  }
  async exists(key: string) {
    return this.values.has(key) ? 1 : 0;
  }
}

/** A knex-shaped fake: db(table).where(...).first() returns the configured row. */
const fakeDb = (tables: Record<string, Record<string, any> | undefined>) => {
  const calls: Array<{ table: string; where: unknown }> = [];
  const db: any = (table: string) => ({
    where: (where: unknown) => {
      calls.push({ table, where });
      return { first: async () => tables[table] };
    },
  });
  db.calls = calls;
  return db;
};

const guestAgent = { id: "agent-1", guest_access: true, guest_auth_mode: "regular" };

const makeEnv = (over: Partial<ChannelServerEnv> = {}): ChannelServerEnv => ({
  entitled: () => true,
  rateLimitExceeded: () => false,
  getDb: async () => fakeDb({ users: { id: 7 }, agent_channels: row }),
  getRedis: async () => ({ isReady: true }) as any,
  loadAgent: async () => guestAgent,
  enqueue: jest.fn(async () => {}),
  userRateLimited: () => false,
  ...over,
});

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

describe("channelAccessAllowed", () => {
  const base = { agentId: "agent-1", channelId: CHANNEL_ID, userId: 7 };

  it("allows an existing user on a guest-published agent", async () => {
    const db = fakeDb({ users: { id: 7 } });
    expect(await channelAccessAllowed({ ...base, db, loadAgent: async () => guestAgent })).toBe(true);
    expect(db.calls).toEqual([{ table: "users", where: { id: 7 } }]);
  });

  it("refuses a user row that no longer exists", async () => {
    const db = fakeDb({ users: undefined });
    expect(await channelAccessAllowed({ ...base, db, loadAgent: async () => guestAgent })).toBe(false);
  });

  it("refuses when the agent is no longer guest-published (evaluateGuestChatAccess)", async () => {
    const db = fakeDb({ users: { id: 7 } });
    const agent = { ...guestAgent, guest_access: false, rights_mode: "public" };
    expect(await channelAccessAllowed({ ...base, db, loadAgent: async () => agent })).toBe(false);
  });

  it("refuses when the agent is gone", async () => {
    const db = fakeDb({ users: { id: 7 } });
    expect(await channelAccessAllowed({ ...base, db, loadAgent: async () => undefined })).toBe(false);
  });

  it("fails closed and logs the channel when a lookup throws", async () => {
    const db = fakeDb({ users: { id: 7 } });
    const loadAgent = async () => {
      throw new Error("Agent instance not found.");
    };
    expect(await channelAccessAllowed({ ...base, db, loadAgent })).toBe(false);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain(CHANNEL_ID);
  });
});

describe("createDecideDeps", () => {
  const build = (store = new FakeStore(), env = makeEnv()) =>
    createDecideDeps({ row, config, db: fakeDb({ users: { id: 7 } }), store, env });

  it("links to the agent's public link page", () => {
    const original = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = "https://newton.example.de";
    expect(build().linkUrl).toBe("https://newton.example.de/public/agents/agent-1/link/whatsapp");
    process.env.NEXTAUTH_URL = original;
  });

  it("runInFlight reads the run lock key of this channel and identity", async () => {
    const store = new FakeStore();
    const deps = build(store);
    expect(await deps.runInFlight("4915112345678")).toBe(false);
    store.values.set(runLockKey(CHANNEL_ID, "4915112345678"), "token");
    expect(await deps.runInFlight("4915112345678")).toBe(true);
    expect(await deps.runInFlight("4915100000000")).toBe(false);
  });

  it("a marked new session is taken exactly once and expires with the idle window", async () => {
    const store = new FakeStore();
    const deps = build(store);
    expect(await deps.takeNewSession("a1")).toBe(false);
    await deps.markNewSession("a1");
    expect([...store.ttls.values()]).toContain(8 * 3600);
    expect(await deps.takeNewSession("a2")).toBe(false);
    expect(await deps.takeNewSession("a1")).toBe(true);
    expect(await deps.takeNewSession("a1")).toBe(false);
  });

  it("rateLimited asks the per-user limiter with the user id", () => {
    const userRateLimited = jest.fn(() => true);
    const deps = build(new FakeStore(), makeEnv({ userRateLimited }));
    expect(deps.rateLimited(7)).toBe(true);
    expect(userRateLimited).toHaveBeenCalledWith(7);
  });

  it("audit de-duplicates code_lockout through the store", async () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => {});
    const deps = build();
    await deps.audit({ type: "code_lockout", identity: "a1111" });
    await deps.audit({ type: "code_lockout", identity: "a1111" });
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("link-code attempts are counted per channel", async () => {
    const store = new FakeStore();
    const deps = build(store);
    await deps.codeAttemptsExceeded("a1");
    expect([...store.values.keys()]).toEqual([`channel-link:attempts:${CHANNEL_ID}:a1`]);
  });
});

describe("createChannelWebhookDeps", () => {
  it("passes entitlement and the global rate limit through", () => {
    const deps = createChannelWebhookDeps(makeEnv({ entitled: () => false, rateLimitExceeded: () => true }));
    expect(deps.entitled()).toBe(false);
    expect(deps.rateLimitExceeded()).toBe(true);
  });

  it("Redis is available only when the client exists and is ready", async () => {
    expect(await createChannelWebhookDeps(makeEnv({ getRedis: async () => null })).redisAvailable()).toBe(false);
    expect(
      await createChannelWebhookDeps(makeEnv({ getRedis: async () => ({ isReady: false }) as any })).redisAvailable(),
    ).toBe(false);
    expect(await createChannelWebhookDeps(makeEnv()).redisAvailable()).toBe(true);
  });

  it("loads the channel row by id from agent_channels", async () => {
    const db = fakeDb({ agent_channels: row });
    const deps = createChannelWebhookDeps(makeEnv({ getDb: async () => db }));
    expect(await deps.loadChannel(CHANNEL_ID)).toBe(row);
    expect(db.calls).toEqual([{ table: "agent_channels", where: { id: CHANNEL_ID } }]);
  });

  it("builds the transport with the shared pool and an onMessage that decides and acts", async () => {
    const post = jest.fn(async () => {});
    const transport = { handleWebhook: jest.fn(), post, typing: jest.fn(), markRead: jest.fn() };
    let onMessage: ((msg: InboundMessage) => Promise<void>) | undefined;
    const getTransport = jest.fn(async (_row: AgentChannelRow, deps: any) => {
      onMessage = onMessage ?? deps.onMessage;
      expect(deps.pgPool).toEqual({ fake: "pool" });
      return transport as any;
    });
    const store = new FakeStore();
    const redis = { isReady: true };
    const deps = createChannelWebhookDeps(
      makeEnv({ getRedis: async () => redis as any, getTransport, storeFor: () => store }),
    );
    expect(await deps.transportFor(row)).toBe(transport);
    expect(onMessage).toBeDefined();

    // an attachment is answered with the fixed textOnly reply, without the model
    await onMessage!({
      channelId: CHANNEL_ID,
      threadId: "whatsapp:pn-1:4915112345678",
      identity: "4915112345678",
      messageId: "wamid.1",
      text: "",
      hasAttachments: true,
    });
    expect(post).toHaveBeenCalledWith("whatsapp:pn-1:4915112345678", replyText("textOnly", config));
  });

  it("onMessage refuses to decide without Redis (the SDK handler logs it)", async () => {
    let onMessage: ((msg: InboundMessage) => Promise<void>) | undefined;
    const getTransport = jest.fn(async (_row: AgentChannelRow, deps: any) => {
      onMessage = deps.onMessage;
      return { post: jest.fn() } as any;
    });
    let ready = true;
    const deps = createChannelWebhookDeps(
      makeEnv({ getRedis: async () => ({ isReady: ready }) as any, getTransport, storeFor: () => new FakeStore() }),
    );
    await deps.transportFor(row);
    ready = false;
    await expect(
      onMessage!({ channelId: CHANNEL_ID, threadId: "t", identity: "i", messageId: "m", text: "hi", hasAttachments: false }),
    ).rejects.toThrow(/redis/i);
  });
});

describe("channelStoreFromRedis", () => {
  it("maps the store calls onto node-redis v4", async () => {
    const client = {
      set: jest.fn(async () => "OK"),
      getDel: jest.fn(async () => "v"),
      del: jest.fn(async () => 1),
      incr: jest.fn(async () => 2),
      expire: jest.fn(async () => true),
      get: jest.fn(async () => "g"),
      ttl: jest.fn(async () => 5),
      eval: jest.fn(async () => 1),
      exists: jest.fn(async () => 1),
    };
    const store = channelStoreFromRedis(client as any);
    await store.set("k", "v", { EX: 10 });
    await store.set("k", "v", { EX: 10, NX: true });
    expect(client.set).toHaveBeenNthCalledWith(1, "k", "v", { EX: 10 });
    expect(client.set).toHaveBeenNthCalledWith(2, "k", "v", { EX: 10, NX: true });
    await store.eval("script", { keys: ["k"], arguments: ["t"] });
    expect(client.eval).toHaveBeenCalledWith("script", { keys: ["k"], arguments: ["t"] });
    expect(await store.exists("k")).toBe(1);
    expect(await store.getDel("k")).toBe("v");
  });
});
