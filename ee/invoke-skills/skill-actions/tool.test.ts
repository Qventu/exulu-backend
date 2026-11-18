import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { findContextItems, readContextItem } from "@SRC/templates/tools/context-read-tools";
import { createRunSkillActionTool, deriveConnectedContextIds, RUN_SKILL_ACTION_TOOL_ID } from "./tool";
import type { LoadedSkillActions } from "./load";
import type { SkillAction } from "./schema";

jest.mock("@SRC/templates/tools/context-read-tools", () => ({
  readContextItem: jest.fn(),
  findContextItems: jest.fn(),
}));

const readMock = readContextItem as jest.Mock;
const findMock = findContextItems as jest.Mock;

// The read function's own not-found sentence (missing and unreadable are the same).
const NOT_FOUND = 'Item not found in "Pitches", or you do not have access to it.';
const ROWS = [{ id: "r1" }, { id: "r2" }, { id: "r3" }];

const action = (a: Partial<SkillAction>): SkillAction => ({
  description: "d",
  run: "true",
  timeoutSeconds: 60,
  inputs: {},
  ...a,
});

let root: string;
let sessionDir: string;
let seen: {
  command?: string;
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
  files: Record<string, unknown>;
  mode?: number;
  runDir?: string;
};
let runResult: () => Promise<any>;
let tool: ReturnType<typeof createRunSkillActionTool>;
let truncate: jest.Mock;

const loadedFor = (dir: string): LoadedSkillActions => ({
  bySkill: {
    a: {
      skillDir: join(dir, "skills", "a"),
      actions: {
        export: action({
          description: "Writes the workbook.",
          run: 'python3 "$EXULU_SKILL_DIR/scripts/export.py"',
          timeoutSeconds: 30,
          inputs: { pitch: { type: "item", context: "pitches", fields: ["felder"] } },
        }),
        note: action({ run: "python3 note.py", inputs: { note: { type: "text", required: true } } }),
        opt: action({
          inputs: {
            title: { type: "text", required: true },
            extra: { type: "text", required: false },
          },
        }),
        list: action({
          inputs: { rows: { type: "items", context: "rows", where: { status: { eq: "open" } } } },
        }),
        two: action({
          inputs: {
            pitch: { type: "item", context: "pitches" },
            rows: { type: "items", context: "rows" },
          },
        }),
        other_ctx: action({ inputs: { it: { type: "item", context: "secret" } } }),
        ghost_ctx: action({ inputs: { it: { type: "item", context: "ghost" } } }),
        bad_args: action({ inputs: { args: { type: "item", context: "pitches" } } }),
      },
    },
  },
  problems: [{ skill: "b", error: "version: Invalid literal value" }],
});

const contexts = [
  { id: "pitches", name: "Pitches" },
  { id: "rows", name: "Rows" },
  { id: "secret", name: "Secret" },
] as never;

const run = (input: Record<string, unknown>) =>
  (tool as any).tool.execute({ ...input, user: { id: 1 }, req: { r: 1 } }, {}) as Promise<{ result: string }>;

beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), "skill-action-tool-"));
  sessionDir = join(root, "session");
  await fs.mkdir(join(sessionDir, "skills", "a"), { recursive: true });
  seen = { files: {} };
  runResult = async () => ({ stdout: "out", stderr: "err", exitCode: 0, timedOut: false, artifacts: [] });
  readMock.mockReset().mockImplementation(async (_ctx: unknown, args: { id?: string; external_id?: string }) => {
    if (args.id === "forbidden") return { ok: false, message: NOT_FOUND };
    return { ok: true, item: { id: args.id ?? `ext:${args.external_id}`, felder: {} } };
  });
  findMock.mockReset().mockImplementation(async (_ctx: unknown, args: { limit: number }) => ({
    ok: true,
    items: ROWS.slice(0, args.limit),
    limit: args.limit,
    truncated: ROWS.length > args.limit,
  }));
  truncate = jest.fn((text: string, kind: string) => `${kind}<${text}>`);
  tool = createRunSkillActionTool({
    handle: {
      sessionDir,
      runCommand: async (command, options) => {
        seen.command = command;
        seen.extraEnv = options?.extraEnv;
        seen.timeoutMs = options?.timeoutMs;
        const dir = options!.extraEnv!.EXULU_INPUTS_DIR!;
        seen.runDir = dir;
        seen.mode = (await fs.stat(dir)).mode & 0o777;
        for (const name of await fs.readdir(dir)) {
          seen.files[name] = JSON.parse(await fs.readFile(join(dir, name), "utf8"));
        }
        return runResult();
      },
    },
    loaded: loadedFor(sessionDir),
    contexts,
    connectedContextIds: new Set(["pitches", "rows"]),
    truncate,
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

test("item input lands as a file, ids never in the command", async () => {
  await run({ skill: "a", action: "export", inputs: { pitch: "id-1" } });
  expect(seen.command).toBe('python3 "$EXULU_SKILL_DIR/scripts/export.py"');
  expect(seen.extraEnv!.EXULU_SKILL_DIR).toBe(join(sessionDir, "skills", "a"));
  expect(seen.files["pitch.json"]).toEqual({ id: "id-1", felder: {} });
  expect(seen.extraEnv!.EXULU_INPUTS_DIR.startsWith(join(sessionDir, ".exulu-inputs") + "/")).toBe(true);
  expect(Object.keys(seen.files)).toEqual(["pitch.json"]); // no args.json without text inputs
  expect(seen.timeoutMs).toBe(30_000);
  expect(seen.mode).toBe(0o700);
  expect(readMock).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pitches" }),
    { id: "id-1", fields: ["felder"] },
    { user: { id: 1 }, req: { r: 1 } },
  );
});

test("item input by external_id", async () => {
  await run({ skill: "a", action: "export", inputs: { pitch: { external_id: "X-9" } } });
  expect(readMock.mock.calls[0][1]).toEqual({ external_id: "X-9", fields: ["felder"] });
  expect(seen.files["pitch.json"]).toEqual({ id: "ext:X-9", felder: {} });
});

test("hostile text is data only", async () => {
  const evil = '"; rm -rf . #\n$(id) `id`';
  await run({ skill: "a", action: "note", inputs: { note: evil } });
  expect(seen.files["args.json"]).toEqual({ note: evil });
  expect(seen.command).toBe("python3 note.py");
  expect(seen.command).not.toContain("rm -rf");
  expect(JSON.stringify(seen.extraEnv)).not.toContain("rm -rf");
});

test("an omitted optional text input is absent from args.json", async () => {
  await run({ skill: "a", action: "opt", inputs: { title: "T" } });
  expect(seen.files["args.json"]).toEqual({ title: "T" });
});

test("items envelope and truncation warning", async () => {
  const r = await run({ skill: "a", action: "list", inputs: { rows: { limit: 2 } } }); // 3 rows match
  expect(seen.files["rows.json"]).toEqual({ items: [expect.anything(), expect.anything()], limit: 2, truncated: true });
  expect(r.result).toContain('warning: input "rows" was cut at 2 items');
});

test("items defaults to 50 with a ceiling of 500 and no warning when complete", async () => {
  const r = await run({ skill: "a", action: "list" });
  expect(findMock.mock.calls[0][1]).toMatchObject({ limit: 50, maxLimit: 500 });
  expect(seen.files["rows.json"]).toEqual({ items: ROWS, limit: 50, truncated: false });
  expect(r.result).not.toContain("warning:");
});

test("yaml where is AND-ed with the caller's where", async () => {
  await run({ skill: "a", action: "list", inputs: { rows: { where: { kunde: { eq: "ACME" } } } } });
  expect(findMock).toHaveBeenCalledTimes(1);
  expect(findMock.mock.calls[0][1].where).toEqual({ status: { eq: "open" }, kunde: { eq: "ACME" } });
  expect(findMock.mock.calls[0][2]).toEqual({ user: { id: 1 }, req: { r: 1 } });
});

test("the result carries exit code, stdout and stderr through truncate", async () => {
  runResult = async () => ({ stdout: "hello", stderr: "oops", exitCode: 3, timedOut: false, artifacts: [] });
  const r = await run({ skill: "a", action: "export", inputs: { pitch: "id-1" } });
  expect(r.result).toBe("exit_code: 3\nstdout:\nstdout<hello>\nstderr:\nstderr<oops>");
  expect(truncate).toHaveBeenCalledWith("hello", "stdout");
  expect(truncate).toHaveBeenCalledWith("oops", "stderr");
});

test("a timeout is reported with the action's limit", async () => {
  runResult = async () => ({ stdout: "", stderr: "", exitCode: 124, timedOut: true, artifacts: [] });
  const r = await run({ skill: "a", action: "export", inputs: { pitch: "id-1" } });
  expect(r.result.split("\n").slice(0, 2)).toEqual(["exit_code: 124", "timed out after 30s"]);
});

test("inputs directory is removed after success, failure and timeout", async () => {
  const outcomes = [
    async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, artifacts: [] }),
    async () => ({ stdout: "", stderr: "boom", exitCode: 1, timedOut: false, artifacts: [] }),
    async () => ({ stdout: "", stderr: "", exitCode: 124, timedOut: true, artifacts: [] }),
  ];
  for (const outcome of outcomes) {
    runResult = outcome;
    seen.runDir = undefined;
    await run({ skill: "a", action: "export", inputs: { pitch: "id-1" } });
    expect(seen.runDir).toBeDefined();
    expect(await exists(seen.runDir!)).toBe(false);
  }
  expect(await fs.readdir(join(sessionDir, ".exulu-inputs"))).toEqual([]);
});

test("inputs directory is removed when the runner throws, and the error propagates", async () => {
  runResult = async () => {
    throw new Error("sandbox gone");
  };
  await expect(run({ skill: "a", action: "export", inputs: { pitch: "id-1" } })).rejects.toThrow("sandbox gone");
  expect(await exists(seen.runDir!)).toBe(false);
});

test("a link planted at .exulu-inputs does not redirect the input files", async () => {
  const outside = join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, join(sessionDir, ".exulu-inputs"));
  await run({ skill: "a", action: "export", inputs: { pitch: "id-1" } });
  expect(seen.files["pitch.json"]).toEqual({ id: "id-1", felder: {} });
  expect(await fs.readdir(outside)).toEqual([]);
  expect((await fs.lstat(join(sessionDir, ".exulu-inputs"))).isDirectory()).toBe(true);
});

test.each([
  ["unknown skill", { skill: "zzz", action: "export" }, "Available:"],
  ["prototype skill name", { skill: "__proto__", action: "export" }, "Available:"],
  ["unknown action", { skill: "a", action: "zzz" }, "Available:"],
  ["prototype action name", { skill: "a", action: "constructor" }, "Available:"],
  ["missing input", { skill: "a", action: "export", inputs: {} }, 'input "pitch" is required'],
  ["surplus input", { skill: "a", action: "export", inputs: { pitch: "1", x: "y" } }, 'unknown input "x"'],
  ["item of wrong shape", { skill: "a", action: "export", inputs: { pitch: { id: "1" } } }, 'input "pitch" must be'],
  ["empty item id", { skill: "a", action: "export", inputs: { pitch: "" } }, 'input "pitch" must be'],
  ["items of wrong shape", { skill: "a", action: "list", inputs: { rows: "all" } }, 'input "rows" must be'],
  ["items with unknown key", { skill: "a", action: "list", inputs: { rows: { order: "x" } } }, 'unknown key "order"'],
  ["items with bad limit", { skill: "a", action: "list", inputs: { rows: { limit: 0 } } }, '"limit" must be'],
  ["where clash with the yaml", { skill: "a", action: "list", inputs: { rows: { where: { status: { eq: "x" } } } } }, '"status"'],
  ["context not connected", { skill: "a", action: "other_ctx", inputs: { it: "1" } }, "not connected to this agent"],
  ["context not resolvable", { skill: "a", action: "ghost_ctx", inputs: { it: "1" } }, "not connected to this agent"],
  ["unreadable item", { skill: "a", action: "export", inputs: { pitch: "forbidden" } }, NOT_FOUND],
  ["text not a string", { skill: "a", action: "note", inputs: { note: 5 } }, 'input "note" must be a string'],
  ["text too long", { skill: "a", action: "note", inputs: { note: "x".repeat(10001) } }, "10000"],
  ["missing required text", { skill: "a", action: "note", inputs: {} }, 'input "note" is required'],
  ["args collision", { skill: "a", action: "bad_args", inputs: { args: "1" } }, "args.json"],
])("refuses without running: %s", async (_n, input, part) => {
  const r = await run(input as any);
  expect(r.result).toContain(part);
  expect(seen.command).toBeUndefined();
  expect(await exists(join(sessionDir, ".exulu-inputs"))).toBe(false);
});

test("refusal names the context id", async () => {
  const r = await run({ skill: "a", action: "other_ctx", inputs: { it: "1" } });
  expect(r.result).toContain('"secret"');
  expect(readMock).not.toHaveBeenCalled();
});

test("a later failing input stops the run after an earlier one was read", async () => {
  findMock.mockResolvedValueOnce({ ok: false, message: "bad filter" });
  const r = await run({ skill: "a", action: "two", inputs: { pitch: "id-1" } });
  expect(r.result).toContain('input "rows": bad filter');
  expect(seen.command).toBeUndefined();
  expect(await exists(join(sessionDir, ".exulu-inputs"))).toBe(false);
});

test("the tool description lists actions and problems", () => {
  expect(tool.id).toBe(RUN_SKILL_ACTION_TOOL_ID);
  expect(tool.needsApproval).toBe(false);
  expect(tool.description).toContain("a / export —");
  expect(tool.description).toContain('skill "b": actions.yaml ignored — version: Invalid literal value');
});

describe("deriveConnectedContextIds", () => {
  const ALL = ["docs", "rows", "pitches", "mem"];
  const kb = (row: Record<string, unknown>) => ({
    config: { id: "agentic_context_search", type: "context", config: [{ name: "knowledge_bases", ...row }] } as never,
  });
  const sorted = (set: Set<string>) => [...set].sort();

  test.each<[string, Parameters<typeof deriveConnectedContextIds>[0], string[]]>([
    ["editor only", { contextIds: ALL, editorContextIds: ["pitches"] }, ["pitches"]],
    [
      "agentic search with no config entry → all but memory",
      { contextIds: ALL, memoryContextId: "mem", editorContextIds: [], agenticSearch: {} },
      ["docs", "pitches", "rows"],
    ],
    [
      "agentic search with default \"{}\" → all but memory",
      { contextIds: ALL, memoryContextId: "mem", editorContextIds: [], agenticSearch: kb({ type: "json", variable: "{}" }) },
      ["docs", "pitches", "rows"],
    ],
    [
      "agentic search with an empty hydrated value → all but memory",
      { contextIds: ALL, memoryContextId: "mem", editorContextIds: [], agenticSearch: kb({ type: "json", value: "" }) },
      ["docs", "pitches", "rows"],
    ],
    [
      "one context disabled (object variable)",
      {
        contextIds: ALL,
        memoryContextId: "mem",
        editorContextIds: [],
        agenticSearch: kb({ type: "json", variable: { docs: { enabled: false }, rows: { kind: "records" } } }),
      },
      ["pitches", "rows"],
    ],
    [
      "one context disabled (JSON string variable)",
      {
        contextIds: ALL,
        memoryContextId: "mem",
        editorContextIds: [],
        agenticSearch: kb({ type: "json", variable: JSON.stringify({ rows: { enabled: false } }) }),
      },
      ["docs", "pitches"],
    ],
    [
      "all disabled → none from search (no fall back to all)",
      {
        contextIds: ["docs", "rows"],
        editorContextIds: [],
        agenticSearch: kb({ type: "json", variable: { docs: { enabled: false }, rows: { enabled: false } } }),
      },
      [],
    ],
    [
      "unparsable config → none from search, editor still applies",
      { contextIds: ALL, editorContextIds: ["pitches"], agenticSearch: kb({ type: "json", variable: "{not json" }) },
      ["pitches"],
    ],
    [
      "config that is not an object → none from search",
      { contextIds: ALL, editorContextIds: [], agenticSearch: kb({ type: "json", variable: "[1,2]" }) },
      [],
    ],
    [
      "profile with a non-boolean enabled → none from search",
      { contextIds: ALL, editorContextIds: [], agenticSearch: kb({ type: "json", variable: { docs: { enabled: "no" } } }) },
      [],
    ],
    [
      "variable reference only hydration resolves → none from search",
      { contextIds: ALL, editorContextIds: [], agenticSearch: kb({ type: "variable", variable: "KB_PROFILES" }) },
      [],
    ],
    [
      "memory context always excluded, even when granted to the editor",
      { contextIds: ALL, memoryContextId: "mem", editorContextIds: ["mem", "pitches"], agenticSearch: {} },
      ["docs", "pitches", "rows"],
    ],
    [
      "agentic search present but disabled this turn (caller passes no agenticSearch)",
      { contextIds: ALL, memoryContextId: "mem", editorContextIds: ["pitches"] },
      ["pitches"],
    ],
    [
      "no agentic search + project scope",
      { contextIds: ALL, memoryContextId: "mem", editorContextIds: [], projectSearchContextIds: ["docs"] },
      ["docs"],
    ],
    ["no agentic search, no project, no editor → empty", { contextIds: ALL, editorContextIds: [] }, []],
  ])("%s", (_name, args, expected) => {
    expect(sorted(deriveConnectedContextIds(args))).toEqual(expected);
  });
});
