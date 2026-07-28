# Runs List Alignment + Multi-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the runs-list columns with a fixed-track grid and add per-row + select-all multi-select with subset-count bulk Cancel/Delete actions.

**Architecture:** Frontend-only change to `runs-list.tsx`. The run row becomes a nested CSS grid (outer `[checkbox][1fr]`; the expand button is itself a fixed-track grid so content columns align across rows). `RunsList` holds a `selectedIds` set; a pure `partitionSelection` helper splits the selection into cancellable/deletable id lists that drive an always-present slim toolbar (select-all + counts + actions). Bulk actions loop the existing single mutations with `Promise.allSettled`. No backend changes.

**Tech Stack:** Next.js, React, Apollo Client, next-intl (ICU plurals), shadcn/ui (`Checkbox`, `Button`, `ConfirmDialog`), Vitest (helper).

## Global Constraints

- **Frontend repo only** (`exulu/frontend`); no backend/GraphQL/type changes. Bulk ops reuse the existing `CANCEL_ROUTINE_RUN` / `DELETE_ROUTINE_RUN` mutations.
- **Alignment via fixed grid tracks** (compact, NO column-label header row). The state and trigger columns get fixed widths — that's what aligns everything after them.
- **No nested interactives:** the checkbox is a standalone grid cell; the row's expand `<button>` is a sibling cell (a nested grid), never a parent of the checkbox.
- **Bulk = subset actions with counts:** `Cancel (C)` acts on the cancellable subset (`canCancelRun`), `Delete (D)` on the terminal subset (`canDeleteRun`); each button disabled when its count is 0. Both open a destructive `ConfirmDialog`, then loop the single mutation over the eligible ids via `Promise.allSettled`, toast a summary, `refetch`, and clear the selection.
- **Select-all scoped to the loaded page.** Selection clears on any filter/page change.
- Every commit subject starts lowercase (the backend commitlint hook does not apply to the frontend repo, but keep it consistent). End messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Verify repo+branch before each commit.
- Verify: `npx vitest run` for the helper; `npx tsc --noEmit` + `npm run lint` + `npm run build` + manual smoke for the UI.

## File Structure

- `lib/routine-runs/presentation.ts` — add `partitionSelection` (+ `SelectionPartition`).
- `lib/routine-runs/presentation.test.ts` — add its test.
- `components/widgets/routine-runs/runs-list.tsx` — RunRow grid + checkbox (Task 2); `RunsList` selection state + bulk toolbar (Tasks 2-3).
- `messages/en.json`, `messages/de.json` — `routineRuns.bulk.*` (Task 3).

---

### Task 1: `partitionSelection` helper

**Files:**
- Modify: `lib/routine-runs/presentation.ts`
- Test: `lib/routine-runs/presentation.test.ts`

**Interfaces:**
- Consumes: existing `canCancelRun`, `canDeleteRun`.
- Produces: `interface SelectionPartition { cancellable: string[]; deletable: string[] }` and `partitionSelection(runs: { id: string; state: string }[], selectedIds: ReadonlySet<string>): SelectionPartition`.

- [ ] **Step 1: Write the failing test**

Add `partitionSelection` to the import from `./presentation` in `lib/routine-runs/presentation.test.ts`, and append:

```ts
describe("partitionSelection", () => {
  const runs = [
    { id: "a", state: "active" },       // cancellable
    { id: "b", state: "completed" },    // deletable
    { id: "c", state: "waiting_approval" }, // cancellable
    { id: "d", state: "cancelled" },    // deletable
    { id: "e", state: "failed" },       // deletable, but not selected below
  ];
  it("splits the selection into cancellable and deletable id lists", () => {
    expect(
      partitionSelection(runs, new Set(["a", "b", "c", "d"])),
    ).toEqual({ cancellable: ["a", "c"], deletable: ["b", "d"] });
  });
  it("ignores ids not present in runs and returns empty lists for an empty selection", () => {
    expect(partitionSelection(runs, new Set(["zzz"]))).toEqual({
      cancellable: [],
      deletable: [],
    });
    expect(partitionSelection(runs, new Set())).toEqual({
      cancellable: [],
      deletable: [],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/routine-runs/presentation.test.ts -t partitionSelection`
Expected: FAIL — `partitionSelection` is not exported.

- [ ] **Step 3: Implement the helper**

In `lib/routine-runs/presentation.ts`, after `canDeleteRun` / `isTerminalRunState`:

```ts
export interface SelectionPartition {
  /** selected run ids that can be cancelled (canCancelRun). */
  cancellable: string[];
  /** selected run ids that can be deleted (canDeleteRun / terminal). */
  deletable: string[];
}

/** Splits the selected run ids into the subset each bulk action can act on. */
export function partitionSelection(
  runs: { id: string; state: string }[],
  selectedIds: ReadonlySet<string>,
): SelectionPartition {
  const cancellable: string[] = [];
  const deletable: string[] = [];
  for (const run of runs) {
    if (!selectedIds.has(run.id)) continue;
    if (canCancelRun(run.state)) cancellable.push(run.id);
    else if (canDeleteRun(run.state)) deletable.push(run.id);
  }
  return { cancellable, deletable };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/routine-runs/presentation.test.ts -t partitionSelection`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected frontend branch
git add lib/routine-runs/presentation.ts lib/routine-runs/presentation.test.ts
git commit -m "feat(routines): partitionSelection helper for bulk run actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Row layout → aligned grid + per-row selection

Restructure `RunRow` into a nested grid with a checkbox column, and thread selection state from `RunsList`. No bulk toolbar yet (Task 3) — after this task the columns align and per-row checkboxes toggle selection.

**Files:**
- Modify: `components/widgets/routine-runs/runs-list.tsx`

**Interfaces:**
- Consumes: `Checkbox` from `@/components/ui/checkbox`.
- Produces: `RunRowProps` gains `selected: boolean` + `onSelectChange: (checked: boolean) => void`; `RunsList` owns `selectedIds: Set<string>`.

- [ ] **Step 1: Add the Checkbox import**

In `runs-list.tsx`, add next to the other `@/components/ui/*` imports:

```tsx
import { Checkbox } from "@/components/ui/checkbox";
```

- [ ] **Step 2: Add `selectedIds` state + clear-on-change to `RunsList`**

Next to `const [cancelTarget, ...]` / `const [deleteTarget, ...]`, add:

```tsx
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
```

After the `useQuery(...)` that yields `data` / `runs`, add an effect that clears selection whenever the loaded set's context changes (filter or page):

```tsx
  const filterKey = JSON.stringify(filter);
  React.useEffect(() => {
    setSelectedIds(new Set());
  }, [filterKey]);
```

Add a per-row toggle helper (near the other handlers):

```tsx
  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
```

- [ ] **Step 3: Pass selection props to `RunRow` at the mount**

In the `runs.map((run) => (<RunRow ... />))`, add:

```tsx
              selected={selectedIds.has(run.id)}
              onSelectChange={(checked) => toggleSelected(run.id, checked)}
```

- [ ] **Step 4: Add the props to `RunRowProps` + destructure**

In `interface RunRowProps`, add:

```tsx
  selected: boolean;
  onSelectChange: (checked: boolean) => void;
```

And add `selected,` + `onSelectChange,` to the `function RunRow({ ... })` destructure.

- [ ] **Step 5: Restructure the RunRow header into a nested grid with the checkbox**

Replace the RunRow header (the `<li className={cn(run.state === "filtered" && "opacity-60")}>` opening through the closing `</button>` of the header — i.e. the flex `<button onClick={onToggle}>…</button>`) with this nested-grid structure. Leave the `{expanded ? (<div …detail…/>) : null}` block and the closing `</li>` exactly as they are:

```tsx
    <li className={cn(run.state === "filtered" && "opacity-60")}>
      <div
        className={cn(
          "grid grid-cols-[auto_1fr] items-center gap-3 px-3",
          expanded && "bg-muted/30",
        )}
      >
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onSelectChange(checked === true)}
          aria-label={t("bulk.selectRow")}
        />
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="grid min-h-11 grid-cols-[auto_150px_190px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 py-2.5 text-left transition-colors hover:bg-muted/50"
        >
          <StatusDot status={mapped.status} pulse={mapped.pulse} />
          <Badge
            variant="outline"
            className={cn("justify-self-start", RUN_STATE_BADGE[run.state] ?? "")}
          >
            {stateLabel(run.state)}
          </Badge>
          <Badge
            variant="outline"
            className="max-w-full justify-self-start truncate font-normal text-muted-foreground"
          >
            {triggerLabel}
          </Badge>
          <span className="hidden min-w-0 truncate text-sm sm:block">
            {showRoutineColumn && run.workflowName ? (
              <span className="text-muted-foreground">
                {run.workflowName}
                {title !== "" && title !== run.workflowName ? " — " : ""}
              </span>
            ) : null}
            {title !== run.workflowName || !showRoutineColumn ? title : null}
          </span>
          {run.createdAt ? (
            <RelativeTime
              date={run.createdAt}
              className="shrink-0 text-xs text-muted-foreground"
            />
          ) : (
            <span />
          )}
          {duration ? (
            <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground md:block">
              {duration}
            </span>
          ) : (
            <span className="hidden md:block" />
          )}
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
      </div>
```

Notes: the inner button is a 7-track grid, so State/Trigger/Subject/When/Dur/Chevron align across rows; the empty `<span />` placeholders keep the 7 tracks filled when `createdAt`/`duration` are absent; the `t("bulk.selectRow")` aria label key is added in Task 3 (until then the checkbox still renders — `t` returns the raw key if missing, which is harmless for this task's verification).

- [ ] **Step 6: Verify — type-check + lint**

Run: `npx tsc --noEmit`
Run: `npm run lint`
Expected: clean for the touched file. (No bulk toolbar yet; `selectedIds` is consumed by the row checkboxes, so no unused-var.)

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "components/widgets/routine-runs/runs-list.tsx"
git commit -m "feat(routines): align runs-list columns via grid + per-row selection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Select-all + bulk toolbar + actions

**Files:**
- Modify: `components/widgets/routine-runs/runs-list.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `partitionSelection` (Task 1); `selectedIds`/`setSelectedIds`/`toggleSelected` + `cancelMutate`/`deleteMutate`/`refetch` (existing); `Checkbox`, `Button`, `ConfirmDialog`.

- [ ] **Step 1: Add selection-derived values + bulk handlers to `RunsList`**

Below the `runs` / `total` derivations, add:

```tsx
  const { cancellable, deletable } = partitionSelection(runs, selectedIds);
  const selectedCount = runs.filter((r) => selectedIds.has(r.id)).length;
  const allSelected = runs.length > 0 && selectedCount === runs.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const toggleSelectAll = (checked: boolean) =>
    setSelectedIds(checked ? new Set(runs.map((r) => r.id)) : new Set());

  const [bulkConfirm, setBulkConfirm] = React.useState<
    "cancel" | "delete" | null
  >(null);

  const runBulk = async () => {
    if (!bulkConfirm) return;
    const ids = bulkConfirm === "cancel" ? cancellable : deletable;
    const mutate = bulkConfirm === "cancel" ? cancelMutate : deleteMutate;
    const results = await Promise.allSettled(
      ids.map((id) => mutate({ variables: { id } })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - ok;
    if (failed === 0) {
      toast.success(
        t(bulkConfirm === "cancel" ? "bulk.toast.cancelled" : "bulk.toast.deleted", {
          count: ok,
        }),
      );
    } else {
      toast.error(t("bulk.toast.partial", { ok, failed }));
    }
    setBulkConfirm(null);
    setSelectedIds(new Set());
    await refetch();
  };
```

- [ ] **Step 2: Add the always-present select bar above the list**

Immediately before the `{/* List */}` block (the `loading && runs.length === 0 ? … : runs.length === 0 ? … : <ul>…`), add a slim bar that shows the select-all when idle and the counts+actions when a selection exists:

```tsx
      {runs.length > 0 ? (
        <div className="flex items-center gap-3 rounded-md border bg-muted/20 px-3 py-2 text-sm">
          <Checkbox
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(checked) => toggleSelectAll(checked === true)}
            aria-label={t("bulk.selectAll")}
          />
          {selectedCount > 0 ? (
            <>
              <span className="text-muted-foreground">
                {t("bulk.selected", { count: selectedCount })}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cancellable.length === 0}
                  onClick={() => setBulkConfirm("cancel")}
                >
                  {t("bulk.cancel", { count: cancellable.length })}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deletable.length === 0}
                  onClick={() => setBulkConfirm("delete")}
                >
                  {t("bulk.delete", { count: deletable.length })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                >
                  {t("bulk.clear")}
                </Button>
              </div>
            </>
          ) : (
            <span className="text-muted-foreground">{t("bulk.selectAll")}</span>
          )}
        </div>
      ) : null}
```

- [ ] **Step 3: Add the bulk ConfirmDialog**

Next to the existing cancel/delete `<ConfirmDialog>`s (near the end of `RunsList`'s return), add:

```tsx
      <ConfirmDialog
        open={bulkConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setBulkConfirm(null);
        }}
        title={
          bulkConfirm === "delete"
            ? t("bulk.deleteConfirm.title", { count: deletable.length })
            : t("bulk.cancelConfirm.title", { count: cancellable.length })
        }
        description={
          bulkConfirm === "delete"
            ? t("bulk.deleteConfirm.description")
            : t("bulk.cancelConfirm.description")
        }
        variant="destructive"
        confirmLabel={
          bulkConfirm === "delete"
            ? t("bulk.deleteConfirm.confirmLabel")
            : t("bulk.cancelConfirm.confirmLabel")
        }
        onConfirm={runBulk}
      />
```

- [ ] **Step 4: Add the i18n keys (en + de)**

In `messages/en.json`, inside the `routineRuns` object (the one holding `cancelConfirm` / `toast.cancelled`), add a `bulk` object:

```json
      "bulk": {
        "selectAll": "Select all",
        "selectRow": "Select run",
        "selected": "{count} selected",
        "cancel": "Cancel ({count})",
        "delete": "Delete ({count})",
        "clear": "Clear",
        "cancelConfirm": {
          "title": "Cancel {count, plural, one {# run} other {# runs}}?",
          "description": "The selected runs will stop. This cannot be undone.",
          "confirmLabel": "Cancel runs"
        },
        "deleteConfirm": {
          "title": "Delete {count, plural, one {# run} other {# runs}}?",
          "description": "The selected runs and their transcripts will be permanently deleted. This cannot be undone.",
          "confirmLabel": "Delete runs"
        },
        "toast": {
          "cancelled": "{count, plural, one {# run cancelled} other {# runs cancelled}}",
          "deleted": "{count, plural, one {# run deleted} other {# runs deleted}}",
          "partial": "{ok} done, {failed} failed"
        }
      },
```

In `messages/de.json`, add the matching `bulk` object in the same `routineRuns` block:

```json
      "bulk": {
        "selectAll": "Alle auswählen",
        "selectRow": "Lauf auswählen",
        "selected": "{count} ausgewählt",
        "cancel": "Abbrechen ({count})",
        "delete": "Löschen ({count})",
        "clear": "Leeren",
        "cancelConfirm": {
          "title": "{count, plural, one {# Lauf} other {# Läufe}} abbrechen?",
          "description": "Die ausgewählten Läufe werden gestoppt. Dies kann nicht rückgängig gemacht werden.",
          "confirmLabel": "Läufe abbrechen"
        },
        "deleteConfirm": {
          "title": "{count, plural, one {# Lauf} other {# Läufe}} löschen?",
          "description": "Die ausgewählten Läufe und ihre Transkripte werden dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.",
          "confirmLabel": "Läufe löschen"
        },
        "toast": {
          "cancelled": "{count, plural, one {# Lauf abgebrochen} other {# Läufe abgebrochen}}",
          "deleted": "{count, plural, one {# Lauf gelöscht} other {# Läufe gelöscht}}",
          "partial": "{ok} erledigt, {failed} fehlgeschlagen"
        }
      },
```

- [ ] **Step 5: Verify — helper test, type-check, lint, JSON, build**

Run: `npx vitest run lib/routine-runs/presentation.test.ts`
Expected: PASS (incl. `partitionSelection`).
Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `node -e "require('./messages/en.json'); require('./messages/de.json'); console.log('json ok')"`
Run: `npm run build`
Expected: all clean for touched files.

- [ ] **Step 6: Manual smoke (author confirms)**

On `/workflows` (and a routine's Runs section): run columns line up (State/Trigger/Subject/When/Duration). A select-all bar shows above the list. Selecting rows shows `N selected` + `Cancel (C)` + `Delete (D)` + `Clear`; `Cancel` is enabled only when a live run is selected, `Delete` only when a terminal run is; each confirms, acts on its subset, toasts a summary, refetches, and clears. Selecting a mix lets you delete the finished ones and cancel the live ones separately. Clicking a checkbox does not expand the row.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add "components/widgets/routine-runs/runs-list.tsx" messages/en.json messages/de.json
git commit -m "feat(routines): bulk cancel/delete runs from the runs list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** aligned grid (fixed tracks, no header) → Task 2. Per-row + select-all selection, page-scoped, clears on filter/page change → Tasks 2-3. Bulk toolbar with subset counts, disabled-at-0, ConfirmDialogs, `Promise.allSettled` loop over existing mutations, summary toast, refetch, clear → Task 3. `partitionSelection` helper + test → Task 1. i18n → Task 3. No backend changes (bulk reuses existing mutations). Checkbox-not-in-button handled by the nested grid (Task 2 §5).
- **Placeholder scan:** none — every step has concrete code; the only forward-reference (`t("bulk.selectRow")` used in Task 2 but keyed in Task 3) is called out with its harmless-until-then behavior.
- **Type consistency:** `partitionSelection(runs, selectedIds): { cancellable, deletable }` (Task 1) matches its use in Task 3 (`cancellable.length` / `deletable.length` / the id lists fed to `mutate`). `RunRowProps.selected: boolean` + `onSelectChange: (checked: boolean) => void` (Task 2) match the mount props and the `<Checkbox onCheckedChange>` usage. `selectedIds: Set<string>` / `setSelectedIds` / `toggleSelected` / `bulkConfirm` are defined in Task 2/3 and used consistently. i18n keys used (`bulk.selectAll/selectRow/selected/cancel/delete/clear/cancelConfirm.*/deleteConfirm.*/toast.*`) are all added in Task 3 §4.
