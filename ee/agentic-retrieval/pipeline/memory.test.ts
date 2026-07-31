// ee/agentic-retrieval/pipeline/memory.test.ts
import { runMemoryPhase, clearMemoryItemCache } from "./memory";

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

beforeEach(() => { clearMemoryItemCache(); (generateText as jest.Mock).mockReset(); });

describe("runMemoryPhase", () => {
  it("returns a neutral result when memory is disabled", async () => {
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined,
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
      memoryContext: undefined, memoryConfig: allOn });
    expect(r.memoryChunksForAnswer).toHaveLength(1);
    expect(r.memoryChunksForAnswer[0]).toMatchObject({ chunk_id: "1", rerank_score: 1, context: { id: "memory" } });
  });

  it("activates the override only with overrides=true AND high confidence AND chunks", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { overrides: true, confidence: "medium", authoritativeChunkIds: ["1"], reason: "r" } })
      .mockResolvedValueOnce({ output: { shouldPrioritizeFiles: false } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: baseOpts.question, updatedRelevantKeywords: [], updatedImportantKeyword: "FST-2XT" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined, memoryConfig: allOn });
    expect(r.memoryOverride.active).toBe(false); // medium confidence blocks it
  });

  it("skips override/file/augmentation LLM calls when those features are off", async () => {
    (generateText as jest.Mock).mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined,
      memoryConfig: { enabled: true, override: false, filePrioritization: false, queryAugmentation: false } });
    expect(generateText).toHaveBeenCalledTimes(1); // relevance only
    expect(r.memoryOverride.active).toBe(false);
  });

  it("augmentation merges keywords but preserves the original important keyword", async () => {
    (generateText as jest.Mock)
      .mockResolvedValueOnce({ output: { relevantChunkIds: ["1"] } })
      .mockResolvedValueOnce({ output: { updatedUserQuestion: "expanded q", updatedRelevantKeywords: ["Feldbussteuerung"], updatedImportantKeyword: "SOMETHING-ELSE" } });
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "x")], memoryContext: undefined,
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
      memoryContext: undefined, documentContexts: [{ id: "docs" }],
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
    const r = await runMemoryPhase({ ...baseOpts, memoryChunks: [memChunk("1", "test")], memoryContext: undefined, memoryConfig: allOn });

    // Verify it returns a neutral result (original question preserved, no crash)
    expect(r).toBeDefined();
    expect(r.updatedQuestion).toBe(baseOpts.question);
  });
});
