# Budget reset date: smart default + custom override

**Date:** 2026-07-10
**Status:** Design approved, pending spec review
**Area:** Tag-based budgets (Exulu backend `src/exulu/litellm/*` + `src/exulu/routes.ts`, Exulu frontend `components/budget-editor.tsx` + budget libs)

## Problem

A user set a project budget ("Hermes AVIS Tool", €300) to **weekly**, then switched it to
**monthly**. They expected the reset ("refresh") date to move; it stayed on the original weekly
reset date (Mon 13.07). They asked for the ability to set the reset date manually when changing
the type.

### Root cause (verified against the vendored LiteLLM source)

The reset date is stored on LiteLLM's budget row as `budget_reset_at`. Three facts combine into the
bug:

1. **`update_budget` never recomputes `budget_reset_at`.** `new_budget` sets it from the duration
   when absent (`budget_management_endpoints.py:86-90` via `get_budget_reset_time`), but
   `update_budget` just writes through the fields it received (`:175-181`). Changing the duration
   does not touch the reset date.

2. **The tag endpoints structurally cannot carry a reset date.** Both `/tag/new` and `/tag/update`
   route budget fields through `handle_budget_for_entity`, which filters the payload to
   `LiteLLM_BudgetTable.model_fields` (`management_helpers/utils.py:89-95`). That field set is
   `[budget_id, soft_budget, max_budget, max_parallel_requests, tpm_limit, rpm_limit,
   model_max_budget, budget_duration]` — **`budget_reset_at` is not in it**, so any reset date sent
   to a tag endpoint is silently dropped.

3. **The background reset job only heals a *past-due* date.** `reset_budget_for_litellm_budget_table`
   selects budgets where `budget_reset_at < now` (`reset_budget_job.py:240-248`,
   `_reset_budget_reset_at_date`). A freshly-changed duration leaves the *future* weekly date in
   place until it passes; only then does the budget reset — a week early — and jump to the 1st of the
   next month.

Consequently, after weekly→monthly the stale date sits untouched, and the spend window that Exulu
derives from it (`budget-service.ts:windowStartYmd`) is computed against the wrong period.

### Secondary finding: the mental-model mismatch

LiteLLM reset dates are **standardized calendar boundaries**, not rolling windows from the creation
date (`duration_parser.py:_handle_day_reset`):

- `1d` (daily) → next midnight
- `7d` (weekly) → next Monday
- `30d` (monthly) → 1st of next month

So the reporter's expectation ("a month from when I set it → 09.08") never matched the system even in
the absence of the bug; monthly would land on 01.08. This is why the accepted solution is not merely
"recompute on change" but **surface the reset date and let the admin override it**.

## Goal

Make the budget reset date an explicit, editable field in the budget editor:

- The duration selector prefills a **standardized smart default**, clearly labeled.
- The admin can **override** it with any calendar date.
- The chosen date is persisted immediately and correctly, so no stale-date window remains.

Applies to **both create and edit**, single and bulk.

## Non-goals

- Changing LiteLLM's standardized reset scheme, or patching the vendored LiteLLM package.
- Rolling-from-creation-date windows as an automatic behavior (a custom date covers that case
  manually).
- Any change to how spend is tallied (`windowStartYmd` already handles calendar-month alignment and
  needs no change — it simply becomes correct once the reset date is correct).

## Design

### Data flow

```
BudgetEditor (frontend)
  → budget_reset_at (ISO date) in upsert payload
  → PUT /admin/budgets/:entityType/:entityId  (routes.ts)
  → upsertBudget(tag, max_budget, budget_duration, budget_reset_at)  (budget-service.ts)
      → tagNew / tagUpdate  (creates/updates the tag + budget row as today)
      → if budget_reset_at provided:
          resolve budget_id via tagInfo(tag)
          budgetUpdate(budget_id, { budget_reset_at })  → POST /budget/update  (admin-client.ts)
      → invalidateBudgetCaches(tag)
```

The dedicated `/budget/update` call is required because the tag endpoints strip `budget_reset_at`
(root cause #2). `/budget/update` accepts it (`budget_management_endpoints.py:136`,
`BudgetNewRequest`).

### Backend changes

**`src/exulu/litellm/admin-client.ts`**
- `TagBudgetInput`: add optional `budget_reset_at?: string`.
- `TagInfo`: add `budget_id: string | null`.
- `extractBudget`: also pull `budget_id` from `litellm_budget_table` (present on `/tag/info` — the
  handler includes `litellm_budget_table`, tag_management_endpoints.py:451-456).
- New `budgetUpdate(budget_id: string, patch: { budget_reset_at?: string }): Promise<void>` →
  `POST /budget/update` with `{ budget_id, ...patch }`.
- `tagNew` / `tagUpdate` are unchanged (still send only name/max_budget/budget_duration); the reset
  date is applied in the follow-up `/budget/update`.

**`src/exulu/litellm/budget-service.ts`**
- `upsertBudget(tag, max_budget, budget_duration, budget_reset_at?)`: after the existing
  tagNew/tagUpdate branch, if `budget_reset_at` is set, look up `budget_id` via `tagInfo([tag])` and
  call `budgetUpdate(budget_id, { budget_reset_at })`. Then `invalidateBudgetCaches`.
- If `budget_reset_at` is absent (e.g. an older client), behavior is unchanged from today — no
  `/budget/update` call.
- Note: `tagInfo` is already called at the top of `upsertBudget` for the create-vs-update decision;
  reuse a fresh `tagInfo` read after the write to obtain the (possibly newly created) `budget_id`.

**`src/exulu/routes.ts`**
- `parseBudgetBody`: accept optional `budget_reset_at`. Validate it is a parseable ISO date string;
  reject otherwise with 400. Pass it through to `upsertBudget`.
- The bulk endpoint applies the same `budget_reset_at` to every entity.

### Frontend changes

**`lib/budget.ts`**
- Add a helper `defaultResetDate(duration: BudgetDuration, now = new Date()): Date` mirroring
  LiteLLM's scheme: `1d` → next local midnight; `7d` → next Monday 00:00; `30d` → 1st of next month
  00:00. (Kept in the shared budget lib next to the other projection math.)

**`lib/api/budgets.ts`**
- `upsert` / `bulkUpsert` input type gains optional `budget_reset_at: string`.

**`components/budget-editor.tsx`**
- New state `resetAt: Date` initialized from `existing?.budget_reset_at` (edit) or
  `defaultResetDate(duration)` (create).
- On duration change: set `resetAt = defaultResetDate(newDuration)` — **overwrites any custom pick**
  (approved behavior: predictable, re-customizable).
- Render a `Popover` + `Calendar` date picker (shadcn primitives already in `components/ui`) below
  the duration `Select`. Helper text (i18n `budgets.editor.resetHint`): the budget resets at the
  start of each week/month by default; pick a date to override.
- Include `budget_reset_at: resetAt.toISOString()` in both single and bulk `upsert` payloads.
- Field is shown in both create and edit modes.

**i18n**
- Add `budgets.editor.resetDateLabel` and `budgets.editor.resetHint` (and German translations) —
  follow the existing `budgets.editor.*` namespace convention.

### Error handling

- Backend: an invalid `budget_reset_at` → 400 from `parseBudgetBody` before any LiteLLM call.
- If the `/budget/update` follow-up fails after a successful tag upsert, the budget's amount/duration
  are already saved but the reset date is not. Surface this as a failed save (throw) so the admin
  retries, rather than silently succeeding with a wrong date. (The tag upsert is idempotent, so a
  retry is safe.)
- Frontend: existing try/catch toast in `handleSave` covers the surfaced error.

## Testing (TDD)

**Backend**
- `upsertBudget` with a `budget_reset_at` calls `budgetUpdate` with the resolved `budget_id` and the
  given date; without one, it makes no `/budget/update` call.
- `parseBudgetBody` rejects a non-date `budget_reset_at` and accepts a valid ISO string / omitted
  value.

**Frontend**
- `defaultResetDate` returns next Monday for `7d`, 1st-of-next-month for `30d`, next midnight for
  `1d`.
- Changing the duration in `BudgetEditor` updates the picker to the new default (overwriting a prior
  custom pick).
- Saving includes `budget_reset_at` in the payload; a custom pick is sent verbatim.

## Rollout / compatibility

- Additive: older frontend builds that omit `budget_reset_at` keep working (backend skips the
  `/budget/update` step, preserving today's behavior).
- No schema migration — `budget_reset_at` already exists on LiteLLM's budget table.
- `BudgetEditor`'s prop API is unchanged (internal state only), honoring its documented
  additive-only contract.
