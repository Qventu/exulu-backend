import { convertExuluToolsToAiSdkTools } from "./convert-exulu-tools-to-ai-sdk-tools";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import { postgresClient } from "@SRC/postgres/client";

jest.mock("@EE/agentic-retrieval/pipeline/index", () => ({
  createAgenticRetrievalTool: jest.fn(() => ({
    id: "agentic_context_search",
    name: "Context Search",
    description: "d",
    type: "context",
    category: "contexts",
    needsApproval: false,
    config: [],
    tool: { execute: jest.fn() },
  })),
}));
jest.mock("./session-file-read-tool", () => ({ createSessionFileReadTool: jest.fn(() => undefined) }));
jest.mock("./parse-document-tool", () => ({ createParseDocumentTool: jest.fn().mockReturnValue(undefined) }));
jest.mock("./view-document-page-tool", () => ({ createViewDocumentPageTool: jest.fn().mockReturnValue(undefined) }));
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));

// Additional mocks to prevent import-time failures from heavy side-effect modules
jest.mock("@EE/invoke-skills/create-sandbox", () => ({ createSessionSandbox: jest.fn() }));
jest.mock("@SRC/uppy", () => ({ getPresignedUrl: jest.fn() }));
jest.mock("@SRC/exulu/tool-output-offload", () => ({ guardToolOutput: jest.fn(async (v: unknown) => v) }));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));

const factory = createAgenticRetrievalTool as jest.Mock;

function mockProjectRow(row: unknown) {
  (postgresClient as jest.Mock).mockResolvedValue({
    db: { from: () => ({ where: () => ({ first: async () => row }) }) },
  });
}

const docsContext = { id: "docs", name: "Docs" } as never;
const otherContext = { id: "other", name: "Other" } as never;
const model = {} as never;

const PROJECT_ROW = {
  id: "p1",
  name: "Modernization",
  description: "desc",
  custom_instructions: "check norms",
  project_items: ["docs/i1", "docs/i2"],
};

beforeEach(() => {
  factory.mockClear();
  mockProjectRow(PROJECT_ROW);
});

const agenticEntry = {
  id: "agentic_context_search",
  name: "Context Search",
  description: "d",
  type: "context",
  category: "contexts",
  config: [],
  tool: { execute: jest.fn() },
} as never;

const call = (currentTools: unknown[], opts?: { project?: string; disabledTools?: string[]; agent?: unknown; user?: unknown }) =>
  convertExuluToolsToAiSdkTools(
    currentTools as never, [], [], [], [],
    [docsContext, otherContext] as never, opts?.user as never, undefined, undefined, undefined,
    opts?.project, undefined, model, opts?.agent as never, undefined, undefined,
    opts?.disabledTools,
  );

describe("project → agentic retrieval wiring", () => {
  it("Case 2: agent HAS the tool → factory receives projectScope, tool replaced in place", async () => {
    const tools = await call([agenticEntry], { project: "p1" });
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0][0];
    expect(opts.projectScope).toMatchObject({
      id: "p1",
      name: "Modernization",
      customInstructions: "check norms",
      items: ["docs/i1", "docs/i2"],
    });
    expect(Object.keys(tools)).toEqual(["Context_Search"]);
  });

  it("Case 1: agent lacks the tool → project-scoped instance pushed with project items preselected", async () => {
    const tools = await call([], { project: "p1" });
    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0][0];
    expect(opts.preselected).toEqual(["docs/i1", "docs/i2"]);
    expect(opts.contexts.map((c: { id: string }) => c.id)).toEqual(["docs"]);
    expect(Object.keys(tools)).toEqual(["Context_Search"]);
  });

  it("unlicensed (factory returns undefined) → no tool at all, no legacy fallback", async () => {
    factory.mockReturnValueOnce(undefined);
    const tools = await call([], { project: "p1" });
    expect(Object.keys(tools)).toEqual([]);
  });

  it("empty project_items → no injection", async () => {
    mockProjectRow({ ...PROJECT_ROW, project_items: [] });
    const tools = await call([], { project: "p1" });
    expect(factory).not.toHaveBeenCalled();
    expect(Object.keys(tools)).toEqual([]);
  });

  it("disabledTools contains agentic_context_search → no project load, no injection", async () => {
    const tools = await call([], { project: "p1", disabledTools: ["agentic_context_search"] });
    expect(factory).not.toHaveBeenCalled();
    expect(Object.keys(tools)).toEqual([]);
  });

  it("project_items arriving as a JSON string is parsed defensively", async () => {
    mockProjectRow({ ...PROJECT_ROW, project_items: JSON.stringify(["docs/i1"]) });
    await call([], { project: "p1" });
    expect(factory.mock.calls[0][0].preselected).toEqual(["docs/i1"]);
  });
});

describe("tool-output offload exemption (agentic retrieval)", () => {
  const guardMock = jest.requireMock("@SRC/exulu/tool-output-offload")
    .guardToolOutput as jest.Mock;

  const emailEntry = {
    id: "email",
    name: "Email",
    description: "d",
    type: "utility",
    category: "utilities",
    config: [],
    tool: { execute: jest.fn(async () => "ok") },
  } as never;

  const drain = async (gen: AsyncGenerator<unknown>) => {
    const out: unknown[] = [];
    for await (const v of gen) out.push(v);
    return out;
  };

  beforeEach(() => {
    guardMock.mockClear();
  });

  it("agentic_context_search output is NOT routed through guardToolOutput", async () => {
    const tools = await call([agenticEntry]);
    await drain(
      (tools as Record<string, { execute: (i: unknown, o: unknown) => AsyncGenerator<unknown> }>)
        .Context_Search.execute({}, {}),
    );
    expect(guardMock).not.toHaveBeenCalled();
  });

  it("other tools still pass through guardToolOutput", async () => {
    const tools = await call([emailEntry]);
    await drain(
      (tools as Record<string, { execute: (i: unknown, o: unknown) => AsyncGenerator<unknown> }>)
        .Email.execute({}, {}),
    );
    expect(guardMock).toHaveBeenCalledTimes(1);
  });
});

describe("document tool registration", () => {
  it("registers parse_document and view_document_page factories with session context", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createParseDocumentTool } = require("./parse-document-tool") as { createParseDocumentTool: jest.Mock };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createViewDocumentPageTool } = require("./view-document-page-tool") as { createViewDocumentPageTool: jest.Mock };
    createParseDocumentTool.mockClear();
    createViewDocumentPageTool.mockClear();
    await convertExuluToolsToAiSdkTools(
      [], [], [], [], [], undefined,
      { id: 7 } as never,           // user
      { fileUploads: { s3Bucket: "b" } } as never, // exuluConfig
      "session-1",                  // sessionID
    );
    expect(createParseDocumentTool).toHaveBeenCalledWith({
      sessionID: "session-1",
      user: { id: 7 },
      exuluConfig: { fileUploads: { s3Bucket: "b" } },
    });
    expect(createViewDocumentPageTool).toHaveBeenCalledWith({
      sessionID: "session-1",
      user: { id: 7 },
      exuluConfig: { fileUploads: { s3Bucket: "b" } },
    });
  });
});

describe("knowledge base write tool injection", () => {
  const kbContext = {
    id: "products",
    name: "Products",
    description: "Product catalog",
    fields: [{ name: "price", type: "number", required: true }],
    createItem: jest.fn(async () => ({ item: { id: "new-1" } })),
    updateItem: jest.fn(async () => ({ item: { id: "i1" } })),
    getItem: jest.fn(),
  } as never;

  const kbAgent = {
    id: "agent-1",
    name: "Agent",
    tools: [
      {
        id: "knowledge_base_editor",
        type: "function",
        config: [
          {
            name: "knowledge_bases",
            type: "json",
            variable: JSON.stringify({ products: { create: true, update: true } }),
          },
          { name: "skip_approval", type: "boolean", variable: "false" },
        ],
      },
    ],
  } as never;

  it("injects create/update tools for configured contexts", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [],
      [],
      [],
      [],
      (kbAgent as any).tools,
      [kbContext],
      { id: 7 } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kbAgent,
    );
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["Create_Products_item", "Update_Products_item"]),
    );
  });

  it("injects nothing when the agent has no knowledge_base_editor entry", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [],
      [],
      [],
      [],
      [],
      [kbContext],
      { id: 7 } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { id: "agent-1", name: "Agent", tools: [] } as never,
    );
    expect(Object.keys(tools)).not.toEqual(expect.arrayContaining(["Create_Products_item"]));
  });

  it("respects per-message disabledTools for generated write tools", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [],
      [],
      [],
      [],
      (kbAgent as any).tools,
      [kbContext],
      { id: 7 } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      kbAgent,
      undefined,
      undefined,
      ["create_products_item"],
    );
    expect(Object.keys(tools)).not.toEqual(expect.arrayContaining(["Create_Products_item"]));
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["Update_Products_item"]));
  });
});

describe("memory tool registration", () => {
  const memoryContext = {
    id: "newton_memory_context", name: "Newton memory",
    fields: [{ name: "information", type: "text" }, { name: "type", type: "enum", enumValues: ["FACT"] }],
  } as never;
  const agent = { id: "a1", name: "Newton", memory: "newton_memory_context" } as never;
  const user = { id: 4, role: { id: "r1" } } as never;
  const callWith = (opts: { user?: unknown; agent?: unknown; contexts?: unknown[]; decisions?: Map<string, unknown> }) =>
    convertExuluToolsToAiSdkTools(
      [] as never, [], [], [], [],
      (opts.contexts ?? [memoryContext]) as never, opts.user as never, undefined, undefined, undefined,
      undefined, undefined, model, (opts.agent ?? agent) as never, undefined, undefined,
      undefined, undefined, opts.decisions as never,
    );

  it("registers remember/update/forget for a signed-in user on a valid memory base", async () => {
    const tools = await callWith({ user });
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["Remember", "Update_memory", "Forget_memory"]));
    expect((tools as any).Remember.needsApproval).toBe(true);
    expect(typeof (tools as any).Update_memory.needsApproval).toBe("function");
  });

  it("registers nothing for guests (no user id) and for a context failing the contract", async () => {
    expect(Object.keys(await callWith({}))).toEqual([]);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const bad = { id: "newton_memory_context", name: "x", fields: [{ name: "body", type: "text" }] } as never;
    expect(Object.keys(await callWith({ user, contexts: [bad] }))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a valid memory base"));
    warn.mockRestore();
  });

  it("warns instead of throwing when the configured memory context is missing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(callWith({ user, contexts: [docsContext] })).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("was not found"));
    warn.mockRestore();
  });

  it("never applies the pre-approval shortcut to memory tools", async () => {
    const tools = await convertExuluToolsToAiSdkTools(
      [] as never, [], ["tool-Remember", "tool-memory_remember"], [], [],
      [memoryContext] as never, user, undefined, undefined, undefined,
      undefined, undefined, model, agent, undefined, undefined, undefined,
    );
    expect((tools as any).Remember.needsApproval).toBe(true);
  });

  it("hands the matching decision to the wrapped execute by toolCallId", async () => {
    const seen: any[] = [];
    const fake = {
      id: "memory_forget", name: "Forget memory", description: "d", type: "function", category: "m", needsApproval: true, config: [],
      tool: { execute: jest.fn(async (p: any) => { seen.push(p); return { type: "memory_forgotten" }; }) },
    } as never;
    const decisions = new Map([["call-1", { v: 1, kind: "forget" }]]);
    const tools = await convertExuluToolsToAiSdkTools(
      [fake] as never, [], [], [], [], [] as never, user, undefined, undefined, undefined,
      undefined, undefined, model, agent, undefined, undefined, undefined, undefined, decisions as never,
    );
    // The wrapper's execute is an async generator — drain it.
    for await (const _chunk of (tools as any).Forget_memory.execute({ memoryId: "m1" }, { toolCallId: "call-1", messages: [] })) { /* drain */ }
    expect(seen[0].memoryDecision).toEqual({ v: 1, kind: "forget" });
    expect(seen[0].user).toBe(user);
  });
});
