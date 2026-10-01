import { recordMemoryUsage, usageRows } from "./usage";

const recall: any = { list: () => [{ id: "m1" }, { id: "m2" }] };
const base = { recall, contextId: "mem", agentId: "ag1", session: "s1", messageId: "msg1", userId: 4 };

function fakeDb(opts: { throwOnInsert?: boolean } = {}) {
  const calls: any[] = [];
  const db: any = jest.fn((table: string) => ({
    insert: (rows: any[]) => {
      calls.push({ table, rows });
      return {
        onConflict: (cols: string[]) => {
          calls[calls.length - 1].onConflict = cols;
          return { ignore: async () => { if (opts.throwOnInsert) throw new Error("boom"); } };
        },
      };
    },
  }));
  db.__calls = calls;
  return db;
}

describe("usageRows", () => {
  it("builds one row per recalled memory, guest when there is no user", () => {
    expect(usageRows(base)).toEqual([
      { memory_id: "m1", context: "mem", agent: "ag1", session: "s1", message_id: "msg1", user: 4, guest: false },
      { memory_id: "m2", context: "mem", agent: "ag1", session: "s1", message_id: "msg1", user: 4, guest: false },
    ]);
    expect(usageRows({ ...base, session: undefined, userId: null })[0]).toMatchObject({ session: null, user: null, guest: true });
    expect(usageRows({ ...base, recall: undefined })).toEqual([]);
    expect(usageRows({ ...base, recall: { list: () => [] } as any })).toEqual([]);
  });
});

describe("recordMemoryUsage", () => {
  it("inserts the batch with conflict-ignore on (message_id, memory_id)", async () => {
    const db = fakeDb();
    expect(await recordMemoryUsage({ ...base, db })).toBe(2);
    expect(db.__calls).toEqual([{ table: "memory_usages", rows: usageRows(base), onConflict: ["message_id", "memory_id"] }]);
  });
  it("writes nothing without recalled memories", async () => {
    const db = fakeDb();
    expect(await recordMemoryUsage({ ...base, db, recall: undefined })).toBe(0);
    expect(db).not.toHaveBeenCalled();
  });
  it("swallows write errors with one console.error", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await recordMemoryUsage({ ...base, db: fakeDb({ throwOnInsert: true }) })).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
