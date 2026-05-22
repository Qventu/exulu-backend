# LoadingStates reuse: consistent loading UX across items modal and data-display

**Date:** 2026-05-20
**Status:** Approved (design)
**Scope:** Frontend only (`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`)

## Problem

`items-selection-modal.tsx` shows a polished, animated `LoadingStates` UI while a new item is being created. `data-display.tsx` runs several async actions on an item (save/update, process, delete, generate chunks, delete chunks) but only shows a tiny inline `<Loading />` spinner inside the action buttons. The loading UX is inconsistent across the two surfaces.

## Goal

Reuse the `LoadingStates` visual treatment from the modal in `data-display.tsx` so both surfaces communicate "work in progress" the same way.

## Non-goals

- Restyling the loader visuals (same `Loader2`, same dot animation, same 1500 ms cadence).
- Changing mutation logic, error toasts, or button disabled states.
- Making the message sets caller-overridable. Variants are predefined.
- Touching unrelated load states in `data-display.tsx` (e.g., the initial-load skeleton at line 318).

## Current state

### `frontend/components/items-selection-modal.tsx`

- Defines a local `LoadingStates` at lines 706–754.
- The component is wrapped in `<DialogContent>` with `onPointerDownOutside` / `onEscapeKeyDown` / `onInteractOutside` guards — so it cannot render outside a `<Dialog>` parent.
- Two message variants are selected via `hasProcessor: boolean`.
- Used at line 850 inside the new-item dialog while `loading` (the create mutation) is true.

### `frontend/app/(application)/data/components/data-display.tsx`

Five async mutations against an item, each currently shown only as a small inline spinner on its button:

| Action | Mutation result | Button location |
|---|---|---|
| Save (update item) | `updateItemMutationResult.loading` | line 472–509 |
| Process item | `processItemMutationResult.loading` | line 549–565 |
| Delete item | `deleteItemMutationResult.loading` | line 406 |
| Generate chunks | `generateChunksMutationResult.loading` | line 1260 |
| Delete chunks | `deleteChunksMutationResult.loading` | line 1294 |

The detail panel root is `<div className="flex h-full flex-col">` at line 343.

## Design

### 1. New shared component: `frontend/components/loading-states.tsx`

Presentational only — no Dialog wrapper. The component is the inner JSX of the current modal `LoadingStates` (Loader2 + animated title + subtitle + dot row), nothing more.

```tsx
export type LoadingStatesVariant =
  | "create"                  // existing modal, no processor
  | "create-with-processor"   // existing modal, with processor
  | "save"                    // data-display: update item
  | "process"                 // data-display: run processor
  | "delete"                  // data-display: delete item
  | "generate-chunks"         // data-display: generate embeddings
  | "delete-chunks";          // data-display: delete chunks

export function LoadingStates({ variant }: { variant: LoadingStatesVariant }): JSX.Element;
```

Internally, an object map drives the state machine:

```ts
const VARIANTS: Record<LoadingStatesVariant, { states: string[]; subtitle: string }> = {
  "create":                  { states: ["Creating item…", "Saving data…", "Almost done…"],
                               subtitle: "Saving your new item…" },
  "create-with-processor":   { states: ["Creating item…", "Processing fields…", "Preparing for AI…", "Almost done…"],
                               subtitle: "Your item is being processed. This may take a moment." },
  "save":                    { states: ["Saving changes…", "Updating fields…", "Almost done…"],
                               subtitle: "Updating your item…" },
  "process":                 { states: ["Processing item…", "Running processor…", "Almost done…"],
                               subtitle: "The processor is running on your item." },
  "delete":                  { states: ["Deleting item…", "Cleaning up…", "Almost done…"],
                               subtitle: "Removing your item…" },
  "generate-chunks":         { states: ["Generating embeddings…", "Indexing chunks…", "Almost done…"],
                               subtitle: "Creating embedding vectors for this item." },
  "delete-chunks":           { states: ["Deleting chunks…", "Cleaning up…", "Almost done…"],
                               subtitle: "Removing chunks for this item." },
};
```

The component reads `VARIANTS[variant]`, advances `currentStateIndex` every 1500 ms, and renders the same `flex flex-col items-center space-y-6 py-6` block currently in the modal. No `DialogContent` involved.

### 2. `items-selection-modal.tsx`

- Delete the local `LoadingStates` definition (lines 706–754).
- Import the shared one: `import { LoadingStates } from "@/components/loading-states";`.
- At the usage site (currently line 849–851), wrap the shared component in the same `<DialogContent>` that the old local one rendered, preserving the dismiss-blocking props:

```tsx
{loading ? (
  <DialogContent
    className="sm:max-w-md border-none shadow-2xl bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/95"
    onPointerDownOutside={(e) => e.preventDefault()}
    onEscapeKeyDown={(e) => e.preventDefault()}
    onInteractOutside={(e) => e.preventDefault()}
  >
    <LoadingStates variant={context.processor ? "create-with-processor" : "create"} />
  </DialogContent>
) : (
  <DialogContent ...>{/* form, unchanged */}</DialogContent>
)}
```

Visible behavior is identical to today.

### 3. `data-display.tsx` — panel-scoped overlay

Add `relative` to the detail panel root and render an absolutely positioned overlay sibling whenever any of the five tracked mutations is loading. Variant selected by priority (only one realistically runs at a time):

```tsx
import { LoadingStates, type LoadingStatesVariant } from "@/components/loading-states";

const overlayVariant: LoadingStatesVariant | null =
  updateItemMutationResult.loading      ? "save"
: processItemMutationResult.loading     ? "process"
: deleteItemMutationResult.loading      ? "delete"
: generateChunksMutationResult.loading  ? "generate-chunks"
: deleteChunksMutationResult.loading    ? "delete-chunks"
: null;

return (
  <div className="relative flex h-full flex-col">
    {/* existing detail-panel content, unchanged */}
    {overlayVariant && (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <LoadingStates variant={overlayVariant} />
      </div>
    )}
  </div>
);
```

Constraints:
- The overlay must not appear during the initial `loading` skeleton path (line 318–328) — that early return short-circuits before the overlay JSX renders, so this is automatic.
- Existing inline `<Loading />` spinners and `disabled` props on the action buttons stay as-is. The overlay is additive.
- `z-50` matches the project's overlay convention (verify against neighbouring tailwind usage during implementation; adjust if a higher stacking context is in play).

### 4. File layout

- New: `frontend/components/loading-states.tsx` (single export, ~60 LOC).
- Modified: `frontend/components/items-selection-modal.tsx` (remove local component, add import, wrap loading branch in `<DialogContent>`).
- Modified: `frontend/app/(application)/data/components/data-display.tsx` (add `relative` to root, add `overlayVariant` const, add overlay JSX, add import).

## Visible behavior after change

- Modal: indistinguishable from today (same copy, same DialogContent guards, same animation).
- Data-display: when the user clicks Save / Process / Delete / Generate / Delete chunks, the detail panel dims with a backdrop and shows the animated `LoadingStates` block until the mutation resolves. The rest of the page (sidebar, list) stays interactive.

## Risks & mitigations

- **Two mutations loading simultaneously.** The priority `if/else` deterministically picks one variant; the overlay still appears. In practice the buttons disable themselves while a mutation is in flight, so simultaneous loads are unlikely.
- **Z-index clashes.** `z-50` is a sensible default but the data page may have its own overlays (dialogs for confirm-delete-chunks, etc.). Confirmation dialogs use Radix which renders to a portal at a higher layer, so they will still appear above the panel overlay when triggered.
- **Long-running processor.** The animated step text cycles indefinitely; subtitle stays accurate ("The processor is running on your item.").

## Testing

Manual UAT in the browser:

1. **Modal — happy path.** Open New Item dialog in a context without processor, submit; confirm loader copy says "Creating item… / Saving data… / Almost done…" and subtitle "Saving your new item…".
2. **Modal — with processor.** Same flow in a context with a processor; confirm the four-step copy and processor subtitle.
3. **Data-display — Save.** Edit an item, click Save; overlay appears with "Saving changes…" copy until success toast fires.
4. **Data-display — Process.** Click Process; overlay shows "Processing item…" copy.
5. **Data-display — Delete.** Click Delete; overlay shows "Deleting item…" copy until the row is removed.
6. **Data-display — Generate chunks.** Confirm dialog → confirm; overlay shows "Generating embeddings…" copy.
7. **Data-display — Delete chunks.** Confirm dialog → confirm; overlay shows "Deleting chunks…" copy.
8. **Regression.** Confirm the sidebar and item list remain interactive while the data-display overlay is shown.
9. **Initial load.** Open a fresh item URL; confirm the skeleton state still renders (the overlay does not appear during initial load).
