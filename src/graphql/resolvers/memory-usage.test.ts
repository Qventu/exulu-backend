jest.mock("@SRC/graphql/utilities/access-control", () => ({ applyAccessControl: jest.fn((_t: unknown, q: any) => { q.__scoped = true; return q; }) }));
jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition", () => ({ convertContextToTableDefinition: (c: any) => ({ name: { singular: c.id, plural: `${c.id}s` } }) }));
// `mock`-prefixed so jest's hoist plugin allows the closure (see jest.mock docs).
const mockAgentSessionsSchema = jest.fn(() => ({ name: { singular: "agent_session", plural: "agent_sessions" } }));
jest.mock("@SRC/postgres/core-schema", () => ({ coreSchemas: { get: () => ({ agentSessionsSchema: mockAgentSessionsSchema }) } }));

import { isStale, memoryBaseUnusedIds, memoryBaseUsage, memoryUsage, memoryUsageByIds, staleCutoff, weekBuckets } from "./memory-usage";

const NOW = new Date("2026-10-01T12:00:00.000Z");

describe("pure helpers", () => {
  it("staleCutoff subtracts whole days; isStale is strictly older than the cutoff", () => {
    const cutoff = staleCutoff(NOW, 90);
    expect(cutoff.toISOString()).toBe("2026-07-03T12:00:00.000Z");
    expect(isStale(new Date("2026-07-03T12:00:00.000Z"), cutoff)).toBe(false);
    expect(isStale(new Date("2026-07-03T11:59:59.000Z"), cutoff)).toBe(true);
    expect(isStale(null, cutoff)).toBe(false);
  });
  it("weekBuckets returns the last six ISO weeks oldest first, zero-filled", () => {
    const buckets = weekBuckets([new Date("2026-09-30T08:00:00Z"), new Date("2026-09-29T08:00:00Z"), new Date("2026-08-25T08:00:00Z"), new Date("2026-01-01T00:00:00Z")], NOW);
    expect(buckets).toHaveLength(6);
    expect(buckets[5]).toEqual({ weekStart: "2026-09-28", count: 2 });
    expect(buckets[0]).toEqual({ weekStart: "2026-08-24", count: 1 });
    expect(buckets.map((b) => b.count)).toEqual([1, 0, 0, 0, 0, 2]);
  });
});

/** A tiny knex stand-in: every builder method returns the same chain; terminal awaits resolve per table. */
function fakeDb(answers: Record<string, any[] | (() => any[])>, opts: { hasTable?: (t: string) => boolean } = {}) {
  const log: any[] = [];
  const make = (table: string) => {
    const rows = () => { const a = answers[table] ?? []; return typeof a === "function" ? a() : a; };
    const chain: any = { __table: table, __scoped: false };
    const methods = ["where", "whereIn", "whereNotIn", "whereNot", "whereNull", "groupBy", "orderBy", "limit", "select", "count", "countDistinct", "max", "min", "andWhere", "whereRaw", "distinct"];
    for (const m of methods) chain[m] = (...args: any[]) => { log.push([table, m, ...args]); return chain; };
    chain.then = (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject);
    // `.first()` answers from "<table>#first" when given, so a count query and a
    // row query on the same table can be stubbed separately.
    chain.first = async () => { const f = answers[`${table}#first`]; return (f ? (typeof f === "function" ? f() : f) : rows())[0]; };
    return chain;
  };
  const db: any = jest.fn((table: string) => make(table));
  db.schema = { hasTable: async (t: string) => (opts.hasTable ? opts.hasTable(t) : true) };
  db.raw = (s: string) => s;
  db.__log = log;
  return db;
}

const context = { id: "mem", name: "Memory" } as any;

describe("memoryUsageByIds", () => {
  it("groups by memory and maps count + last use; absent ids are omitted", async () => {
    const db = fakeDb({ memory_usages: [{ memory_id: "m1", c: "3", last: new Date("2026-09-30T08:00:00Z") }] });
    expect(await memoryUsageByIds({ db, contextId: "mem", ids: ["m1", "m2"] })).toEqual([{ memoryId: "m1", count: 3, lastUsedAt: "2026-09-30T08:00:00.000Z" }]);
    expect(db.__log).toContainEqual(["memory_usages", "whereIn", "memory_id", ["m1", "m2"]]);
  });
  it("returns [] when the usage table is missing or ids are empty", async () => {
    expect(await memoryUsageByIds({ db: fakeDb({}, { hasTable: () => false }), contextId: "mem", ids: ["m1"] })).toEqual([]);
    const db = fakeDb({});
    expect(await memoryUsageByIds({ db, contextId: "mem", ids: [] })).toEqual([]);
    expect(db).not.toHaveBeenCalled();
  });
  it("clamps ids to 200 before the whereIn", async () => {
    const db = fakeDb({ memory_usages: [] });
    const ids = Array.from({ length: 250 }, (_, i) => `m${i}`);
    await memoryUsageByIds({ db, contextId: "mem", ids });
    const [, , , whereInIds] = db.__log.find((l: any[]) => l[0] === "memory_usages" && l[1] === "whereIn");
    expect(whereInIds).toHaveLength(200);
  });
});

describe("memoryUsage", () => {
  it("returns count, last use and recent entries with scoped titles, guest entries without a user", async () => {
    const db = fakeDb({
      "memory_usages#first": [{ c: "14", last: new Date("2026-09-30T08:00:00Z") }],
      memory_usages: [
        { session: "s1", message_id: "a", createdAt: new Date("2026-09-30T08:00:00Z"), agent: "ag1", user: 4, guest: false },
        { session: "s2", message_id: "b", createdAt: new Date("2026-09-29T08:00:00Z"), agent: "ag1", user: null, guest: true },
      ],
      agent_sessions: [{ id: "s1", title: "Display zeigt 0,2 m/s" }],
      agents: [{ id: "ag1", name: "Newton" }],
      users: [{ id: 4, firstname: "Daniel", lastname: "C." }],
    });
    const out = await memoryUsage({ db, contextId: "mem", memoryId: "m1", limit: 5, user: { id: 9 } as any });
    expect(out).toEqual({
      count: 14, lastUsedAt: "2026-09-30T08:00:00.000Z",
      recent: [
        { sessionId: "s1", messageId: "a", usedAt: "2026-09-30T08:00:00.000Z", agent: { id: "ag1", name: "Newton" }, user: { id: 4, name: "Daniel C." }, title: "Display zeigt 0,2 m/s" },
        { sessionId: "s2", messageId: "b", usedAt: "2026-09-29T08:00:00.000Z", agent: { id: "ag1", name: "Newton" }, user: null, title: null },
      ],
    });
    expect((require("@SRC/graphql/utilities/access-control") as any).applyAccessControl).toHaveBeenCalled();

    // sessionsTable() memoizes coreSchemas.get().agentSessionsSchema() at module scope;
    // a second call must reuse the cached definition, not re-invoke the factory.
    await memoryUsage({ db, contextId: "mem", memoryId: "m1", limit: 5, user: { id: 9 } as any });
    expect(mockAgentSessionsSchema).toHaveBeenCalledTimes(1);
  });
  it("is null-safe for a missing table", async () => {
    expect(await memoryUsage({ db: fakeDb({}, { hasTable: () => false }), contextId: "mem", memoryId: "m1", limit: 5, user: undefined })).toEqual({ count: 0, lastUsedAt: null, recent: [] });
  });
});

describe("memoryBaseUsage", () => {
  it("splits used / never / stale, ranks mostUsed by count then last use through the viewer's scope, buckets new items by week", async () => {
    const db = fakeDb({
      memory_usages: [
        { memory_id: "m1", c: "19", last: new Date("2026-09-30T08:00:00Z") },
        { memory_id: "m2", c: "6", last: new Date("2026-05-01T08:00:00Z") },
        { memory_id: "m3", c: "6", last: new Date("2026-09-01T08:00:00Z") },
      ],
      mem_items: () => [{ id: "m1", information: "A", createdAt: new Date("2026-09-30T08:00:00Z") }, { id: "m3", information: "C", createdAt: new Date("2026-09-29T08:00:00Z") }, { id: "m4", information: "D", createdAt: new Date("2026-01-01T00:00:00Z") }],
    });
    const out = await memoryBaseUsage({ db, context, user: { id: 9 } as any, staleDays: 90, now: NOW });
    expect(out.used).toBe(2);        // m1, m3 are non-archived & visible-independent counts: usage ids ∩ existing items (m2 was archived/deleted → not an item)
    expect(out.neverUsed).toBe(1);   // m4
    expect(out.stale).toBe(0);       // m2 is stale but no longer an item
    expect(out.mostUsed).toEqual([
      { id: "m1", information: "A", count: 19, lastUsedAt: "2026-09-30T08:00:00.000Z" },
      { id: "m3", information: "C", count: 6, lastUsedAt: "2026-09-01T08:00:00.000Z" },
    ]);
    expect(out.newPerWeek).toHaveLength(6);
    expect(out.newPerWeek[5]).toEqual({ weekStart: "2026-09-28", count: 2 });
    expect(db.__log.some((l: any[]) => l[0] === "mem_items" && l[1] === "whereNot" && l[2] === "archived")).toBe(true);
  });
  it("returns zeros when the items table or the usage table is missing", async () => {
    const zero = { used: 0, neverUsed: 0, stale: 0, mostUsed: [], newPerWeek: expect.any(Array) };
    expect(await memoryBaseUsage({ db: fakeDb({}, { hasTable: (t) => t !== "memory_usages" }), context, user: undefined, staleDays: 90, now: NOW })).toMatchObject(zero);
  });
});

describe("memoryBaseUnusedIds", () => {
  it("NEVER = items without usage; STALE = items whose last use is older than the cutoff", async () => {
    const db = fakeDb({
      memory_usages: [{ memory_id: "m1", last: new Date("2026-09-30T08:00:00Z") }, { memory_id: "m2", last: new Date("2026-05-01T08:00:00Z") }],
      mem_items: [{ id: "m1" }, { id: "m2" }, { id: "m4" }],
    });
    expect(await memoryBaseUnusedIds({ db, context, mode: "NEVER", staleDays: 90, now: NOW })).toEqual(["m4"]);
    expect(await memoryBaseUnusedIds({ db, context, mode: "STALE", staleDays: 90, now: NOW })).toEqual(["m2"]);
  });
  it("NEVER = all items when the usage table is missing; STALE = none", async () => {
    const db = fakeDb({ mem_items: [{ id: "m1" }, { id: "m2" }] }, { hasTable: (t) => t !== "memory_usages" });
    expect(await memoryBaseUnusedIds({ db, context, mode: "NEVER", staleDays: 90, now: NOW })).toEqual(["m1", "m2"]);
    expect(await memoryBaseUnusedIds({ db, context, mode: "STALE", staleDays: 90, now: NOW })).toEqual([]);
  });
  it("returns [] for both modes when the items table is missing", async () => {
    const db = fakeDb({}, { hasTable: () => false });
    expect(await memoryBaseUnusedIds({ db, context, mode: "NEVER", staleDays: 90, now: NOW })).toEqual([]);
    expect(await memoryBaseUnusedIds({ db, context, mode: "STALE", staleDays: 90, now: NOW })).toEqual([]);
  });
});
