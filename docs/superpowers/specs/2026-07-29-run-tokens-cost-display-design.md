# Per-Run Tokens + $ Cost in the Runs Table — Design

- **Date:** 2026-07-29
- **Status:** Approved (ready for implementation plan)
- **Repos:** `exulu/backend` (capture + persist + expose) and `exulu/frontend` (display) — deploy-coupled.

## Problem

The runs table (`RoutineRunsList`, shown in the routine detail Runs section and
the global `/workflows` runs console) shows each run's start time and duration
but not how many tokens it used or what it cost. Per-run token/cost data is
**not tracked anywhere today**: runs are `job_results` rows with no token/cost
columns, and LiteLLM records spend only per **tag, aggregated per day**
(`routine_id`, `user_id`…) — a routine's runs all share one `routine_id` tag, so
there is no per-run slice.

The data does exist at runtime: the routine step executor in `ee/workers.ts`
runs each step via `generateStream`, whose stream `finish` part carries
`totalUsage { inputTokens, outputTokens, cachedInputTokens, … }`. Today this only
feeds aggregate `updateStatistic` counters and is never persisted per run.
Per-model pricing is available from `src/exulu/litellm/catalog.ts`
(`input_cost_per_million_tokens` / `output_cost_per_million_tokens`).

## Goal

Capture token usage during each routine run, persist per-run totals and an
approximate $ cost onto the `job_result`, expose them on the `RoutineRun`
GraphQL type, and show all three inline in each run row as `↑{in} ↓{out} ${cost}`.

## Decisions (settled)

| Question | Decision |
| --- | --- |
| Display | All three inline in the run row: `↑12.3k ↓4.5k  $0.021`. Token pair hidden on narrow widths (existing responsive pattern); `$cost` always shown. |
| Cost basis | Approximate: catalog list prices, no prompt-cache discount, agent-LLM calls only (excludes embeddings/rerank/OCR). Labeled approximate via tooltip. |
| Cost unavailable | If the run's model has no catalog price, `cost_usd` stays null and the row shows `—` for cost but still shows tokens. |
| Accumulation | Incremental on the `job_result` (SQL `COALESCE(col,0)+delta`) so counts survive an approval pause/resume, which restarts the worker and would lose in-memory totals. |
| Backfill | None. Runs predating this — and runs with no LLM calls (e.g. `filtered`) — show `—`. |

## Non-goals

- No per-request LiteLLM SpendLogs querying and no per-run LiteLLM tag (a unique
  tag per run would explode LiteLLM's tag/budget space).
- No billing-grade accuracy (cache discounts, non-LLM spend not modeled).
- No change to the aggregate `updateStatistic` counters (kept as-is).
- No new bulk/aggregate "total cost across runs" surface — per-row only.

## Design

### Backend

**1. Schema — `ee/schemas.ts` (`jobResultsSchema.fields`)**
Add three nullable `number` fields: `input_tokens`, `output_tokens`, `cost_usd`.
`addMissingFields` (`init-exulu-db.ts`) creates the columns on boot (idempotent
via `hasColumn`). No data migration.

**2. Cost helper — `src/exulu/routines/run-cost.ts` (new, pure, jest-tested)**

```ts
export interface RunCostPrice {
  input_cost_per_million_tokens: number | null;
  output_cost_per_million_tokens: number | null;
}
// Returns approximate USD, or null when either price is missing/non-finite.
export function computeRunCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: RunCostPrice | null | undefined,
): number | null;
```

`(inputTokens / 1e6) * inputPrice + (outputTokens / 1e6) * outputPrice`.

**3. Worker wiring — `ee/workers.ts` (routine step executor)**
At each step's stream `finish`, after the existing metadata handling, increment
the run's `job_result`:

```
UPDATE job_results
SET input_tokens = COALESCE(input_tokens,0) + <stepInput>,
    output_tokens = COALESCE(output_tokens,0) + <stepOutput>
WHERE id = <jobResultId>
```

Then recompute `cost_usd` from the new running totals × the run's resolved-model
catalog price (`findLiteLLMModel`) and write it in the same update (or a paired
update). The model is the routine agent's resolved model (`resolvedLanguageModel`),
already in scope. Guard: only when `jobResultId` is set (session-backed runs).

**4. GraphQL — `src/graphql/schemas/index.ts` + `src/exulu/routines/runs-query.ts`**
- `type RoutineRun`: add `inputTokens: Float`, `outputTokens: Float`, `costUsd: Float`.
- `mapRoutineRunRow`: add `inputTokens: row.input_tokens ?? null`, `outputTokens:
  row.output_tokens ?? null`, `costUsd: row.cost_usd ?? null`, and ensure the
  runs-query SELECT includes the three columns (widen the projection if it lists
  columns explicitly).
- Regenerate SDL with the EE license (`npm run sdl` from `mintlify-docs`, with
  `BACKEND_REPO` pointing at the backend root); verify the `RoutineRun` type
  gains the fields and no gated types are stripped; keep `verify-sdl` at its
  existing baseline (fix the `routine`/runs SDL doc block only if this type is
  mirrored there).

### Frontend

**5. Type + query — `lib/routine-runs/types.ts` + the `routineRuns` query document**
Add `inputTokens?: number | null`, `outputTokens?: number | null`,
`costUsd?: number | null` to `RoutineRun`, and request the three fields in the
GraphQL selection.

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
shown. `aria-label`s + i18n strings under the `routineRuns` namespace
(`messages/en.json` + `messages/de.json`), including an approximate-cost tooltip.

## Testing

- **Backend (jest):** `computeRunCostUsd` — normal case, zero tokens, missing
  price → null, non-finite guard.
- **Frontend (vitest):** `formatCompactTokens` and `formatRunCost` across null,
  sub-1k, thousands, millions, sub-cent, and ≥$0.01.
- **Manual smoke:** run a routine → its row shows non-zero `↑in ↓out $cost`;
  a pre-existing run and a `filtered` run show `—`; an approval pause/resume run
  accumulates correctly across the pause.

## Sequencing

1. Backend: schema fields → cost helper (+test) → worker accumulation/persist →
   GraphQL type + mapper + SELECT → SDL regen.
2. Frontend: type + query → formatters (+tests) → row cells + i18n → verify.

Backend and frontend deploy together (the frontend selection references fields
the backend must expose first).
