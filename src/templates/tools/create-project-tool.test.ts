import {
  canRegisterCreateProject,
  createCreateProjectTool,
  CREATE_PROJECT_TOOL_NAME,
  isCreateProjectEnabledOnAgent,
  PRIVATE_PROJECT_SENTENCE,
  createCreateProjectPickerTool,
  CREATE_PROJECT_PROMPT,
} from "./create-project-tool";
import { postgresClient } from "@SRC/postgres/client";
import { createTurnProject } from "@SRC/exulu/turn-project";
import { createParseDocumentTool } from "./parse-document-tool";
import { createSessionFileReadTool } from "./session-file-read-tool";
import { moveSessionFiles } from "@SRC/exulu/project-files-promote";
import type { ExuluConfig } from "@SRC/exulu/app";

const exuluConfig = { fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" } } as unknown as ExuluConfig;
const PREFIX = "exulu/user_7/sessions/s1/";
const agentTools = [{ id: "create_project", type: "function", config: [] }];
const ALL = ["a.pdf", "b.docx"];
const base = { sessionID: "s1", user: { id: 7 } as never, ownerId: 7, exuluConfig, agentTools };

jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
const mockMessages = (rows: { content: string }[]) => {
  const whereRaw = jest.fn(() => ({ select: async () => rows }));
  (postgresClient as jest.Mock).mockResolvedValue({ db: { from: () => ({ where: () => ({ whereRaw }) }) } });
  return whereRaw;
};

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
  const turnProject = createTurnProject(null);
  const tool = createCreateProjectTool({
    ...base,
    turnProject,
    ...over.extra,
    deps: {
      loadSession: async () => (over.session === undefined ? { project: null, user: 7 } : (over.session as never)),
      createAndAttach: create as never,
      referencedKeys: async () => new Set<string>(),
      listSessionFiles: async () => files,
      move: moveSessionFiles,
      s3,
      db: async () => ({}),
      ...over.deps,
    },
  })!;
  return { tool, create, turnProject, log };
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
  it("30 files, the 17th copy fails: 29 moved and gone from the session, 1 stays and is named", async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ name: `f${String(i + 1).padStart(2, "0")}.txt` }));
    const removed: string[] = [];
    const m = make({
      files,
      deps: {
        s3: {
          listProjectNames: async () => [],
          sizeOf: async () => 10,
          copy: async (a: string) => { if (a.endsWith("f17.txt")) throw new Error("boom"); },
          remove: async (k: string) => void removed.push(k.slice(PREFIX.length)),
        },
      },
    });
    const { result } = await run(m.tool, { name: "Alpha", files: files.map((f) => f.name) });
    expect(result).toContain("Moved 29 files");
    expect(removed).toHaveLength(29);
    expect(removed).not.toContain("f17.txt");
    expect(result).toMatch(/Not moved .*f17\.txt/);
  });

  it("copies but keeps the original of a file that a stored message refers to", async () => {
    const m = make({ deps: { referencedKeys: async () => new Set([`${PREFIX}a.pdf`]) } });
    const { result } = await run(m.tool, { name: "Alpha", files: ALL });
    expect(m.log).toEqual(["copy a.pdf", "copy b.docx", "remove b.docx"]);
    expect(result).toMatch(/also kept in the session.*a\.pdf/);
  });
  it("when the message lookup fails, no original is deleted", async () => {
    const m = make({ deps: { referencedKeys: async () => { throw new Error("db"); } } });
    await run(m.tool, { name: "Alpha", files: ALL });
    expect(m.log.filter((l) => l.startsWith("remove"))).toEqual([]);
  });

  it("creates, attaches, copies then deletes each original, and reports everything required", async () => {
    const { tool, create, log, turnProject } = make();
    const { result } = await run(tool, { name: "Alpha", description: "d", files: ALL });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![2]).toEqual({ sessionId: "s1", name: "Alpha", description: "d" });
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
    const { result } = await run(tool, { name: "Alpha", files: ALL });
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

  it("moves only the approved list: unlisted files stay and the result says how many", async () => {
    const { tool, log } = make({ files: [{ name: "a.pdf" }, { name: "b.docx" }, { name: "tool-output-1.txt" }] });
    const { result } = await run(tool, { name: "Alpha", files: ["a.pdf"] });
    expect(log).toEqual(["copy a.pdf", "remove a.pdf"]);
    expect(result).toContain("2 other session files not on the approved list stayed in the session");
  });
  it("an empty list creates the project and moves nothing; a direct call without files does the same", async () => {
    for (const input of [{ name: "Alpha", files: [] }, { name: "Alpha" }]) {
      const m = make();
      const { result } = await run(m.tool, input);
      expect(m.log).toEqual([]);
      expect(m.create).toHaveBeenCalledTimes(1);
      expect(result).toContain("Moved 0 files");
    }
  });
  it("requires files in the input schema, with an array of strings", () => {
    const schema = make().tool.inputSchema as import("zod").ZodTypeAny;
    expect(schema.safeParse({ name: "A" }).success).toBe(false);
    expect(schema.safeParse({ name: "A", files: [] }).success).toBe(true);
    expect(schema.safeParse({ name: "A", files: [1] }).success).toBe(false);
  });
  it("tells the model to list exactly the files to move, from the prompt listing", () => {
    const { tool } = make();
    expect(tool.description).toMatch(/REQUIRED/);
    expect(tool.description).toMatch(/exactly the files to move/);
    expect(tool.description).toMatch(/stays in the session/);
    expect(CREATE_PROJECT_PROMPT).toMatch(/`files`/);
  });
  it("is not created in a routine run, and a direct call on a run session is refused", async () => {
    expect(createCreateProjectTool({ ...base, routineRun: true })).toBeUndefined();
    const m = make({ session: { project: null, user: 7, metadata: { job_result_id: "j1" } } });
    const { result } = await run(m.tool, { name: "Alpha", files: ALL });
    expect(m.create).not.toHaveBeenCalled();
    expect(result).toMatch(/routine run/);
  });

  it("a failed create-and-attach moves nothing, leaves the holder empty and leaks nothing", async () => {
    const { tool, log, turnProject } = make({
      deps: { createAndAttach: jest.fn(async () => { throw new Error("pg: relation secret_table"); }) },
    });
    const { result } = await run(tool, { name: "Alpha", files: ALL });
    expect(log).toEqual([]);
    expect(turnProject.current).toBeNull();
    expect(result).not.toContain("secret_table");
    expect(result).toMatch(/nothing was created or moved/);
  });

  it("a create failure leaks nothing; a validation message is passed on", async () => {
    const boom = make({ deps: { createAndAttach: jest.fn(async () => { throw new Error("pg: password for user exulu"); }) } });
    const r1 = await run(boom.tool, { name: "Alpha", files: ALL });
    expect(r1.result).not.toContain("password");
    const bad = make({ deps: { createAndAttach: jest.fn(async () => { throw new Error("Project name must be 1 to 120 characters."); }) } });
    expect((await run(bad.tool, { name: "", files: ALL })).result).toContain("Project name must be");
  });

  it("refuses a direct call when the live session has a project, no row, or another owner", async () => {
    for (const session of [{ project: "p9", user: 7 }, undefined, { project: null, user: 8 }]) {
      const m = make({ session: session ?? null, deps: session === undefined ? { loadSession: async () => undefined } : {} });
      const { result } = await run(m.tool, { name: "Alpha", files: ALL });
      expect(m.create).not.toHaveBeenCalled();
      expect(typeof result).toBe("string");
    }
  });

  it("a second call in the same turn is refused (the holder already has the project)", async () => {
    const m = make();
    await run(m.tool, { name: "Alpha", files: ALL });
    await run(m.tool, { name: "Beta", files: ALL });
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
    await run(m.tool, { name: "Alpha", files: ALL });
    expect(JSON.stringify(await call(parse, { filename: "project/a.pdf" }))).not.toMatch(NONE);
    expect(JSON.stringify(await call(read, { filename: "project/a.pdf" }))).not.toMatch(NONE);
  });
});

describe("history lookup", () => {
  const withDefaultLookup = () => {
    const m = make();
    // rebuild without the referencedKeys override so the real query path runs
    const tool = createCreateProjectTool({
      ...base,
      turnProject: m.turnProject,
      deps: {
        loadSession: async () => ({ project: null, user: 7 }),
        createAndAttach: m.create as never,
        listSessionFiles: async () => ["a.pdf", "b.docx"].map((n) => ({ key: `${PREFIX}${n}`, name: n, size: 10 })),
        s3: {
          listProjectNames: async () => [],
          sizeOf: async () => 10,
          copy: async (a: string) => void m.log.push(`copy ${a.slice(PREFIX.length)}`),
          remove: async (k: string) => void m.log.push(`remove ${k.slice(PREFIX.length)}`),
        },
        db: async () => ({}),
      },
    })!;
    return { tool, log: m.log };
  };
  it("one unparseable message row counts as a failed lookup: nothing is deleted, files are reported kept", async () => {
    mockMessages([{ content: "{not json" }]);
    const { tool, log } = withDefaultLookup();
    const { result } = await run(tool, { name: "Alpha", files: ALL });
    expect(log.filter((l) => l.startsWith("remove"))).toEqual([]);
    expect(result).toMatch(/also kept in the session.*a\.pdf/);
  });
  it("only rows that can hold a file part are selected, whitespace-tolerant", async () => {
    const whereRaw = mockMessages([]);
    const { tool, log } = withDefaultLookup();
    await run(tool, { name: "Alpha", files: ALL });
    const [sql, [pattern]] = whereRaw.mock.calls[0] as unknown as [string, string[]];
    expect(sql).toContain("content ~");
    const re = new RegExp(pattern.replace(/\[\[:space:\]\]/g, "\\s"));
    expect(re.test('{"parts":[{"type":"file","url":"x"}]}')).toBe(true);
    expect(re.test('{"parts":[{ "type" :\n "file" }]}')).toBe(true);
    expect(re.test('{"parts":[{"type":"text"}]}')).toBe(false);
    expect(log.filter((l) => l.startsWith("remove"))).toEqual(["remove a.pdf", "remove b.docx"]);
  });
});

describe("picker entry", () => {
  it("is a display-only catalogue entry with the opt-in id", () => {
    const picker = createCreateProjectPickerTool();
    expect(picker.id).toBe("create_project");
    expect(picker.category).toBe("default");
    expect(picker.type).toBe("function");
    expect(picker.config).toEqual([]);
    expect(picker.name).toBeTruthy();
    expect(picker.description).toMatch(/approval/);
  });
});
