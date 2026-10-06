// ee/agentic-retrieval/pipeline/memory.test.ts
import { runMemoryPhase } from "./memory";

jest.mock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: jest.fn(),
  Output: { object: (x: any) => x },
}));
jest.mock("./multi-query", () => ({ singleSearch: jest.fn(async () => []) }));
jest.mock("./prefilter", () => ({ fuzzyPrefilter: jest.fn(async () => []) }));
import { generateText } from "ai";
import { fuzzyPrefilter } from "./prefilter";

const memChunk = (id: string, content: string) => ({
  chunk_id: id, chunk_content: content, chunk_index: 1, item_id: "m" + id, item_name: "Memory " + id,
}) as any;
const baseOpts = {
  question: "How do I bypass the door contact on the FST-2XT?",
  keywords: ["door"], importantKeyword: "FST-2XT", user: {}, role: "r", model: {},
  glossary: [{ term: "FST", meaning: "field bus controller" }],
  documentContexts: [],
};
const allOn = { enabled: true, override: true, filePrioritization: true, queryAugmentation: true };

beforeEach(() => { (generateText as jest.Mock).mockReset(); });

describe("runMemoryPhase", () => {
  it("returns a neutral result when memory is disabled", async () => {
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")],
      memoryConfig: { ...allOn, enabled: false } });
    expect(r.memoryChunksForAnswer).toEqual([]);
    expect(r.updatedQuestion).toBe(baseOpts.question);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("marks relevant chunks citable with synthetic score 1 and memory context", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })       // relevance
      .mockResolvedValueOnce({ output: { overrides: false, confidence: "low", authoritativeChunkIds: [], reason: "" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false, fileNameHints: [] } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [], updatedImportantKeyword: "FST-2XT" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "hint"), memChunk("2", "other")],
      memoryConfig: allOn });
    expect(r.memoryChunksForAnswer).toHaveLength(1);
    expect(r.memoryChunksForAnswer[0]).toMatchObject({ chunk_id: "1", rerank_score: 1, context: { id: "memory" } });
  });

  it("keeps the relevance step's text to item names/ids and a count, never the raw chunk_content (no second copy of the memory in the serialized tool result)", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1", "2"] } })
      .mockResolvedValueOnce({ output: { overrides: false, confidence: "low", authoritativeChunkIds: [], reason: "" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false, fileNameHints: [] } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [], updatedImportantKeyword: "FST-2XT" } });
    const r = await runMemoryPhase({
      ...baseOpts,
      memoryChunks: [memChunk("1", "SECRET-CHUNK-CONTENT-ONE"), memChunk("2", "SECRET-CHUNK-CONTENT-TWO")],
      memoryConfig: allOn,
    });
    const relevanceStep = r.steps.find((s) => s.text.includes("Retrieved"));
    expect(relevanceStep?.text).toContain("2 potentially relevant memories");
    expect(relevanceStep?.text).toContain("Memory 1 (m1)");
    expect(relevanceStep?.text).toContain("Memory 2 (m2)");
    expect(relevanceStep?.text).not.toContain("SECRET-CHUNK-CONTENT");
  });

  it("activates the override only with overrides=true AND high confidence AND chunks", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { overrides: true, confidence: "medium", authoritativeChunkIds: ["1"], reason: "r" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [], updatedImportantKeyword: "FST-2XT" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryConfig: allOn });
    expect(r.memoryOverride.active).toBe(false); // medium confidence blocks it
  });

  it("skips override/file/augmentation LLM calls when those features are off", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")],
      memoryConfig: { enabled: true, override: false, filePrioritization: false, queryAugmentation: false } });
    expect(generateText).toHaveBeenCalledTimes(1); // relevance only
    expect(r.memoryOverride.active).toBe(false);
  });

  it("augmentation merges keywords but preserves the original important keyword", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: "expanded q", updatedRelevantKeywords: ["Feldbussteuerung"], updatedImportantKeyword: "SOMETHING-ELSE" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")],
      memoryConfig: { enabled: true, override: false, filePrioritization: false, queryAugmentation: true } });
    expect(r.updatedQuestion).toBe("expanded q");
    expect(r.updatedKeywords).toEqual(expect.arrayContaining(["door", "feldbussteuerung"]));
    expect(r.updatedImportantKeyword).toBe("FST-2XT");
  });

  it("resolves file-prioritization pins keyed by their document context", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: true, fileNameHints: ["PROJECT_NOTES"] } });
    (fuzzyPrefilter as jest.Mock).mockResolvedValue([{ id: "d1", name: "Project Notes", key: "k" }]);
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "always check PROJECT_NOTES")],
      documentContexts: [{ id: "docs" }],
      memoryConfig: { enabled: true, override: false, filePrioritization: true, queryAugmentation: false } });
    // Pins are keyed by the context they were resolved in, so a consumer can apply them
    // only to that context (no cross-context leak). See search.ts rule 2b.
    expect([...(r.memoryPinnedItemIdsByContext.get("docs") ?? [])]).toEqual(["d1"]);
  });

  it("never throws even when post-Promise.all processing encounters runtime errors", async () => {
    // Mock relevance check to succeed
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      // Mock override check
      .mockResolvedValueOnce({ output: { overrides: false, confidence: "low", authoritativeChunkIds: [], reason: "" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false, fileNameHints: [] } })
      // Mock query augmentation: return malformed keywords (non-strings) that will fail during trim()
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [{ bad: "object" } as any], updatedImportantKeyword: "FST-2XT" } });

    // This should resolve without throwing, returning a neutral result despite the runtime error in keyword merge
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "test")], memoryConfig: allOn });

    // Verify it returns a neutral result (original question preserved, no crash)
    expect(r).toBeDefined();
    expect(r.updatedQuestion).toBe(baseOpts.question);
  });

  it("runMemoryPhase judges only the chunks it is given and never searches", async () => {
    const search = jest.fn();
    const r = await runMemoryPhase({
      memoryChunks: [], question: "q", keywords: ["k"], importantKeyword: "k", user: { id: 1 }, role: "r",
      model: {} as never, memoryConfig: { enabled: true, override: true, filePrioritization: true, queryAugmentation: true },
      glossary: [], documentContexts: [{ id: "docs", search } as never],
    });
    expect(search).not.toHaveBeenCalled();
    expect(r.memoryChunksForAnswer).toEqual([]);
    expect(r.memoryOverride.active).toBe(false);
  });
});

describe("runMemoryPhase with mergedCall (engine v2)", () => {
  const merged = (over: Partial<any> = {}) => ({ output: {
    relevantChunkIds: ["1"],
    override: { overrides: true, confidence: "high", authoritativeChunkIds: ["1"], reason: "direct answer" },
    filePrioritization: { shouldPrioritizeFiles: false, fileNameHints: [] },
    augmentation: { updatedUserQuestion: baseOpts.question + " (Türkontakt)", updatedRelevantKeywords: ["türkontakt"], updatedImportantKeyword: "FST-2XT" },
    ...over,
  } });

  it("asks the model once and produces the same result shape as the four v1 hops", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(merged());
    const r = await runMemoryPhase({ ...baseOpts, mergedCall: true, memoryChunks: [memChunk("1", "hint"), memChunk("2", "other")],
      memoryConfig: allOn });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(r.memoryChunksForAnswer.map((c) => c.chunk_id)).toEqual(["1"]);
    expect(r.memoryOverride).toMatchObject({ active: true, reason: "direct answer" });
    expect(r.memoryOverride.chunks.map((c) => c.chunk_id)).toEqual(["1"]);
    expect(r.updatedQuestion).toBe(baseOpts.question + " (Türkontakt)");
    expect(r.updatedKeywords).toEqual(["door", "türkontakt"]);
    expect(r.updatedImportantKeyword).toBe("FST-2XT"); // original always preserved
  });

  it("ignores override/file/augmentation parts of the answer when those features are off", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(merged());
    const r = await runMemoryPhase({ ...baseOpts, mergedCall: true, memoryChunks: [memChunk("1", "hint")],
      memoryConfig: { enabled: true, override: false, filePrioritization: false, queryAugmentation: false } });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(r.memoryOverride.active).toBe(false);
    expect(r.updatedQuestion).toBe(baseOpts.question);
    expect(r.updatedKeywords).toEqual(["door"]);
  });

  it("treats no relevant chunks as a neutral result even if the model filled the other parts", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce(merged({ relevantChunkIds: [] }));
    const r = await runMemoryPhase({ ...baseOpts, mergedCall: true, memoryChunks: [memChunk("1", "hint")], memoryConfig: allOn });
    expect(r.memoryChunksForAnswer).toEqual([]);
    expect(r.memoryOverride.active).toBe(false);
    expect(r.updatedQuestion).toBe(baseOpts.question);
  });
});
