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

const call = (currentTools: unknown[], opts?: { project?: string; disabledTools?: string[] }) =>
  convertExuluToolsToAiSdkTools(
    currentTools as never, [], [], [], [], undefined,
    [docsContext, otherContext] as never, undefined, undefined, undefined, undefined,
    opts?.project, undefined, model, undefined, undefined, undefined,
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
