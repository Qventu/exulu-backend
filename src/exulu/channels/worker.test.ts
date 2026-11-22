process.env.NEXTAUTH_SECRET = "test-secret";

jest.mock("./agent-turn", () => ({ runChannelAgentTurn: jest.fn() }));
jest.mock("./pg-pool", () => ({ getChannelPgPool: jest.fn(() => ({ fake: "pool" })) }));

import { createHash } from "crypto";
import Knex from "knex";
import {
  createChannelSessions,
  createRunDeps,
  findRecentSessionQuery,
  parseChannelMessageJob,
  runChannelMessageJob,
  type ChannelWorkerEnv,
} from "./worker";
import { runLockKey, type ChannelMessageJob } from "./run";
import type { AgentChannelRow } from "./types";

const CHANNEL_ID = "8f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

const config = { phoneNumberId: "pn-1", displayNumber: "+49 30 1234", locale: "de" };
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

const job: ChannelMessageJob = {
  channelId: CHANNEL_ID,
  threadId: "whatsapp:pn-1:4915112345678",
  identity: "4915112345678",
  userId: 7,
  messageId: "wamid.1",
  text: "Wie tausche ich das Relais?",
  newSession: false,
};

class FakeRedis {
  values = new Map<string, string>();
  ttls = new Map<string, number>();
  isReady = true;
  async set(key: string, value: string, opts: { NX?: true; EX: number }) {
    if (opts.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    this.ttls.set(key, opts.EX);
    return "OK";
  }
  async eval(_s: string, o: { keys: string[]; arguments: string[] }) {
    if (this.values.get(o.keys[0]) === o.arguments[0]) this.values.delete(o.keys[0]);
    return 1;
  }
  async exists(key: string) {
    return this.values.has(key) ? 1 : 0;
  }
}

const sql = Knex({ client: "pg" });

describe("parseChannelMessageJob", () => {
  it("accepts a well-formed job", () => {
    expect(parseChannelMessageJob({ ...job })).toEqual(job);
  });

  it.each([
    ["no channel id", { ...job, channelId: undefined }],
    ["user id as text", { ...job, userId: "7" }],
    ["text missing", { ...job, text: undefined }],
    ["newSession missing", { ...job, newSession: undefined }],
    ["not an object", "hello"],
  ])("rejects %s without quoting the payload", (_label, inputs) => {
    let message = "";
    try {
      parseChannelMessageJob(inputs);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/channel_message/);
    expect(message).not.toContain("Relais");
    expect(message).not.toContain("4915112345678");
  });
});

describe("sessions", () => {
  it("findRecent filters by agent, user, channel marker and last activity, newest first", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const q = findRecentSessionQuery(sql as any, {
      agentId: "agent-1",
      userId: 7,
      channelId: CHANNEL_ID,
      idleHours: 8,
      now,
    }).toSQL();
    expect(q.sql).toContain('"agent" = ?');
    expect(q.sql).toContain('"user" = ?');
    expect(q.sql).toContain('"run" is null');
    expect(q.sql).toContain("metadata -> 'channel' ->> 'id' = ?");
    expect(q.sql).toContain('COALESCE(last_answer_at, "createdAt") >= ?');
    expect(q.sql).toContain('order by COALESCE(last_answer_at, "createdAt") DESC');
    expect(q.bindings).toEqual(
      expect.arrayContaining(["agent-1", 7, CHANNEL_ID, new Date("2026-11-20T04:00:00Z")]),
    );
  });

  it("findRecent returns the id or null", async () => {
    const make = (result: unknown) => {
      const builder: any = {
        where: () => builder,
        whereNull: () => builder,
        whereRaw: () => builder,
        orderByRaw: () => builder,
        first: async () => result,
      };
      return (() => builder) as any;
    };
    const p = { agentId: "a", userId: 7, channelId: CHANNEL_ID, idleHours: 8, now: new Date() };
    expect(await createChannelSessions(make({ id: "s1" })).findRecent(p)).toBe("s1");
    expect(await createChannelSessions(make(undefined)).findRecent(p)).toBeNull();
  });

  it("create inserts a private session owned by the user with the channel marker", async () => {
    let inserted: any;
    const db: any = (table: string) => ({
      insert: (values: any) => {
        inserted = { table, values };
        return { returning: async () => [{ id: "s-new" }] };
      },
    });
    const id = await createChannelSessions(db).create({
      agentId: "agent-1",
      userId: 7,
      title: "Wie tausche ich",
      channel: { type: "whatsapp", id: CHANNEL_ID, identity: "4915112345678" },
    });
    expect(id).toBe("s-new");
    expect(inserted).toEqual({
      table: "agent_sessions",
      values: {
        agent: "agent-1",
        user: 7,
        created_by: 7,
        title: "Wie tausche ich",
        rights_mode: "private",
        metadata: { channel: { type: "whatsapp", id: CHANNEL_ID, identity: "4915112345678" } },
      },
    });
  });
});

describe("createRunDeps", () => {
  const tableDb = (channel: unknown) => {
    const db: any = (table: string) => ({ where: () => ({ first: async () => (table === "agent_channels" ? channel : undefined) }) });
    return db;
  };

  const makeEnv = (over: Partial<ChannelWorkerEnv> = {}): ChannelWorkerEnv => ({
    getDb: async () => tableDb(row),
    getRedis: async () => new FakeRedis() as any,
    loadAgent: async () => ({ id: "agent-1", guest_access: true }),
    runAgentTurn: jest.fn(async () => "answer"),
    ...over,
  });

  it("loadChannel parses the config; a bad config or a missing row is null", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const deps = await createRunDeps(makeEnv());
    const loaded = await deps.loadChannel(CHANNEL_ID);
    expect(loaded?.row).toBe(row);
    expect(loaded?.config.sessionIdleHours).toBe(8);
    expect(await (await createRunDeps(makeEnv({ getDb: async () => tableDb(undefined) }))).loadChannel(CHANNEL_ID)).toBeNull();
    expect(
      await (await createRunDeps(makeEnv({ getDb: async () => tableDb({ ...row, config: {} }) }))).loadChannel(CHANNEL_ID),
    ).toBeNull();
    expect(JSON.stringify(error.mock.calls)).toContain(CHANNEL_ID);
    error.mockRestore();
  });

  it("refuses to run without Redis", async () => {
    await expect(createRunDeps(makeEnv({ getRedis: async () => null }))).rejects.toThrow(/redis/i);
  });

  it("the lock is the shared run lock on the job's key", async () => {
    const redis = new FakeRedis();
    const deps = await createRunDeps(makeEnv({ getRedis: async () => redis as any }));
    const key = runLockKey(CHANNEL_ID, job.identity);
    const token = await deps.lock.acquire(key, 900);
    expect(redis.values.get(key)).toBe(token);
    expect(await deps.lock.acquire(key, 900)).toBeNull();
    await deps.lock.release(key, token as string);
    expect(redis.values.has(key)).toBe(false);
  });

  it("markAnswered sets the hashed answered key once, for 24 h, and is true only the first time", async () => {
    const redis = new FakeRedis();
    const deps = await createRunDeps(makeEnv({ getRedis: async () => redis as any }));
    expect(await deps.markAnswered(job)).toBe(true);
    expect(await deps.markAnswered(job)).toBe(false);
    const key = `channel-answered:${CHANNEL_ID}:${createHash("sha256").update(job.messageId).digest("hex")}`;
    expect([...redis.values.keys()]).toEqual([key]);
    expect(redis.ttls.get(key)).toBe(86400);
    expect(key).not.toContain(job.messageId);
    expect(await deps.markAnswered({ ...job, messageId: "wamid.2" })).toBe(true);
  });

  it("posts through a post-only transport of the loaded channel", async () => {
    const post = jest.fn(async () => {});
    const typing = jest.fn(async () => {});
    const getTransport = jest.fn(async (_row: AgentChannelRow, deps: any) => {
      expect(deps.pgPool).toEqual({ fake: "pool" });
      expect(deps.onMessage).toBeUndefined();
      return { post, typing } as any;
    });
    const deps = await createRunDeps(makeEnv({ getTransport }));
    await expect(deps.transport.post("t", "x")).rejects.toThrow(/channel/);
    await deps.loadChannel(CHANNEL_ID);
    await deps.transport.post("t", "hello");
    await deps.transport.typing("t");
    expect(getTransport.mock.calls[0][0]).toBe(row);
    expect(post).toHaveBeenCalledWith("t", "hello");
    expect(typing).toHaveBeenCalledWith("t");
  });
});

describe("stillAllowed", () => {
  const NOW = new Date("2026-11-20T12:00:00Z");
  const validLink = {
    id: "l1",
    channel: CHANNEL_ID,
    identity: job.identity,
    user: 7,
    linked_at: new Date("2026-11-19T12:00:00Z"),
    expires_at: new Date("2026-11-26T12:00:00Z"),
    revoked_at: null,
    last_seen_at: null,
  };
  const dbWith = (link: unknown, opts: { userDeleted?: boolean } = {}) => {
    const user = opts.userDeleted ? undefined : { id: 7 };
    const calls: Array<{ table: string; where: unknown }> = [];
    const db: any = (table: string) => ({
      where: (where: unknown) => {
        calls.push({ table, where });
        const value = table === "channel_links" ? link : table === "users" ? user : table === "agent_channels" ? row : undefined;
        return { first: async () => value };
      },
    });
    db.calls = calls;
    return db;
  };
  const check = async (db: any, loadAgent: ChannelWorkerEnv["loadAgent"] = async () => ({ id: "agent-1", guest_access: true })) => {
    const deps = await createRunDeps({
      getDb: async () => db,
      getRedis: async () => new FakeRedis() as any,
      loadAgent,
      runAgentTurn: jest.fn(),
      now: () => NOW,
    });
    return deps.stillAllowed(job, row);
  };

  it("valid link of the job's user with access → true, checked against the channel's current agent", async () => {
    const loadAgent = jest.fn(async () => ({ id: "agent-1", guest_access: true }));
    const db = dbWith(validLink);
    expect(await check(db, loadAgent)).toBe(true);
    expect(db.calls[0]).toEqual({ table: "channel_links", where: { channel: CHANNEL_ID, identity: job.identity } });
    expect(loadAgent).toHaveBeenCalledWith("agent-1");
  });

  it.each([
    ["no link", undefined],
    ["revoked link", { ...validLink, revoked_at: new Date("2026-11-20T10:00:00Z") }],
    ["expired link", { ...validLink, expires_at: new Date("2026-11-20T11:00:00Z") }],
    ["link now belonging to another user", { ...validLink, user: 8 }],
  ])("%s → false", async (_label, link) => {
    expect(await check(dbWith(link))).toBe(false);
  });

  it("access withdrawn (agent no longer guest-published) → false", async () => {
    expect(await check(dbWith(validLink), async () => ({ id: "agent-1", guest_access: false }))).toBe(false);
  });

  it("user deleted → false", async () => {
    expect(await check(dbWith(validLink, { userDeleted: true }))).toBe(false);
  });

  it("an access check that cannot be made ('unavailable') → false (the job is skipped)", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const loadAgent = async () => {
      throw new Error("agent load failed");
    };
    expect(await check(dbWith(validLink), loadAgent)).toBe(false);
    error.mockRestore();
  });

  it("an API user whose key is scoped to another agent → false", async () => {
    const db = dbWith(validLink);
    const scoped: any = (table: string) =>
      table === "users"
        ? { where: () => ({ first: async () => ({ id: 7, type: "api", scope_mode: "agents", agent_ids: ["other"] }) }) }
        : db(table);
    expect(await check(scoped)).toBe(false);
  });
});

describe("runChannelMessageJob", () => {
  const link = {
    id: "l1",
    channel: CHANNEL_ID,
    identity: job.identity,
    user: 7,
    linked_at: new Date("2026-11-19T12:00:00Z"),
    expires_at: new Date("2099-01-01T00:00:00Z"),
    revoked_at: null,
    last_seen_at: null,
  };
  /** agent_channels, channel_links, users answer by table; agent_sessions finds or inserts. */
  const jobDb = (session: { find?: string; insert?: string }) =>
    ((table: string) => {
      const byTable: Record<string, unknown> = { agent_channels: row, channel_links: link, users: { id: 7 } };
      if (table in byTable) return { where: () => ({ first: async () => byTable[table] }) };
      const builder: any = {
        where: () => builder,
        whereNull: () => builder,
        whereRaw: () => builder,
        orderByRaw: () => builder,
        first: async () => (session.find ? { id: session.find } : undefined),
        insert: () => ({ returning: async () => [{ id: session.insert }] }),
      };
      return builder;
    }) as any;
  const loadAgent = async () => ({ id: "agent-1", guest_access: true });

  it("runs the job and returns only ids and the outcome, never text", async () => {
    const redis = new FakeRedis();
    const post = jest.fn(async () => {});
    const runAgentTurn = jest.fn(async () => "Das Relais tauschen Sie so");
    const result = await runChannelMessageJob(
      { ...job },
      {
        getDb: async () => jobDb({ find: "sess-1" }),
        getRedis: async () => redis as any,
        loadAgent,
        runAgentTurn,
        getTransport: (async () => ({ post, typing: jest.fn(async () => {}) })) as any,
      },
    );
    expect(result).toEqual({ sessionId: "sess-1", posted: "answer" });
    expect(runAgentTurn).toHaveBeenCalledWith({ agentId: "agent-1", userId: 7, sessionId: "sess-1", text: job.text });
    expect(post).toHaveBeenCalledWith(job.threadId, "Das Relais tauschen Sie so");
    // the run lock is released; only the answered marker (hashed message id) stays
    expect([...redis.values.keys()]).toEqual([
      `channel-answered:${CHANNEL_ID}:${createHash("sha256").update(job.messageId).digest("hex")}`,
    ]);
  });

  it("a failed job rethrows a sanitized error: no message text, number or cause", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const post = jest.fn(async () => {
      throw Object.assign(new Error("Graph 400 for recipient 4915112345678: 'Wie tausche ich'"), { code: "E400" });
    });
    let thrown: Error | undefined;
    try {
      await runChannelMessageJob(
        { ...job, newSession: true },
        {
          getDb: async () => jobDb({ insert: "s" }),
          getRedis: async () => new FakeRedis() as any,
          loadAgent,
          runAgentTurn: jest.fn(async () => "answer"),
          getTransport: (async () => ({ post, typing: jest.fn(async () => {}) })) as any,
        },
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toBe(`channel_message job failed on channel ${CHANNEL_ID} (Error E400)`);
    expect((thrown as any).cause).toBeUndefined();
    expect(error.mock.calls.flat().some((a) => a instanceof Error)).toBe(false);
    expect(JSON.stringify(error.mock.calls)).not.toContain("4915112345678");
    error.mockRestore();
  });

  it("an invalid job is rejected with a sanitized error", async () => {
    await expect(
      runChannelMessageJob({ ...job, userId: "7" }, { getDb: jest.fn(), getRedis: jest.fn(), loadAgent, runAgentTurn: jest.fn() } as any),
    ).rejects.toThrow("Invalid channel_message job: userId");
  });
});
