# Per-Run Tokens + $ Cost in the Runs Table — Design

- **Date:** 2026-07-29
- **Status:** Approved (ready for implementation plan)
- **Repos:** `exulu/backend` (cost capture + expose) and `exulu/frontend` (display) — deploy-coupled.

## Problem

The runs table (`RoutineRunsList`, shown in the routine detail Runs section and
the global `/workflows` runs console) shows each run's start time and duration
but not how many tokens it used or what it cost.

**Tokens are already tracked.** The routine step executor in `ee/workers.ts`
runs each step via `generateStream` and persists accumulated token totals on the
run's `job_results` row at `metadata.tokens` (`{ totalTokens, reasoningTokens,
inputTokens, outputTokens, cachedInputTokens }`). This accumulation is already
**resume-safe** (spec §5.7: a resumed continuation sums its own steps with the
pre-pause totals). They are simply not surfaced to the UI.

**Cost is not tracked.** Nothing computes a per-run $ figure. LiteLLM records
spend only per **tag, aggregated per day** (`routine_id`, `user_id`…) — a
routine's runs share one `routine_id` tag, so there is no per-run slice. But
per-model pricing is available from `src/exulu/litellm/catalog.ts`
(`findLiteLLMModel(modelName)` → `input_cost_per_million_tokens` /
`output_cost_per_million_tokens`), and the run's model (`agent.model`) is known
in the executor.

## Goal

Compute an approximate per-run $ cost and store it alongside the existing token
totals, expose tokens + cost on the `RoutineRun` GraphQL type, and show all
three inline in each run row as `↑{in} ↓{out} ${cost}`.

## Decisions (settled)

| Question | Decision |
| --- | --- |
| Display | All three inline in the run row: `↑12.3k ↓4.5k  $0.021`. Token pair hidden on narrow widths (existing responsive pattern); `$cost` always shown. |
| Token source | Reuse the existing `job_results.metadata.tokens.{inputTokens,outputTokens}` — no new columns, no new accumulation code. |
| Cost basis | Approximate: catalog list prices × existing token totals, no prompt-cache discount, agent-LLM calls only (excludes embeddings/rerank/OCR). Labeled approximate via tooltip. |
| Cost storage | Stored in the same JSON blob as `metadata.tokens.costUsd`, recomputed from the cumulative token totals on each persist so it stays resume-safe. No `cost_usd` column. |
| Cost unavailable | If the run's model has no catalog price, `costUsd` is null → the row shows `—` for cost but still shows tokens. |
| Backfill | None. Runs predating this — and runs with no LLM calls (e.g. `filtered`) — show `—`. |

## Non-goals

- No new `job_results` columns and no `ee/schemas.ts` change (tokens already in
  `metadata.tokens`; cost joins them there).
- No per-request LiteLLM SpendLogs querying and no per-run LiteLLM tag (a unique
  tag per run would explode LiteLLM's tag/budget space).
- No billing-grade accuracy (cache discounts, non-LLM spend not modeled).
- No change to the aggregate `updateStatistic` counters (kept as-is).
- No new bulk/aggregate "total cost across runs" surface — per-row only.

## Design

### Backend

**1. Cost helper — `src/exulu/routines/run-cost.ts` (new, pure, jest-tested)**

```ts
export interface RunCostPrice {
  input_cost_per_million_tokens: number | null;
  output_cost_per_million_tokens: number | null;
}
// Approximate USD; null when either price is missing/non-finite.
export function computeRunCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: RunCostPrice | null | undefined,
): number | null;
```

`(inputTokens / 1e6) * inputPrice + (outputTokens / 1e6) * outputPrice`.

**2. Cost computation — `ee/workers.ts` (the token-merge block, ~lines 646-654,
that sums `priorTokens` with the invocation totals into the cumulative `tokens`
object)**
`agent` and `jobResultId` are already in scope here, and the merged `tokens`
object holds the **cumulative** input/output totals (prior + this invocation).
After it is built, look up the model price and compute cost from those
cumulative totals, then add `costUsd` to the `tokens` object (which is persisted
at the pause update and returned for the completed handler):

```ts
const price = await findLiteLLMModel(agent.model); // catalog entry or undefined; cached
const costUsd = computeRunCostUsd(
  tokens.inputTokens,
  tokens.outputTokens,
  price
    ? {
        input_cost_per_million_tokens: price.input_cost_per_million_tokens,
        output_cost_per_million_tokens: price.output_cost_per_million_tokens,
      }
    : null,
);
// costUsd joins totalTokens/inputTokens/outputTokens/… in the persisted tokens object
```

Recomputing from the cumulative totals each write is inherently resume-safe (no
separate cost accumulation needed) and single-point (one computation, one model
lookup). `costUsd` is null when the model has no catalog price.

**4. GraphQL — `src/graphql/schemas/index.ts` + `src/exulu/routines/runs-query.ts`**
- `type RoutineRun` (schemas/index.ts): add `inputTokens: Float`,
  `outputTokens: Float`, `costUsd: Float`.
- `mapRoutineRunRow` (runs-query.ts): the executing query already
  `.select("job_results.*")`, so `row.metadata` is present. Parse it
  (`parseMaybeJson(row.metadata)?.tokens`) and add
  `inputTokens: tokens?.inputTokens ?? null`, `outputTokens: tokens?.outputTokens
  ?? null`, `costUsd: tokens?.costUsd ?? null`.
- Regenerate SDL with the EE license (`npm run sdl` from `mintlify-docs`, with
  `BACKEND_REPO` pointing at the backend root); verify the `RoutineRun` type
  gains the fields and no gated types are stripped; keep `verify-sdl` at its
  existing baseline.

### Frontend

**5. Type + query — `lib/routine-runs/types.ts` + the `routineRuns` query document**
Add `inputTokens?: number | null`, `outputTokens?: number | null`,
`costUsd?: number | null` to `RoutineRun`, and request the three fields.

**6. Formatters — `lib/routine-runs/presentation.ts` (pure, vitest)**
- `formatCompactTokens(n: number | null | undefined): string` → `—` for null,
  `940`, `12.3k`, `1.2M` (one decimal, trimmed).
- `formatRunCost(usd: number | null | undefined): string` → `—` for null,
  `$0.021` for ≥ $0.01; sub-cent shows more precision (e.g. `$0.0004`); `$0` for 0.

**7. Row — `components/widgets/routine-runs/runs-list.tsx`**
Add to the run row grid, after the duration cell: a token-pair cell
(`↑{formatCompactTokens(inputTokens)} ↓{formatCompactTokens(outputTokens)}`) and a
`$cost` cell (`formatRunCost(costUsd)`). Token pair hidden on narrow widths
(match the existing `hidden sm:…` / `md:…` responsive hiding); `$cost` always
shown. `aria-label`s + i18n strings under `routineRuns` (`messages/en.json` +
`messages/de.json`), including an approximate-cost tooltip.

## Testing

- **Backend (jest):** `computeRunCostUsd` — normal case, zero tokens, missing
  price → null, non-finite guard.
- **Frontend (vitest):** `formatCompactTokens` and `formatRunCost` across null,
  sub-1k, thousands, millions, sub-cent, and ≥$0.01.
- **Manual smoke:** run a routine → its row shows non-zero `↑in ↓out $cost`;
  a pre-existing run and a `filtered` run show `—`; an approval pause/resume run
  accumulates cost correctly across the pause.

## Sequencing

1. Backend: cost helper (+test) → job-processor cost computation → GraphQL type +
   mapper → SDL regen.
2. Frontend: type + query → formatters (+tests) → row cells + i18n → verify.

Backend and frontend deploy together (the frontend selection references fields
the backend must expose first).
