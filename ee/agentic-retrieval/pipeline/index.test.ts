// ee/agentic-retrieval/pipeline/index.test.ts
import { createAgenticRetrievalTool, parsePreselectedItems } from "./index";

jest.mock("@EE/entitlements", () => ({ checkLicense: () => ({ "agentic-retrieval": true }) }));
jest.mock("@SRC/exulu/resolve-reranker", () => ({ resolveReranker: jest.fn(async () => ({ model: "m", rerank: async (_q: any, c: any) => c })) }));
jest.mock("@SRC/exulu/resolve-model", () => ({ resolveModel: jest.fn() }));
jest.mock("@SRC/exulu/app/singleton", () => ({ exuluApp: { get: () => ({}) } }));
jest.mock("./routing", () => ({ runRoutingPhase: jest.fn(async () => ({
  mainContexts: ["docs"], fallbackContexts: [], userPinnedItemIdsByContext: new Map(),
  userRequestedPage: null, hasExplicitDocAndPage: false, steps: [{ text: "routed" }] })) }));
jest.mock("./memory", () => ({ runMemoryPhase: jest.fn(async () => ({
  memoryChunksForAnswer: [], memoryOverride: { active: false, chunks: [], reason: "" },
  memoryPinnedItemIdsByContext: new Map(), updatedQuestion: "q", updatedKeywords: ["k"],
  updatedImportantKeyword: "k", steps: [] })) }));
jest.mock("./prefilter", () => ({ resolveIdentifierPins: jest.fn(async () => ({
  pinsByContext: new Map(), exactPinsByContext: new Map(), steps: [] })) }));
jest.mock("./search", () => ({ searchContexts: jest.fn(async () => ({ chunks: [] })) }));
jest.mock("./rerank", () => ({ rerankResults: jest.fn(async () => ({
  limited_results: [], sorted_reranked_results: [], rerank_score_max_genuine: 1 })) }));

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const v of gen) out.push(v);
  return out;
};
const ctx = (id: string) => ({ id, name: id, description: "", configuration: {} }) as any;
const makeTool = (config?: Record<string, unknown>, extra: any = {}) => {
  const tool = createAgenticRetrievalTool({ contexts: [ctx("docs"), ctx("tickets")], model: {} as any, ...extra })!;
  const exec = (tool.tool as any).execute as (i: any, o?: any) => AsyncGenerator<any>;
  return (inputs: any) => exec({ toolVariablesConfig: config ?? {}, ...inputs });
};
const inputs = { userQuery: "q", relevantKeywords: ["k"], importantKeyword: "k" };

describe("createAgenticRetrievalTool", () => {
  it("declares the static config surface (no per-context keys)", () => {
    const tool = createAgenticRetrievalTool({ contexts: [ctx("docs")], model: {} as any })!;
    const names = tool.config.map((c) => c.name).sort();
    expect(names).toEqual([
      "instructions", "knowledge_bases", "logging", "managed_context", "memory",
      "max_steps", "project_search", "require_preselected_contexts", "reranker",
      "routing", "show_sources_to_external_users", "tuning", "utility_model", "vocabulary",
    ].sort());
    expect(tool.config.filter((c) => c.type === "json").map((c) => c.name).sort())
      .toEqual(["knowledge_bases", "memory", "routing", "tuning", "vocabulary"].sort());
    expect(tool.id).toBe("agentic_context_search");
  });

  it("short-circuits managed_context without preselected items", async () => {
    const run = makeTool({ managed_context: true });
    const out = await drain(run(inputs));
    expect(out[out.length - 1].result).toContain("preselect");
  });

  it("yields a message (not a throw) when requested KBs fall outside the preselection", async () => {
    const { runRoutingPhase } = jest.requireMock("./routing");
    runRoutingPhase.mockResolvedValueOnce({
      mainContexts: ["tickets"], fallbackContexts: [], userPinnedItemIdsByContext: new Map(),
      userRequestedPage: null, hasExplicitDocAndPage: false, steps: [] });
    const run = makeTool({}, { preselected: ["docs/item1"] });
    const out = await drain(run(inputs));
    expect(out[out.length - 1].result).toContain("not part of the preselected");
  });

  it("streams cumulative AgenticRetrievalOutput snapshots and runs the full pipeline", async () => {
    const run = makeTool({});
    const out = await drain(run(inputs));
    expect(out.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(out[out.length - 1].result);
    expect(last).toMatchObject({ steps: expect.any(Array), reasoning: expect.any(Array), chunks: [] });
    expect(last.steps.map((s: any) => s.text)).toContain("routed");
  });

  it("accumulates top-level chunks across memory, main, and fallback evidence", async () => {
    const { runMemoryPhase } = jest.requireMock("./memory");
    const { rerankResults } = jest.requireMock("./rerank");
    runMemoryPhase.mockResolvedValueOnce({
      memoryChunksForAnswer: [{ chunk_id: "m1" }],
      memoryOverride: { active: false, chunks: [], reason: "" },
      memoryPinnedItemIdsByContext: new Map(),
      updatedQuestion: "q",
      updatedKeywords: ["k"],
      updatedImportantKeyword: "k",
      steps: [],
    });
    rerankResults.mockResolvedValueOnce({
      limited_results: [{ chunk_id: "r1" }, { chunk_id: "m1" }],
      sorted_reranked_results: [],
      rerank_score_max_genuine: 1,
    });
    const run = makeTool({});
    const out = await drain(run(inputs));
    const last = JSON.parse(out[out.length - 1].result);
    const ids = last.chunks.map((c: any) => c.chunk_id);
    expect(ids).toContain("m1");
    expect(ids).toContain("r1");
    // dedup: "m1" appears in both memory and rerank results but must appear only once
    expect(ids.filter((id: string) => id === "m1").length).toBe(1);
  });

  it("filters contexts by knowledge_bases enabled=false", async () => {
    const { searchContexts } = jest.requireMock("./search");
    const { runRoutingPhase } = jest.requireMock("./routing");
    const run = makeTool({ knowledge_bases: { tickets: { enabled: false } } });
    await drain(run(inputs));
    const routingCall = runRoutingPhase.mock.calls[runRoutingPhase.mock.calls.length - 1][0];
    expect(routingCall.enabledContexts.map((c: any) => c.id)).toEqual(["docs"]);
    expect(searchContexts).toHaveBeenCalled();
  });
});

describe("payload deduplication", () => {
  it("strips chunk_content from step chunks in the serialized payload; top-level keeps it", async () => {
    // Memory chunks are no longer copied into the top-level `chunks` (spec §3.1,
    // "recall once" — the model already holds them via the system prompt), so the
    // memory step here only exercises the per-step content-stripping half of
    // dedup; the top-level-keeps-content half is exercised via a main search
    // chunk, whose path into result.chunks is unchanged.
    const { runMemoryPhase } = jest.requireMock("./memory");
    const { rerankResults } = jest.requireMock("./rerank");
    const memChunk = { chunk_id: "m1", chunk_content: "FULL MEMORY CONTENT", item_id: "i1", item_name: "Mem" };
    runMemoryPhase.mockResolvedValueOnce({
      memoryChunksForAnswer: [memChunk],
      memoryOverride: { active: false, chunks: [], reason: "" },
      memoryPinnedItemIdsByContext: new Map(), updatedQuestion: "q", updatedKeywords: ["k"],
      updatedImportantKeyword: "k",
      steps: [{ text: "memory step", chunks: [memChunk] }],
    });
    const mainChunk = { chunk_id: "r1", chunk_content: "FULL MAIN CONTENT", item_id: "i2", item_name: "Doc" };
    rerankResults.mockResolvedValueOnce({
      limited_results: [mainChunk],
      sorted_reranked_results: [],
      rerank_score_max_genuine: 1,
    });
    const run = makeTool({});
    const out = await drain(run(inputs));
    const last = JSON.parse(out[out.length - 1].result);
    const stepWithChunks = last.steps.find((s: any) => s.chunks?.length > 0);
    expect(stepWithChunks).toBeDefined();
    expect(stepWithChunks.chunks[0].chunk_content).toBeUndefined();
    expect(stepWithChunks.chunks[0].item_name).toBe("Mem");
    const topLevel = last.chunks.find((c: any) => c.chunk_id === "r1");
    expect(topLevel).toBeDefined();
    expect(topLevel.chunk_content).toBe("FULL MAIN CONTENT");
    // Memory chunks no longer reach the top-level chunk list on their own.
    expect(last.chunks.find((c: any) => c.chunk_id === "m1")).toBeUndefined();
  });
});

describe("source visibility for external / anonymous users", () => {
  const SOURCE_FIELDS = ["item_id", "item_name", "item_external_id", "context", "chunk_id", "chunk_index"];
  const richChunk = {
    chunk_id: "c1", chunk_index: 3, chunk_content: "SECRET PASSAGE",
    item_id: "i1", item_name: "Handbook.pdf", item_external_id: "ext-1", context: "docs",
  };
  const internalUser = { id: "u1", role: { name: "admin" } } as any;
  const externalUser = { id: "u2", role: { name: "external" } } as any;

  /**
   * Seed both phases so a fully-populated chunk reaches the top-level list AND
   * a step.
   *
   * The main search is what puts a chunk in `result.chunks`. Seeding only the
   * memory phase used to be enough, because memory chunks were copied into
   * that list — they no longer are ("recall once", asserted by the payload
   * deduplication suite above), so a memory-only fixture leaves the top-level
   * list empty and every assertion on `last.chunks[0]` reads undefined.
   * Stripping itself is indifferent to where a chunk came from.
   */
  const seedRichChunk = () => {
    jest.requireMock("./memory").runMemoryPhase.mockResolvedValueOnce({
      memoryChunksForAnswer: [richChunk],
      memoryOverride: { active: false, chunks: [], reason: "" },
      memoryPinnedItemIdsByContext: new Map(), updatedQuestion: "q", updatedKeywords: ["k"],
      updatedImportantKeyword: "k",
      steps: [{ text: "memory step", chunks: [richChunk] }],
    });
    jest.requireMock("./rerank").rerankResults.mockResolvedValueOnce({
      limited_results: [richChunk],
      sorted_reranked_results: [],
      rerank_score_max_genuine: 1,
    });
  };

  const lastPayload = async (config: Record<string, unknown>, user: any) => {
    seedRichChunk();
    const out = await drain(makeTool(config, { user })(inputs));
    return JSON.parse(out[out.length - 1].result);
  };

  it("strips source references for an external user when the flag is off", async () => {
    const last = await lastPayload({ show_sources_to_external_users: false }, externalUser);
    const topLevel = last.chunks[0];
    expect(topLevel).toBeDefined();
    for (const f of SOURCE_FIELDS) expect(topLevel[f]).toBeUndefined();
    // the passage text itself still reaches the model — only the attribution is removed
    expect(topLevel.chunk_content).toBe("SECRET PASSAGE");
    const stepChunk = last.steps.find((s: any) => s.chunks?.length > 0).chunks[0];
    for (const f of SOURCE_FIELDS) expect(stepChunk[f]).toBeUndefined();
  });

  it("strips source references for an anonymous guest when the flag is off", async () => {
    const last = await lastPayload({ show_sources_to_external_users: false }, undefined);
    for (const f of SOURCE_FIELDS) expect(last.chunks[0][f]).toBeUndefined();
  });

  it("keeps source references for an internal user even when the flag is off", async () => {
    const last = await lastPayload({ show_sources_to_external_users: false }, internalUser);
    expect(last.chunks[0].item_name).toBe("Handbook.pdf");
    expect(last.chunks[0].chunk_id).toBe("c1");
  });

  it("keeps source references for external users when the flag is on", async () => {
    const last = await lastPayload({ show_sources_to_external_users: true }, externalUser);
    expect(last.chunks[0].item_name).toBe("Handbook.pdf");
  });

  it("defaults to showing sources when the flag is unset (backward compatible)", async () => {
    const last = await lastPayload({}, externalUser);
    expect(last.chunks[0].item_name).toBe("Handbook.pdf");
    expect(last.chunks[0].chunk_id).toBe("c1");
  });

  it("still strips chunk_content from step chunks when sources are hidden", async () => {
    const last = await lastPayload({ show_sources_to_external_users: false }, externalUser);
    const stepChunk = last.steps.find((s: any) => s.chunks?.length > 0).chunks[0];
    expect(stepChunk.chunk_content).toBeUndefined();
  });
});

describe("parsePreselectedItems", () => {
  it("parses ctx/item pairs and whole-context entries (null wins)", () => {
    const m = parsePreselectedItems(["a/1", "a/2", "b", "b/3"]);
    expect(m.get("a")).toEqual(["1", "2"]);
    expect(m.get("b")).toBeNull();
  });
});

describe("projectScope factory surface", () => {
  it("declares the project_search config option with default true", () => {
    const tool = createAgenticRetrievalTool({ contexts: [], user: undefined, role: undefined, model: undefined });
    const entry = tool!.config.find((c: { name: string }) => c.name === "project_search");
    expect(entry).toBeDefined();
    expect(entry!.type).toBe("boolean");
    expect(entry!.default).toBe(true);
  });

  it("mentions the attached project in the tool description", () => {
    const tool = createAgenticRetrievalTool({
      contexts: [],
      user: undefined,
      role: undefined,
      model: undefined,
      projectScope: { id: "p1", name: "Modernization", items: ["docs/i1"] },
    });
    expect(tool!.description).toContain('project "Modernization"');
  });
});

describe("projectScope execute-level wiring", () => {
  beforeEach(() => {
    jest.requireMock("./routing").runRoutingPhase.mockClear();
    jest.requireMock("./search").searchContexts.mockClear();
    jest.requireMock("./rerank").rerankResults.mockClear();
    // Restore routing default (some tests override it with mockResolvedValueOnce)
    jest.requireMock("./routing").runRoutingPhase.mockResolvedValue({
      mainContexts: ["docs"], fallbackContexts: [], userPinnedItemIdsByContext: new Map(),
      userRequestedPage: null, hasExplicitDocAndPage: false, steps: [{ text: "routed" }],
    });
  });

  it("gate-off: project_search:false suppresses project instructions, context append, and scopedItemsByContext", async () => {
    const { runRoutingPhase } = jest.requireMock("./routing");
    const { searchContexts } = jest.requireMock("./search");
    const run = makeTool(
      { project_search: false },
      { projectScope: { id: "p1", name: "MyProject", customInstructions: "Do X", items: ["tickets/item1"] } },
    );
    const out = await drain(run(inputs));
    // No "Including sources from project" step text in final output
    const lastParsed = JSON.parse(out[out.length - 1].result);
    expect(lastParsed.steps.every((s: any) => !s.text.includes("Including sources from project"))).toBe(true);
    // Routing must NOT receive project custom instructions
    const routingCall = runRoutingPhase.mock.calls[runRoutingPhase.mock.calls.length - 1][0];
    expect(routingCall.extraInstructions ?? "").not.toContain("Instructions for the attached project");
    // searchContexts must not receive any scopedItemsByContext entries
    const mainSearchCall = searchContexts.mock.calls[0][0];
    const scoped: Map<string, unknown> | undefined = mainSearchCall.scopedItemsByContext;
    expect(scoped == null || scoped.size === 0).toBe(true);
  });

  it("case-2: enabled-context project items boost rerank pins; non-enabled context is appended and item-scoped", async () => {
    const { searchContexts } = jest.requireMock("./search");
    const { rerankResults } = jest.requireMock("./rerank");
    // tickets disabled in agent config so the project adds it as a scoped source
    const run = makeTool(
      { knowledge_bases: { tickets: { enabled: false } } },
      {
        projectScope: {
          id: "p1",
          name: "MyProject",
          customInstructions: "Always cite sources",
          items: ["docs/item1", "tickets/item2"],
        },
      },
    );
    const out = await drain(run(inputs));
    const lastParsed = JSON.parse(out[out.length - 1].result);
    // Step announces the appended project context
    expect(lastParsed.steps.some((s: any) => s.text.includes("Including sources from project"))).toBe(true);
    // Main searchContexts call gets the appended context id
    const mainSearchCall = searchContexts.mock.calls[0][0];
    expect(mainSearchCall.contextIds).toContain("tickets");
    // scopedItemsByContext carries the non-enabled context's item ids
    const scoped: Map<string, string[] | null> = mainSearchCall.scopedItemsByContext;
    expect(scoped).toBeDefined();
    expect(scoped.get("tickets")).toEqual(["item2"]);
    // Rerank receives pinnedItemIds that include the enabled context's project item
    const rerankCall = rerankResults.mock.calls[0][0];
    expect(rerankCall.state.pinnedItemIds.has("item1")).toBe(true);
  });
});

describe("phase timings", () => {
  it("records how long the retrieval phases took as a step, so latency can be read from the stored tool result", async () => {
    const run = makeTool({});
    const out = await drain(run(inputs));
    const last = JSON.parse(out[out.length - 1].result);
    const timing = last.steps.find((s: any) => typeof s.text === "string" && s.text.startsWith("Timing:"));
    expect(timing).toBeDefined();
    expect(timing.text).toMatch(/memory\+routing \d+ms/);
    expect(timing.text).toMatch(/search \d+ms/);
    expect(timing.text).toMatch(/rerank \d+ms/);
    expect(timing.text).toMatch(/total \d+ms/);
    expect(last.timings).toEqual(expect.objectContaining({ totalMs: expect.any(Number), searchMs: expect.any(Number) }));
  });
});

describe("engine v2 — identifier pins run alongside memory and routing", () => {
  it("resolves pins on the original question in parallel, and only once when memory leaves the question unchanged", async () => {
    const { resolveIdentifierPins } = jest.requireMock("./prefilter");
    resolveIdentifierPins.mockClear();
    const run = makeTool({ tuning: '{"engine": "v2"}' });
    await drain(run(inputs));
    expect(resolveIdentifierPins).toHaveBeenCalledTimes(1);
    expect(resolveIdentifierPins.mock.calls[0][0].question).toBe("q");
  });

  it("keeps the parallel pins when memory only added synonyms to the question", async () => {
    const { resolveIdentifierPins } = jest.requireMock("./prefilter");
    const { runMemoryPhase } = jest.requireMock("./memory");
    resolveIdentifierPins.mockClear();
    runMemoryPhase.mockResolvedValueOnce({
      memoryChunksForAnswer: [], memoryOverride: { active: false, chunks: [], reason: "" },
      memoryPinnedItemIdsByContext: new Map(), updatedQuestion: "q plus synonym", updatedKeywords: ["k"],
      updatedImportantKeyword: "k", steps: [] });
    const run = makeTool({ tuning: '{"engine": "v2"}' });
    await drain(run(inputs));
    expect(resolveIdentifierPins).toHaveBeenCalledTimes(1);
  });

  it("re-resolves pins on the memory-augmented question when it introduces a new designation (v1 fidelity)", async () => {
    const { resolveIdentifierPins } = jest.requireMock("./prefilter");
    const { runMemoryPhase } = jest.requireMock("./memory");
    resolveIdentifierPins.mockClear();
    runMemoryPhase.mockResolvedValueOnce({
      memoryChunksForAnswer: [], memoryOverride: { active: false, chunks: [], reason: "" },
      memoryPinnedItemIdsByContext: new Map(), updatedQuestion: "q plus FST-2XT", updatedKeywords: ["k"],
      updatedImportantKeyword: "k", steps: [] });
    const run = makeTool({ tuning: '{"engine": "v2"}' });
    await drain(run(inputs));
    expect(resolveIdentifierPins).toHaveBeenCalledTimes(2);
    expect(resolveIdentifierPins.mock.calls[1][0].question).toBe("q plus FST-2XT");
  });

  it("passes the merged-call flags to the memory and routing phases", async () => {
    const { runMemoryPhase } = jest.requireMock("./memory");
    const { runRoutingPhase } = jest.requireMock("./routing");
    runMemoryPhase.mockClear(); runRoutingPhase.mockClear();
    const run = makeTool({ tuning: '{"engine": "v2", "v2": {"mergedRoutingCall": false}}' });
    await drain(run(inputs));
    expect(runMemoryPhase.mock.calls[0][0].mergedCall).toBe(true);
    expect(runRoutingPhase.mock.calls[0][0].mergedCall).toBe(false);
  });

  it("keeps v1 sequential pins by default", async () => {
    const { resolveIdentifierPins } = jest.requireMock("./prefilter");
    const { runMemoryPhase } = jest.requireMock("./memory");
    resolveIdentifierPins.mockClear(); runMemoryPhase.mockClear();
    const run = makeTool({});
    await drain(run(inputs));
    expect(resolveIdentifierPins).toHaveBeenCalledTimes(1);
    expect(runMemoryPhase.mock.calls[0][0].mergedCall).toBeFalsy();
  });
});
