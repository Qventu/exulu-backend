# Runs List — Column Alignment + Multi-Select Bulk Actions — Design

- **Date:** 2026-07-28
- **Status:** Approved (ready for implementation plan)
- **Repo:** `exulu/frontend` (frontend-only; no backend changes)
- **Surface:** `components/widgets/routine-runs/runs-list.tsx` (the `RoutineRunsList` widget — rendered in the routine detail Runs section AND the global `/workflows` runs console)

## Problem

Two issues with the runs list:

1. **Unaligned columns.** Each run row is a `flex gap-3` where the **State**
   badge has variable width (`Cancelled` / `Needs attention` / `Completed`), so
   the trigger chip, subject, and time start at different x-positions on every
   row — it reads as unstructured.
2. **No multi-select / bulk actions.** Runs can only be cancelled or deleted one
   at a time (per-row). There's no way to select several and bulk-cancel or
   bulk-delete.

## Goals

- Align the run-row columns via a fixed-track CSS grid (compact, no column-label
  header).
- Add per-row selection + select-all, and a bulk-action toolbar (Cancel /
  Delete) that appears when ≥1 run is selected.

## Non-goals

- No backend changes: bulk ops reuse the existing `cancelRoutineRun` /
  `deleteRoutineRun` single mutations (client-side loop). No new bulk mutation.
- No column-label header row (the compact aesthetic is kept — alignment comes
  from the grid tracks).
- Select-all is scoped to the currently-loaded page, not a cross-page "select
  every matching run".
- No change to the per-row cancel/retry/delete actions, the expand/detail panel,
  or the filter bar (beyond selection clearing on filter/page change).

## Decisions (settled)

| Question | Decision |
| --- | --- |
| Structure | Aligned **fixed-track grid**, no column-label header; select-all + bulk actions in a slim toolbar shown on selection. |
| Bulk mixed selection | **Subset actions with counts**: `Cancel (C)` acts on the cancellable subset, `Delete (D)` on the terminal subset; each disabled when its count is 0. |
| Backend | Reuse the existing single mutations in a client-side loop (`Promise.allSettled`). No bulk mutation. |
| Select-all scope | The currently-loaded page's runs. |

## Design

### 1. Row layout — aligned grid

Convert the `RunRow` header from a single flex `<button>` to a grid `<li>` with
fixed column tracks so every row aligns:

```
[checkbox] [status-dot] [state-badge (fixed w)] [trigger (fixed w)] [subject (1fr, truncate)] [when] [duration] [chevron]
```

- Fixed widths on the state-badge and trigger columns are what align the
  subsequent columns across rows. Subject takes the remaining space (`1fr`,
  truncate). Keep the existing responsive hiding (subject on ≥sm, duration on
  ≥md).
- **Checkbox vs the expand button (no nested interactives):** the row currently
  is one `<button onClick={onToggle}>`. A checkbox cannot nest inside a button.
  Restructure so the `<Checkbox>` is a standalone grid cell (col 1) and the
  remaining cells sit inside the expand-toggle rendered with `display:contents`
  (a `<button className="contents …">`), so its children still occupy the grid
  tracks while the checkbox stays a separate, independently-clickable control.
- The expandable detail panel (From/Subject/Message ID/Open session/Show raw
  JSON) stays unchanged, rendered full-width below the header row.

### 2. Multi-select state — `RunsList`

- `RunsList` owns `const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())`.
- Each `RunRow` gets `selected: boolean` + `onSelectChange: (checked: boolean) => void`;
  renders `<Checkbox checked={selected} onCheckedChange={onSelectChange} />` in
  col 1. Toggling selection must NOT toggle expand (separate control).
- **Select-all:** a `<Checkbox>` in the bulk toolbar; checked when all loaded
  runs are selected, indeterminate when some are, toggles all `runs.map(r=>r.id)`.
- **Clear on context change:** selection resets to empty whenever the loaded set
  changes — on filter change, page change, and refetch. (Effect keyed on the
  runs' id list / filter.)

### 3. Bulk toolbar — shown when `selectedIds.size > 0`

A slim bar above the list: **`N selected · Cancel (C) · Delete (D) · Clear`**.

- `C` = count of selected runs where `canCancelRun(state)`; the Cancel button is
  disabled when `C === 0`.
- `D` = count of selected runs where `canDeleteRun(state)`; the Delete button is
  disabled when `D === 0`.
- **Cancel / Delete** each open a destructive `ConfirmDialog` carrying the count
  (Delete's copy notes the runs + transcripts are permanently removed). On
  confirm:
  - Resolve the eligible id subset via `partitionSelection` (§4).
  - `await Promise.allSettled(ids.map(id => mutate({ variables: { id } })))` over
    the eligible subset (existing `CANCEL_ROUTINE_RUN` / `DELETE_ROUTINE_RUN`).
  - Toast a summary from the settled results (e.g. `"3 deleted, 1 failed"`);
    `await refetch()`; clear the selection.
- **Clear** empties the selection.

### 4. Pure helper — `lib/routine-runs/presentation.ts`

```ts
export interface SelectionPartition {
  cancellable: string[]; // selected & canCancelRun
  deletable: string[];   // selected & canDeleteRun
}
export function partitionSelection(
  runs: { id: string; state: string }[],
  selectedIds: ReadonlySet<string>,
): SelectionPartition
```

Drives the toolbar counts (`C = cancellable.length`, `D = deletable.length`) and
the exact ids each bulk action operates on. Unit-tested (vitest, alongside the
existing `canCancelRun` / `canDeleteRun` tests).

### 5. i18n — `messages/en.json` + `messages/de.json`

Under the `routineRuns` namespace: `bulk.selectAll`, `bulk.selected`
(`"{count} selected"`), `bulk.cancel` (`"Cancel ({count})"`), `bulk.delete`
(`"Delete ({count})"`), `bulk.clear`, `bulk.cancelConfirm.{title,description,confirmLabel}`,
`bulk.deleteConfirm.{title,description,confirmLabel}`, `bulk.toast.{cancelled,deleted,partial,failed}`.

## Error handling

- Partial failures: `Promise.allSettled` → summary toast counting fulfilled vs
  rejected; the list refetches so the true post-state is shown regardless.
- A run whose state changed since selection (e.g. an "active" run that finished)
  is simply excluded from the eligible subset at action time (the backend also
  re-validates and would reject it).
- No eligible ids for an action → that button is already disabled (count 0).

## Testing

- **`partitionSelection`** unit test (vitest): mixed selection → correct
  cancellable/deletable id partition; empty selection → empty partitions; ids not
  in `runs` ignored.
- The grid alignment, checkbox/select-all wiring, and the bulk toolbar/confirm
  flow are verified by `tsc` + lint + build + manual smoke (no component-test
  infra for this widget).

## Sequencing

1. `partitionSelection` helper + test.
2. Row layout → aligned grid + per-row `<Checkbox>` (selection state threaded
   from `RunsList`, no bulk actions yet).
3. Bulk toolbar (select-all, counts, Cancel/Delete confirms + `Promise.allSettled`
   loop + summary toast + refetch + clear) + i18n.
4. Verify (vitest + tsc + lint + build + manual smoke).
