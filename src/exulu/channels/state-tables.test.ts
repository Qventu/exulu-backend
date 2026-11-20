import {
  CHAT_STATE_PURGE_INTERVAL_MS,
  ensureChatStateTables,
  purgeChatStateThrottled,
  purgeExpiredChatState,
  resetChatStatePurgeThrottle,
} from "./state-tables";

it("creates the chat state tables through the adapter's own DDL", async () => {
  const calls: string[] = [];
  const state = {
    connect: jest.fn(async () => void calls.push("connect")),
    disconnect: jest.fn(async () => void calls.push("disconnect")),
  };
  const createPostgresState = jest.fn(() => state);
  const pool = { fake: true } as any;

  await ensureChatStateTables(pool, async () => ({ createPostgresState }));

  expect(createPostgresState).toHaveBeenCalledWith({
    client: pool,
    keyPrefix: "exulu-channel",
    autoCreateSchema: true,
  });
  expect(calls).toEqual(["connect", "disconnect"]);
});

it("disconnects even when connect fails", async () => {
  const state = {
    connect: jest.fn(async () => {
      throw new Error("boom");
    }),
    disconnect: jest.fn(async () => {}),
  };
  await expect(
    ensureChatStateTables({} as any, async () => ({ createPostgresState: () => state })),
  ).rejects.toThrow("boom");
  expect(state.disconnect).toHaveBeenCalled();
});

describe("purgeExpiredChatState", () => {
  const LICENCE = "EXULU_ENTERPRISE_LICENSE";
  let saved: string | undefined;
  let error: jest.SpyInstance;
  beforeEach(() => {
    saved = process.env[LICENCE];
    process.env[LICENCE] = "EXULU_EE_test";
    error = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[LICENCE];
    else process.env[LICENCE] = saved;
    error.mockRestore();
  });

  const EXPIRING = ["chat_state_locks", "chat_state_cache", "chat_state_lists", "chat_state_queues"];

  /** A pg.Pool stand-in: to_regclass answers by the `present` tables, DELETEs report a count. */
  const fakePool = (present: string[] = EXPIRING, opts: { failOn?: string } = {}) => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool: any = {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (opts.failOn && text.includes(opts.failOn)) {
          throw Object.assign(new Error("delete from chat_state_lists where '4915112345678'"), { code: "57014" });
        }
        if (text.includes("to_regclass")) {
          return { rows: ((values as unknown[])[0] as string[]).filter((t) => present.includes(t)).map((t) => ({ name: t })) };
        }
        return { rowCount: 2, rows: [] };
      }),
    };
    return { pool, queries };
  };

  it("deletes only expired rows under our key prefix, in every table with an expiry", async () => {
    const { pool, queries } = fakePool();
    await purgeExpiredChatState(pool);
    const deletes = queries.filter((q) => q.text.startsWith("DELETE"));
    expect(deletes.map((q) => q.text)).toEqual(
      EXPIRING.map((t) => `DELETE FROM ${t} WHERE key_prefix = $1 AND expires_at IS NOT NULL AND expires_at <= now()`),
    );
    for (const q of deletes) expect(q.values).toEqual(["exulu-channel"]);
    // chat_state_subscriptions has no expiry and is never touched
    expect(queries.some((q) => q.text.includes("chat_state_subscriptions"))).toBe(false);
  });

  it("skips tables that do not exist", async () => {
    const { pool, queries } = fakePool(["chat_state_cache"]);
    await purgeExpiredChatState(pool);
    expect(queries.filter((q) => q.text.startsWith("DELETE")).map((q) => q.text)).toEqual([
      "DELETE FROM chat_state_cache WHERE key_prefix = $1 AND expires_at IS NOT NULL AND expires_at <= now()",
    ]);
  });

  it("does nothing when none of the tables exists", async () => {
    const { pool, queries } = fakePool([]);
    await purgeExpiredChatState(pool);
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain("to_regclass");
  });

  it("makes no query without the channels licence", async () => {
    delete process.env[LICENCE];
    const { pool } = fakePool();
    await purgeExpiredChatState(pool);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("never throws; logs one safe line (no message, no data)", async () => {
    const { pool } = fakePool(EXPIRING, { failOn: "chat_state_lists" });
    await expect(purgeExpiredChatState(pool)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("4915112345678");
    expect(logged).toContain("57014");
  });

  it("the throttled purge runs at most once per interval per process", () => {
    resetChatStatePurgeThrottle();
    const purge = jest.fn(async () => {});
    const pool = { fake: true } as any;
    expect(purgeChatStateThrottled(pool, 1_000, purge)).toBe(true);
    expect(purgeChatStateThrottled(pool, 1_000 + CHAT_STATE_PURGE_INTERVAL_MS - 1, purge)).toBe(false);
    expect(purgeChatStateThrottled(pool, 1_000 + CHAT_STATE_PURGE_INTERVAL_MS, purge)).toBe(true);
    expect(purge).toHaveBeenCalledTimes(2);
    expect(purge).toHaveBeenCalledWith(pool);
    expect(CHAT_STATE_PURGE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it("the throttled purge never lets a rejection escape", async () => {
    resetChatStatePurgeThrottle();
    const purge = jest.fn(async () => {
      throw new Error("boom");
    });
    expect(purgeChatStateThrottled({} as any, 5, purge)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(error).toHaveBeenCalledTimes(1);
  });
});
