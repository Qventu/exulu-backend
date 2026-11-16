import {
  convertExuluToolsToAiSdkTools,
  OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS,
} from "./convert-exulu-tools-to-ai-sdk-tools";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import { postgresClient } from "@SRC/postgres/client";
import { createSessionSandbox } from "@EE/invoke-skills/create-sandbox";
import { resolveSandboxProjectId } from "@EE/invoke-skills/project-sync";

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
jest.mock("@EE/invoke-skills/project-sync", () => ({ resolveSandboxProjectId: jest.fn(async () => null) }));
jest.mock("@SRC/uppy", () => ({ getPresignedUrl: jest.fn() }));
jest.mock("@SRC/exulu/tool-output-offload", () => ({ guardToolOutput: jest.fn(async (v: unknown) => v) }));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/exulu/audit/logger", () => ({
  getAuditLogger: jest.fn(() => ({ shouldAuditTool: () => true, failClosed: false })),
}));
jest.mock("@SRC/exulu/audit/emit-tool-call", () => ({ emitToolCallAudit: jest.fn(async () => undefined) }));

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

  // Fix round 2, Important 2.3: claim-check reads the retrieval tool's
  // `output.result`, which an offloaded output does not have — so this
  // exemption is load-bearing for a feature in another directory. Removing
  // the id to save context would turn claim checks off on exactly the large
  // turns they were built for, with every gate green and no log line. This
  // assertion is the loud failure that replaces that silence; see
  // src/exulu/claim-check/finish-metadata.ts.
  it("still exempts agentic_context_search, which claim-check depends on", () => {
    expect(OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS.has("agentic_context_search")).toBe(true);
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
      projectId: null,
    });
    expect(createViewDocumentPageTool).toHaveBeenCalledWith({
      sessionID: "session-1",
      user: { id: 7 },
      exuluConfig: { fileUploads: { s3Bucket: "b" } },
      projectId: null,
    });
  });
});

describe("document tools get the access-checked project", () => {
  it("passes the resolved id, not the raw session project, and resolves once", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createParseDocumentTool } = require("./parse-document-tool") as { createParseDocumentTool: jest.Mock };
    createParseDocumentTool.mockClear();
    (resolveSandboxProjectId as jest.Mock).mockReset();
    (resolveSandboxProjectId as jest.Mock).mockResolvedValue(null);
    await convertExuluToolsToAiSdkTools(
      [], [], [], [], [], undefined, { id: 7 } as never, { fileUploads: { s3Bucket: "b" } } as never,
      "session-1", undefined, "raw-project",
    );
    expect(createParseDocumentTool.mock.calls[0][0].projectId).toBeNull();

    createParseDocumentTool.mockClear();
    (resolveSandboxProjectId as jest.Mock).mockClear();
    // a caller that already resolved hands the result in: no second resolution
    await convertExuluToolsToAiSdkTools(
      [], [], [], [], [], undefined, { id: 7 } as never, { fileUploads: { s3Bucket: "b" } } as never,
      "session-1", undefined, "raw-project", undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, { id: "p-resolved", name: "Alpha" },
    );
    expect(createParseDocumentTool.mock.calls[0][0].projectId).toBe("p-resolved");
    expect(resolveSandboxProjectId).not.toHaveBeenCalled();
  });
});

describe("save_to_project registration", () => {
  const run = (resolved: unknown, user: unknown = { id: 7 }) =>
    convertExuluToolsToAiSdkTools(
      [], [], [], [], [], undefined, user as never, { fileUploads: { s3Bucket: "b" } } as never,
      "session-1", undefined, "raw-project", undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, resolved as never,
    );
  it("is registered, with approval, when the speaker can write to the project", async () => {
    const tools = await run({ id: "p1", name: "Alpha", speakerCanWrite: true });
    expect(Object.keys(tools)).toContain("save_to_project");
    const needs = (tools.save_to_project as any).needsApproval;
    expect(await needs({}, { toolCallId: "c1", messages: [] })).toBe(true);
  });
  it("is absent without a project, for a reader, and for a guest speaker", async () => {
    expect(Object.keys(await run(null))).not.toContain("save_to_project");
    expect(Object.keys(await run({ id: "p1", name: "Alpha", speakerCanWrite: false }))).not.toContain("save_to_project");
    expect(Object.keys(await run({ id: "p1", name: "Alpha", speakerCanWrite: true }, null))).not.toContain("save_to_project");
  });
});

describe("save_to_project approval", () => {
  const project = { id: "p1", name: "Alpha", speakerCanWrite: true };
  const build = (approved: string[]) =>
    convertExuluToolsToAiSdkTools(
      [], [], approved, [], [], undefined, { id: 7 } as never, { fileUploads: { s3Bucket: "b" } } as never,
      "session-1", undefined, "raw-project", undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, project as never,
    );
  const ask = async (tools: any, input: unknown, messages: unknown[] = []) =>
    tools.save_to_project.needsApproval(input, { toolCallId: "c1", messages });
  const answered = [
    { role: "assistant", content: [{ type: "tool-approval-request", approvalId: "a1", toolCallId: "c1" }] },
    { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a1", approved: true }] },
  ];
  it("allowed for this chat: a plain save is not asked again, an overwrite always is", async () => {
    const tools = await build(["tool-save_to_project"]);
    expect(await ask(tools, { filename: "a.pdf" })).toBe(false);
    expect(await ask(tools, { filename: "a.pdf", overwrite: true })).toBe(true);
  });
  it("not allowed for the chat: every call is asked", async () => {
    const tools = await build([]);
    expect(await ask(tools, { filename: "a.pdf" })).toBe(true);
  });
  it("an already-answered overwrite call keeps needing approval so the SDK honours the answer", async () => {
    const tools = await build(["tool-save_to_project"]);
    expect(await ask(tools, { filename: "a.pdf", overwrite: true }, answered)).toBe(true);
    expect(await ask(tools, { filename: "a.pdf" }, answered)).toBe(true);
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
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["memory_remember", "memory_update", "memory_forget"]));
    expect((tools as any).memory_remember.needsApproval).toBe(true);
    expect(typeof (tools as any).memory_update.needsApproval).toBe("function");
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
      [] as never, [], ["tool-memory_remember"], [], [],
      [memoryContext] as never, user, undefined, undefined, undefined,
      undefined, undefined, model, agent, undefined, undefined, undefined,
    );
    expect((tools as any).memory_remember.needsApproval).toBe(true);
  });

  it("hands the matching decision to the wrapped execute by toolCallId", async () => {
    const seen: any[] = [];
    const fake = {
      id: "memory_forget", name: "memory_forget", description: "d", type: "function", category: "m", needsApproval: true, config: [],
      tool: { execute: jest.fn(async (p: any) => { seen.push(p); return { type: "memory_forgotten" }; }) },
    } as never;
    const decisions = new Map([["call-1", { v: 1, kind: "forget" }]]);
    const tools = await convertExuluToolsToAiSdkTools(
      [fake] as never, [], [], [], [], [] as never, user, undefined, undefined, undefined,
      undefined, undefined, model, agent, undefined, undefined, undefined, undefined, decisions as never,
    );
    // The wrapper's execute is an async generator — drain it.
    for await (const _chunk of (tools as any).memory_forget.execute({ memoryId: "m1" }, { toolCallId: "call-1", messages: [] })) { /* drain */ }
    expect(seen[0].memoryDecision).toEqual({ v: 1, kind: "forget" });
    expect(seen[0].user).toBe(user);
  });
});

describe("project → session sandbox wiring", () => {
  const sandboxCall = (project: string | undefined, ownerId: number, user: unknown) =>
    convertExuluToolsToAiSdkTools(
      [] as never, [], [], [], [], [] as never, user as never, {} as never, "s1", undefined,
      project, undefined, model, { id: "a1", name: "A", sandbox_enabled: true } as never, undefined, undefined,
      ["agentic_context_search"], ownerId,
    );

  beforeEach(() => {
    (createSessionSandbox as jest.Mock).mockReset().mockResolvedValue({ tools: {}, sessionDir: "/tmp/x" });
    (resolveSandboxProjectId as jest.Mock).mockReset();
  });

  it("passes the project id the resolver granted for the session owner", async () => {
    (resolveSandboxProjectId as jest.Mock).mockResolvedValue("p1");
    const user = { id: 9, role: { id: "r1" } };
    await sandboxCall("p1", 3, user);
    expect((resolveSandboxProjectId as jest.Mock).mock.calls[0][0]).toEqual({ projectId: "p1", ownerId: 3, owner: user });
    expect((createSessionSandbox as jest.Mock).mock.calls[0][5]).toEqual({ projectId: "p1" });
  });

  it("passes null when the resolver denies (no access, gone, or failed)", async () => {
    (resolveSandboxProjectId as jest.Mock).mockResolvedValue(null);
    await sandboxCall("p1", 3, { id: 3 });
    expect((createSessionSandbox as jest.Mock).mock.calls[0][5]).toEqual({ projectId: null });
  });
});

describe("routine handle in the execute context", () => {
  const drainAll = async (gen: AsyncGenerator<unknown>) => {
    for await (const _ of gen) void _;
  };
  const toolEntry = () => {
    const execute = jest.fn(async (_inputs: Record<string, unknown>) => "ok");
    return {
      execute,
      entry: { id: "generate_offer_xml", name: "Offer", description: "d", type: "utility", category: "erp", config: [], tool: { execute } } as never,
    };
  };
  const convert = (entry: unknown, factory?: unknown) =>
    convertExuluToolsToAiSdkTools(
      [entry] as never, [], [], [], [], [] as never, undefined, undefined, undefined, undefined,
      undefined, undefined, model, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      factory as never,
    );

  it("passes routine, built for the executing tool's id, when the turn is part of a routine run", async () => {
    const handle = { id: "wf-1", name: "R", statuses: [], runs: { current: { id: "jr-1", status: null, update: jest.fn() } } };
    const factory = jest.fn(() => handle);
    const { execute, entry } = toolEntry();
    const tools = await convert(entry, factory);
    await drainAll((tools as Record<string, { execute: (i: unknown, o: unknown) => AsyncGenerator<unknown> }>).Offer.execute({}, {}));
    expect(factory).toHaveBeenCalledWith({ kind: "tool", id: "generate_offer_xml" });
    expect(execute.mock.calls[0][0].routine).toBe(handle);
  });

  it("passes routine: undefined outside a routine run", async () => {
    const { execute, entry } = toolEntry();
    const tools = await convert(entry);
    await drainAll((tools as Record<string, { execute: (i: unknown, o: unknown) => AsyncGenerator<unknown> }>).Offer.execute({}, {}));
    expect(execute.mock.calls[0][0].routine).toBeUndefined();
  });
});

describe("set_routine_status injection", () => {
  const handleWith = (statuses: unknown[]) => ({
    id: "wf-1", name: "R", statuses,
    runs: { current: { id: "jr-1", status: null, update: jest.fn(), updateWithResult: jest.fn() } },
  });
  const convert = (factory?: unknown, disabledTools?: string[]) =>
    convertExuluToolsToAiSdkTools(
      [] as never, [], [], [], [], [] as never, undefined, undefined, undefined, undefined,
      undefined, undefined, model, undefined, undefined, undefined, disabledTools, undefined, undefined, undefined,
      factory as never,
    );
  const hasStatusTool = (tools: Record<string, unknown>) => Object.keys(tools).some((name) => /set_routine_status/i.test(name));

  it("is offered in a routine run whose routine has statuses, built with the agent as actor", async () => {
    const factory = jest.fn(() => handleWith([{ key: "neu", label: "Neu" }]));
    expect(hasStatusTool(await convert(factory))).toBe(true);
    expect(factory).toHaveBeenCalledWith({ kind: "agent" });
  });

  it("is not offered outside a routine run, without statuses, or when disabled", async () => {
    expect(hasStatusTool(await convert(undefined))).toBe(false);
    expect(hasStatusTool(await convert(() => handleWith([])))).toBe(false);
    expect(hasStatusTool(await convert(() => handleWith([{ key: "neu", label: "Neu" }]), ["set_routine_status"]))).toBe(false);
  });
});

describe("interim reading status from a generator tool", () => {
  const guardMock = jest.requireMock("@SRC/exulu/tool-output-offload").guardToolOutput as jest.Mock;
  const auditMock = jest.requireMock("@SRC/exulu/audit/emit-tool-call").emitToolCallAudit as jest.Mock;
  const reading = (n: number) => ({ status: "reading", filename: "a.pdf", phase: "ocr", pagesDone: n, pagesTotal: 2 });
  const finalResult = { content: "text" };

  const run = async (execute: () => unknown) => {
    const entry = {
      id: "streamer", name: "Streamer", description: "d", type: "utility", category: "utilities", config: [],
      tool: { execute },
    } as never;
    const tools = (await call([entry])) as Record<string, { execute: (i: unknown, o: unknown) => AsyncGenerator<unknown> }>;
    const out: unknown[] = [];
    for await (const v of tools.Streamer.execute({}, { toolCallId: "c1" })) out.push(v);
    return out;
  };
  async function* streamed() {
    yield reading(1);
    yield reading(2);
    yield finalResult;
  }

  beforeEach(() => {
    guardMock.mockClear();
    auditMock.mockClear();
  });

  it("passes interim objects through untouched and yields the final value last", async () => {
    const out = await run(() => streamed());
    expect(out).toEqual([reading(1), reading(2), finalResult]);
  });

  it("keeps the final value as the last yield even if the tool ends on an interim object", async () => {
    async function* trailing() { yield reading(1); yield finalResult; yield reading(2); }
    const out = await run(() => trailing());
    expect(out[out.length - 1]).toBe(finalResult);
    expect(guardMock).toHaveBeenCalledTimes(1);
    expect(guardMock.mock.calls[0][0]).toBe(finalResult);
  });

  it("treats a real output that merely has status 'reading' as a normal result", async () => {
    const real = { status: "reading" };
    async function* g() { yield real; }
    const out = await run(() => g());
    expect(out).toEqual([real]);
    expect(guardMock).toHaveBeenCalledTimes(1);
    expect(guardMock.mock.calls[0][0]).toBe(real);
    expect(auditMock.mock.calls[0][1].output).toBe(real);
  });

  it("guards and audits only the final value, once", async () => {
    guardMock.mockImplementationOnce(async () => ({ offloaded: true }));
    const out = await run(() => streamed());
    expect(guardMock).toHaveBeenCalledTimes(1);
    expect(guardMock.mock.calls[0][0]).toBe(finalResult);
    // The guarded replacement is the last yield, so it is what the SDK takes as the result.
    expect(out[out.length - 1]).toEqual({ offloaded: true });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][1].output).toEqual({ offloaded: true });
  });

  it("leaves a tool that returns a promise exactly as before", async () => {
    const out = await run(async () => finalResult);
    expect(out).toEqual([finalResult]);
    expect(guardMock).toHaveBeenCalledTimes(1);
  });

  it("leaves a generator that yields once exactly as before", async () => {
    async function* once() { yield finalResult; }
    const out = await run(() => once());
    expect(out).toEqual([finalResult]);
    expect(guardMock).toHaveBeenCalledTimes(1);
  });
});
