jest.mock("@SRC/exulu/table-names", () => ({ getTableName: (id: string) => `${id}_items` }));
import { memoryConflictCounts, memoryConflicts, memoryConflictsForMemory } from "./memory-conflicts";

function fakeDb(t: Record<string, any[]>) {
  const db: any = jest.fn((table: string) => {
    const chain: any = {};
    for (const m of ["where", "whereIn", "whereNot", "orderBy", "select", "groupBy", "count", "max"]) chain[m] = () => chain;
    chain.first = async () => t[`${table}#first`]?.[0];
    chain.then = (res: any) => Promise.resolve(t[table] ?? []).then(res);
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
      mem_items: [{ id: "a", information: "A", type: "FACT", created_by: "4", createdAt: new Date("2026-09-01T00:00:00Z") }, { id: "b", information: "B", type: null, created_by: null, createdAt: new Date("2026-09-02T00:00:00Z") }],
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
  it("counts open groups and distinct memories involved, with the last scan time", async () => {
    const db = fakeDb({ memory_conflicts: [{ members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }, { members: JSON.stringify(["b", "c", "d"]), scanned_at: new Date("2026-10-02T10:00:00Z") }] });
    expect(await memoryConflictCounts({ db, context })).toEqual({ open: 2, memoriesInvolved: 4, lastScanAt: "2026-10-03T10:00:00.000Z" });
  });
  it("memoryConflictsForMemory returns the open groups containing the memory and the originals of a merge", async () => {
    const db = fakeDb({
      memory_conflicts: [{ id: "g1", kind: "duplicate", status: "open", similarity: 0.9, reason: null, members: JSON.stringify(["a", "b"]), scanned_at: new Date("2026-10-03T10:00:00Z") }],
      "memory_conflicts#first": [{ id: "g9", members: JSON.stringify(["x", "y"]), merged_into: "a" }],
      mem_items: [{ id: "a", information: "A" }, { id: "b", information: "B" }, { id: "x", information: "X", archived: true }, { id: "y", information: "Y", archived: true }],
      users: [], memory_usages: [],
    });
    const out = await memoryConflictsForMemory({ db, context, memoryId: "a" });
    expect(out.open.map((g) => g.id)).toEqual(["g1"]);
    expect(out.mergedFrom.map((m) => m.id)).toEqual(["x", "y"]);
  });
});
