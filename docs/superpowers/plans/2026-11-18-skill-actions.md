# Skill Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skill declares named actions in `actions.yaml`; one tool call `run_skill_action` reads the declared platform data with the user's rights, hands it to the skill's script as files and runs it in the session sandbox.

**Architecture:** A strict schema parses `actions.yaml` from the skill folders already downloaded into the session sandbox. A new ExuluTool resolves the declared inputs through logic extracted from the generated read tools, writes them into a per-run directory that is excluded from artifact mirroring, and runs the command through a runner extracted from the existing `bash` wrapper (extra env, timeout, same mirroring). The skill author tool gains a guide tool and validates `actions.yaml` at save.

**Tech Stack:** TypeScript, zod 4, `yaml` 2.8 (new direct dependency, already in the tree), jest 29, `@anthropic-ai/sandbox-runtime` (unchanged).

**Spec:** `docs/superpowers/specs/2026-11-18-skill-actions-design.md`

## Global Constraints

- Work in a sibling worktree `../backend-skill-actions` on branch `feature/skill-actions` off `develop`; never in the primary checkout. Symlink `node_modules`.
- One jest process at a time, e.g. `npx jest <path> --runInBand`. No parallel fan-out, no servers started.
- Typecheck gate is an equality: `npx tsc --noEmit` reports exactly 8 errors with the same identities as on `develop`. Record the baseline before Task 1.
- No migration, no schema change, no frontend change, no network change.
- Caller-supplied values never appear in a shell command string.
- `.exulu-inputs` is never mirrored to S3, never restored, never listed as a session file.
- Tool id `run_skill_action`; env vars `EXULU_INPUTS_DIR`, `EXULU_SKILL_DIR`; file name `actions.yaml`; `version: 1`.
- Names: action and input names match `^[a-z][a-z0-9_]{0,39}$`. Limits: file ≤ 64 KB, ≤ 20 actions per skill, `timeout_seconds` default 60 / max 300, `items` limit default 50 / max 500, `text` ≤ 10,000 chars.
- Existing behaviour of `bash`, `get_<ctx>_item`, `find_<ctx>_items` (output strings included) must not change.
- Commit per task, conventional commits, header ≤ 100 chars. No push, no merge.

## Review Focus

- A `text` input containing `"; rm -rf . #`, `$(id)`, backticks and newlines → arrives byte-identical in `args.json`, nowhere in the command. (Task 5)
- A second `bash` call while an action's inputs directory exists → the directory is not mirrored and not listed. (Task 3)
- `items` matching 501 rows with limit 500 → `truncated: true` in the file and a warning line in the result. (Tasks 2, 5)
- An `actions.yaml` with a typo'd key → skill keeps working, action absent, reason visible in the tool description. (Tasks 1, 4)
- Command exceeds its timeout → process killed, inputs directory removed, result says so. (Tasks 3, 5)

---

### Task 1: `actions.yaml` schema and parser

**Files:**
- Create: `ee/invoke-skills/skill-actions/schema.ts`
- Test: `ee/invoke-skills/skill-actions/schema.test.ts`
- Modify: `package.json` (add `"yaml": "^2.8.3"` to dependencies)

**Interfaces:**
- Produces:
  ```ts
  export type ActionInput =
    | { type: "item"; context: string; fields?: string[]; description?: string }
    | { type: "items"; context: string; fields?: string[]; where?: Record<string, unknown>; description?: string }
    | { type: "text"; required: boolean; description?: string };
  export type SkillAction = { description: string; run: string; timeoutSeconds: number; inputs: Record<string, ActionInput> };
  export const ACTIONS_FILE = "actions.yaml";
  export const ACTIONS_MAX_BYTES = 64 * 1024;
  export const ACTION_INPUT_TYPES = ["item", "items", "text"] as const;
  export const parseActionsYaml: (text: string) =>
    { ok: true; actions: Record<string, SkillAction> } | { ok: false; error: string };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const VALID = `version: 1
actions:
  export:
    description: Writes the workbook.
    run: python3 "$EXULU_SKILL_DIR/scripts/export.py"
    inputs:
      pitch: { type: item, context: mv_pitches, fields: [felder] }
      note: { type: text, required: false }
`;
test("valid file", () => {
  const r = parseActionsYaml(VALID);
  expect(r.ok && r.actions.export.timeoutSeconds).toBe(60);
  expect(r.ok && r.actions.export.inputs.note).toEqual({ type: "text", required: false });
});
test("text input is required by default", () => {
  const r = parseActionsYaml(VALID.replace(", required: false", ""));
  expect(r.ok && (r.actions.export.inputs.note as any).required).toBe(true);
});
test.each([
  ["wrong version", VALID.replace("version: 1", "version: 2")],
  ["unknown top-level key", VALID + "extra: 1\n"],
  ["unknown action key", VALID.replace("    run:", "    rnu: x\n    run:")],
  ["bad action name", VALID.replace("  export:", "  Export-1:")],
  ["unknown input type", VALID.replace("type: text", "type: file")],
  ["item without context", VALID.replace("context: mv_pitches, ", "")],
  ["timeout above 300", VALID.replace("    inputs:", "    timeout_seconds: 301\n    inputs:")],
  ["not yaml", "{{{"],
  ["oversized", VALID + "#".repeat(ACTIONS_MAX_BYTES)],
])("refuses: %s", (_n, text) => {
  const r = parseActionsYaml(text);
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error.length).toBeGreaterThan(0);
});
test("refuses more than 20 actions", () => { /* build 21 actions, expect ok:false */ });
```

- [ ] **Step 2: Run** `npx jest ee/invoke-skills/skill-actions/schema.test.ts --runInBand` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `parseActionsYaml` with `yaml`'s `parse` and strict zod objects (`z.strictObject`), mapping `timeout_seconds` → `timeoutSeconds`. The error is the first zod issue as `<path>: <message>`. Never throws.
- [ ] **Step 4: Run the tests** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(skills): actions.yaml schema and parser`

### Task 2: Data-returning read functions shared with the read tools

**Files:**
- Modify: `src/templates/tools/context-read-tools.ts`
- Test: `src/templates/tools/context-read-tools.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export type ReadFailure = { ok: false; message: string };
  export const readContextItem: (
    context: ExuluContext,
    args: { id?: string; external_id?: string; fields?: string[] },
    caller: { user?: User; req?: any },
    deps?: ReadToolDeps,
  ) => Promise<{ ok: true; item: Record<string, unknown> } | ReadFailure>;
  export const findContextItems: (
    context: ExuluContext,
    args: { where?: Record<string, any>; limit?: number; fields?: string[]; maxLimit?: number },
    caller: { user?: User; req?: any },
  ) => Promise<{ ok: true; items: Record<string, unknown>[]; limit: number; truncated: boolean } | ReadFailure>;
  ```
  `maxLimit` defaults to `FIND_MAX_LIMIT`. `truncated` is determined by fetching `limit + 1` rows and returning `limit`.

- [ ] **Step 1: Write the failing tests** (using the file's existing fixtures)

```ts
test("readContextItem returns the projected item as data", async () => {
  const r = await readContextItem(ctx, { id: "a", fields: ["title"] }, { user });
  expect(r).toEqual({ ok: true, item: { id: "a", title: "Alpha" } });
});
test("readContextItem: unreadable and missing give the same message", async () => {
  const a = await readContextItem(ctx, { id: "forbidden" }, { user });
  const b = await readContextItem(ctx, { id: "nope" }, { user });
  expect(a.ok).toBe(false);
  expect(a).toEqual(b);
});
test("findContextItems honours maxLimit and reports truncation", async () => {
  // fixture with 3 rows
  const r = await findContextItems(ctx, { limit: 2, maxLimit: 500 }, { user });
  expect(r.ok && r.items.length).toBe(2);
  expect(r.ok && r.truncated).toBe(true);
});
test("findContextItems without maxLimit clamps at 50", async () => {
  const r = await findContextItems(ctx, { limit: 999 }, { user });
  expect(r.ok && r.limit).toBe(50);
});
test("guest reads nothing", async () => {
  expect((await readContextItem(ctx, { id: "a" }, {})).ok).toBe(false);
  const r = await findContextItems(ctx, {}, {});
  expect(r.ok && r.items).toEqual([]);
});
```

- [ ] **Step 2: Run** `npx jest src/templates/tools/context-read-tools.test.ts --runInBand` — Expected: new tests FAIL, existing PASS.
- [ ] **Step 3: Implement.** Move the bodies of the two `execute` functions into `readContextItem` / `findContextItems`; the tools call them and format exactly the strings they return today (`Item: …`, `Found n item(s): …`, every error sentence unchanged). The find tool passes no `maxLimit` and ignores `truncated`.
- [ ] **Step 4: Run the whole file** — Expected: all PASS, including every pre-existing test untouched.
- [ ] **Step 5: Commit** `refactor(tools): read tools share data-returning read functions`

### Task 3: Command runner with extra env and timeout; inputs directory never mirrored

**Files:**
- Modify: `ee/invoke-skills/artifact-filter.ts` (add `".exulu-inputs"` to `IGNORED_SEGMENTS`)
- Modify: `ee/invoke-skills/create-sandbox.ts` (extract the runner from the `bash` wrapper, ~1140-1250; `runWrapped` ~865; `SessionSandboxHandle` ~202)
- Test: `ee/invoke-skills/artifact-filter.test.ts`, new `ee/invoke-skills/create-sandbox.run-command.test.ts` (same harness as `create-sandbox.env.test.ts`)

**Interfaces:**
- Produces, on `SessionSandboxHandle`:
  ```ts
  runCommand: (
    command: string,
    options?: { extraEnv?: Record<string, string>; timeoutMs?: number },
  ) => Promise<{
    stdout: string; stderr: string; exitCode: number; timedOut: boolean;
    artifacts: Array<{ path: string; relativePath: string; key?: string; url?: string }>;
    artifactsOmitted?: number;
  }>;
  ```
  Semantics: sandbox-wrapped like `bash`; `extraEnv` is merged over the session env for this call only; on timeout the process group is killed, `timedOut` is true and `exitCode` is 124; snapshot → run → snapshot → mirror → `[exulu-artifacts]` block appended to `stdout`, exactly as `bash` does today.

- [ ] **Step 1: Write the failing tests**

```ts
// artifact-filter.test.ts
test("the action inputs directory is never an artifact", () => {
  expect(isIgnoredArtifactPath(".exulu-inputs/r1/pitch.json")).toBe(true);
});
// create-sandbox.run-command.test.ts
test("extraEnv reaches the command and does not leak into the next call", async () => {
  const a = await handle.runCommand('printf %s "$EXULU_INPUTS_DIR"', { extraEnv: { EXULU_INPUTS_DIR: "/x" } });
  expect(a.stdout.startsWith("/x")).toBe(true);
  const b = await handle.runCommand('printf %s "${EXULU_INPUTS_DIR:-none}"');
  expect(b.stdout.startsWith("none")).toBe(true);
});
test("timeout kills the command", async () => {
  const r = await handle.runCommand("sleep 5", { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBe(124);
});
test("a file created by the command is mirrored, .exulu-inputs is not", async () => {
  const r = await handle.runCommand("mkdir -p .exulu-inputs/r1 && echo x > .exulu-inputs/r1/a.json && echo y > out.txt");
  expect(r.artifacts.map((a) => a.relativePath)).toEqual(["out.txt"]);
});
test("the bash tool still returns stdout, exit code and the artifacts block", async () => { /* via handle.tools.bash.execute */ });
```

- [ ] **Step 2: Run both test files** — Expected: FAIL.
- [ ] **Step 3: Implement.** `runCommand` owns snapshot, execution, diff, mirroring and the stdout block. The `bash` tool keeps delegating the execution itself to bash-tool's original `execute` (its truncation and cwd pinning stay) and uses the same snapshot/mirror helper; `runCommand` executes through `wrapIfNeeded` + spawn with `{ env: { ...sandboxedExecEnv, ...extraEnv } }`, cwd = `sessionDir`, a kill timer, `EXEC_MAX_BUFFER`. Confirm the restore path (`create-sandbox.ts:422`) and `session-file-listing.ts` already go through `isIgnoredArtifactPath`, so the new segment covers both.
- [ ] **Step 4: Run** the two new files plus `create-sandbox.env.test.ts`, `create-sandbox.project.test.ts`, `create-sandbox.symlink.test.ts`, one after another — Expected: PASS.
- [ ] **Step 5: Commit** `feat(skills): sandbox command runner with env and timeout, inputs dir excluded from mirroring`

### Task 4: Load the actions of a session's skills

**Files:**
- Create: `ee/invoke-skills/skill-actions/load.ts`
- Test: `ee/invoke-skills/skill-actions/load.test.ts`

**Interfaces:**
- Consumes: `parseActionsYaml`, `ACTIONS_FILE`, `ACTIONS_MAX_BYTES` (Task 1); `readRegularFileInside` from `ee/invoke-skills/safe-fs.ts`.
- Produces:
  ```ts
  export type LoadedSkillActions = {
    bySkill: Record<string, { skillDir: string; actions: Record<string, SkillAction> }>;
    problems: Array<{ skill: string; error: string }>;
  };
  export const loadSkillActions: (sessionDir: string, skills: Array<{ name: string }>) => Promise<LoadedSkillActions>;
  export const describeActions: (loaded: LoadedSkillActions) => string;
  ```
  `describeActions` renders, per action: `<skill> / <action> — <description>` and one line per input `  <name> (<type>[, context <ctx>][, optional]) — <description>`; then one line per problem: `skill "<name>": actions.yaml ignored — <error>`.

- [ ] **Step 1: Write the failing tests** — a temp dir with `skills/a/actions.yaml` valid, `skills/b/actions.yaml` invalid, `skills/c/` without the file, `skills/d/actions.yaml` a symlink to a file outside the session dir:

```ts
expect(Object.keys(loaded.bySkill)).toEqual(["a"]);
expect(loaded.problems.map((p) => p.skill).sort()).toEqual(["b", "d"]);
expect(describeActions(loaded)).toContain("a / export — Writes the workbook.");
expect(describeActions(loaded)).toContain('skill "b": actions.yaml ignored —');
```

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** Missing file → skipped silently. Read through `readRegularFileInside`; unreadable or over the cap → a problem entry. Never throws.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(skills): load declared actions from the session's skills`

### Task 5: The `run_skill_action` tool and its registration

**Files:**
- Create: `ee/invoke-skills/skill-actions/tool.ts`
- Test: `ee/invoke-skills/skill-actions/tool.test.ts`
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (push into `currentTools` next to `collectSkillAuthorTools`, after the sandbox exists)
- Test: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts` (extend)

**Interfaces:**
- Consumes: `LoadedSkillActions`, `describeActions` (Task 4); `readContextItem`, `findContextItems` (Task 2); `handle.runCommand`, `handle.sessionDir` (Task 3).
- Produces:
  ```ts
  export const RUN_SKILL_ACTION_TOOL_ID = "run_skill_action";
  export const createRunSkillActionTool: (deps: {
    handle: Pick<SessionSandboxHandle, "sessionDir" | "runCommand">;
    loaded: LoadedSkillActions;
    contexts: ExuluContext[];
    connectedContextIds: Set<string>;
    truncate: (text: string, kind: "stdout" | "stderr") => string;
  }) => ExuluTool;
  ```
  Input schema: `{ skill: string, action: string, inputs?: Record<string, unknown> }`. Per input type the value is: `item` → a string id or `{ external_id: string }`; `items` → `{ where?: object, limit?: number }` or omitted; `text` → string.
  Result: `{ result: string }` where the string is `exit_code: <n>` + optional `timed out after <s>s` + optional `warning: input "<name>" was cut at <limit> items` lines + `stdout:` / `stderr:` blocks.

- [ ] **Step 1: Write the failing tests** (fake `handle.runCommand` that records its arguments and inspects the inputs directory while "running"):

```ts
test("item input lands as a file, ids never in the command", async () => {
  await run({ skill: "a", action: "export", inputs: { pitch: "id-1" } });
  expect(seen.command).toBe('python3 "$EXULU_SKILL_DIR/scripts/export.py"');
  expect(seen.extraEnv.EXULU_SKILL_DIR).toBe(join(sessionDir, "skills", "a"));
  expect(seen.files["pitch.json"]).toEqual({ id: "id-1", felder: {} });
  expect(seen.extraEnv.EXULU_INPUTS_DIR.startsWith(join(sessionDir, ".exulu-inputs"))).toBe(true);
});
test("hostile text is data only", async () => {
  const evil = '"; rm -rf . #\n$(id) `id`';
  await run({ skill: "a", action: "note", inputs: { note: evil } });
  expect(seen.files["args.json"]).toEqual({ note: evil });
  expect(seen.command).not.toContain("rm -rf");
});
test("items envelope and truncation warning", async () => {
  const r = await run({ skill: "a", action: "list", inputs: { rows: { limit: 2 } } }); // 3 rows match
  expect(seen.files["rows.json"]).toEqual({ items: [expect.anything(), expect.anything()], limit: 2, truncated: true });
  expect(r.result).toContain('warning: input "rows" was cut at 2 items');
});
test("yaml where is AND-ed with the caller's where", async () => { /* both keys reach findContextItems */ });
test("inputs directory is removed after success, failure and timeout", async () => { /* three runs, dir absent each time */ });
test.each([
  ["unknown skill", { skill: "zzz", action: "export" }, "Available:"],
  ["unknown action", { skill: "a", action: "zzz" }, "Available:"],
  ["missing input", { skill: "a", action: "export", inputs: {} }, 'input "pitch" is required'],
  ["surplus input", { skill: "a", action: "export", inputs: { pitch: "1", x: "y" } }, 'unknown input "x"'],
  ["context not connected", { skill: "a", action: "other_ctx", inputs: { it: "1" } }, "not connected to this agent"],
  ["unreadable item", { skill: "a", action: "export", inputs: { pitch: "forbidden" } }, "not found"],
  ["text too long", { skill: "a", action: "note", inputs: { note: "x".repeat(10001) } }, "10000"],
])("refuses without running: %s", async (_n, input, part) => {
  const r = await run(input as any);
  expect(r.result).toContain(part);
  expect(seen.command).toBeUndefined();
});
test("the tool description lists actions and problems", () => {
  expect(tool.description).toContain("a / export —");
});
// convert-exulu-tools-to-ai-sdk-tools.test.ts
test("no skill with actions → no run_skill_action tool", async () => { /* expect key absent */ });
test("sandbox + a skill with actions → the tool is present and passes the audit loop", async () => { /* expect key present; audit emitter called on execute */ });
```

- [ ] **Step 2: Run** `npx jest ee/invoke-skills/skill-actions/tool.test.ts --runInBand` — Expected: FAIL.
- [ ] **Step 3: Implement the tool.** Order: resolve skill and action → validate input names and shapes → check every context id against `connectedContextIds` → resolve all inputs (as `params.user`, `params.req`) → create `<sessionDir>/.exulu-inputs/<randomUUID>/` (mode 0700) and write the files → `runCommand(action.run, { extraEnv, timeoutMs })` → remove the directory in `finally`. `needsApproval: false`, category as for sandbox-adjacent tools.
- [ ] **Step 4: Register it.** In `convertExuluToolsToAiSdkTools`, after `sharedSessionSandbox` exists: `loadSkillActions(sharedSessionSandbox.sessionDir, currentSkills)`; if it has at least one action or one problem and the tool is not in `disabledTools`, push the tool. `connectedContextIds` = contexts of the agent's `knowledge_base_editor` config ∪ the contexts handed to `agentic_context_search` for this agent (the memory context excluded) — read lines ~296-306 and ~394-432 for both sets. `truncate` applies `truncateToolOutput` with the same ratios the `bash` wrapper uses (0.10 stdout, 0.40 stderr).
- [ ] **Step 5: Run** both test files, one after another — Expected: PASS.
- [ ] **Step 6: Typecheck gate** `npx tsc --noEmit` — Expected: exactly the 8 baseline errors.
- [ ] **Step 7: Commit** `feat(skills): run_skill_action runs a declared action with platform data as files`

### Task 6: Skill author tool — guide, prompt, validation at save

**Files:**
- Create: `src/skills/authoring-guide.ts`
- Modify: `src/templates/tools/skill-author-tools.ts`, `src/templates/tools/skill-author-config.ts`
- Test: `src/templates/tools/skill-author-tools.test.ts`, `src/templates/tools/skill-author-config.test.ts` (extend), new `src/skills/authoring-guide.test.ts`

**Interfaces:**
- Consumes: `parseActionsYaml`, `ACTIONS_FILE`, `ACTION_INPUT_TYPES` (Task 1).
- Produces: `export const SKILL_AUTHORING_GUIDE: string`; a tool with id `skill_guide` in the author set, result type `{ type: "skill_guide"; result: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// authoring-guide.test.ts — drift guard
test.each([...ACTION_INPUT_TYPES, "version", "actions", "run", "inputs", "timeout_seconds",
           "EXULU_INPUTS_DIR", "EXULU_SKILL_DIR", "[exulu-artifacts]", "run_skill_action"])(
  "the guide names %s", (term) => expect(SKILL_AUTHORING_GUIDE).toContain(term));
test("the example in the guide parses", () => {
  const yaml = SKILL_AUTHORING_GUIDE.match(/```yaml\n([\s\S]*?)```/)![1];
  expect(parseActionsYaml(yaml).ok).toBe(true);
});
// skill-author-tools.test.ts
test("skill_guide returns the guide", async () => { /* result === SKILL_AUTHORING_GUIDE */ });
test("skill_create refuses an invalid actions.yaml and saves nothing", async () => {
  /* files: SKILL.md + actions.yaml with version: 2 → result contains "actions.yaml"; no row inserted, no upload */
});
test("skill_update refuses an invalid actions.yaml and keeps the version", async () => { /* same */ });
// skill-author-config.test.ts
test("the prompt points at skill_guide", () => expect(SKILL_AUTHOR_PROMPT).toContain("skill_guide"));
```

- [ ] **Step 2: Run** the three files, one after another — Expected: FAIL.
- [ ] **Step 3: Write the guide** with the seven sections of spec §8. Verify every statement against the code before writing it (network: `create-sandbox.ts` `allowedDomains`; env: `skill-env.ts`; limits: `MAX_FILES`, `MAX_FILE_BYTES` in `skill-author-tools.ts` and the constants of Task 1; artifacts block: Task 3). State nothing you could not find.
- [ ] **Step 4: Implement** the `skill_guide` tool (no input, no approval, present whenever the author tool is enabled), the prompt sentence, and the validation in the shared path of `skill_create` / `skill_update` before anything is written.
- [ ] **Step 5: Run** the three files — Expected: PASS. Typecheck gate — Expected: 8.
- [ ] **Step 6: Commit** `feat(skills): skill author explains IMP specifics and validates actions.yaml`

### Task 7: Documentation page

**Files:**
- Create: `mintlify-docs/building/skills/actions.mdx`
- Modify: `mintlify-docs/docs.json` (add `"building/skills/actions"` after `"building/skills/connect-your-agent"`), `mintlify-docs/building/skills/overview.mdx` (one paragraph "How skills on the IMP differ" linking to the new page)

- [ ] **Step 1: Write the page** from `SKILL_AUTHORING_GUIDE`: when to use an action, the file format with the example, the three input types, the env vars, a Python and a Node script reading `EXULU_INPUTS_DIR`, the connected-contexts rule, limits, staying portable. Follow `mintlify-docs/AGENTS.md`; "IMP" naming.
- [ ] **Step 2: Verify** every key, limit and env var on the page against `schema.ts` and `tool.ts` by grep; the YAML example on the page is the one from the guide.
- [ ] **Step 3: Commit** `docs(skills): skill actions`

---

## After the last task

Whole-branch review against the spec, three-dot diff against `develop`. Then stop: merge, push, release and the manual check on a Linux instance are Daniel's. The mevakipi change (spec §9) is a separate plan after the release.
