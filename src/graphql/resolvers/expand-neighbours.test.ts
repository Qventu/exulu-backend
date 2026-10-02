import { planNeighbourFetch, mergeNeighbours } from "./expand-neighbours";

const hit = (item_id: string, chunk_index: number) => ({ item_id, chunk_index } as any);

describe("planNeighbourFetch — which neighbouring chunks a result expansion needs", () => {
  it("collects before/after indices per item, skips negatives and chunks already in the result set", () => {
    const plan = planNeighbourFetch([hit("A", 1), hit("A", 2), hit("B", 0)], { before: 2, after: 1 });
    expect(plan.get("A")).toEqual(new Set([0, 3]));
    expect(plan.get("B")).toEqual(new Set([1]));
  });

  it("returns an empty plan when expansion is off", () => {
    expect(planNeighbourFetch([hit("A", 5)], { before: 0, after: 0 }).size).toBe(0);
  });

  it("deduplicates overlapping windows so each neighbour is fetched once", () => {
    const plan = planNeighbourFetch([hit("A", 10), hit("A", 12)], { before: 3, after: 3 });
    expect([...plan.get("A")!].sort((a, b) => a - b)).toEqual([7, 8, 9, 11, 13, 14, 15]);
  });
});

describe("mergeNeighbours — fetched rows are attached to their result item and ordered by index", () => {
  it("keeps the original hits, adds only planned neighbours, and sorts per item by chunk_index", () => {
    const results = [{ ...hit("A", 2), chunk_id: "a2", item_name: "Doc A", item_external_id: "x", item_created_at: "c", item_updated_at: "u", chunk_content: "two" }] as any[];
    const rows = [
      { id: "a1", source: "A", chunk_index: 1, content: "one", metadata: {}, createdAt: "c1", updatedAt: "u1" },
      { id: "a9", source: "A", chunk_index: 9, content: "nine", metadata: {}, createdAt: "c9", updatedAt: "u9" }, // not planned
      { id: "a3", source: "A", chunk_index: 3, content: "three", metadata: {}, createdAt: "c3", updatedAt: "u3" },
    ];
    const plan = new Map([["A", new Set([1, 3])]]);
    const merged = mergeNeighbours(results, rows, plan, { name: "Doc", id: "ctx" });
    expect(merged.map((c) => c.chunk_index)).toEqual([1, 2, 3]);
    expect(merged[0]).toMatchObject({ chunk_id: "a1", chunk_content: "one", item_name: "Doc A", item_id: "A", chunk_hybrid_score: 0, context: { id: "ctx", name: "Doc" } });
  });
});
