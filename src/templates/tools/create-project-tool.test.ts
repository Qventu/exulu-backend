import {
  canRegisterCreateProject,
  createCreateProjectTool,
  CREATE_PROJECT_TOOL_NAME,
  isCreateProjectEnabledOnAgent,
  PRIVATE_PROJECT_SENTENCE,
} from "./create-project-tool";
import { createTurnProject } from "@SRC/exulu/turn-project";
import { createParseDocumentTool } from "./parse-document-tool";
import { createSessionFileReadTool } from "./session-file-read-tool";
import { moveSessionFiles } from "@SRC/exulu/project-files-promote";
import type { ExuluConfig } from "@SRC/exulu/app";

const exuluConfig = { fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" } } as unknown as ExuluConfig;
const PREFIX = "exulu/user_7/sessions/s1/";
const agentTools = [{ id: "create_project", type: "function", config: [] }];
const base = { sessionID: "s1", user: { id: 7 } as never, ownerId: 7, exuluConfig, agentTools };

const finalOf = async (r: unknown): Promise<unknown> => {
  if (r && typeof r === "object" && Symbol.asyncIterator in r) {
    let last: unknown;
    for await (const v of r as AsyncGenerator<unknown>) last = v;
    return last;
  }
  return r;
};

const run = (tool: { tool: { execute?: unknown } }, input: Record<string, unknown>) =>
  (tool.tool.execute as (i: unknown) => Promise<{ result: string }>)(input);

const make = (over: { deps?: Record<string, unknown>; files?: { name: string; size?: number }[]; extra?: Record<string, unknown>; session?: unknown } = {}) => {
  const files = (over.files ?? [{ name: "a.pdf" }, { name: "b.docx" }]).map((f) => ({ key: `${PREFIX}${f.name}`, name: f.name, size: f.size ?? 10 }));
  const log: string[] = [];
  const s3 = {
    listProjectNames: async () => [],
    sizeOf: async () => 10,
    copy: async (a: string) => void log.push(`copy ${a.slice(PREFIX.length)}`),
    remove: async (k: string) => void log.push(`remove ${k.slice(PREFIX.length)}`),
  };
  const create = jest.fn(async (_db: unknown, _u: unknown, i: { name: string }) => ({ id: "proj-1", name: i.name }));
  const attach = jest.fn(async () => undefined);
  const discardProject = jest.fn(async () => undefined);
  const turnProject = createTurnProject(null);
  const tool = createCreateProjectTool({
    ...base,
    turnProject,
    ...over.extra,
    deps: {
      loadSession: async () => (over.session === undefined ? { project: null, user: 7 } : (over.session as never)),
      create: create as never,
      attach: attach as never,
      discardProject,
      listSessionFiles: async () => files,
      move: moveSessionFiles,
      s3,
      db: async () => ({}),
      ...over.deps,
    },
  })!;
  return { tool, create, attach, discardProject, turnProject, log };
};

describe("opt-in switch", () => {
  it("is on only for an agent whose tool list holds a create_project entry (array or JSON string)", () => {
    expect(isCreateProjectEnabledOnAgent(agentTools)).toBe(true);
    expect(isCreateProjectEnabledOnAgent(JSON.stringify(agentTools))).toBe(true);
    expect(isCreateProjectEnabledOnAgent([{ id: "save_to_project" }])).toBe(false);
    expect(isCreateProjectEnabledOnAgent(undefined)).toBe(false);
    expect(isCreateProjectEnabledOnAgent(null)).toBe(false);
    expect(isCreateProjectEnabledOnAgent("not json")).toBe(false);
  });
});

describe("registration", () => {
  it("is created for the owner of a project-less session on an agent that enabled it", () => {
    expect(createCreateProjectTool(base)).toBeDefined();
  });
  it.each([
    ["the agent has not enabled it", { agentTools: [] }],
    ["the agent has no tools at all", { agentTools: undefined }],
    ["the session has a resolved project", { project: { id: "p", name: "A", speakerCanWrite: true } }],
    ["the session has a project the speaker cannot see", { sessionProjectId: "p" }],
    ["the speaker is not the owner", { ownerId: 8 }],
    ["there is no owner (no session row)", { ownerId: undefined }],
    ["no user", { user: undefined }],
    ["the public surface", { req: { headers: { "x-public-surface": "1" } } }],
    ["no file uploads", { exuluConfig: {} as ExuluConfig }],
    ["no session", { sessionID: undefined }],
    ["the user switched it off for this chat", { disabled: ["create_project"] }],
  ])("is not created when %s", (_label, over) => {
    expect(createCreateProjectTool({ ...base, ...(over as object) })).toBeUndefined();
  });
  it("the prompt and the registration share the predicate", () => {
    const a = { ...base, user: base.user };
    expect(canRegisterCreateProject(a)).toBe(true);
    expect(canRegisterCreateProject({ ...a, ownerId: 9 })).toBe(false);
    expect(canRegisterCreateProject({ ...a, agentTools: [] })).toBe(false);
  });
  it("always needs approval, and never lets 'allow for this chat' skip it", () => {
    const { tool } = make();
    expect(tool.name).toBe(CREATE_PROJECT_TOOL_NAME);
    expect(tool.needsApproval).toBe(true);
    expect(tool.alwaysAskWhen?.({ name: "x" })).toBe(true);
  });
});

describe("execute", () => {
  it("creates, attaches, copies then deletes each original, and reports everything required", async () => {
    const { tool, create, attach, log, turnProject } = make();
    const { result } = await run(tool, { name: "Alpha", description: "d" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![2]).toEqual({ name: "Alpha", description: "d" });
    expect(attach).toHaveBeenCalledWith({}, { sessionId: "s1", projectId: "proj-1", user: base.user });
    expect(log).toEqual(["copy a.pdf", "copy b.docx", "remove a.pdf", "remove b.docx"]);
    expect(result).toContain('"Alpha"');
    expect(result).toContain("proj-1");
    expect(result).toContain("Moved 2 files");
    expect(result).toContain(PRIVATE_PROJECT_SENTENCE);
    expect(result).toContain("/projects/proj-1");
    expect(result).toMatch(/sandbox project\/ folder appears from the next message/);
    expect(turnProject.current).toEqual({ id: "proj-1", name: "Alpha", speakerCanWrite: true });
  });

  it("a failing copy leaves that file in the session and names it; the others still move", async () => {
    const { tool, log } = make({
      deps: {
        s3: {
          listProjectNames: async () => [],
          sizeOf: async () => 10,
          copy: async (a: string) => {
            if (a.endsWith("b.docx")) throw new Error("secret-bucket exploded");
          },
          remove: async (k: string) => void 0,
        },
      },
    });
    const { result } = await run(tool, { name: "Alpha" });
    expect(result).toContain("Moved 1 file");
    expect(result).toMatch(/Not moved .*b\.docx/);
    expect(result).not.toContain("secret-bucket");
    expect(log).toEqual([]);
  });

  it("reports unknown requested names and moves only what was asked for", async () => {
    const { tool, log } = make();
    const { result } = await run(tool, { name: "Alpha", files: ["a.pdf", "ghost.pdf"] });
    expect(log).toEqual(["copy a.pdf", "remove a.pdf"]);
    expect(result).toMatch(/ghost\.pdf \(No session file/);
  });

  it("says how many files stayed behind on purpose (tool outputs etc.)", async () => {
    const { tool } = make({ files: [{ name: "a.pdf" }, { name: "tool-output-1.txt" }] });
    const { result } = await run(tool, { name: "Alpha" });
    expect(result).toContain("1 other session file");
  });

  it("an attach failure discards the new project, moves nothing and leaks nothing", async () => {
    const { tool, discardProject, log, turnProject } = make({
      deps: { attach: jest.fn(async () => { throw new Error("pg: relation secret_table"); }) },
    });
    const { result } = await run(tool, { name: "Alpha" });
    expect(discardProject).toHaveBeenCalledWith("proj-1");
    expect(log).toEqual([]);
    expect(turnProject.current).toBeNull();
    expect(result).not.toContain("secret_table");
    expect(result).toMatch(/nothing was created or moved/);
  });

  it("a create failure leaks nothing; a validation message is passed on", async () => {
    const boom = make({ deps: { create: jest.fn(async () => { throw new Error("pg: password for user exulu"); }) } });
    const r1 = await run(boom.tool, { name: "Alpha" });
    expect(r1.result).not.toContain("password");
    expect(boom.attach).not.toHaveBeenCalled();
    const bad = make({ deps: { create: jest.fn(async () => { throw new Error("Project name must be 1 to 120 characters."); }) } });
    expect((await run(bad.tool, { name: "" })).result).toContain("Project name must be");
  });

  it("refuses a direct call when the live session has a project, no row, or another owner", async () => {
    for (const session of [{ project: "p9", user: 7 }, undefined, { project: null, user: 8 }]) {
      const m = make({ session: session ?? null, deps: session === undefined ? { loadSession: async () => undefined } : {} });
      const { result } = await run(m.tool, { name: "Alpha" });
      expect(m.create).not.toHaveBeenCalled();
      expect(typeof result).toBe("string");
    }
  });

  it("a second call in the same turn is refused (the holder already has the project)", async () => {
    const m = make();
    await run(m.tool, { name: "Alpha" });
    await run(m.tool, { name: "Beta" });
    expect(m.create).toHaveBeenCalledTimes(1);
  });

  it("after the call, parse_document and read_session_file of the same turn resolve project/<name>", async () => {
    const m = make();
    const common = { sessionID: "s1", user: base.user, exuluConfig, ownerId: 7, turnProject: m.turnProject };
    const parse = createParseDocumentTool(common)!;
    const read = createSessionFileReadTool(common)!;
    const call = (t: { tool: { execute?: unknown } }, input: unknown) => finalOf((t.tool.execute as (i: unknown) => unknown)(input));
    const NONE = /no project files/i;
    expect(JSON.stringify(await call(parse, { filename: "project/a.pdf" }))).toMatch(NONE);
    expect(JSON.stringify(await call(read, { filename: "project/a.pdf" }))).toMatch(NONE);
    await run(m.tool, { name: "Alpha" });
    expect(JSON.stringify(await call(parse, { filename: "project/a.pdf" }))).not.toMatch(NONE);
    expect(JSON.stringify(await call(read, { filename: "project/a.pdf" }))).not.toMatch(NONE);
  });
});
