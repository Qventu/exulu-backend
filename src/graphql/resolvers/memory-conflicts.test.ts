jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));
import { memoryConflictCounts, memoryConflicts, memoryConflictsForMemory } from "./memory-conflicts";

function fakeDb(t: Record<string, any[]>) {
  const db: any = jest.fn((table: string) => {
    const eq: Record<string, any> = {};
    const not: Record<string, any> = {};
    let ids: string[] | null = null;
    const chain: any = {};
    for (const m of ["orderBy", "select", "groupBy", "count", "max"]) chain[m] = () => chain;
    chain.where = (...a: any[]) => { if (typeof a[0] === "object") Object.assign(eq, a[0]); else if (a.length >= 2) eq[a[0]] = a[a.length - 1]; return chain; };
    chain.whereIn = (col: string, values: any[]) => { if (col === "id") ids = values; return chain; };
    chain.whereNot = (col: string, value: any) => { not[col] = value; return chain; };
    chain.first = async () => t[`${table}#first`]?.[0];
    // Item queries filter for real: hydrate's public/archived predicates are part of what these tests check.
    chain.then = (res: any) => {
      const rows = t[table] ?? [];
      const out = table.endsWith("_items")
        ? rows.filter((r) => (ids === null || ids.includes(r.id))
          && Object.entries(eq).every(([k, v]) => r[k] === v)
          && Object.entries(not).every(([k, v]) => r[k] !== v))
        : rows;
      return Promise.resolve(out).then(res);
    };
    return chain;
  });
  db.schema = { hasTable: async () => true };
  return db;
}
const context = { id: "mem", name: "Memory" } as any;

describe("memoryConflicts", () => {
  it("hydrates members with wording, author, saved and usedCount; drops groups with fewer than two live members", async () => {
    const db = fakeDb({
      memory_conflicts: [
        { id: "g1", kind: "duplicate", status: "open", similarity: 0.9, reason: null, members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") },
        { id: "g2", kind: "contradiction", status: "open", similarity: 0.8, reason: "r", members: JSON.stringify(["a", "gone"]), scanned_at: new Date("2026-10-03T10:00:00Z") },
      ],
      mem_items: [
        { id: "a", information: "A", type: "FACT", rights_mode: "public", created_by: "4", createdAt: new Date("2026-09-01T00:00:00Z") },
        { id: "b", information: "B", type: null, rights_mode: "public", created_by: null, createdAt: new Date("2026-09-02T00:00:00Z") },
      ],
      users: [{ id: 4, firstname: "Sara", lastname: "Kraus" }],
      memory_usages: [{ memory_id: "a", c: "3" }],
    });
    const out = await memoryConflicts({ db, context });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "g1", kind: "duplicate", similarity: 0.9, members: [
      { id: "a", information: "A", type: "FACT", author: { id: 4, name: "Sara Kraus" }, createdAt: "2026-09-01T00:00:00.000Z", usedCount: 3 },
      { id: "b", information: "B", type: null, author: null, usedCount: 0 },
    ] });
  });
  it("drops a member that is no longer public, and the group with it when fewer than two remain", async () => {
    const db = fakeDb({
      memory_conflicts: [{ id: "g1", kind: "duplicate", status: "open", similarity: 0.9, reason: null, members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }],
      mem_items: [{ id: "a", information: "A", rights_mode: "public" }, { id: "b", information: "B", rights_mode: "private" }],
      users: [], memory_usages: [],
    });
    expect(await memoryConflicts({ db, context })).toEqual([]);
  });
  it("counts open groups and distinct memories involved, dating the base by the scan's own marker", async () => {
    const groups = [{ members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }, { members: JSON.stringify(["b", "c", "d"]), scanned_at: new Date("2026-10-02T10:00:00Z") }];
    const marked = fakeDb({ memory_conflicts: groups, "memory_conflict_scans#first": [{ scanned_at: new Date("2026-10-03T12:30:00Z") }] });
    expect(await memoryConflictCounts({ db: marked, context })).toEqual({ open: 2, memoriesInvolved: 4, lastScanAt: "2026-10-03T12:30:00.000Z" });
    // No marker (a base last scanned before the table existed): the newest group the scan touched.
    expect(await memoryConflictCounts({ db: fakeDb({ memory_conflicts: groups }), context })).toEqual({ open: 2, memoriesInvolved: 4, lastScanAt: "2026-10-03T10:00:00.000Z" });
  });
  it("memoryConflictsForMemory returns the open groups containing the memory and the originals of a merge", async () => {
    const db = fakeDb({
      memory_conflicts: [{ id: "g1", kind: "duplicate", status: "open", similarity: 0.9, reason: null, members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }],
      "memory_conflicts#first": [{ id: "g9", members: JSON.stringify(["x", "y"]), merged_into: "a" }],
      mem_items: [
        { id: "a", information: "A", rights_mode: "public" }, { id: "b", information: "B", rights_mode: "public" },
        { id: "x", information: "X", rights_mode: "public", archived: true }, { id: "y", information: "Y", rights_mode: "public", archived: true },
      ],
      users: [], memory_usages: [],
    });
    const out = await memoryConflictsForMemory({ db, context, memoryId: "a" });
    expect(out.open.map((g) => g.id)).toEqual(["g1"]);
    expect(out.mergedFrom.map((m) => m.id)).toEqual(["x", "y"]);
  });
});
