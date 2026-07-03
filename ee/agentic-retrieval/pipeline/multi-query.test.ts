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
    const ctx = {
      search: jest
        .fn()
        .mockResolvedValueOnce({ chunks: [chunk("a"), chunk("b")] })
        .mockResolvedValueOnce({ chunks: [chunk("c"), chunk("a")] }),
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
