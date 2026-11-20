process.env.NEXTAUTH_SECRET = "test-secret";

jest.mock("./agent-turn", () => ({ runChannelAgentTurn: jest.fn() }));
jest.mock("./pg-pool", () => ({ getChannelPgPool: jest.fn(() => ({ fake: "pool" })) }));

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
  isReady = true;
  async set(key: string, value: string, opts: { NX?: true; EX: number }) {
    if (opts.NX && this.values.has(key)) return null;
    this.values.set(key, value);
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

  it("posts through the transport of the loaded channel, with a no-op message handler", async () => {
    const post = jest.fn(async () => {});
    const typing = jest.fn(async () => {});
    const getTransport = jest.fn(async (_row: AgentChannelRow, deps: any) => {
      expect(deps.pgPool).toEqual({ fake: "pool" });
      await expect(deps.onMessage({})).resolves.toBeUndefined();
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

describe("runChannelMessageJob", () => {
  it("runs the job and returns only ids and the outcome, never text", async () => {
    const redis = new FakeRedis();
    const post = jest.fn(async () => {});
    const db: any = (table: string) => {
      if (table === "agent_channels") return { where: () => ({ first: async () => row }) };
      const builder: any = {
        where: () => builder,
        whereNull: () => builder,
        whereRaw: () => builder,
        orderByRaw: () => builder,
        first: async () => ({ id: "sess-1" }),
      };
      return builder;
    };
    const runAgentTurn = jest.fn(async () => "Das Relais tauschen Sie so");
    const result = await runChannelMessageJob(
      { ...job },
      {
        getDb: async () => db,
        getRedis: async () => redis as any,
        runAgentTurn,
        getTransport: (async () => ({ post, typing: jest.fn(async () => {}) })) as any,
      },
    );
    expect(result).toEqual({ sessionId: "sess-1", posted: "answer" });
    expect(runAgentTurn).toHaveBeenCalledWith({ agentId: "agent-1", userId: 7, sessionId: "sess-1", text: job.text });
    expect(post).toHaveBeenCalledWith(job.threadId, "Das Relais tauschen Sie so");
    expect(redis.values.size).toBe(0);
  });

  it("a failed job rethrows without the underlying error text", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const db: any = () => ({ where: () => ({ first: async () => row }) });
    const post = jest.fn(async () => {
      throw new Error("Graph 400 for recipient 4915112345678");
    });
    let thrown: Error | undefined;
    try {
      await runChannelMessageJob(
        { ...job, newSession: true },
        {
          getDb: async () =>
            ((table: string) =>
              table === "agent_sessions"
                ? { insert: () => ({ returning: async () => [{ id: "s" }] }) }
                : db(table)) as any,
          getRedis: async () => new FakeRedis() as any,
          runAgentTurn: jest.fn(async () => "answer"),
          getTransport: (async () => ({ post, typing: jest.fn(async () => {}) })) as any,
        },
      );
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain(CHANNEL_ID);
    expect(thrown!.message).not.toContain("4915112345678");
    error.mockRestore();
  });
});
