import { multiQuerySearch, singleSearch } from "./multi-query";
import { UnknownFilterPathError } from "@SRC/graphql/utilities/convert-graphql-filter-operator-to-pg-query";

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

// Final review, Important 4: singleSearch's catch-all turns any failure into
// zero chunks, which is right for a search that broke and wrong for a filter
// that cannot be answered -- an undeclared json filter path degraded to an
// empty result the model reports as "there are none", the exact silence spec
// Part C exists to end. It is re-thrown so the pipeline's boundary can
// surface the refusal message instead.
describe("singleSearch and a refused json filter path", () => {
  it("re-throws UnknownFilterPathError instead of degrading it to zero chunks", async () => {
    const err = new UnknownFilterPathError("felder", ["konfidenz"], ["<key>.konfidenz"]);
    const ctx = { search: jest.fn().mockRejectedValue(err) };

    await expect(
      singleSearch({
        query: "q",
        config: { method: "hybridSearch", limit: 5 },
        user: {},
        role: "r",
        pinnedItemIds: [],
        context: ctx,
      }),
    ).rejects.toBe(err);
  });

  it("every OTHER failure is still swallowed into an empty result, exactly as before", async () => {
    const ctx = { search: jest.fn().mockRejectedValue(new Error("connection reset")) };

    await expect(
      singleSearch({
        query: "q",
        config: { method: "hybridSearch", limit: 5 },
        user: {},
        role: "r",
        pinnedItemIds: [],
        context: ctx,
      }),
    ).resolves.toEqual([]);
  });

  it("multiQuerySearch propagates it too -- one refused filter is refused for every query variation", async () => {
    const err = new UnknownFilterPathError("felder", ["konfidenz"], ["<key>.konfidenz"]);
    const ctx = { search: jest.fn().mockRejectedValue(err) };

    await expect(
      multiQuerySearch({
        queries: ["q1", "q2"],
        config: { method: "hybridSearch", limit: 5 },
        user: {},
        role: "r",
        pinnedItemIds: [],
        context: ctx,
      }),
    ).rejects.toBe(err);
  });
});
