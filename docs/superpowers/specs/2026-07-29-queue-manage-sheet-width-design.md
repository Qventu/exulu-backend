# Widen the "Manage queue" Sheet — Design

- **Date:** 2026-07-29
- **Status:** Approved (ready for implementation)
- **Repo:** `exulu/frontend` (frontend-only, single-line change)
- **Surface:** `app/(application)/workflows/[id]/components/routine-workbench.tsx` — the queue `SheetContent` opened by "Manage queue".

## Problem

Clicking "Manage queue" on `workflows/[id]` opens a right-side Sheet holding the
`QueuePanel`. The sheet is capped at `sm:max-w-2xl` (~672px). The panel's
4-stat row (Max queue concurrency / Max worker concurrency / Job timeout /
Rate limit), its 5 status pills (Active / Waiting / Failed / Stuck /
Completed), and its jobs table all need more than 672px, so they wrap and
collide: the "Completed" pill overlaps the "Only the last 5,000…" caption and
the jobs table's right-most column ("Attempt") is clipped.

## Root cause

The container, not the panel. `QueuePanel` is already internally responsive
(`flex flex-wrap`, `md:` breakpoints, truncating table cells). The
`sm:max-w-2xl` cap on the sheet is simply too narrow for its intended layout.

## Design

Widen the queue `SheetContent` from `sm:max-w-2xl` to `sm:max-w-4xl` (~896px)
in `routine-workbench.tsx` (the `className` on the queue sheet's
`SheetContent`). This matches the sibling `steps-editor-sheet.tsx` in the same
workbench, which already uses `sm:max-w-4xl` with a comment that its editors
"need horizontal room the workbench column cannot give them." At ~896px the
stat row (~600px), pills, and table (~660px) all fit on their intended rows,
resolving the wrap/overlap. Sub-`sm` viewports remain `w-full` (unchanged).

## Non-goals

- No changes to `QueuePanel` — it is already responsive; the container was the
  constraint.
- Not passing the panel's `embedded` prop (strips inner padding — a subjective
  styling change beyond the reported bug). YAGNI.
- No change to any other sheet.

## Verification

`tsc --noEmit` + `next build` clean; manual check that the queue manager
renders in the sheet without pill/caption overlap or column clipping, and that
the sibling step-editor sheet is unaffected.
