# Per-Run Tokens + $ Cost in the Runs Table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each routine run's input/output tokens and an approximate $ cost inline in the runs table, reusing the token totals the worker already persists.

**Architecture:** The worker already accumulates resume-safe token totals in `job_results.metadata.tokens`. Compute an approximate $ cost from those totals × the run model's catalog price and store it in the same blob (`metadata.tokens.costUsd`). Expose `inputTokens`/`outputTokens`/`costUsd` on the `RoutineRun` GraphQL type (mapped from `metadata.tokens`) and render them in each run row.

**Tech Stack:** TypeScript, Knex/Postgres, GraphQL code-first SDL, BullMQ worker, jest (backend); Next.js + Apollo, next-intl, vitest (frontend).

## Global Constraints

- Tokens come from the existing `job_results.metadata.tokens.{inputTokens,outputTokens}` — do NOT add DB columns or new token-accumulation code.
- Cost is stored at `metadata.tokens.costUsd`, recomputed from the cumulative token totals on each persist (resume-safe). No `cost_usd` column.
- Cost is approximate: catalog list prices, no prompt-cache discount, agent-LLM calls only. `costUsd` is null when the run model has no catalog price.
- No backfill: runs predating this — and runs with no LLM calls (e.g. `filtered`) — show `—`.
- GraphQL field names are camelCase: `inputTokens`, `outputTokens`, `costUsd` (Float).
- Commit subjects must start lowercase (commitlint). Backend on `develop`, frontend on `main`; stage only task files (both trees hold unrelated uncommitted changes). SDL regen uses `npm run sdl` from `mintlify-docs` with `BACKEND_REPO` set — the script applies the EE license itself.
- Backend + frontend are deploy-coupled (frontend selection references fields the backend must expose first).

---

### Task 1: Backend — cost helper `run-cost.ts`

**Files:**
- Create: `src/exulu/routines/run-cost.ts`
- Test: `src/exulu/routines/run-cost.test.ts`

**Interfaces:**
- Produces: `computeRunCostUsd(inputTokens: number, outputTokens: number, price: RunCostPrice | null | undefined): number | null` and `interface RunCostPrice { input_cost_per_million_tokens: number | null; output_cost_per_million_tokens: number | null }`. Consumed by Task 2 (worker).

- [ ] **Step 1: Write the failing test**

Create `src/exulu/routines/run-cost.test.ts`:

```ts
import { computeRunCostUsd } from "./run-cost";

const price = {
  input_cost_per_million_tokens: 3, // $3 / 1M input
  output_cost_per_million_tokens: 15, // $15 / 1M output
};

describe("computeRunCostUsd", () => {
  it("computes cost from tokens and per-million prices", () => {
    // 1,000,000 in * $3/M + 500,000 out * $15/M = 3 + 7.5 = 10.5
    expect(computeRunCostUsd(1_000_000, 500_000, price)).toBeCloseTo(10.5, 6);
  });
  it("is zero for zero tokens", () => {
    expect(computeRunCostUsd(0, 0, price)).toBe(0);
  });
  it("returns null when price is missing", () => {
    expect(computeRunCostUsd(1000, 1000, null)).toBeNull();
    expect(computeRunCostUsd(1000, 1000, undefined)).toBeNull();
  });
  it("returns null when either per-million price is null or non-finite", () => {
    expect(
      computeRunCostUsd(1000, 1000, {
        input_cost_per_million_tokens: null,
        output_cost_per_million_tokens: 15,
      }),
    ).toBeNull();
    expect(
      computeRunCostUsd(1000, 1000, {
        input_cost_per_million_tokens: 3,
        output_cost_per_million_tokens: Number.NaN,
      }),
    ).toBeNull();
  });
  it("treats missing token counts as zero", () => {
    expect(
      computeRunCostUsd(undefined as unknown as number, 1_000_000, price),
    ).toBeCloseTo(15, 6);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/exulu/routines/run-cost.test.ts`
Expected: FAIL — module `./run-cost` not found.

- [ ] **Step 3: Implement the helper**

Create `src/exulu/routines/run-cost.ts`:

```ts
/**
 * Approximate per-run $ cost from token totals × the run model's catalog list
 * price. Approximate by design (spec): no prompt-cache discount, agent-LLM
 * calls only. Returns null when pricing is unavailable so callers can render
 * "—" rather than a fabricated $0.
 */
export interface RunCostPrice {
  input_cost_per_million_tokens: number | null;
  output_cost_per_million_tokens: number | null;
}

export function computeRunCostUsd(
  inputTokens: number,
  outputTokens: number,
  price: RunCostPrice | null | undefined,
): number | null {
  if (!price) return null;
  const inPrice = price.input_cost_per_million_tokens;
  const outPrice = price.output_cost_per_million_tokens;
  if (
    inPrice == null ||
    outPrice == null ||
    !Number.isFinite(inPrice) ||
    !Number.isFinite(outPrice)
  ) {
    return null;
  }
  const inTok = Number.isFinite(inputTokens) ? inputTokens : 0;
  const outTok = Number.isFinite(outputTokens) ? outputTokens : 0;
  return (inTok / 1_000_000) * inPrice + (outTok / 1_000_000) * outPrice;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/exulu/routines/run-cost.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/exulu/routines/run-cost.ts src/exulu/routines/run-cost.test.ts
git commit -m "feat(routines): add approximate per-run cost helper"
```

---

### Task 2: Backend — compute + persist `costUsd` in the worker

**Files:**
- Modify: `ee/workers.ts` (the routine-run token-merge block, ~lines 646-654, inside the `started.jobResultId` handler)

**Interfaces:**
- Consumes: `computeRunCostUsd` / `RunCostPrice` (Task 1); `findLiteLLMModel(modelName)` from `@SRC/exulu/litellm/catalog.ts` (returns a catalog entry with `input_cost_per_million_tokens` / `output_cost_per_million_tokens`, or undefined).
- Produces: `job_results.metadata.tokens.costUsd` (number | null) on run persist. Consumed by Task 3 (mapper).

- [ ] **Step 1: Add the imports**

At the top of `ee/workers.ts`, add (near the existing `@SRC/exulu/...` imports):

```ts
import { findLiteLLMModel } from "@SRC/exulu/litellm/catalog.ts";
import { computeRunCostUsd } from "@SRC/exulu/routines/run-cost.ts";
```

(Match the existing import style in the file — several imports already use the `@SRC/...` alias with a `.ts` suffix.)

- [ ] **Step 2: Compute cost from the cumulative totals and attach it to `tokens`**

In the token-merge block, immediately AFTER the `const tokens = { … cachedInputTokens: … };` object is constructed (currently ends ~line 654) and BEFORE the `if (result.pausedAtStepIndex !== undefined) {` branch, insert:

```ts
      // Approximate per-run $ cost (spec 2026-07-29): recompute from the
      // cumulative token totals × the run model's catalog list price on every
      // persist, so it stays correct across pause/resume. Null when the model
      // has no catalog price — the UI shows "—", not a fabricated $0.
      const modelPrice = await findLiteLLMModel(agent.model);
      (tokens as Record<string, number | null>).costUsd = computeRunCostUsd(
        tokens.inputTokens,
        tokens.outputTokens,
        modelPrice
          ? {
              input_cost_per_million_tokens: modelPrice.input_cost_per_million_tokens,
              output_cost_per_million_tokens: modelPrice.output_cost_per_million_tokens,
            }
          : null,
      );
```

`tokens` is spread into the persisted `metadata` at both the pause update and the returned metadata, so `costUsd` rides along automatically. `agent` is in scope (destructured from `validateWorkflowPayload` earlier in the handler).

- [ ] **Step 3: Typecheck**

Run: `cd backend && npx tsc --noEmit 2>&1 | grep -E "workers.ts|run-cost" || echo "no new errors in touched files"`
Expected: no errors referencing `ee/workers.ts` or `run-cost` (the repo may have unrelated pre-existing type errors; the touched files must be clean).

- [ ] **Step 4: Commit**

```bash
cd backend
git add ee/workers.ts
git commit -m "feat(routines): persist approximate cost on run token totals"
```

---

### Task 3: Backend — expose tokens + cost on `RoutineRun`

**Files:**
- Modify: `src/graphql/schemas/index.ts:827-841` (the `RoutineRun` SDL type)
- Modify: `src/exulu/routines/runs-query.ts:67-101` (`mapRoutineRunRow`)
- Test: `src/exulu/routines/runs-query.test.ts` (add token/cost mapping assertions)
- Regenerate: `mintlify-docs/api-reference/graphql/schema.graphql`

**Interfaces:**
- Consumes: `job_results.metadata.tokens.{inputTokens,outputTokens,costUsd}` (Task 2).
- Produces: `RoutineRun.inputTokens/outputTokens/costUsd` (Float) — consumed by the frontend (Task 5).

- [ ] **Step 1: Add a failing mapper test**

In `src/exulu/routines/runs-query.test.ts`, inside `describe("mapRoutineRunRow", …)`, add a new test:

```ts
  it("maps token totals and cost from metadata.tokens (jsonb or string)", () => {
    const fromObject = mapRoutineRunRow(
      {
        id: "jr-3",
        state: "completed",
        workflow: "wf-1",
        createdAt: "2026-07-29T09:00:00Z",
        updatedAt: "2026-07-29T09:01:00Z",
        metadata: { tokens: { inputTokens: 12340, outputTokens: 4512, costUsd: 0.021 } },
      },
      routineById,
    );
    expect(fromObject).toMatchObject({
      inputTokens: 12340,
      outputTokens: 4512,
      costUsd: 0.021,
    });

    const fromString = mapRoutineRunRow(
      {
        id: "jr-4",
        state: "completed",
        workflow: "wf-1",
        createdAt: "2026-07-29T09:00:00Z",
        updatedAt: "2026-07-29T09:01:00Z",
        metadata: JSON.stringify({ tokens: { inputTokens: 5, outputTokens: 6 } }),
      },
      routineById,
    );
    // costUsd absent → null; tokens still mapped
    expect(fromString).toMatchObject({ inputTokens: 5, outputTokens: 6, costUsd: null });

    const noMetadata = mapRoutineRunRow(
      { id: "jr-5", state: "filtered", workflow: "wf-1", metadata: null },
      routineById,
    );
    expect(noMetadata).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/exulu/routines/runs-query.test.ts -t "maps token totals"`
Expected: FAIL — `inputTokens`/`outputTokens`/`costUsd` are `undefined`.

- [ ] **Step 3: Map the fields in `mapRoutineRunRow`**

In `src/exulu/routines/runs-query.ts`, extend the return type and the returned object of `mapRoutineRunRow`. Add to the return-type annotation (after `updatedAt: unknown;`):

```ts
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
```

Inside the function, before `return {`, read the tokens blob (reuse the existing `parseMaybeJson`):

```ts
  const tokens = parseMaybeJson(row.metadata)?.tokens as
    | { inputTokens?: number; outputTokens?: number; costUsd?: number }
    | undefined;
```

And add to the returned object (after `updatedAt: row.updatedAt,`):

```ts
    inputTokens: tokens?.inputTokens ?? null,
    outputTokens: tokens?.outputTokens ?? null,
    costUsd: tokens?.costUsd ?? null,
```

- [ ] **Step 4: Run the mapper test**

Run: `cd backend && npx jest src/exulu/routines/runs-query.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Add the fields to the `RoutineRun` SDL type**

In `src/graphql/schemas/index.ts`, in `type RoutineRun { … }` (after `updatedAt: Date`):

```graphql
  inputTokens: Float
  outputTokens: Float
  costUsd: Float
```

- [ ] **Step 6: Regenerate the SDL (EE license)**

Run: `cd backend/mintlify-docs && BACKEND_REPO=$(cd .. && pwd) npm run sdl`
Then verify:

Run: `cd backend && git diff mintlify-docs/api-reference/graphql/schema.graphql | grep -E "^\+|^-" | grep -iE "inputTokens|outputTokens|costUsd|^-[^-]"`
Expected: the diff ADDS `inputTokens: Float`, `outputTokens: Float`, `costUsd: Float` on `RoutineRun` and shows no unexpected large deletions (a mass deletion = EE license not applied; do not commit — re-run).

Run: `cd backend/mintlify-docs && npm run verify-sdl 2>&1 | grep "pages match"`
Expected: still `21/23 pages match` (the pre-existing baseline — `RoutineRun` is not one of the mirrored core-type doc blocks, so no doc-block edit is needed; if `verify-sdl` now flags a `routine`/runs block, update that block to match).

- [ ] **Step 7: Run the backend suite (no new failures)**

Run: `cd backend && npm test 2>&1 | tail -5`
Expected: the same 5 pre-existing failing suites (`resolve-context-window`, `convert-exulu-tools-to-ai-sdk-tools`, `intake`, `compact-session`, `agentic-retrieval/pipeline`) and no others; `runs-query`, `run-cost` green.

- [ ] **Step 8: Commit**

```bash
cd backend
git add src/graphql/schemas/index.ts \
        src/exulu/routines/runs-query.ts \
        src/exulu/routines/runs-query.test.ts \
        mintlify-docs/api-reference/graphql/schema.graphql
git commit -m "feat(routines): expose run tokens and cost on the RoutineRun type"
```

(Stage only these files; do NOT stage unrelated changes such as `src/exulu/email-inbound/intake.ts`.)

---

### Task 4: Frontend — token/cost formatters

**Files:**
- Modify: `lib/routine-runs/presentation.ts` (add two pure formatters)
- Test: `lib/routine-runs/presentation.test.ts` (add a describe block)

**Interfaces:**
- Produces: `formatCompactTokens(n?: number | null): string` and `formatRunCost(usd?: number | null): string`. Consumed by Task 5 (row).

- [ ] **Step 1: Write the failing tests**

In `lib/routine-runs/presentation.test.ts`, add:

```ts
import { formatCompactTokens, formatRunCost } from "./presentation";

describe("formatCompactTokens", () => {
  it("renders — for null/undefined", () => {
    expect(formatCompactTokens(null)).toBe("—");
    expect(formatCompactTokens(undefined)).toBe("—");
  });
  it("renders raw integers below 1000", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(940)).toBe("940");
  });
  it("renders k for thousands, trimming .0", () => {
    expect(formatCompactTokens(5000)).toBe("5k");
    expect(formatCompactTokens(12340)).toBe("12.3k");
  });
  it("renders M for millions, trimming .0", () => {
    expect(formatCompactTokens(1_200_000)).toBe("1.2M");
    expect(formatCompactTokens(3_000_000)).toBe("3M");
  });
});

describe("formatRunCost", () => {
  it("renders — for null/undefined and $0 for zero", () => {
    expect(formatRunCost(null)).toBe("—");
    expect(formatRunCost(undefined)).toBe("—");
    expect(formatRunCost(0)).toBe("$0");
  });
  it("uses 2 decimals at or above $1", () => {
    expect(formatRunCost(1.5)).toBe("$1.50");
  });
  it("uses 3 decimals between 1 cent and $1", () => {
    expect(formatRunCost(0.021)).toBe("$0.021");
  });
  it("uses 4 decimals for sub-cent, flooring the tiniest to <$0.0001", () => {
    expect(formatRunCost(0.0004)).toBe("$0.0004");
    expect(formatRunCost(0.00001)).toBe("<$0.0001");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run lib/routine-runs/presentation.test.ts`
Expected: FAIL — `formatCompactTokens`/`formatRunCost` not exported.

- [ ] **Step 3: Implement the formatters**

Append to `lib/routine-runs/presentation.ts`:

```ts
/** "—" for null; compact integer/k/M (one decimal, trailing .0 trimmed). */
export function formatCompactTokens(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

/** "—" for null; approximate USD with precision scaled to magnitude. */
export function formatRunCost(usd?: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run lib/routine-runs/presentation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd frontend
git add lib/routine-runs/presentation.ts lib/routine-runs/presentation.test.ts
git commit -m "feat(routines): add compact token and cost formatters"
```

---

### Task 5: Frontend — type, query, row cells + i18n

**Files:**
- Modify: `lib/routine-runs/types.ts:17-34` (`RoutineRun`)
- Modify: `lib/routine-runs/queries.ts:9-23` (`ROUTINE_RUN_SELECTION`)
- Modify: `components/widgets/routine-runs/runs-list.tsx` (RunRow grid: +2 cells)
- Modify: `messages/en.json` + `messages/de.json` (`routineRuns.row`)

**Interfaces:**
- Consumes: backend `RoutineRun.inputTokens/outputTokens/costUsd` (Task 3); `formatCompactTokens`/`formatRunCost` (Task 4).

- [ ] **Step 1: Extend the `RoutineRun` type**

In `lib/routine-runs/types.ts`, add to `interface RoutineRun` (after `updatedAt?: string | null;`):

```ts
  /** Cumulative agent-LLM tokens for the run (from metadata.tokens). */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Approximate $ cost (catalog list prices, agent-LLM only); null if unpriced. */
  costUsd?: number | null;
```

- [ ] **Step 2: Request the fields in the query**

In `lib/routine-runs/queries.ts`, add to `ROUTINE_RUN_SELECTION` (after `updatedAt`):

```
  inputTokens
  outputTokens
  costUsd
```

- [ ] **Step 3: Add the i18n strings**

In `messages/en.json` under `routineRuns.row`, add:

```json
      "tokensIn": "Input tokens",
      "tokensOut": "Output tokens",
      "cost": "Approx. cost",
      "costTooltip": "Approximate — model list prices, excludes cache discounts and non-LLM calls"
```

In `messages/de.json` under `routineRuns.row`, add:

```json
      "tokensIn": "Eingabe-Tokens",
      "tokensOut": "Ausgabe-Tokens",
      "cost": "Ca. Kosten",
      "costTooltip": "Näherungswert — Modell-Listenpreise, ohne Cache-Rabatte und Nicht-LLM-Aufrufe"
```

- [ ] **Step 4: Add the cells to the run row grid**

In `components/widgets/routine-runs/runs-list.tsx`, in `RunRow`, widen the grid template from 7 to 9 tracks by adding two `auto` tracks before the trailing `auto` (the chevron). Change:

```
className="grid min-h-11 grid-cols-[auto_150px_190px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 py-2.5 text-left transition-colors hover:bg-muted/50"
```

to:

```
className="grid min-h-11 grid-cols-[auto_150px_190px_minmax(0,1fr)_auto_auto_auto_auto_auto] items-center gap-3 py-2.5 text-left transition-colors hover:bg-muted/50"
```

Then, immediately AFTER the duration cell block (the `{duration ? ( … ) : ( <span className="hidden md:block" /> )}` block, ~lines 598-604) and BEFORE the `<ChevronDown … />`, insert the token-pair cell and the cost cell:

```tsx
          <span
            className="hidden shrink-0 text-xs tabular-nums text-muted-foreground lg:block"
            aria-label={`${t("row.tokensIn")}: ${run.inputTokens ?? "—"}, ${t("row.tokensOut")}: ${run.outputTokens ?? "—"}`}
          >
            ↑{formatCompactTokens(run.inputTokens)} ↓{formatCompactTokens(run.outputTokens)}
          </span>
          <span
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
            title={t("row.costTooltip")}
            aria-label={`${t("row.cost")}: ${formatRunCost(run.costUsd)}`}
          >
            {formatRunCost(run.costUsd)}
          </span>
```

Add `formatCompactTokens` and `formatRunCost` to the existing import from `@/lib/routine-runs/presentation` at the top of the file.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -cE "error TS"`
Expected: `0`.

- [ ] **Step 6: Lint the touched files**

Run: `cd frontend && npx eslint "components/widgets/routine-runs/runs-list.tsx" "lib/routine-runs/queries.ts" "lib/routine-runs/types.ts"`
Expected: clean (exit 0).

- [ ] **Step 7: Build**

Run: `cd frontend && npm run build`
Expected: success.

- [ ] **Step 8: Manual smoke (documented for the human)**

1. Run a routine (or open a recent post-deploy run). Its row shows `↑<in> ↓<out>` (≥ lg width) and a `$<cost>` value.
2. A pre-existing run (before this shipped) and a `filtered` run show `—` for tokens and cost.
3. Hovering the cost shows the "approximate" tooltip.

- [ ] **Step 9: Commit**

```bash
cd frontend
git add lib/routine-runs/types.ts lib/routine-runs/queries.ts \
        "components/widgets/routine-runs/runs-list.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(routines): show run tokens and cost in the runs table"
```

(Stage only these files; the frontend tree holds unrelated uncommitted changes.)

---

## Self-Review

- **Spec coverage:** cost helper (Task 1) ✓; worker cost compute/persist from cumulative totals via `agent.model` (Task 2) ✓; `RoutineRun` type + mapper from `metadata.tokens` + SDL (Task 3) ✓; frontend type/query (Task 5) ✓; formatters (Task 4) ✓; inline row display with responsive token hiding + approximate tooltip + `—` fallbacks (Task 5) ✓; no columns / no backfill / no new operator honored as Global Constraints ✓.
- **Type consistency:** GraphQL `inputTokens`/`outputTokens`/`costUsd` (Float) ↔ mapper `number | null` ↔ frontend `number | null` ↔ formatters `(n?: number | null)`. `RunCostPrice` shape matches `catalog.ts` (`input_cost_per_million_tokens` / `output_cost_per_million_tokens`).
- **No placeholders:** every code step carries the exact edit.
