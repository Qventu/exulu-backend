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
      "max_steps", "project_search", "require_preselected_contexts", "reranker", "routing", "tuning", "utility_model", "vocabulary",
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
    const { runMemoryPhase } = jest.requireMock("./memory");
    const memChunk = { chunk_id: "m1", chunk_content: "FULL MEMORY CONTENT", item_id: "i1", item_name: "Mem" };
    runMemoryPhase.mockResolvedValueOnce({
      memoryChunksForAnswer: [memChunk],
      memoryOverride: { active: false, chunks: [], reason: "" },
      memoryPinnedItemIdsByContext: new Map(), updatedQuestion: "q", updatedKeywords: ["k"],
      updatedImportantKeyword: "k",
      steps: [{ text: "memory step", chunks: [memChunk] }],
    });
    const run = makeTool({});
    const out = await drain(run(inputs));
    const last = JSON.parse(out[out.length - 1].result);
    const stepWithChunks = last.steps.find((s: any) => s.chunks?.length > 0);
    expect(stepWithChunks).toBeDefined();
    expect(stepWithChunks.chunks[0].chunk_content).toBeUndefined();
    expect(stepWithChunks.chunks[0].item_name).toBe("Mem");
    const topLevel = last.chunks.find((c: any) => c.chunk_id === "m1");
    expect(topLevel).toBeDefined();
    expect(topLevel.chunk_content).toBe("FULL MEMORY CONTENT");
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
