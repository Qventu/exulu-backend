# Bulk "Set access" (RBAC) action for knowledge base items

**Date:** 2026-07-29
**Status:** Approved design — ready for implementation planning
**Repos:** `exulu/backend` (new bulk mutation) and `exulu/frontend` (action-bar button + dialog)

## Problem

The knowledge base items management page (`/data/<context>`) supports two bulk
actions today — **Archive** and **Delete**. Users can select multiple items via
row checkboxes and act on the whole selection. There is no way to change the
**access control (RBAC) settings** of several items at once; a user must open
each item's detail page and edit its Access section individually.

We want a third bulk action, **"Set access"**, that applies a chosen RBAC
configuration to all selected items in one step.

## Goals

- Add a "Set access" bulk action to the items management page that overwrites the
  RBAC configuration (visibility mode + user/role/team grants) of every selected
  item with a single chosen configuration.
- Reuse the existing per-item access editor UI (`RBACControl`) so the bulk dialog
  behaves identically to the single-item editor.
- Do the write server-side via one dedicated mutation that does **not** trigger
  re-embedding or processor re-runs.

## Non-goals

- Additive/merge semantics (e.g. "grant team X read to all, keep existing
  grants"). This design is **overwrite/replace** only.
- Filter-based bulk ("apply to all items matching the current filter, including
  unselected pages"). We operate on the explicitly selected item ids, matching
  the existing Archive/Delete behavior. A filter-based variant is a possible
  future enhancement.
- Fixing the pre-existing gap where the single-item detail save omits `teams`
  from its RBAC payload. The bulk path will be complete (includes teams); the
  single-item save is left untouched.

## Key decision: overwrite semantics

Chosen behavior: the dialog defines a complete target access configuration
(`rights_mode` + the full set of user/role/team grants), and every selected item
is set to **exactly** that configuration. Any grants an item previously had that
are not in the new configuration are removed.

This maps directly onto the existing `handleRBACUpdate` helper
(`ee/rbac-update.ts`), which diffs a desired grant set against the existing rows
for a resource and deletes/inserts accordingly.

## Key decision: dedicated backend mutation (not frontend fan-out)

Bulk Archive and Delete are currently implemented purely on the frontend by
fanning out single-item mutations (`Promise.all` over `‹ctx›_itemsUpdateOneById`
/ `‹ctx›_itemsRemoveOneById`). We deliberately do **not** reuse that pattern for
RBAC, because the single-item update path runs `postprocessUpdate`
(`src/graphql/mutations/index.ts`), which — for any context configured with
`calculateVectors: "onUpdate"` or `"always"` (or an `onUpdate`/`always`
processor) — **deletes all chunks and re-generates embeddings / re-runs the
processor on every updated item, regardless of which fields changed**. Applying
an RBAC-only change through that path would trigger a full, costly re-embed of
every selected item.

The dedicated bulk mutation writes `rights_mode` and RBAC records directly and
skips `postprocessUpdate` entirely, so a pure access change never re-embeds.

## Architecture

### Backend

**New mutation** (generated per RBAC-enabled item context, matching existing
`${tableNamePlural}...` naming — e.g. `‹ctx›_itemsBulkUpdateRBAC`):

```graphql
‹ctx›_itemsBulkUpdateRBAC(
  ids: [ID!]!,
  input: BulkRBACInput!
): ‹ctx›_itemsBulkUpdateRBACPayload

# input mirrors the rights_mode + RBAC sub-object of the existing
# single-item ‹ctx›_itemsInput, so the RBACControl payload works unchanged:
#   rights_mode: String!
#   RBAC: <the existing RBAC input type used by ‹ctx›_itemsInput.RBAC>

type ‹ctx›_itemsBulkUpdateRBACPayload {
  message: String!
  itemCount: Int!
}
```

**Files:**
- `src/graphql/schemas/index.ts` — add the mutation field + input/payload types,
  gated on `table.type === "items" && table.RBAC` (the same gate that governs
  whether per-item access editing exists).
- `src/graphql/mutations/index.ts` — add the resolver
  `${tableNamePlural}BulkUpdateRBAC` to the object returned by `createMutations`.
- `ee/rbac-update.ts` — reuse `handleRBACUpdate` unchanged.

**Resolver behavior** (all inside one `db.transaction`):
1. For every id, `validateWriteAccess(id, context)` (super_admin bypasses, as
   today). **Atomic / fail-fast:** if the user lacks write access to any selected
   item, the call throws a clear error
   (e.g. `"You don't have write access to N of the selected items"`) and nothing
   is changed.
2. `UPDATE ‹ctx›_items SET rights_mode = :rights_mode WHERE id IN (:ids)` — one
   query, plus `updatedAt`.
3. For each id: load existing `rbac` rows
   (`entity = table.name.singular`, `target_resource_id = id`) and call
   `handleRBACUpdate(trx, table.name.singular, id, input.RBAC, existingRows)`.
   This performs
   the overwrite (removes grants no longer present, inserts new ones). Empty
   grants (private/public mode) correctly clears all grants for the item.
4. **No `postprocessUpdate` call** — no chunk deletion, no re-embedding, no
   processor re-run.
5. Return `{ message, itemCount }`. No item payloads (bulk responses stay light;
   the frontend refetches the list).

**License:** `handleRBACUpdate` already enforces `checkLicense().rbac`, and the
mutation only exists for `table.RBAC` contexts.

### Frontend

Route: `app/(application)/data/[ctx]/...`

- **`components/items-action-bar.tsx`** — add a **"Set access"** button
  (shield/lock icon, `variant="secondary"`) alongside Archive. Rendered whenever
  `selection.size > 0` **and** the context supports RBAC (same condition that
  surfaces the per-item Access section). New `onSetAccess` prop. Shown in both the
  Active and Archived views (access is orthogonal to archive state).
- **`components/bulk-access-dialog.tsx` (new)** — shadcn `Dialog` (matching
  `bulk-filter-dialog.tsx`), embedding the existing **`RBACControl`**
  (`components/rbac.tsx`) — no duplication. Because this is overwrite, the control
  opens at a **neutral default (Private, no grants)** rather than reading any one
  item's config; the header notes "Applies to N selected items." Footer: Cancel +
  **Apply**; Apply is disabled while pending.
- **`app/(application)/data/queries.ts`** — add `BULK_UPDATE_ITEM_RBAC(ctxId)`
  returning `{ message, itemCount }`.
- **`components/items-table.tsx`** — dialog open state + `handleBulkSetAccess`
  that calls the mutation **once** with `ids: Array.from(selection)` and
  `input: { rights_mode, RBAC: { users, roles, teams } }`; on success → clear
  selection, `refetch()`, success toast (`"Access updated for N items"`).
- **i18n** — new keys in the workspace/`knowledge` namespace
  (`action.setAccess`, `bulk.accessDialog.title` / `.description` / `.apply`,
  success/error toasts).

## Data flow

1. User selects item rows → `ItemsActionBar` appears.
2. User clicks **Set access** → `BulkAccessDialog` opens with `RBACControl` at a
   neutral default.
3. User picks visibility mode + grants → clicks **Apply**.
4. Frontend calls `‹ctx›_itemsBulkUpdateRBAC(ids, { rights_mode, RBAC })` once.
5. Backend validates write access for all ids, updates `rights_mode`, overwrites
   `rbac` rows per item, all in one transaction, no re-embed.
6. Frontend clears selection, refetches the list, shows a success toast.

## Edge cases & error handling

- **Read-only items in selection** → atomic fail-fast; error surfaced as a toast;
  nothing changed.
- **Mode = private/public** → grants ignored/cleared; only `rights_mode` applies.
- **RBAC unsupported / license off** → button hidden on the frontend; mutation
  absent from the schema for that context.
- **Partial DB failure** → transaction rolls back; nothing half-applied.
- **Large selections** → single request; per-id write-access checks + per-id RBAC
  diff are N small queries inside one transaction. Acceptable for realistic
  selection sizes (selection is per-page today).

## Testing

**Backend (primary)** — resolver tests in `src/graphql/mutations/`, following
`create-rights-mode.test.ts` / `validate-write-access.test.ts`:
- Sets `rights_mode` across multiple items.
- Overwrites grants (adds new, removes obsolete) via `handleRBACUpdate`.
- **Asserts no embedding/processor job is created** (the core reason for the
  dedicated endpoint).
- Write-access enforcement: atomic rejection when any selected item is read-only.
- Transaction rollback on mid-batch failure.
- super_admin bypass.

**Frontend** — manual smoke test on `/data/‹ctx›` (select items → Set access →
verify the list and one item's detail reflect the change) plus a build/typecheck
(`pnpm build`), matching the usual UAT-deferred flow. Add a lightweight component
test only if the repo already has comparable ones.

## Rollout / branching

Feature branch in both repos (`feature/bulk-set-access-rbac` or similar), worked
in sibling worktrees per the usual parallel-session workflow. Frontend build +
Mailgun-style manual UAT deferred to Daniel as usual.
