import { splitChunksIntoGroups, rerankResults } from "./rerank";

const chunk = (id: string, itemId: string, index: number, extra: any = {}) => ({
  chunk_id: id, item_id: itemId, item_name: "item " + itemId, chunk_index: index,
  chunk_content: "c" + id, chunk_hybrid_score: 1, ...extra,
}) as any;
const state = (over: Partial<any> = {}) => ({
  pinnedItemIds: new Set<string>(), userPinnedItemIds: new Set<string>(),
  userRequestedPage: null, keywords: [], importantKeyword: "", ...over,
});
const tuning = { topK: 5, pinBoost: 0.15, identifierBoost: 0.15, pageWindow: 1 };

describe("splitChunksIntoGroups", () => {
  it("returns empty for empty input", () => {
    expect(splitChunksIntoGroups([])).toEqual([]);
  });

  it("splits at index gaps and at 10 chunks", () => {
    const run = Array.from({ length: 12 }, (_, i) => chunk("a" + i, "A", i + 1));
    expect(splitChunksIntoGroups(run).map((g) => g.length)).toEqual([10, 2]);
    const gap = [chunk("b1", "B", 1), chunk("b2", "B", 5)];
    expect(splitChunksIntoGroups(gap)).toHaveLength(2);
  });

  it("groups consecutive chunks together", () => {
    const chunks = [chunk("x1", "X", 0), chunk("x2", "X", 1), chunk("x3", "X", 2)];
    const groups = splitChunksIntoGroups(chunks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });
});

describe("rerankResults", () => {
  it("reranks, applies pin boost, limits to topK, reports genuine max before boosts", async () => {
    const chunks = Array.from({ length: 8 }, (_, i) => chunk("c" + i, "I" + i, 1));
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it, i) => ({ ...it, rerank_score: 0.8 - i * 0.05 }))) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state({ pinnedItemIds: new Set(["I7"]) }), reranker, tuning });
    expect(r.rerank_score_max_genuine).toBeCloseTo(0.8);
    expect(r.limited_results.some((c: any) => c.item_id === "I7")).toBe(true);
    expect(r.limited_results.length).toBe(6);
    const pinned = r.sorted_reranked_results.find((c: any) => c.item_id === "I7");
    expect(pinned!.rerank_score).toBeCloseTo(0.8 - 7 * 0.05 + 0.15);
  });

  it("caps force-included pinned groups at topK (token-bomb regression)", async () => {
    // 30 pinned items — an unbounded force-include would return 30+ groups.
    const chunks = Array.from({ length: 30 }, (_, i) => chunk("c" + i, "P" + i, 1));
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it, i) => ({ ...it, rerank_score: 0.9 - i * 0.01 }))) } as any;
    const r = await rerankResults({
      chunks, query: "q",
      state: state({ pinnedItemIds: new Set(Array.from({ length: 30 }, (_, i) => "P" + i)) }),
      reranker, tuning,
    });
    expect(r.limited_results.length).toBeLessThanOrEqual(2 * tuning.topK);
    // The best-scoring pinned groups survive the cap
    expect(r.limited_results.some((c: any) => c.item_id === "P0")).toBe(true);
  });

  it("boosts items whose name matches an identifier token", async () => {
    const chunks = [chunk("c1", "A", 1), chunk("c2", "B", 1)];
    chunks[1].item_name = "hb_FST-2XT_manual";
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it) => ({ ...it, rerank_score: 0.5 }))) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state({ importantKeyword: "FST-2XT" }), reranker, tuning });
    expect(r.sorted_reranked_results[0].item_name).toBe("hb_FST-2XT_manual");
  });

  it("filters to the requested page window when a page was asked for", async () => {
    const chunks = [
      chunk("c1", "A", 1, { chunk_metadata: { page: 12 } }),
      chunk("c2", "A", 2, { chunk_metadata: { page: 40 } }),
    ];
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it) => ({ ...it, rerank_score: 0.5 }))) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state({ userRequestedPage: 12 }), reranker, tuning });
    expect(r.limited_results).toHaveLength(1);
    expect((r.limited_results[0] as any).chunk_metadata.page).toBe(12);
  });

  it("without a reranker falls back to hybrid-score ordering with genuine max 0", async () => {
    const chunks = [chunk("c1", "A", 1, { chunk_hybrid_score: 0.2 }), chunk("c2", "B", 1, { chunk_hybrid_score: 0.9 })];
    const r = await rerankResults({ chunks, query: "q", state: state(), reranker: undefined, tuning });
    expect(r.sorted_reranked_results[0].chunk_id).toBe("c2");
    expect(r.rerank_score_max_genuine).toBe(0);
  });

  it("treats an empty rerank response for non-empty input as the fallback ordering", async () => {
    const chunks = [chunk("c1", "A", 1)];
    const reranker = { model: "m", rerank: jest.fn(async () => []) } as any;
    const r = await rerankResults({ chunks, query: "q", state: state(), reranker, tuning });
    expect(r.sorted_reranked_results).toHaveLength(1);
    expect(r.rerank_score_max_genuine).toBe(0);
    expect((r.sorted_reranked_results[0] as any).rerank_score).toBeUndefined();
  });

  it("returns empty result for empty chunk input", async () => {
    const r = await rerankResults({ chunks: [], query: "q", state: state(), reranker: undefined, tuning });
    expect(r.limited_results).toHaveLength(0);
    expect(r.sorted_reranked_results).toHaveLength(0);
    expect(r.rerank_score_max_genuine).toBe(0);
  });

  it("merges consecutive chunks from the same item before reranking", async () => {
    const chunks = [
      chunk("c1", "A", 0, { chunk_content: "hello" }),
      chunk("c2", "A", 1, { chunk_content: "world" }),
    ];
    const reranker = { model: "m", rerank: jest.fn(async (_q: string, items: any[]) =>
      items.map((it) => ({ ...it, rerank_score: 0.5 }))) } as any;
    await rerankResults({ chunks, query: "q", state: state(), reranker, tuning });
    const passedItems: any[] = reranker.rerank.mock.calls[0][1];
    expect(passedItems).toHaveLength(1);
    expect(passedItems[0].chunk_content).toBe("hello\nworld");
  });
});
