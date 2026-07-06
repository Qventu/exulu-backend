import { multiQuerySearch, singleSearch } from "./multi-query";

const chunk = (id: string, score = 1) => ({
  chunk_id: id,
  chunk_content: id,
  chunk_index: 1,
  item_id: "i" + id,
  item_name: "n" + id,
  chunk_hybrid_score: score,
});

describe("multiQuerySearch", () => {
  it("merges result sets with RRF; chunks in multiple sets rank first", async () => {
    // Chunk "a" has the LOWEST hybrid score (0.2) but appears in BOTH result sets,
    // so it must have the highest RRF score. A sort by chunk_hybrid_score would
    // incorrectly place "b" or "c" first.
    const ctx = {
      search: jest
        .fn()
        .mockResolvedValueOnce({ chunks: [chunk("a", 0.2), chunk("b", 1.0)] })
        .mockResolvedValueOnce({ chunks: [chunk("c", 1.0), chunk("a", 0.2)] }),
    };
    const merged = await multiQuerySearch({
      queries: ["q1", "q2"],
      config: { method: "hybridSearch", limit: 10 },
      user: {},
      role: "r",
      pinnedItemIds: [],
      context: ctx,
    });
    expect(merged[0].chunk_id).toBe("a"); // appears in both sets → highest RRF
    expect(merged).toHaveLength(3);
    expect(ctx.search).toHaveBeenCalledTimes(2);
    // rrf_score must be propagated and correctly ordered
    expect(merged[0].rrf_score).toBeDefined();
    expect(merged[0].rrf_score).toBeGreaterThan(merged[1].rrf_score);
  });

  it("passes pinned item ids as an id filter", async () => {
    const ctx = { search: jest.fn().mockResolvedValue({ chunks: [] }) };
    await singleSearch({
      query: "q",
      config: { method: "hybridSearch", limit: 5 },
      user: {},
      role: "r",
      pinnedItemIds: ["x"],
      context: ctx,
    });
    expect(ctx.search.mock.calls[0][0].itemFilters).toEqual([{ id: { in: ["x"] } }]);
  });
});
