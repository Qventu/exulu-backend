# Routine Work Status (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each routine a configurable list of work statuses and each run a work status (separate from the technical `state`) that people, tools and the agent can set.

**Architecture:** Pure rules live in one module (`work-status.ts`: config parsing/validation and the write decision); a thin store applies them to `job_results`. A `routine` handle built per turn from either the worker's job result id or the run session is added to the `ExuluTool.execute` context and backs a built-in `set_routine_status` tool. GraphQL exposes the fields, two filters and one mutation.

**Tech Stack:** TypeScript, knex/Postgres, Apollo GraphQL, AI SDK tools, jest.

**Spec:** `docs/superpowers/specs/2026-11-16-routine-work-status-design.md` — read it first. The frontend has its own plan: `exulu/frontend/docs/superpowers/plans/2026-11-16-routine-work-status-frontend.md`.

## Global Constraints

- `job_results.state` and everything reading it are untouched.
- Status key format: `^[a-z][a-z0-9_]{1,39}$`, unique per routine, immutable once saved.
- `default` must be an existing key and must not be a `done` status.
- A routine with `work_statuses` null or `statuses: []` behaves exactly as today (no default written, no tool injected, `routine.statuses` is `[]`).
- Human wins only for writes with origin `"worker"`; origin `"chat"` writes apply.
- `updated_by` shapes: `{kind:"user",id}`, `{kind:"tool",id,user?}`, `{kind:"agent",user?}`, `{kind:"default"}`.
- Commit messages follow commitlint (header ≤ 100 chars). Run `npx jest <path>` for tests, `npx tsc --noEmit -p tsconfig.json` for types (pre-existing errors in `auth/flow.ts`, `validate.ts`, `openai-transformer.ts` are not yours).
- JSON columns may come back as strings — always read them through `parseMaybeJson`-style parsing.

## Review Focus

1. Run row pruned by retention while its session is continued in chat → `routine` is `undefined`, tools still work. (Task 5)
2. A run carries a status key that was later deleted from the routine config → reads return the stored key, `update` to a valid key works, GraphQL does not throw. (Tasks 3, 7)
3. `work_statuses` arrives as a JSON string, as `{}`, or with `statuses` missing → treated as "not configured", never a crash. (Task 1)
4. A tool calls `update({ status })` on a routine without statuses → throws a clear error that names the routine; the tool's own work (e.g. the uploaded XML) is not rolled back. (Task 3; noted in Task 5 for tool authors)
5. Worker retry after a person set a done status → status unchanged, call resolves. (Task 3)

---

### Task 1: Config rules — `work-status.ts`

**Files:**
- Create: `src/exulu/routines/work-status.ts`
- Test: `src/exulu/routines/work-status.test.ts`

**Interfaces — Produces:**

```ts
export type WorkStatus = { key: string; label: string; color?: string; done?: boolean };
export type WorkStatusConfig = { statuses: WorkStatus[]; default: string | null };
export type WorkStatusActor =
  | { kind: "user"; id: number }
  | { kind: "tool"; id: string; user?: number }
  | { kind: "agent"; user?: number }
  | { kind: "default" };
export const WORK_STATUS_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
/** Never throws. Anything unusable → { statuses: [], default: null }. */
export function parseWorkStatusConfig(raw: unknown): WorkStatusConfig;
/** Problems for a config about to be saved; [] when valid. `previous` enables the immutable-key check. */
export function validateWorkStatusConfig(next: unknown, previous?: unknown): string[];
export function isDoneStatus(config: WorkStatusConfig, key: string | null): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseWorkStatusConfig", () => {
  it("returns the empty config for null, {}, a string that is not JSON, and statuses missing", () => {
    for (const raw of [null, undefined, {}, "nope", { default: "x" }, { statuses: "x" }])
      expect(parseWorkStatusConfig(raw)).toEqual({ statuses: [], default: null });
  });
  it("parses a JSON string and drops entries without a valid key", () => {
    const raw = JSON.stringify({ statuses: [{ key: "neu", label: "Neu" }, { key: "Bad Key", label: "x" }, { label: "y" }], default: "neu" });
    expect(parseWorkStatusConfig(raw)).toEqual({ statuses: [{ key: "neu", label: "Neu" }], default: "neu" });
  });
  it("nulls a default that is not among the statuses", () => {
    expect(parseWorkStatusConfig({ statuses: [{ key: "neu", label: "Neu" }], default: "weg" }).default).toBeNull();
  });
});
describe("validateWorkStatusConfig", () => {
  const ok = { statuses: [{ key: "neu", label: "Neu" }, { key: "erledigt", label: "Erledigt", done: true }], default: "neu" };
  it("accepts null, an empty list and a complete config", () => {
    expect(validateWorkStatusConfig(null)).toEqual([]);
    expect(validateWorkStatusConfig({ statuses: [], default: null })).toEqual([]);
    expect(validateWorkStatusConfig(ok)).toEqual([]);
  });
  it("rejects bad key format, duplicate keys, empty label, unknown default, done default", () => {
    expect(validateWorkStatusConfig({ ...ok, statuses: [{ key: "Neu!", label: "Neu" }] }).join()).toMatch(/key/);
    expect(validateWorkStatusConfig({ ...ok, statuses: [...ok.statuses, { key: "neu", label: "x" }] }).join()).toMatch(/duplicate/i);
    expect(validateWorkStatusConfig({ ...ok, statuses: [{ key: "neu", label: " " }] }).join()).toMatch(/label/);
    expect(validateWorkStatusConfig({ ...ok, default: "weg" }).join()).toMatch(/default/);
    expect(validateWorkStatusConfig({ ...ok, default: "erledigt" }).join()).toMatch(/done/);
  });
  it("allows removing a status and editing label/colour/done, but not renaming a key in place", () => {
    expect(validateWorkStatusConfig({ statuses: [{ key: "neu", label: "Offen", color: "blue" }], default: "neu" }, ok)).toEqual([]);
  });
});
```

Key immutability note: with keys as identity, a "rename" is indistinguishable from remove + add, which is allowed. The rule is therefore enforced in the **frontend** (key field read-only after creation) and by this module only through the format/uniqueness checks. Do not invent a heuristic.

- [ ] **Step 2:** Run `npx jest src/exulu/routines/work-status.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement the module. `parseWorkStatusConfig` accepts object or JSON string, keeps `color`/`done` only when string/boolean.
- [ ] **Step 4:** Run the test — PASS.
- [ ] **Step 5:** `git commit -m "feat(routines): work-status config parsing and validation"`

---

### Task 2: Schema columns + validation on routine save

**Files:**
- Modify: `ee/schemas.ts` — `job_results` (line ~279) and `workflow_templates` (line ~461) field lists
- Modify: `src/graphql/schemas/index.ts` — wrap the generated routine write mutations
- Test: `src/exulu/routines/work-status-save.test.ts`

**Interfaces — Consumes:** `validateWorkStatusConfig` (Task 1). **Produces:** columns `workflow_templates.work_statuses` (json), `job_results.work_status` (text, `index: true`), `job_results.work_status_updated_at` (date), `job_results.work_status_updated_by` (json); and

```ts
/** src/exulu/routines/work-status.ts */
export function assertWorkStatusConfigSavable(next: unknown, previous?: unknown): void; // throws Error("Invalid work statuses: <problems joined by '; '>")
```

- [ ] **Step 1:** Add the four fields to `ee/schemas.ts` in the style of their neighbours (`type: "json"` / `"text"` / `"date"`). Columns are created by the existing init path (`src/postgres/init-exulu-db.ts`) — verify by reading it that new fields on existing tables are added on boot; if it only creates missing tables, add the `ALTER TABLE … ADD COLUMN IF NOT EXISTS` where that file handles other late-added columns.
- [ ] **Step 2: Write the failing test** for `assertWorkStatusConfigSavable`: throws with all problems joined for an invalid config; does not throw for `undefined` (field not part of the write), `null`, and a valid config.
- [ ] **Step 3:** Implement it, and in `src/graphql/schemas/index.ts` after the generic resolvers are generated, wrap `resolvers.Mutation.workflow_templatesCreateOne`, `…UpdateOneById` and `…UpdateOne`: when `args.input.work_statuses !== undefined`, call `assertWorkStatusConfigSavable(args.input.work_statuses, <current row's value for updates>)` before delegating. Follow how nearby routine-specific resolvers in that file load the row (`db.from("workflow_templates")`, line ~1532).
- [ ] **Step 4:** `npx jest src/exulu/routines/work-status-save.test.ts src/postgres/core-schema.test.ts` — PASS; `tsc` clean for touched files.
- [ ] **Step 5:** `git commit -m "feat(routines): work-status columns and save-time validation"`

---

### Task 3: The write rule and the store

**Files:**
- Modify: `src/exulu/routines/work-status.ts`
- Create: `src/exulu/routines/work-status-store.ts`
- Test: `src/exulu/routines/work-status.test.ts` (decision), `src/exulu/routines/work-status-store.test.ts` (store, with a stubbed `db`)

**Interfaces — Produces:**

```ts
// work-status.ts — pure
export type WorkStatusOrigin = "worker" | "chat" | "manual";
export type WorkStatusDecision =
  | { action: "write"; status: string | null }
  | { action: "skip"; reason: "human_set" | "unchanged" }
  | { action: "reject"; message: string };
export function decideWorkStatusWrite(input: {
  config: WorkStatusConfig; routineName: string;
  current: { status: string | null; updatedBy: WorkStatusActor | null };
  next: string | null;            // null only allowed for origin "manual" (clear)
  origin: WorkStatusOrigin;
}): WorkStatusDecision;

// work-status-store.ts
export type RunWorkStatusRow = { id: string; workflow: string; work_status: string | null; work_status_updated_at: unknown; work_status_updated_by: WorkStatusActor | null };
export async function loadRunWorkStatus(db: any, jobResultId: string): Promise<RunWorkStatusRow | undefined>;
export async function loadRunBySession(db: any, sessionId: string): Promise<RunWorkStatusRow | undefined>; // newest job_results row with session = id and workflow not null
export async function loadRoutineWorkStatusConfig(db: any, workflowId: string): Promise<{ id: string; name: string; config: WorkStatusConfig } | undefined>;
/** Applies decideWorkStatusWrite; throws Error(message) on reject; returns the decision otherwise. */
export async function setRunWorkStatus(db: any, args: { jobResultId: string; status: string | null; actor: WorkStatusActor; origin: WorkStatusOrigin }): Promise<WorkStatusDecision>;
```

- [ ] **Step 1: Write the failing decision tests** (config `C` = neu / angebot_im_erp / rueckfrage / erledigt(done), default neu):

```ts
const base = { config: C, routineName: "Angebote", current: { status: "neu", updatedBy: { kind: "default" } as const } };
it("writes a configured status", () => expect(decideWorkStatusWrite({ ...base, next: "angebot_im_erp", origin: "worker" })).toEqual({ action: "write", status: "angebot_im_erp" }));
it("skips when unchanged", () => expect(decideWorkStatusWrite({ ...base, next: "neu", origin: "worker" })).toEqual({ action: "skip", reason: "unchanged" }));
it("rejects an unknown key and lists the allowed ones", () => {
  const d = decideWorkStatusWrite({ ...base, next: "fertig", origin: "worker" });
  expect(d).toMatchObject({ action: "reject" }); expect((d as any).message).toContain("neu, angebot_im_erp, rueckfrage, erledigt");
});
it("rejects when the routine has no statuses, naming the routine", () => {
  const d = decideWorkStatusWrite({ ...base, config: { statuses: [], default: null }, next: "neu", origin: "worker" });
  expect((d as any).message).toContain('"Angebote" has no work statuses configured');
});
const human = { status: "erledigt", updatedBy: { kind: "user", id: 14 } as const };
it("worker write does not override a human-set status", () => expect(decideWorkStatusWrite({ ...base, current: human, next: "angebot_im_erp", origin: "worker" })).toEqual({ action: "skip", reason: "human_set" }));
it("chat and manual writes do override it", () => {
  for (const origin of ["chat", "manual"] as const)
    expect(decideWorkStatusWrite({ ...base, current: human, next: "angebot_im_erp", origin })).toEqual({ action: "write", status: "angebot_im_erp" });
});
it("clearing (null) is manual-only", () => {
  expect(decideWorkStatusWrite({ ...base, next: null, origin: "manual" })).toEqual({ action: "write", status: null });
  expect(decideWorkStatusWrite({ ...base, next: null, origin: "chat" })).toMatchObject({ action: "reject" });
});
it("a stored key that is no longer configured can be replaced", () =>
  expect(decideWorkStatusWrite({ ...base, current: { status: "alt_geloescht", updatedBy: null }, next: "neu", origin: "worker" })).toEqual({ action: "write", status: "neu" }));
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement `decideWorkStatusWrite`.
- [ ] **Step 4: Store tests** with a hand-rolled `db` stub (see `src/exulu/email-inbound/intake.test.ts` for the stubbing style): `setRunWorkStatus` updates `work_status`, `work_status_updated_at` (a `Date`), `work_status_updated_by` (JSON string of the actor) on action `write`; performs no update on `skip`; throws on `reject`; throws `Run <id> not found` when the row is missing. `loadRunBySession` ignores rows without `workflow`.
- [ ] **Step 5:** Implement the store. Reads go through `parseWorkStatusConfig` / JSON-parse of `work_status_updated_by`.
- [ ] **Step 6:** Tests PASS. `git commit -m "feat(routines): work-status write rule and store"`

---

### Task 4: Default status when a run is created

**Files:**
- Modify: `src/exulu/routines/run-state.ts` (`upsertWorkflowRunStart`, line ~60 — the insert branch only)
- Modify: `src/exulu/email-inbound/intake.ts` (the run insert at line ~116; **not** the failed-payload insert at ~352, and not filtered rows)
- Test: extend `src/exulu/routines/run-state.test.ts` and `src/exulu/email-inbound/intake.test.ts`

**Interfaces — Consumes:** `loadRoutineWorkStatusConfig` (Task 3). **Produces:**

```ts
/** work-status-store.ts — columns to spread into a job_results insert; {} when the routine has no statuses or no default. */
export async function defaultWorkStatusColumns(db: any, workflowId: string): Promise<{ work_status?: string; work_status_updated_at?: Date; work_status_updated_by?: string }>;
```

- [ ] **Step 1: Failing tests:** a new run row for a routine with default `neu` is inserted with `work_status: "neu"` and `work_status_updated_by` = `{"kind":"default"}`; a routine without statuses inserts none of the three columns; a filtered email run (`state: "filtered"`) inserts none; `upsertWorkflowRunStart` on an **existing** row (resume/retry) does not touch `work_status`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement and spread into the two inserts.
- [ ] **Step 4:** `npx jest src/exulu/routines src/exulu/email-inbound` — PASS.
- [ ] **Step 5:** `git commit -m "feat(routines): write the default work status when a run is created"`

---

### Task 5: The `routine` handle in the tool execute context

**Files:**
- Create: `src/exulu/routines/routine-handle.ts`
- Modify: `src/exulu/generate-stream.ts` (accept and forward `routineRun?: { jobResultId: string }` in `generateStream`; it already loads `sessionData`)
- Modify: `ee/workers.ts` (`processUiMessagesFlow` → pass `routineRun: { jobResultId }` into `generateStream`; `jobResultId` is in scope where `routine: { id: workflow.id, name: workflow.name }` is passed, line ~613)
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (new trailing param `routineHandleFor?: (toolId: string) => RoutineHandle | undefined`; add `routine: routineHandleFor?.(cur.id)` to the object passed to `cur.tool.execute`, next to `exuluConfig`)
- Modify: `src/exulu/tool.ts` — document `routine?: RoutineHandle` in the execute input type/comment
- Modify: `src/index.ts` — export the `RoutineHandle` and `RoutineRunPatch` types
- Test: `src/exulu/routines/routine-handle.test.ts`

**Interfaces — Produces:**

```ts
export type RoutineRunPatch = { status?: string };
export type RoutineHandle = {
  id: string; name: string;
  statuses: { key: string; label: string; done?: boolean }[];
  runs: { current: { id: string; status: string | null; update(patch: RoutineRunPatch): Promise<void> } };
};
/**
 * One per turn. Resolves the run from jobResultId (worker) or from the session (chat on a run
 * session, decided by isRunSessionMetadata). Returns undefined when the turn is not part of a run
 * or the run row is gone. The returned factory binds the acting tool id for updated_by.
 */
export async function resolveRoutineHandleFactory(db: any, args: {
  sessionId?: string; sessionMetadata?: unknown; jobResultId?: string; actingUser?: number;
}): Promise<((actor: { kind: "tool"; id: string } | { kind: "agent" }) => RoutineHandle) | undefined>;
```

The object the factory returns is a `RoutineHandle` plus one non-exported extra used by Task 6:
`runs.current.updateWithResult(patch): Promise<WorkStatusDecision>`; `update` calls it and discards the result
(internal type `RoutineHandleInternal`, not exported from `src/index.ts`).

Origin is `"worker"` when `jobResultId` was passed, else `"chat"`. `update` rejects unknown patch keys with `Unknown routine run field(s): <keys>. Allowed: status`, an empty patch is a no-op, and after a successful write `runs.current.status` on that handle reflects the new value.

- [ ] **Step 1: Failing tests** (stub the store functions with `jest.mock("./work-status-store")`):
  - no `jobResultId`, session metadata not a run → `undefined`;
  - `jobResultId` given → handle with `id`/`name`/`statuses` from the routine and `runs.current.id === jobResultId`; `update({status:"angebot_im_erp"})` calls `setRunWorkStatus` with `origin: "worker"` and actor `{kind:"tool", id:"generate_offer_xml"}`;
  - run session without `jobResultId` → resolved via `loadRunBySession`, origin `"chat"`, actor carries `user: actingUser`;
  - run row missing (pruned) → `undefined`;
  - `update({ state: "completed" } as any)` rejects and calls nothing;
  - `update({})` resolves and calls nothing.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement the module.
- [ ] **Step 4:** Thread it: in `generateStream`, build the factory once (`sessionData.metadata`, `session`, `routineRun?.jobResultId`, `user?.id`) and pass `routineHandleFor = (toolId) => factory?.({ kind: "tool", id: toolId })` into `convertExuluToolsToAiSdkTools`. `generateSync` passes nothing.
- [ ] **Step 5:** `npx jest src/exulu/routines src/templates/tools` — PASS; `tsc` clean for touched files.
- [ ] **Step 6:** `git commit -m "feat(tools): routine handle in the execute context for routine-run sessions"`

---

### Task 6: Built-in `set_routine_status` tool

**Files:**
- Create: `src/templates/tools/routine-status-tool.ts`
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (inject next to `createParseDocumentTool`, line ~338; honour `disabled`)
- Test: `src/templates/tools/routine-status-tool.test.ts`

**Interfaces — Consumes:** the factory from Task 5 (convert receives it as a second new param `routineAgentHandle?: RoutineHandle`, i.e. `factory?.({ kind: "agent" })`). **Produces:**

```ts
export const SET_ROUTINE_STATUS_TOOL_ID = "set_routine_status";
/** undefined when handle is undefined or has no statuses. */
export function createRoutineStatusTool(handle: RoutineHandleInternal | undefined): ExuluTool | undefined;
```

Tool: name `Set routine status`, `needsApproval: false`, input `z.object({ status: z.enum(<keys>) })`; description lists every `key — label` and says: "Sets the work status of this routine run for the people working the run list. Use it when the step instructions tell you to, with exactly one of these values." Result on write: `Status set to "<label>".`; when the store skipped with `human_set`: `A person already set the status to "<label>"; left unchanged.`

The tool reads the outcome from `updateWithResult` (Task 5); `createRoutineStatusTool` therefore takes `RoutineHandleInternal | undefined`.

- [ ] **Step 1: Failing tests:** `undefined` for no handle and for `statuses: []`; schema enum equals the configured keys (`schema.safeParse({status:"erfunden"}).success === false`); execute calls `updateWithResult({status})` and returns the two messages above for `write` and `skip/human_set`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement and inject.
- [ ] **Step 4:** `npx jest src/templates/tools` — PASS.
- [ ] **Step 5:** `git commit -m "feat(tools): built-in set_routine_status tool for routine-run sessions"`

---

### Task 7: GraphQL — fields, filters, manual mutation

**Files:**
- Modify: `src/exulu/routines/runs-query.ts` (`RoutineRunsFilterArgs`, `applyRoutineRunFilters`, `mapRoutineRunRow`)
- Modify: `src/graphql/schemas/index.ts` (`type RoutineRun` ~1425, `routineRuns(...)` ~1109, new mutation next to `cancelRoutineRun` ~1259/2278)
- Test: `src/exulu/routines/runs-query.test.ts`, plus a resolver test beside the existing routine-run resolver tests (find with `grep -rl cancelRoutineRun src --include=*.test.ts`)

**Interfaces — Produces (GraphQL):**

```graphql
type RoutineRun { … work_status: String  work_status_updated_at: Date  work_status_updated_by: JSON }
routineRuns(…, workStatuses: [String!], workStatusOpen: Boolean): RoutineRunPage
setRoutineRunWorkStatus(id: ID!, status: String): RoutineRun
```

`workStatusOpen: true` → `work_status IS NULL OR work_status NOT IN (<done keys of that routine>)`; `false` → `work_status IN (<done keys>)`. The done keys depend on the routine, so the resolver loads the config for `args.workflow`; **`workStatusOpen` without `workflow` is ignored** (the cross-routine list has no single definition of done).

- [ ] **Step 1: Failing tests:** `mapRoutineRunRow` returns the three fields (JSON-parsing `work_status_updated_by` when it is a string; `null` when absent); `applyRoutineRunFilters` adds the `whereIn` for `workStatuses`, the open/done conditions given `doneKeys`, and nothing when `doneKeys` is undefined. Resolver: sets the status with actor `{kind:"user", id}` and origin `"manual"`; `status: null` clears; a run of a routine the caller cannot read → the same not-found error `cancelRoutineRun` uses; an unknown status → GraphQL error carrying the allowed keys; a stored key no longer in the config is returned as-is.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. `applyRoutineRunFilters` gets a 4th optional param `doneKeys?: string[]`. The mutation reuses `readableRoutines(db, user)` exactly like `cancelRoutineRun` (decision 1: whoever can read the runs may set the status).
- [ ] **Step 4:** `npx jest src/exulu/routines src/graphql` — PASS; `tsc` clean.
- [ ] **Step 5:** `git commit -m "feat(routines): work status in the routine-runs API"`

---

### Task 8: End-to-end check and docs

- [ ] **Step 1:** `npx jest src/exulu/routines src/templates/tools src/exulu/email-inbound src/graphql` and `npm run build` — all green.
- [ ] **Step 2:** Add a section "Work status" to the routines docs page where `cancelRoutineRun`/triggers are documented (find with `grep -rl "routineRuns" docs --include=*.md* | grep -v superpowers`): the config shape, the `routine` execute param with the one-line usage example from the spec, the built-in tool, the human-wins rule.
- [ ] **Step 3:** `git commit -m "docs(routines): work status, routine handle and set_routine_status"`
- [ ] **Step 4:** Manual check against a dev instance, recorded in the PR description: configure four statuses on a routine via the API, fire it with `testFireWorkflowTrigger`, confirm the run row gets the default, call `setRoutineRunWorkStatus`, confirm `routineRuns(workflow, workStatusOpen: true|false)` splits correctly.
