# Step-Budget Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The knowledge-search `max_steps` bounds only agentic-retrieval calls per message; a new per-agent `max_tool_steps` column owns the whole-turn tool budget (default 10); the final-step history flattening becomes prose so models stop mimicking tool-call syntax.

**Architecture:** Backend: rename `resolveMaxStepsFromToolConfigs` → `resolveRetrievalCallBudget` (same config entry, new meaning), add `resolveTurnStepBudget(maxStepCount, agent)` for the turn budget, and a new `retrievalBudgetGuard(limit, agenticToolKey, allToolKeys)` prepareStep guard that counts agentic tool calls in `steps[].toolCalls` and removes just that tool from `activeTools` once spent. Wire at the three provider sites + two gateway sites. Frontend: a general "Max tool steps per message" number field in Chat Experience (agents column, `sandbox_enabled` pattern) and a copy-only relabel of the wizard field.

**Tech Stack:** Backend: TypeScript, Vercel AI SDK v6, Knex/Postgres (auto-ALTER via `addMissingFields`), Jest. Frontend: Next.js, react-hook-form + zod, Apollo, next-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-step-budget-decoupling-design.md`

## Global Constraints

- Backend repo `/Users/daniel.claessen/Desktop/Projects/exulu/backend` (branch base: current `develop`); frontend repo `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (branch base: current `main` — the frontend has NO develop branch). Work in NEW worktrees named `backend-sbd` / `frontend-sbd` on branch `feature/step-budget-decoupling` (the names `backend-par`/`frontend-par` are TAKEN by a parallel session — do not touch them or the primary checkouts).
- `node_modules` symlinked from the primary checkouts works for jest/vitest/tsc/lint (NOT for `next build` — not needed in this plan).
- Baselines (verify before first change, compare after): backend `npx tsc --noEmit` has ~14 pre-existing errors and jest is fully green; frontend has 1 pre-existing tsc error at most and 1 pre-existing vitest failure in `components/shell/nav-config.test.ts`. Gates everywhere: zero NEW failures/errors.
- Exact names later tasks depend on: `DEFAULT_MAX_STEPS` (=10, unchanged), `resolveRetrievalCallBudget`, `resolveTurnStepBudget`, `retrievalBudgetGuard`, agents column `max_tool_steps` (number, 0/null ⇒ default), guard order `composePrepareSteps(contextGuard(contextWindow), retrievalGuard, finalAnswerGuard(turnBudget))`.
- Copy (verbatim): Chat Experience label **"Max tool steps per message"**; wizard label **"Max knowledge searches per message"**. All frontend strings in BOTH `messages/en.json` and `messages/de.json`; run `npm run check-messages` after i18n edits (31 pre-existing missing keys in `variables.*` are known).
- The parallel `project-agentic-retrieval` session plans edits to `ee/agentic-retrieval/pipeline/index.ts`, `convert-exulu-tools-to-ai-sdk-tools.ts`, and the knowledge-search wizard. This plan's touches there are one description line and copy — keep them minimal, no drive-by refactors.
- Commit per task: backend prefix `feat(steps):`, frontend `feat(agents):`.

---

## Backend

### Task 1: `resolveTurnStepBudget` + rename to `resolveRetrievalCallBudget` + `max_tool_steps` column

**Files:**
- Modify: `src/exulu/resolve-max-steps.ts` (rename + new function)
- Modify: `src/exulu/resolve-max-steps.test.ts`
- Modify: `src/postgres/core-schema.ts` (agents schema, after `sandbox_enabled` at ~line 277-281)
- Modify: `types/models/agent.ts` (ExuluAgent, near `sandbox_enabled?` at ~line 34)
- Modify: `src/exulu/provider.ts` — ONLY the identifier rename at lines 567, 568, 653, 654, 1192, 1193 and the import at line 2 (full rewiring is Task 4)

**Interfaces:**
- Produces: `resolveRetrievalCallBudget(toolConfigs: ExuluAgentToolConfig[] | undefined): number | undefined` (exact same body/behavior as the old `resolveMaxStepsFromToolConfigs`); `resolveTurnStepBudget(maxStepCount: number | undefined, agent: { max_tool_steps?: number | string | null } | undefined): number`; agents column `max_tool_steps` (auto-ALTER on boot — NO manual migration); `ExuluAgent.max_tool_steps?: number | null`.

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git worktree add ../backend-sbd -b feature/step-budget-decoupling develop
ln -s /Users/daniel.claessen/Desktop/Projects/exulu/backend/node_modules /Users/daniel.claessen/Desktop/Projects/exulu/backend-sbd/node_modules
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-sbd
```
All subsequent backend commands run from `/Users/daniel.claessen/Desktop/Projects/exulu/backend-sbd`.

- [ ] **Step 2: Write the failing tests**

In `src/exulu/resolve-max-steps.test.ts`: change the import line and every `resolveMaxStepsFromToolConfigs(` occurrence to `resolveRetrievalCallBudget(` (import: `import { resolveRetrievalCallBudget, resolveTurnStepBudget, finalAnswerGuard, DEFAULT_MAX_STEPS } from "./resolve-max-steps";`), rename the describe to `describe("resolveRetrievalCallBudget", ...)`, keep all existing cases. Then APPEND:

```ts
describe("resolveTurnStepBudget", () => {
  it("uses the explicit maxStepCount argument first", () => {
    expect(resolveTurnStepBudget(4, { max_tool_steps: 7 })).toBe(4);
    expect(resolveTurnStepBudget(4.9, undefined)).toBe(4);
  });

  it("falls back to the agent's max_tool_steps column", () => {
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: 7 })).toBe(7);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: 7.9 })).toBe(7);
    // pg number columns can surface as strings depending on driver config
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: "12" as never })).toBe(12);
  });

  it("returns the platform default for unset/zero/negative/garbage", () => {
    expect(resolveTurnStepBudget(undefined, undefined)).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, {})).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: null })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: 0 })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: -3 })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(undefined, { max_tool_steps: "banana" as never })).toBe(DEFAULT_MAX_STEPS);
    expect(resolveTurnStepBudget(0, { max_tool_steps: 0 })).toBe(DEFAULT_MAX_STEPS);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- src/exulu/resolve-max-steps.test.ts`
Expected: FAIL — `resolveRetrievalCallBudget`/`resolveTurnStepBudget` are not exported.

- [ ] **Step 4: Implement**

In `src/exulu/resolve-max-steps.ts`:
- Rename `resolveMaxStepsFromToolConfigs` → `resolveRetrievalCallBudget` (body unchanged) and replace its doc comment with:

```ts
/**
 * Read the `max_steps` option from the agentic retrieval tool's saved config.
 *
 * Since 2026-07-08 this bounds ONLY agentic-retrieval CALLS per message —
 * enforced by retrievalBudgetGuard, which removes the retrieval tool from
 * activeTools once the budget is spent. It no longer feeds the turn-wide step
 * budget (that is resolveTurnStepBudget / agents.max_tool_steps).
 *
 * Returns a positive integer, or undefined when unset/0/invalid.
 */
```

- Add below it:

```ts
/**
 * The per-turn step budget for ALL tools (bash, files, retrieval,
 * integrations). Precedence: explicit maxStepCount argument →
 * agents.max_tool_steps column (positive number; strings tolerated for pg
 * driver configs that return numerics as text) → DEFAULT_MAX_STEPS.
 */
export function resolveTurnStepBudget(
  maxStepCount: number | undefined,
  agent: { max_tool_steps?: number | string | null } | undefined,
): number {
  if (typeof maxStepCount === "number" && Number.isFinite(maxStepCount) && maxStepCount > 0) {
    return Math.floor(maxStepCount);
  }
  const raw = agent?.max_tool_steps;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_MAX_STEPS;
}
```

In `src/exulu/provider.ts`: update the import on line 2 to the new name and mechanically replace the six `resolveMaxStepsFromToolConfigs(` occurrences (lines 567, 568, 653, 654, 1192, 1193) with `resolveRetrievalCallBudget(` — expressions otherwise unchanged in this task.

In `src/postgres/core-schema.ts`, after the `sandbox_enabled` field object (~line 277-281) add:

```ts
    {
      // Per-turn budget for ALL tool steps on one chat message (bash, files,
      // knowledge search, integrations). 0/null = platform default
      // (DEFAULT_MAX_STEPS in resolve-max-steps.ts). Auto-ALTERed on boot.
      name: "max_tool_steps",
      type: "number",
    },
```

In `types/models/agent.ts`, after `sandbox_enabled?: boolean;` (~line 34) add:

```ts
    max_tool_steps?: number | null;
```

- [ ] **Step 5: Verify**

Run: `npm test -- src/exulu/resolve-max-steps.test.ts` → PASS (all old + new cases).
Run: `npm test` and `npx tsc --noEmit 2>&1 | grep -c "error TS"` → full suite green, error count at the pre-recorded baseline (no new).
Also confirm no stale references: `grep -rn "resolveMaxStepsFromToolConfigs" src ee` → no hits.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(steps): resolveTurnStepBudget + rename retrieval budget resolver; max_tool_steps column"
```

---

### Task 2: `retrievalBudgetGuard`

**Files:**
- Modify: `src/exulu/resolve-max-steps.ts` (new guard)
- Modify: `src/exulu/context-guard.ts:3-6` (widen `PrepareStepFn`)
- Test: `src/exulu/resolve-max-steps.test.ts` (append)

**Interfaces:**
- Consumes: `PrepareStepFn` from `./context-guard`; `composePrepareSteps` + `finalAnswerGuard` for the composition test.
- Produces: `retrievalBudgetGuard(limit: number | undefined, agenticToolKey: string | undefined, allToolKeys: string[]): PrepareStepFn` — inert when limit unset/≤0, key missing, or key not in allToolKeys; once prior `steps[].toolCalls` contain ≥ limit calls with `toolName === agenticToolKey`, returns `{ activeTools: allToolKeys minus agenticToolKey }` on that and every later step.

- [ ] **Step 1: Write the failing tests** — append to `src/exulu/resolve-max-steps.test.ts` (add `retrievalBudgetGuard` to the import, plus `import { composePrepareSteps } from "./context-guard";`):

```ts
describe("retrievalBudgetGuard", () => {
  const step = (...toolNames: string[]) => ({ toolCalls: toolNames.map((toolName) => ({ toolName })) });
  const KEYS = ["Context_Search", "bash", "writeFile"];

  it("is inert without a limit, without a key, or when the key is not registered", async () => {
    expect(await retrievalBudgetGuard(undefined, "Context_Search", KEYS)({ stepNumber: 1, steps: [step("Context_Search")] })).toBeUndefined();
    expect(await retrievalBudgetGuard(0, "Context_Search", KEYS)({ stepNumber: 1, steps: [step("Context_Search")] })).toBeUndefined();
    expect(await retrievalBudgetGuard(1, undefined, KEYS)({ stepNumber: 1, steps: [step("Context_Search")] })).toBeUndefined();
    expect(await retrievalBudgetGuard(1, "not_registered", KEYS)({ stepNumber: 1, steps: [step("not_registered")] })).toBeUndefined();
  });

  it("is inert while calls are under the limit", async () => {
    const guard = retrievalBudgetGuard(2, "Context_Search", KEYS);
    expect(await guard({ stepNumber: 0, steps: [] })).toBeUndefined();
    expect(await guard({ stepNumber: 1, steps: [step("Context_Search"), step("bash")] })).toBeUndefined();
  });

  it("removes ONLY the agentic tool once the limit is reached, on every later step", async () => {
    const guard = retrievalBudgetGuard(2, "Context_Search", KEYS);
    const spent = [step("Context_Search"), step("Context_Search")];
    expect(await guard({ stepNumber: 2, steps: spent })).toEqual({ activeTools: ["bash", "writeFile"] });
    // re-asserted on later steps too (activeTools applies per-step)
    expect(await guard({ stepNumber: 5, steps: [...spent, step("bash")] })).toEqual({ activeTools: ["bash", "writeFile"] });
  });

  it("counts multiple calls within one step", async () => {
    const guard = retrievalBudgetGuard(2, "Context_Search", KEYS);
    expect(await guard({ stepNumber: 1, steps: [step("Context_Search", "Context_Search")] })).toEqual({ activeTools: ["bash", "writeFile"] });
  });

  it("composes so finalAnswerGuard still strips ALL tools on the last step", async () => {
    const composed = composePrepareSteps(
      retrievalBudgetGuard(1, "Context_Search", KEYS),
      finalAnswerGuard(5),
    );
    const spent = [step("Context_Search")];
    // mid-turn: retrieval hidden, other tools alive
    expect(((await composed({ stepNumber: 2, steps: spent })) as { activeTools: string[] }).activeTools).toEqual(["bash", "writeFile"]);
    // final step: finalAnswerGuard's [] wins the shallow merge
    expect(((await composed({ stepNumber: 4, steps: spent })) as { activeTools: string[] }).activeTools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/exulu/resolve-max-steps.test.ts`
Expected: FAIL — `retrievalBudgetGuard` not exported (and possibly a TS error on `steps` in `PrepareStepFn`).

- [ ] **Step 3: Implement**

In `src/exulu/context-guard.ts`, replace the `PrepareStepFn` type (lines 3-6) with:

```ts
export type PrepareStepFn = (opts: {
  stepNumber: number;
  messages?: unknown[];
  /** Prior steps' results — the AI SDK provides toolCalls per step. */
  steps?: Array<{ toolCalls?: Array<{ toolName?: string }> }>;
}) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
```

In `src/exulu/resolve-max-steps.ts` add (with `import type { PrepareStepFn } from "./context-guard";` at the top):

```ts
/**
 * Bound agentic-retrieval CALLS per turn (spec 2026-07-08). Counts prior
 * steps' tool calls against the retrieval tool's REGISTERED key (the
 * sanitized tool name — resolve it at wiring time) and, once the budget is
 * spent, removes only that tool from activeTools. activeTools applies
 * per-step, so the exhausted state is re-asserted on every later step;
 * finalAnswerGuard runs later in the composition and its activeTools: []
 * still wins the final step.
 */
export function retrievalBudgetGuard(
  limit: number | undefined,
  agenticToolKey: string | undefined,
  allToolKeys: string[],
): PrepareStepFn {
  if (limit == null || limit <= 0 || !agenticToolKey || !allToolKeys.includes(agenticToolKey)) {
    return () => undefined;
  }
  const remainingTools = allToolKeys.filter((k) => k !== agenticToolKey);
  return ({ steps }) => {
    const calls = (steps ?? [])
      .flatMap((s) => s?.toolCalls ?? [])
      .filter((c) => c?.toolName === agenticToolKey).length;
    if (calls < limit) return undefined;
    return { activeTools: remainingTools };
  };
}
```

- [ ] **Step 4: Verify**

Run: `npm test -- src/exulu/resolve-max-steps.test.ts src/exulu/context-guard.test.ts` → PASS.
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → baseline count, no new.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(steps): retrievalBudgetGuard bounds agentic retrieval calls via activeTools"
```

---

### Task 3: Prose-hardened flattening + final-answer instruction

**Files:**
- Modify: `src/exulu/resolve-max-steps.ts` (`flattenPart`, `FINAL_ANSWER_INSTRUCTION`)
- Test: `src/exulu/resolve-max-steps.test.ts` (append assertions)

**Interfaces:**
- Produces: `flattenPart` prose output (no `[called tool`/`[result of` templates); `FINAL_ANSWER_INSTRUCTION` containing "normal prose". No signature changes — existing behavior tests must keep passing (tool names and outputs still appear in the flattened text).

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe("finalAnswerGuard")` block:

```ts
  it("flattens history as prose — no copyable tool-call templates (mimicry hardening)", () => {
    const guard = finalAnswerGuard(3);
    const messages = [
      { role: "user", content: "Frage?" },
      { role: "assistant", content: [{ type: "tool-call", toolName: "bash", input: { command: "ls" } }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "bash", output: { value: "file.pdf" } }] },
    ];
    const r = guard({ stepNumber: 2, messages }) as any;
    const flat = JSON.stringify(r.messages);
    expect(flat).not.toContain("[called tool");
    expect(flat).not.toContain("[result of");
    expect(flat).not.toContain("[searched");
    // prose phrasing present, content preserved
    expect(flat).toContain("ran the \\\"bash\\\" tool with input");
    expect(flat).toContain("The \\\"bash\\\" tool returned");
    expect(flat).toContain("file.pdf");
    // the instruction forbids tool-call-shaped output
    const instruction = r.messages[r.messages.length - 1].content as string;
    expect(instruction).toContain("normal prose");
    expect(instruction).toContain("[called tool ...]");
  });
```

(If the escaped-quote `toContain` assertions prove brittle against `JSON.stringify` escaping, match on the unescaped joined text instead: `const texts = (r.messages as any[]).map((m) => String(m.content)).join("\n");` and assert `texts.toContain('ran the "bash" tool with input')` etc. — keep the negative template assertions on `flat`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- src/exulu/resolve-max-steps.test.ts`
Expected: the new case FAILS (`[called tool` present today); all old cases PASS.

- [ ] **Step 3: Implement**

In `flattenPart`, replace the two template branches:

```ts
  if (p?.type === "tool-call") {
    return `Earlier, the assistant ran the "${p.toolName}" tool with input: ${JSON.stringify(p.input ?? {}).slice(0, 300)}`;
  }
  if (p?.type === "tool-result") {
    const out = p.output?.value ?? p.output;
    return `The "${p.toolName}" tool returned: ${typeof out === "string" ? out : JSON.stringify(out ?? "")}`;
  }
```

Replace `FINAL_ANSWER_INSTRUCTION` with:

```ts
const FINAL_ANSWER_INSTRUCTION =
  "This is your last step for this turn. Answer the user's original question now, in plain text, using only the information gathered above. " +
  "If you could not finish the task, tell the user you reached the maximum number of tool steps, summarize what you found and did so far, and say what remains — they can ask you to continue. " +
  "Do not attempt any further tool calls. Write your answer as normal prose for the user: do not output tool-call syntax, JSON commands, or bracketed lines such as \"[called tool ...]\" — describe anything you did or still plan to do in plain language.";
```

Update the `flattenToolHistory` doc comment's last line to mention that the flattened text is deliberately prose so it cannot serve as a mimicry template.

- [ ] **Step 4: Verify**

Run: `npm test -- src/exulu/resolve-max-steps.test.ts` → ALL cases pass, including the pre-existing ones ("RESULT TEXT", "TUERANTRIEB DEFEKT", "write_file", "maximum number of tool steps" still present in prose output).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(steps): prose flatten + explicit no-tool-syntax final-step instruction"
```

---

### Task 4: Wire budgets at all five call sites + pipeline description

**Files:**
- Modify: `src/exulu/provider.ts` (3 sites: sync-prompt ~539-569, sync-messages ~628-655, stream ~1148-1193)
- Modify: `src/exulu/openai-gateway.ts` (2 sites: ~537-538, ~579-580 + imports)
- Modify: `ee/agentic-retrieval/pipeline/index.ts:170` (description line only)

**Interfaces:**
- Consumes: `resolveTurnStepBudget`, `resolveRetrievalCallBudget`, `retrievalBudgetGuard` (Tasks 1-2), `sanitizeToolName` from `@SRC/utils/sanitize-tool-name`, existing `composePrepareSteps`/`contextGuard`/`finalAnswerGuard`.
- Produces: final wiring; no new exports.

- [ ] **Step 1: provider.ts — sync prompt path** (~line 539). The `tools:` value is currently an inline `await convertExuluToolsToAiSdkTools(...)` (16 args + `contextWindow`). Hoist it and compute the budget values. IMPORTANT: compute `agenticToolKey` AFTER the convert call — the conversion mutates/replaces entries in `currentTools` (including the agentic tool), and the registered key is `sanitizeToolName(entry.name)` of the FINAL entry:

```ts
      const toolsObject = await convertExuluToolsToAiSdkTools(
        currentTools,
        currentSkills,
        approvedTools,
        allExuluTools,
        toolConfigs,
        providerapikey,
        contexts,
        user,
        exuluConfig,
        session,
        req,
        project,
        sessionItems,
        model,
        agent,
        memoryItems,
        contextWindow
      );
      // The retrieval budget matches tool calls by their REGISTERED key
      // (sanitized name of the post-conversion entry) — resolve after convert.
      const agenticEntry = currentTools?.find((t) => t.id === "agentic_context_search");
      const agenticToolKey = agenticEntry ? sanitizeToolName(agenticEntry.name) : undefined;
      const retrievalGuard = retrievalBudgetGuard(
        resolveRetrievalCallBudget(toolConfigs),
        agenticToolKey,
        Object.keys(toolsObject),
      );
      const turnBudget = resolveTurnStepBudget(maxStepCount, agent);

      const output = await generateText({
        temperature: 0, // TODO Make this configurable
        model: model,
        system,
        prompt: prompt,
        maxRetries: 2,
        tools: toolsObject,
        // Stop after the image_generation tool fires — the widget IS the
        // assistant's response, no follow-up text turn is wanted (same
        // reasoning as question_ask: the UI artifact is the message).
        prepareStep: composePrepareSteps(contextGuard(contextWindow), retrievalGuard, finalAnswerGuard(turnBudget)) as never,
        stopWhen: [stepCountIs(turnBudget), hasToolCall("image_generation")]
      });
```

Add to provider.ts imports: `retrievalBudgetGuard, resolveTurnStepBudget` (line 2, alongside the Task-1 rename) and `import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";`.

- [ ] **Step 2: provider.ts — sync messages path** (~line 628): same transformation — hoist the inline `tools:` argument to `const toolsObject = await convertExuluToolsToAiSdkTools(...same args...)`, add the identical `agenticEntry`/`agenticToolKey`/`retrievalGuard`/`turnBudget` block (variable names can be reused — separate function scope), then `tools: toolsObject`, `prepareStep: composePrepareSteps(contextGuard(contextWindow), retrievalGuard, finalAnswerGuard(turnBudget)) as never`, `stopWhen: [stepCountIs(turnBudget), hasToolCall("image_generation")]`.

- [ ] **Step 3: provider.ts — stream path** (~line 1148): `const tools = await convertExuluToolsToAiSdkTools(...)` is ALREADY hoisted. After it (and after the existing `console.log("[EXULU] Converted tools", ...)`) add:

```ts
    const agenticEntry = currentTools?.find((t) => t.id === "agentic_context_search");
    const agenticToolKey = agenticEntry ? sanitizeToolName(agenticEntry.name) : undefined;
    const retrievalGuard = retrievalBudgetGuard(
      resolveRetrievalCallBudget(toolConfigs),
      agenticToolKey,
      Object.keys(tools),
    );
    const turnBudget = resolveTurnStepBudget(maxStepCount, agent);
```

and replace lines ~1192-1193 with:

```ts
      prepareStep: composePrepareSteps(contextGuard(contextWindow), retrievalGuard, finalAnswerGuard(turnBudget)) as never,
      stopWhen: [stepCountIs(turnBudget), hasToolCall("image_generation")],
```

- [ ] **Step 4: openai-gateway.ts** — extend the import at line 28 to `import { finalAnswerGuard, resolveRetrievalCallBudget, resolveTurnStepBudget, retrievalBudgetGuard } from "./resolve-max-steps.ts";` (drop `DEFAULT_MAX_STEPS` if now unused — check with grep) and add `import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";`. After `convertedTools` is built (~line 450, before the stream/non-stream branch) add:

```ts
        const gatewayAgenticEntry = enabledTools?.find((t) => t.id === "agentic_context_search");
        const gatewayAgenticKey = gatewayAgenticEntry ? sanitizeToolName(gatewayAgenticEntry.name) : undefined;
        const gatewayRetrievalGuard = retrievalBudgetGuard(
          resolveRetrievalCallBudget(agent.tools),
          gatewayAgenticKey,
          Object.keys(convertedTools),
        );
        const turnBudget = resolveTurnStepBudget(undefined, agent);
```

Replace BOTH guard sites (lines ~537-538 and ~579-580) with:

```ts
            prepareStep: clientTools.length > 0 ? undefined : composePrepareSteps(contextGuard(contextWindow), gatewayRetrievalGuard, finalAnswerGuard(turnBudget)),
            stopWhen: clientTools.length > 0 ? undefined : [stepCountIs(turnBudget)],
```

- [ ] **Step 5: pipeline description** — in `ee/agentic-retrieval/pipeline/index.ts:170` replace the `max_steps` entry's description string with:

```ts
        description: "Maximum knowledge searches the agent may run for one message. Once spent, the search tool is disabled for the rest of the turn. 0 = no search-specific cap (the agent's overall tool-step budget still applies).",
```

- [ ] **Step 6: Verify**

Run: `npm test` → full suite green (no new failures).
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → baseline count.
Run: `grep -rn "resolveMaxStepsFromToolConfigs\|DEFAULT_MAX_STEPS" src ee --include="*.ts" | grep -v test | grep -v "resolve-max-steps.ts"` → confirm no orphaned turn-budget expressions remain. After this task neither provider.ts nor openai-gateway.ts consumes `DEFAULT_MAX_STEPS` directly — remove it from their import lines (any hit the grep shows outside resolve-max-steps.ts should be exactly zero once done).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(steps): wire decoupled turn + retrieval budgets at provider and gateway sites"
```

---

## Frontend

### Task 5: `max_tool_steps` in the agent editor (Chat Experience)

**Files:**
- Modify: `app/(application)/agents/edit/[id]/sections/chat-experience.tsx` (after the `sandbox_enabled` FormField, ~line 133)
- Modify: `app/(application)/agents/edit/[id]/hooks.ts` (zod ~line 83, defaults ~line 217, save payload ~line 319, discard ~line 387)
- Modify: `app/(application)/agents/edit/[id]/queries.ts` (fragment ~line 73, mutation variable/input/return ~lines 279/302/328)
- Modify: `types/models/agent.ts` (frontend Agent type, near `sandbox_enabled`)
- Modify: `messages/en.json`, `messages/de.json` (`editor.chatExperience.*`)

**Interfaces:**
- Consumes: backend column `max_tool_steps` (Task 1 — the GraphQL input accepts it once the backend runs the new schema; NOTE the deploy-order requirement below).
- Produces: agent Save round-trips `max_tool_steps` (Int, 0 = platform default).

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
git worktree add ../frontend-sbd -b feature/step-budget-decoupling main
ln -s /Users/daniel.claessen/Desktop/Projects/exulu/frontend/node_modules /Users/daniel.claessen/Desktop/Projects/exulu/frontend-sbd/node_modules
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-sbd
```
All frontend commands run from there; quote paths containing parentheses.

- [ ] **Step 2: i18n** — in `messages/en.json` under `editor.chatExperience` (next to `sandboxLabel`/`sandboxDescription`) add:

```json
"maxToolStepsLabel": "Max tool steps per message",
"maxToolStepsDescription": "Caps how many tool/reasoning steps this agent may take on one message — applies to every tool (bash, files, knowledge search, integrations). 0 = platform default (10)."
```

In `messages/de.json`, same location:

```json
"maxToolStepsLabel": "Max. Tool-Schritte pro Nachricht",
"maxToolStepsDescription": "Begrenzt, wie viele Tool-/Denk-Schritte dieser Agent pro Nachricht ausführen darf — gilt für alle Tools (Bash, Dateien, Wissenssuche, Integrationen). 0 = Plattform-Standard (10)."
```

Run: `npm run check-messages` → zero NEW missing keys.

- [ ] **Step 3: hooks.ts** — four edits:

Zod (after `sandbox_enabled: z.boolean().optional(),` ~line 83):
```ts
  max_tool_steps: z.number().int().min(0).max(50).optional(),
```

Form defaults (after `sandbox_enabled: !!(agent as any).sandbox_enabled,` ~line 217) — and the IDENTICAL line in `discard()` (~line 387):
```ts
      max_tool_steps: Math.max(0, Math.round(Number((agent as any).max_tool_steps) || 0)),
```

Save payload (after `sandbox_enabled: values.sandbox_enabled ?? false,` ~line 319):
```ts
      max_tool_steps: values.max_tool_steps ?? 0,
```

- [ ] **Step 4: queries.ts** — three edits:
- `AGENT_EDITOR_FIELDS` fragment: add `max_tool_steps` on its own line after `sandbox_enabled` (~line 73).
- Mutation variables: add `$max_tool_steps: Int` after `$sandbox_enabled: Boolean` (~line 279). (The backend auto-generates the input field from the `number` column; if its generated type is `Float`, `Int` remains spec-coercible — only if the server rejects the variable type at runtime, switch the declaration to `Float`.)
- Mutation input: add `max_tool_steps: $max_tool_steps` after `sandbox_enabled: $sandbox_enabled` (~line 302); and add `max_tool_steps` to the returned `item { ... }` selection after `sandbox_enabled` (~line 328).

- [ ] **Step 5: chat-experience.tsx** — after the `sandbox_enabled` FormField block (~line 133) add (import `Input` from `@/components/ui/input` if not already imported):

```tsx
          <FormField
            control={editor.form.control}
            name="max_tool_steps"
            render={({ field }) => (
              <SettingRow
                htmlFor="agent-max-tool-steps"
                label={t("editor.chatExperience.maxToolStepsLabel")}
                description={t("editor.chatExperience.maxToolStepsDescription")}
              >
                <Input
                  id="agent-max-tool-steps"
                  type="number"
                  min={0}
                  max={50}
                  className="w-24"
                  value={field.value ?? 0}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    field.onChange(Number.isFinite(n) ? Math.max(0, Math.min(50, Math.round(n))) : 0);
                  }}
                />
              </SettingRow>
            )}
          />
```

(If `SettingRow` renders its child in a switch-sized slot that clips the input, place the Input directly — match the file's existing layout conventions and note any adaptation in the report.)

- [ ] **Step 6: frontend Agent type** — in `types/models/agent.ts` add `max_tool_steps?: number | null;` next to `sandbox_enabled?: boolean;`.

- [ ] **Step 7: Verify**

Run: `npm test` → no NEW failures (the nav-config failure is pre-existing).
Run: `npx tsc --noEmit 2>&1 | grep -c "error TS"` → baseline, no new.
Run: `npm run lint 2>&1 | tail -3` → no new problems.

DEPLOY-ORDER NOTE for the report: the new mutation field hard-breaks agent Save against a backend that has not booted the new schema (unknown input field). Backend and frontend must be deployed/restarted together — flag this in the task report so the final summary carries it.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(agents): general max_tool_steps budget in Chat Experience"
```

---

### Task 6: Knowledge-search wizard relabel (copy only)

**Files:**
- Modify: `messages/en.json:588-589`, `messages/de.json:588-589` (`editor.knowledge.wizard.behavior.maxSteps*`)
- Modify: `app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.ts` (doc comment ~line 45-46; header comment ~line 5)

**Interfaces:**
- Consumes: nothing new. Storage/serialization contract UNCHANGED — `config-schema.test.ts` must pass untouched.

- [ ] **Step 1: en.json** — replace the two values (~lines 588-589):

```json
"maxStepsLabel": "Max knowledge searches per message",
"maxStepsHint": "Caps how many knowledge searches the assistant may run for one message. Once spent, the search tool is disabled for the rest of the turn. 0 = no search-specific cap (the overall tool-step budget still applies)."
```

- [ ] **Step 2: de.json** — replace the corresponding values:

```json
"maxStepsLabel": "Max. Wissenssuchen pro Nachricht",
"maxStepsHint": "Begrenzt, wie viele Wissenssuchen der Assistent für eine Nachricht ausführen darf. Danach ist die Suche für den Rest der Nachricht deaktiviert. 0 = keine suchspezifische Grenze (das allgemeine Tool-Schritte-Budget gilt weiterhin)."
```

- [ ] **Step 3: config-schema.ts** — replace the `maxSteps` doc comment (~lines 45-46) with:

```ts
  /** Max agentic-retrieval CALLS per message (search-only budget; the turn-wide
   *  tool budget is the agent's max_tool_steps). 0 = no search-specific cap. */
  maxSteps: number;
```

And fix the stale header at ~line 5: change "11-entry serialisation contract" to "12-entry serialisation contract".

- [ ] **Step 4: Verify + commit**

Run: `npm run check-messages` (no new missing), `npm test -- "app/(application)/agents/edit/[id]/components/knowledge-search/config-schema.test.ts"` → PASS unchanged.

```bash
git add -A && git commit -m "feat(agents): relabel wizard max_steps as knowledge-search call budget"
```

---

### Task 7: Full verification

**Files:** none (verification; fix-forward commits allowed).

- [ ] **Step 1: Backend gates** (in `/Users/daniel.claessen/Desktop/Projects/exulu/backend-sbd`)

```bash
npm test && npx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: full jest green; tsc at the recorded baseline.

- [ ] **Step 2: Frontend gates** (in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-sbd`)

```bash
npm test ; npm run lint 2>&1 | tail -3 ; npm run check-messages 2>&1 | tail -3 ; npx tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: only pre-existing failures; no new lint problems; no new missing keys; tsc baseline.

- [ ] **Step 3: Semantics spot-check (backend)** — one focused integration-style jest assertion already exists via Task 2's composition test; additionally verify by grep that every `stopWhen` in provider.ts/openai-gateway.ts uses `turnBudget` and none references `resolveRetrievalCallBudget`:

```bash
grep -n "stopWhen" src/exulu/provider.ts src/exulu/openai-gateway.ts
```
Expected: `stepCountIs(turnBudget)` at all five sites.

- [ ] **Step 4: Hand off** — report branch state (commits per repo); merging follows superpowers:finishing-a-development-branch. The manual acceptance test is the user's 7-PDF Newton run: expect the full rename+summaries flow within 10 steps, knowledge searches capped at 3, and — if the budget is ever exhausted — a prose "step limit reached" answer instead of `[called tool …]` text.
