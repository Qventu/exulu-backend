# Step-Budget Decoupling & Final-Step Mimicry Hardening

**Date:** 2026-07-08
**Status:** Approved — ready for implementation plan
**Scope:** backend (`exulu/backend`) + frontend (`exulu/frontend`)

## Problem

A production test (agent "Newton v0.9 [TESTING]", 7 uploaded PDFs, a rename-and-
summarize task) surfaced two coupled defects:

1. **Budget bleed-over.** The knowledge-search wizard's `max_steps` (stored on
   the `agentic_context_search` tool config, intended to bound retrieval
   retry-rounds) feeds the WHOLE turn's step budget:
   `maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS`
   at `src/exulu/provider.ts:567, 653, 1192` (both `stopWhen: stepCountIs(...)`
   and `prepareStep: finalAnswerGuard(...)`). Newton's `max_steps: 3` capped the
   entire turn at 3 steps: two bash calls, then the forced final answer. A
   3-step budget cannot do multi-step sandbox work.
2. **Flatten-format mimicry.** On the last budgeted step, `finalAnswerGuard`
   rewrites history via `flattenPart`, which renders tool calls as
   `[called tool ${toolName}: ${json.slice(0,300)}]`
   (`src/exulu/resolve-max-steps.ts:39`). The model mimicked that template and
   emitted `[called tool bash: {...full command...}]` as its final TEXT instead
   of an answer. Verified from the persisted message: three `step-start` parts,
   two healthy `tool-bash` parts, and a 676-char text part in exactly that
   format — no error parts. The guard's three layers stop real tool calls, but
   the flatten format itself became the mimicry template.

## Research facts the design rests on

- **One `agentic_context_search` call runs the entire pipeline** (routing +
  memory in parallel, identifier pins, main + speculative fallback search,
  rerank incl. the internal fallback-rerank retry, memory override) —
  `ee/agentic-retrieval/pipeline/index.ts:217-636`. Extra calling-agent rounds
  come only from the model re-calling the tool or from early-return gate
  messages (managed-context / `require_preselected_contexts` /
  preselection-subset, `index.ts:239-251, 374-378`). Therefore retrieval rounds
  are exactly countable as `agentic_context_search` tool CALLS per turn.
- **`prepareStep` receives `steps: Array<StepResult>` with per-step
  `toolCalls` (with `toolName`) and may return `activeTools`**
  (`ai@6.0.49`, `node_modules/ai/dist/index.d.ts:874-895, :797, :913`).
  `activeTools` applies per-step, so an exhausted budget must be re-asserted on
  every subsequent step. The local `PrepareStepFn` type
  (`src/exulu/context-guard.ts:3-6`) must be widened to include `steps`;
  `composePrepareSteps` already spreads all options through at runtime.
- **A new `agents` column self-provisions**: `addMissingFields`
  (`src/postgres/init-exulu-db.ts:41-68`) auto-ALTERs existing tables at boot
  for any new field in `agentsSchema` (`src/postgres/core-schema.ts:202-283`);
  GraphQL type + input are generated from `table.fields`
  (`src/graphql/schemas/index.ts:51-137`); the generic update mutation writes
  all input keys; the runtime agent is the raw DB row
  (`src/exulu/app/index.ts:519-525`). Pattern precedent: `sandbox_enabled`.
- **Tool keys in the AI SDK tools object are sanitized NAMES**, not ids
  (`sanitizeToolName(tool.name)` in `convert-exulu-tools-to-ai-sdk-tools.ts`).
  The retrieval guard must match `steps[].toolCalls[].toolName` against the
  agentic tool's registered key, resolved at wiring time from the
  `currentTools` entry with `id === "agentic_context_search"`.

## Decisions (design review, 2026-07-08)

- The retrieval `max_steps` stays where it is (tool-config entry; e.g. Newton's
  `3` untouched) but changes meaning: it bounds ONLY agentic-retrieval calls
  per message. `0`/unset = no retrieval-specific cap.
- A new per-agent turn budget `max_tool_steps` (agents column) caps ALL tool
  steps per message; `0`/null = platform default (`DEFAULT_MAX_STEPS` = 10).
  It is edited in the agent editor's Chat Experience section (near the File
  sandbox toggle) but worded as a GENERAL setting — it governs every tool type,
  not just sandbox tools.
- Exhausted retrieval budget deactivates the tool silently (dropped from
  `activeTools`); no note is injected.
- Flatten output becomes prose (no copyable call-syntax template) and the
  final-step instruction explicitly forbids tool-call-shaped text.

## Goals

- Retrieval `max_steps: N` limits the agent to N knowledge searches per message
  while leaving other tools bounded only by the turn budget.
- The turn budget is configurable per agent and defaults to 10.
- A budget-exhausted final step produces a prose answer (or an honest "step
  limit reached" summary), never `[called tool …]`-shaped text.
- Existing data keeps working with no migration: tool configs unchanged; the
  new column auto-provisions.

## Non-goals

- No note/message injected when the retrieval tool is deactivated.
- No streaming-time detection/rewrite of mimicry-shaped model output (future
  hardening if prose flattening proves insufficient).
- No per-tool budgets beyond the agentic retrieval tool (YAGNI).
- The OpenAI gateway keeps no retrieval-specific budget UI; it simply uses the
  same helpers.

## Design

### 1. `resolveTurnStepBudget` — the turn budget

New helper in `src/exulu/resolve-max-steps.ts`:

```ts
export function resolveTurnStepBudget(
  maxStepCount: number | undefined,
  agent: { max_tool_steps?: number | null } | undefined,
): number
```

Precedence: `maxStepCount` (explicit argument, unchanged semantics) →
`agent.max_tool_steps` when a finite number > 0 (floored) →
`DEFAULT_MAX_STEPS`. All five call sites switch to it:

- `provider.ts` generateSync prompt path, generateSync messages path,
  generateStream — replacing
  `maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS`
  in BOTH `stopWhen` and the `finalAnswerGuard(...)` argument.
- `openai-gateway.ts` stream + non-stream — replacing the hardcoded
  `DEFAULT_MAX_STEPS` (the gateway already has the agent row).

`resolveMaxStepsFromToolConfigs` no longer participates in the turn budget
anywhere; it is renamed in place to `resolveRetrievalCallBudget` (same logic,
same config entry) with an updated doc comment, and every reference updated.

### 2. `retrievalBudgetGuard` — bounding retrieval calls

New guard in `src/exulu/resolve-max-steps.ts`:

```ts
export function retrievalBudgetGuard(
  limit: number | undefined,
  agenticToolKey: string | undefined,
  allToolKeys: string[],
): PrepareStepFn
```

- Inert (always returns `undefined`) when `limit` is undefined/≤0 or
  `agenticToolKey` is undefined or absent from `allToolKeys`.
- Otherwise, on EVERY step: count `steps.flatMap(s => s.toolCalls ?? [])`
  entries with `toolName === agenticToolKey`; when `count >= limit`, return
  `{ activeTools: allToolKeys.filter(k => k !== agenticToolKey) }`.
- `PrepareStepFn` in `src/exulu/context-guard.ts` is widened:
  `opts` gains `steps?: Array<{ toolCalls?: Array<{ toolName?: string }> }>`.

Wiring (all three provider sites; the two gateway sites likewise):

```ts
const toolsObject = await convertExuluToolsToAiSdkTools(...); // hoisted to a
// variable where it is currently inline (generateSync paths)
const allToolKeys = Object.keys(toolsObject);
const agenticEntry = currentTools?.find((t) => t.id === "agentic_context_search");
const agenticToolKey = agenticEntry ? sanitizeToolName(agenticEntry.name) : undefined;
const turnBudget = resolveTurnStepBudget(maxStepCount, agent);
...
prepareStep: composePrepareSteps(
  contextGuard(contextWindow),
  retrievalBudgetGuard(resolveRetrievalCallBudget(toolConfigs), agenticToolKey, allToolKeys),
  finalAnswerGuard(turnBudget),
),
stopWhen: [stepCountIs(turnBudget), hasToolCall("image_generation")],
```

Composition semantics (existing `composePrepareSteps`): later guards win on
shallow-merged keys, so on the final step `finalAnswerGuard`'s
`activeTools: []` overrides the retrieval guard's filtered list — correct.
On non-final steps the retrieval guard's `activeTools` survives. The gateway's
two sites already compose `contextGuard` + `finalAnswerGuard`; the retrieval
guard slots between them, and the existing `clientTools.length > 0 ?
undefined : …` gating is unchanged (client-executed tools keep no guards).

### 3. `max_tool_steps` agent column

- `src/postgres/core-schema.ts` `agentsSchema.fields`: add
  `{ name: "max_tool_steps", type: "number", required: false }`. Boot
  auto-ALTER provisions it; GraphQL type + input pick it up automatically.
- `types/models/agent.ts` (`ExuluAgent`): `max_tool_steps?: number | null;`.
- No data backfill needed: null/0 ⇒ platform default.

### 4. Mimicry-hardened flattening

In `src/exulu/resolve-max-steps.ts`:

- `flattenPart` prose output (no brackets, no `called tool` template):
  - tool-call → `Earlier, the assistant ran the "${toolName}" tool with input: ${JSON.stringify(input ?? {}).slice(0, 300)}`
  - tool-result → `The "${toolName}" tool returned: ${typeof out === "string" ? out : JSON.stringify(out ?? "")}` (output stays untruncated, exactly as today)
- `FINAL_ANSWER_INSTRUCTION` appends: `Write your answer as normal prose for
  the user. Do not output tool-call syntax, JSON commands, or bracketed lines
  such as "[called tool ...]" — describe anything you did or still plan to do
  in plain language.`
- Tests updated; a new assertion checks the flattened output of a bash/write
  trace contains neither `[called tool` nor `[result of`.

### 5. Frontend

**Chat Experience section** (`sections/chat-experience.tsx`, near the File
sandbox toggle): number field (min 0, max 50, integer) labeled
**"Max tool steps per message"** with copy making the GENERAL scope explicit —
en: "Caps how many tool/reasoning steps this agent may take on one message —
applies to every tool (bash, files, knowledge search, integrations). 0 =
platform default (10)." (de equivalent). Follows the `sandbox_enabled` RHF
pattern exactly: zod field + defaults + discard reset + the single
save-payload assembly point (`hooks.ts:298-331`), `UPDATE_AGENT_EDITOR`
variable + input field + return selection, `AGENT_EDITOR_FIELDS` fragment,
frontend Agent type, en/de strings.

**Knowledge-search wizard** (`config-schema.ts`, `behavior-step.tsx`): copy
only — label becomes **"Max knowledge searches per message"**, hint: "Caps how
many knowledge searches the assistant may run for one message. 0 = no
search-specific cap (the overall tool-step budget still applies)." Doc comment
in `config-schema.ts:45-46` updated; storage/serialization contract unchanged
(existing tests must keep passing). Fix the stale "11-entry" header comment
while touching the file.

**Backend config description** (`ee/agentic-retrieval/pipeline/index.ts`
`max_steps` entry description): same new wording, replacing the stale
"platform default (5, or 10 with skills)" text.

### 6. Behavior change (intentional)

Agents that used retrieval `max_steps` as a de-facto turn cap change behavior:
the turn budget reverts to 10 (or their new `max_tool_steps`), and retrieval is
capped at N calls. Newton: up to 10 tool steps per message in total (searches
included), of which at most 3 may be knowledge searches.

### 7. Coordination note

The parallel `project-agentic-retrieval` branch plans edits to
`ee/agentic-retrieval/pipeline/index.ts` (config array adjacent to the
`max_steps` entry), `convert-exulu-tools-to-ai-sdk-tools.ts`, the
knowledge-search wizard files, and `messages/*.json`. This design touches one
line in the pipeline file and copy in the wizard — trivial merges, but rebase
whichever lands second.

### 8. Testing

- **Unit (backend, jest):** `resolveTurnStepBudget` precedence (explicit arg >
  column > default; 0/null/negative column ⇒ default);
  `resolveRetrievalCallBudget` rename keeps existing cases;
  `retrievalBudgetGuard` — inert without limit/key, inert under budget,
  filtered `activeTools` at/after the limit and re-asserted on later steps,
  composed with `finalAnswerGuard` so the final step still yields
  `activeTools: []`; prose `flattenPart`/instruction assertions (no
  `[called tool` template anywhere).
- **Unit (frontend, vitest):** config-schema serialization contract unchanged;
  save-payload includes `max_tool_steps`.
- **Manual:** re-run the 7-PDF Newton test — expect the full rename+summaries
  flow to complete within 10 steps while knowledge search stays capped at 3.

## Files touched

**Backend:** `src/exulu/resolve-max-steps.ts` (+ test),
`src/exulu/context-guard.ts` (type widening), `src/exulu/provider.ts` (3
sites + tools-object hoisting), `src/exulu/openai-gateway.ts` (2 sites),
`src/postgres/core-schema.ts`, `types/models/agent.ts`,
`ee/agentic-retrieval/pipeline/index.ts` (description line).

**Frontend:** `.../sections/chat-experience.tsx`, `.../agents/edit/[id]/hooks.ts`,
`.../agents/edit/[id]/queries.ts`, `.../knowledge-search/config-schema.ts`
(comments), `.../knowledge-search/steps/behavior-step.tsx` (labels),
`types/models/agent.ts` (frontend), `messages/en.json`, `messages/de.json`.
