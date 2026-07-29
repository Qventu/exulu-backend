# Bulk "Set access" (RBAC) action for knowledge base items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Set access" bulk action to the knowledge base items page (`/data/<context>`) that overwrites the RBAC configuration (visibility mode + user/role/team grants) of all selected items in one server-side operation, without re-embedding.

**Architecture:** A new dedicated backend GraphQL mutation `‹ctx›_itemsBulkUpdateRBAC(ids, rights_mode, RBAC)` writes `rights_mode` + RBAC rows directly inside one transaction and deliberately skips `postprocessUpdate` (so no chunk deletion / re-embed / processor re-run). The frontend adds a "Set access" button to the existing `ItemsActionBar` that opens a new `BulkAccessDialog` embedding the existing `RBACControl`; on Apply it calls the mutation once with all selected ids.

**Tech Stack:** Backend — TypeScript, knex, GraphQL (SDL generated per context in `src/graphql/schemas/index.ts`, resolvers in `src/graphql/mutations/index.ts`), Jest. Frontend — Next.js (app router), Apollo Client, shadcn/ui (Radix Dialog), next-intl, sonner toasts.

**Design doc:** `docs/superpowers/specs/2026-07-29-bulk-set-access-rbac-design.md`

## Global Constraints

- **Semantics are overwrite/replace:** every selected item is set to exactly the chosen configuration; grants not present in the new configuration are removed (handled by `handleRBACUpdate`'s diff).
- **Valid rights modes (verbatim):** `["private", "users", "roles", "teams", "public"]` — reuse the existing `VALID_RIGHTS_MODES` constant in `src/graphql/mutations/index.ts:27`.
- **RBAC entity name:** always `table.name.singular` (e.g. `documents_item`) — never a hardcoded `"item"`.
- **No re-embed:** the bulk resolver must NOT call `postprocessUpdate` / `context.embeddings` / the processor. A pure access change never touches chunks.
- **Atomic:** validate write access for every id BEFORE any mutation; if any selected item is not writable, throw and change nothing.
- **Teams included:** the bulk path sends `users` + `roles` + `teams` (the existing single-item detail save omits teams — leave that untouched).
- **Button visibility:** "Set access" appears whenever `selection.size > 0`, in BOTH the Active and Archived views (access is orthogonal to archive state).
- **Two repos:** backend = `/Users/daniel.claessen/Desktop/Projects/exulu/backend`, frontend = `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`. Do the work on a feature branch (`feature/bulk-set-access-rbac`) in each repo — per the project workflow, use a sibling worktree so the primary checkouts' branches are not disturbed. Backend task first (frontend consumes its mutation).

---

### Task 1: Backend — `‹ctx›_itemsBulkUpdateRBAC` mutation (resolver + SDL + tests)

**Repo:** `/Users/daniel.claessen/Desktop/Projects/exulu/backend`

**Files:**
- Modify: `src/graphql/mutations/index.ts` — add the resolver inside `createMutations`.
- Modify: `src/graphql/schemas/index.ts` — expose the mutation field + payload type.
- Test: `src/graphql/mutations/bulk-update-rbac.test.ts` (create).

**Interfaces:**
- Consumes (existing, already imported in `mutations/index.ts`):
  - `validateWriteAccess(id: string, context): Promise<true>` — closure in `createMutations`; throws on denial, returns `true` on success (super_admin bypasses).
  - `handleRBACUpdate(db, entityName: string, resourceId: string, rbacData: {users?, roles?, teams?}, existingRbacRecords: any[]): Promise<void>` — from `../../../ee/rbac-update.ts` (accepts a knex transaction as `db`).
  - `VALID_RIGHTS_MODES: string[]` — module constant at `src/graphql/mutations/index.ts:27`.
  - `RBACInput` — global GraphQL input type already defined once in `src/graphql/schemas/index.ts:333` (`{ users: [RBACUserInput!], roles: [RBACRoleInput!], teams: [RBACTeamInput!] }`).
- Produces:
  - GraphQL mutation `‹ctx›_itemsBulkUpdateRBAC(ids: [ID!]!, rights_mode: String!, RBAC: RBACInput): ‹ctx›_itemBulkUpdateRBACPayload` where `‹ctx›_item` = `tableNameSingular`, `‹ctx›_items` = `tableNamePlural`.
  - Payload type `‹ctx›_itemBulkUpdateRBACPayload { message: String!, itemCount: Int! }`.
  - Resolver key on the `mutations` object: `` `${tableNamePlural}BulkUpdateRBAC` ``.

- [ ] **Step 1: Write the failing test**

Create `src/graphql/mutations/bulk-update-rbac.test.ts`. This mirrors the mocking approach of the sibling `validate-write-access.test.ts` (jest.mock hoisted above the import). The `handleRBACUpdate` mock lets us assert per-item overwrite calls without a real DB, and passing `contexts: []` proves no `postprocessUpdate` runs (it would throw "Context not found" for an items table if it were called).

```ts
/**
 * Tests for the bulk RBAC mutation (‹ctx›_itemsBulkUpdateRBAC): overwrites
 * rights_mode + grants across many items in one transaction, WITHOUT
 * re-embedding, and is atomic on a write-access failure.
 */

jest.mock("@SRC/exulu/context", () => ({
  getChunksTableName: (id: string) => `${id}_chunks`,
  getTableName: (id: string) => id,
}));
jest.mock("@SRC/exulu/entities", () => ({
  resolveEntityModel: jest.fn(),
  setEntityModelSetting: jest.fn(),
}));
jest.mock("@SRC/exulu/statistics", () => ({ updateStatistic: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/utils", () => ({
  contextItemsProcessorHandler: jest.fn(),
  getRequestedFields: jest.fn(() => []),
}));
jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: any, q: any) => q),
}));
jest.mock("@SRC/auth/generate-key.ts", () => ({ SALT_ROUNDS: 10 }));
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("@SRC/graphql/resolvers/apply-filters.ts", () => ({
  applyFilters: jest.fn(),
}));
jest.mock("@SRC/graphql/utilities/validate-super-admin-update.ts", () => ({
  validateCreateOrRemoveSuperAdminPermission: jest.fn(async () => {}),
}));
jest.mock("@SRC/graphql/utilities/encrypt-sensitive-fields.ts", () => ({
  encryptSensitiveFields: (input: any) => input,
}));
jest.mock("@SRC/graphql/utilities/sanitize-and-hydrate-fields.ts", () => ({
  finalizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@SRC/exulu/routines/run-state.ts", () => ({
  cancelRoutineRunRow: jest.fn(),
}));
jest.mock("@EE/queues/queues", () => ({ queues: {} }));
jest.mock("@SRC/graphql/resolvers/index.ts", () => ({
  itemsPaginationRequest: jest.fn(),
  sanitizeRequestedFields: jest.fn((f: any) => f),
}));
jest.mock("@EE/rbac-update.ts", () => ({ handleRBACUpdate: jest.fn() }));

import { createMutations } from "./index";
import { handleRBACUpdate } from "@EE/rbac-update.ts";

const ID_1 = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const ID_2 = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";

const itemsTable: any = {
  name: { singular: "documents_item", plural: "documents_items" },
  type: "items",
  RBAC: true,
  fields: [],
};

// Chainable knex-like mock. `db` doubles as the transaction object (handed to
// the resolver's db.transaction callback); handleRBACUpdate is mocked so the
// awaited rbac fetch value is never inspected.
function makeDb({ record }: { record?: any } = {}) {
  const captured: {
    updateIds?: any;
    updateVals?: any;
    txnCalled?: boolean;
  } = {};
  const chain = (table: string) => {
    const q: any = {
      select: () => q,
      where: () => q,
      whereIn: (_col: string, vals: any) => {
        captured.updateIds = vals;
        return q;
      },
      update: async (vals: any) => {
        captured.updateVals = vals;
        return Array.isArray(captured.updateIds) ? captured.updateIds.length : 0;
      },
      first: async () => record,
    };
    return q;
  };
  const db: any = Object.assign((table: string) => chain(table), {
    from: (table: string) => chain(table),
    transaction: jest.fn(async (cb: any) => {
      captured.txnCalled = true;
      return cb(db);
    }),
  });
  return { db, captured };
}

const makeContext = (db: any, user: any) => ({ db, user, req: {} });

const mutations = createMutations(itemsTable, [], [], [], {} as any);
const bulkUpdateRbac = mutations["documents_itemsBulkUpdateRBAC"];

beforeEach(() => {
  (handleRBACUpdate as jest.Mock).mockClear();
});

describe("‹ctx›_itemsBulkUpdateRBAC", () => {
  it("sets rights_mode on all ids and overwrites grants per item, without re-embedding", async () => {
    const { db, captured } = makeDb();
    const superAdmin = { id: 1, super_admin: true };
    const RBAC = { roles: [{ id: "role-1", rights: "write" }], users: [], teams: [] };

    const result = await bulkUpdateRbac(
      null,
      { ids: [ID_1, ID_2], rights_mode: "roles", RBAC },
      makeContext(db, superAdmin),
      {},
    );

    // one bulk rights_mode update over both ids
    expect(captured.updateIds).toEqual([ID_1, ID_2]);
    expect(captured.updateVals.rights_mode).toBe("roles");
    expect(captured.updateVals.updatedAt).toBeInstanceOf(Date);

    // grants overwritten per item with the entity = table.name.singular
    expect(handleRBACUpdate).toHaveBeenCalledTimes(2);
    expect((handleRBACUpdate as jest.Mock).mock.calls[0][1]).toBe("documents_item");
    expect((handleRBACUpdate as jest.Mock).mock.calls[0][2]).toBe(ID_1);
    expect((handleRBACUpdate as jest.Mock).mock.calls[0][3]).toBe(RBAC);
    expect((handleRBACUpdate as jest.Mock).mock.calls[1][2]).toBe(ID_2);

    // ran inside a transaction; no throw proves postprocessUpdate was skipped
    // (contexts=[] would make postprocessUpdate throw "Context not found")
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ message: "Access updated for 2 items.", itemCount: 2 });
  });

  it("rejects the whole batch and changes nothing when an item is not writable", async () => {
    // non-super-admin, private item owned by someone else → validateWriteAccess throws
    const { db, captured } = makeDb({ record: { rights_mode: "private", created_by: "999" } });
    const user = { id: 2, super_admin: false };

    await expect(
      bulkUpdateRbac(
        null,
        { ids: [ID_1], rights_mode: "public", RBAC: {} },
        makeContext(db, user),
        {},
      ),
    ).rejects.toThrow("Only the creator can edit this private record");

    expect(db.transaction).not.toHaveBeenCalled();
    expect(handleRBACUpdate).not.toHaveBeenCalled();
    expect(captured.updateVals).toBeUndefined();
  });

  it("rejects an invalid rights_mode before touching the database", async () => {
    const { db } = makeDb();
    const superAdmin = { id: 1, super_admin: true };

    await expect(
      bulkUpdateRbac(
        null,
        { ids: [ID_1], rights_mode: "bogus", RBAC: {} },
        makeContext(db, superAdmin),
        {},
      ),
    ).rejects.toThrow('Invalid rights_mode "bogus"');

    expect(db.transaction).not.toHaveBeenCalled();
    expect(handleRBACUpdate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/graphql/mutations/bulk-update-rbac.test.ts`
Expected: FAIL — `mutations["documents_itemsBulkUpdateRBAC"]` is `undefined`, so calling it throws `TypeError: bulkUpdateRbac is not a function`.

- [ ] **Step 3: Implement the resolver**

In `src/graphql/mutations/index.ts`, inside the `if (table.type === "items") {` block that begins near line 863, after the `mutations[\`${tableNameSingular}DetachEntities\`] = …` assignment and before that block's closing `}` (immediately preceding `return mutations;` at ~line 1247), add:

```ts
    if (table.RBAC) {
      mutations[`${tableNamePlural}BulkUpdateRBAC`] = async (_, args, context) => {
        const { db } = context;
        const { ids, rights_mode, RBAC } = args;

        if (!Array.isArray(ids) || ids.length === 0) {
          throw new Error("ids is required and must be a non-empty array.");
        }
        if (!VALID_RIGHTS_MODES.includes(rights_mode)) {
          throw new Error(
            `Invalid rights_mode "${rights_mode}" — expected one of: ${VALID_RIGHTS_MODES.join(", ")}`,
          );
        }

        // Atomic: reject the whole batch if the user lacks write access to any
        // selected item. Validated BEFORE mutating anything.
        for (const id of ids) {
          await validateWriteAccess(id, context);
        }

        await db.transaction(async (trx) => {
          // 1. Set rights_mode on every selected item in one statement.
          //    Deliberately no postprocessUpdate(): a pure access change must
          //    never delete chunks or re-embed / re-run the processor.
          await trx(tableNamePlural)
            .whereIn("id", ids)
            .update({ rights_mode, updatedAt: new Date() });

          // 2. Overwrite the RBAC grants for each item (diff against existing).
          for (const id of ids) {
            const existingRbacRecords = await trx
              .from("rbac")
              .where({ entity: table.name.singular, target_resource_id: id })
              .select("*");
            await handleRBACUpdate(
              trx,
              table.name.singular,
              id,
              RBAC ?? {},
              existingRbacRecords,
            );
          }
        });

        return {
          message: `Access updated for ${ids.length} item${ids.length === 1 ? "" : "s"}.`,
          itemCount: ids.length,
        };
      };
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/graphql/mutations/bulk-update-rbac.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the SDL (mutation field + payload type)**

In `src/graphql/schemas/index.ts`, inside the `if (table.type === "items") {` block, immediately after the items `mutationDefs += \`… ${tableNameSingular}DetachEntities(item: ID!): … \`;` template closes (around line 422) and before the `if (table.processor) {` block, add:

```ts
      if (table.RBAC) {
        mutationDefs += `
    ${tableNamePlural}BulkUpdateRBAC(ids: [ID!]!, rights_mode: String!, RBAC: RBACInput): ${tableNameSingular}BulkUpdateRBACPayload
    `;
        modelDefs += `
    type ${tableNameSingular}BulkUpdateRBACPayload {
      message: String!
      itemCount: Int!
    }
    `;
      }
```

(`RBACInput` is already defined once globally at line 333 — reference it, do not redefine it.)

- [ ] **Step 6: Verify the schema builds and lints**

Run: `npx jest src/graphql/mutations/bulk-update-rbac.test.ts && npm run lint`
Expected: tests PASS; eslint reports no new errors for the two edited files. (If the repo has a fast typecheck, also run `npx tsc --noEmit`; otherwise `npm run build` (tsup) exercises compilation.)

- [ ] **Step 7: Commit**

```bash
git -C /Users/daniel.claessen/Desktop/Projects/exulu/backend rev-parse --abbrev-ref HEAD
git -C /Users/daniel.claessen/Desktop/Projects/exulu/backend add \
  src/graphql/mutations/index.ts \
  src/graphql/schemas/index.ts \
  src/graphql/mutations/bulk-update-rbac.test.ts
git -C /Users/daniel.claessen/Desktop/Projects/exulu/backend commit -m "$(cat <<'EOF'
feat(rbac): add bulk set-access mutation for knowledge base items

itemsBulkUpdateRBAC overwrites rights_mode + grants across many items in
one transaction, skipping postprocessUpdate so a pure access change never
re-embeds. Atomic on write-access failure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Confirm the branch printed by the first command is the intended feature branch before committing.)

---

### Task 2: Frontend — i18n keys, GraphQL op, and `BulkAccessDialog` component

**Repo:** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`

**Files:**
- Modify: `messages/en.json` — add `knowledge.workspace.items.action.setAccess` and `knowledge.workspace.bulk.setAccess.*`.
- Modify: `messages/de.json` — same keys, German copy.
- Modify: `app/(application)/data/queries.ts` — add `BULK_UPDATE_ITEM_RBAC`.
- Create: `app/(application)/data/[ctx]/components/bulk-access-dialog.tsx`.

**Interfaces:**
- Consumes:
  - `RBACControl` from `@/components/rbac` — props `{ subjectLabel?, modalMode?, allowedModes?, initialRightsMode, initialUsers, initialRoles, initialTeams?, onChange(rights_mode, users, roles, teams) }`. `users: {id:number, rights:'read'|'write'}[]`, `roles`/`teams: {id:string, rights:'read'|'write'}[]`.
  - `Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter` from `@/components/ui/dialog`; `Button` from `@/components/ui/button`.
  - `Context` type from `@/types/models/context`.
- Produces:
  - `BULK_UPDATE_ITEM_RBAC(context: string)` → gql document for `${context}_itemsBulkUpdateRBAC(ids, rights_mode, RBAC) { message itemCount }`.
  - `BulkAccessDialog` component with props `{ open: boolean; onOpenChange: (v: boolean) => void; context: Context; ids: string[]; onApplied: () => void }`.

- [ ] **Step 1: Add the GraphQL operation**

In `app/(application)/data/queries.ts`, after the `UPDATE_ITEM` export (ends line 434), add:

```ts
export const BULK_UPDATE_ITEM_RBAC = (context: string) => gql`
  mutation BulkUpdateRBAC${context}(
    $ids: [ID!]!
    $rights_mode: String!
    $rbac: RBACInput
  ) {
    ${context}_itemsBulkUpdateRBAC(ids: $ids, rights_mode: $rights_mode, RBAC: $rbac) {
      message
      itemCount
    }
  }
`;
```

- [ ] **Step 2: Add translation keys (en)**

In `messages/en.json`, add to `knowledge.workspace.items.action` (between `"selected"` at line 2709 and `"unarchive"` at line 2710):

```json
          "setAccess": "Set access",
```

And add a `setAccess` object to `knowledge.workspace.bulk` (after `"processScheduled"` at line 2559, before the block's closing `}` at line 2560 — add a comma after the `processScheduled` line):

```json
        "setAccess": {
          "apply": "Apply",
          "description": "{count, plural, one {Apply access settings to # selected item.} other {Apply access settings to # selected items.}}",
          "error": "Couldn't update access",
          "success": "{count, plural, one {Access updated for # item} other {Access updated for # items}}",
          "title": "Set access"
        }
```

- [ ] **Step 3: Add translation keys (de)**

In `messages/de.json`, add the same keys under the matching `knowledge.workspace.items.action` and `knowledge.workspace.bulk` blocks:

```json
          "setAccess": "Zugriff festlegen",
```
```json
        "setAccess": {
          "apply": "Anwenden",
          "description": "{count, plural, one {Zugriffseinstellungen auf # ausgewähltes Element anwenden.} other {Zugriffseinstellungen auf # ausgewählte Elemente anwenden.}}",
          "error": "Zugriff konnte nicht aktualisiert werden",
          "success": "{count, plural, one {Zugriff für # Element aktualisiert} other {Zugriff für # Elemente aktualisiert}}",
          "title": "Zugriff festlegen"
        }
```

- [ ] **Step 4: Create the `BulkAccessDialog` component**

Create `app/(application)/data/[ctx]/components/bulk-access-dialog.tsx`:

```tsx
"use client";

/**
 * BulkAccessDialog — overwrites the RBAC configuration of the currently
 * selected items in one call. Because this is overwrite semantics, the
 * embedded RBACControl opens at a neutral default (Private, no grants)
 * rather than reading any single item's config. modalMode keeps the
 * "view all users" popover inline (this is already inside a Dialog).
 */

import { useMutation } from "@apollo/client";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { RBACControl } from "@/components/rbac";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Context } from "@/types/models/context";

import { BULK_UPDATE_ITEM_RBAC } from "../../queries";

type Mode = "private" | "users" | "roles" | "teams" | "public";
type Grant<Id> = { id: Id; rights: "read" | "write" };

export interface BulkAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: Context;
  ids: string[];
  onApplied: () => void;
}

export function BulkAccessDialog({
  open,
  onOpenChange,
  context,
  ids,
  onApplied,
}: BulkAccessDialogProps) {
  const t = useTranslations("knowledge");

  const [rightsMode, setRightsMode] = React.useState<Mode>("private");
  const [users, setUsers] = React.useState<Grant<number>[]>([]);
  const [roles, setRoles] = React.useState<Grant<string>[]>([]);
  const [teams, setTeams] = React.useState<Grant<string>[]>([]);

  // Reset to a neutral default each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setRightsMode("private");
      setUsers([]);
      setRoles([]);
      setTeams([]);
    }
  }, [open]);

  const [bulkUpdateRbac, { loading }] = useMutation(
    BULK_UPDATE_ITEM_RBAC(context.id),
    {
      onCompleted: () => {
        toast.success(
          t("workspace.bulk.setAccess.success", { count: ids.length }),
        );
        onApplied();
        onOpenChange(false);
      },
      onError: (e) =>
        toast.error(t("workspace.bulk.setAccess.error"), {
          description: e.message,
        }),
    },
  );

  const handleApply = async () => {
    await bulkUpdateRbac({
      variables: {
        ids,
        rights_mode: rightsMode,
        rbac: { users, roles, teams },
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{t("workspace.bulk.setAccess.title")}</DialogTitle>
          <DialogDescription>
            {t("workspace.bulk.setAccess.description", { count: ids.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RBACControl
            modalMode
            subjectLabel={t("workspace.access.subjectLabel")}
            initialRightsMode={rightsMode}
            initialUsers={users}
            initialRoles={roles}
            initialTeams={teams}
            onChange={(mode, nextUsers, nextRoles, nextTeams) => {
              setRightsMode(mode as Mode);
              setUsers(nextUsers);
              setRoles(nextRoles);
              setTeams(nextTeams ?? []);
            }}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {t("workspace.bulk.cancel")}
          </Button>
          <Button type="button" onClick={handleApply} disabled={loading}>
            {t("workspace.bulk.setAccess.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 5: Verify it compiles and lints**

Run: `npx tsc --noEmit && pnpm lint`
Expected: no type errors and no new lint errors in the created/modified files. (`DialogFooter` is exported from `@/components/ui/dialog` — the `RBACControl` import resolves — the `../../queries` import path from `[ctx]/components/` matches the existing `bulk-filter-dialog.tsx` import.)

- [ ] **Step 6: Commit**

```bash
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend rev-parse --abbrev-ref HEAD
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend add \
  app/\(application\)/data/queries.ts \
  app/\(application\)/data/\[ctx\]/components/bulk-access-dialog.tsx \
  messages/en.json messages/de.json
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend commit -m "$(cat <<'EOF'
feat(data): add BulkAccessDialog + bulk RBAC mutation for items

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — wire "Set access" into the action bar and items table

**Repo:** `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`

**Files:**
- Modify: `app/(application)/data/[ctx]/components/items-action-bar.tsx` — add `onSetAccess` prop + "Set access" button (both views).
- Modify: `app/(application)/data/[ctx]/components/items-table.tsx` — dialog state + render `BulkAccessDialog`, pass `onSetAccess`.

**Interfaces:**
- Consumes: `BulkAccessDialog` (Task 2), `ItemsActionBar` (updated below).
- Produces: end-to-end bulk "Set access" behavior.

- [ ] **Step 1: Add the button + prop to `ItemsActionBar`**

In `app/(application)/data/[ctx]/components/items-action-bar.tsx`:

1. Extend the lucide import (line 12) to include a lock/shield icon:
```ts
import { Archive, PackageOpen, ShieldCheck, Trash2, X } from "lucide-react";
```

2. Add `onSetAccess` to the props interface (after `onDelete`, line 25):
```ts
  onSetAccess: () => void;
```

3. Destructure it in the component signature (after `onDelete`, line 35):
```ts
  onSetAccess,
```

4. Render the button so it shows in BOTH views — insert it after the `archived ? (...) : (...)` block closes (after line 84, before the ghost Clear button at line 85):
```tsx
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-11 md:h-9"
          disabled={pending}
          onClick={onSetAccess}
        >
          <ShieldCheck aria-hidden="true" className="mr-2 size-4" />
          {t("workspace.items.action.setAccess")}
        </Button>
```

- [ ] **Step 2: Wire the dialog into `ItemsTable`**

In `app/(application)/data/[ctx]/components/items-table.tsx`:

1. Add the import (next to the `ItemsActionBar` import at line 54):
```ts
import { BulkAccessDialog } from "./bulk-access-dialog";
```

2. Add dialog open state near the other `React.useState` declarations (e.g. beside `selection`):
```ts
  const [accessDialogOpen, setAccessDialogOpen] = React.useState(false);
```

3. Pass `onSetAccess` to `ItemsActionBar` (in the render block at lines 255-263), adding one prop:
```tsx
          onSetAccess={() => setAccessDialogOpen(true)}
```

4. Render the dialog. Immediately after the `{selection.size > 0 && ( <ItemsActionBar … /> )}` block (after line 264), add:
```tsx
      <BulkAccessDialog
        open={accessDialogOpen}
        onOpenChange={setAccessDialogOpen}
        context={context}
        ids={Array.from(selection)}
        onApplied={() => {
          setSelection(new Set());
          refetch();
        }}
      />
```

- [ ] **Step 3: Verify it compiles and lints**

Run: `npx tsc --noEmit && pnpm lint`
Expected: no type errors, no new lint errors. `context`, `refetch`, `selection`, and `setSelection` are all already in scope in `items-table.tsx` (used by the existing bulk handlers).

- [ ] **Step 4: Manual smoke test**

Start the frontend against a backend that has the Task 1 mutation deployed, then on `/data/<an items context>`:
1. Select 2+ items → the action bar shows **Set access**.
2. Click **Set access** → dialog opens at **Private**.
3. Choose **Roles**, grant a role **write**, click **Apply**.
4. Expect: success toast "Access updated for N items", selection cleared, list refetched.
5. Open one of those items' detail → Access section shows **Roles** with that grant.
6. Repeat setting mode to **Private** → confirm grants are cleared (overwrite).
7. Negative: as a non-admin, select an item you only have read access to → Apply → expect the error toast (atomic; nothing changed).

- [ ] **Step 5: Commit**

```bash
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend rev-parse --abbrev-ref HEAD
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend add \
  app/\(application\)/data/\[ctx\]/components/items-action-bar.tsx \
  app/\(application\)/data/\[ctx\]/components/items-table.tsx
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend commit -m "$(cat <<'EOF'
feat(data): wire bulk Set access action into items table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Overwrite semantics → Task 1 resolver + `handleRBACUpdate` diff; dialog opens neutral (Task 2 Step 4). ✓
- Dedicated backend mutation, no re-embed → Task 1 Step 3 (no `postprocessUpdate`), asserted in Step 1 test. ✓
- Atomic on read-only → Task 1 resolver validate-loop + test 2. ✓
- Reuse `RBACControl` → Task 2 Step 4. ✓
- "Set access" button in both views → Task 3 Step 1 (rendered outside the archived ternary). ✓
- Teams included → Task 2 gql + dialog send `teams`; resolver/`handleRBACUpdate` persist teams. ✓
- License/RBAC gating → mutation generated only when `table.RBAC` (Task 1 Step 5); `handleRBACUpdate` enforces `checkLicense().rbac`. ✓
- i18n → Task 2 Steps 2-3. ✓
- Testing → Task 1 unit tests; Task 3 Step 4 manual smoke. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete content. ✓

**Type consistency:** `BulkAccessDialogProps` (`open/onOpenChange/context/ids/onApplied`) matches the render in Task 3 Step 2. Mutation variables `{ ids, rights_mode, rbac }` match the gql operation (Task 2 Step 1) and the resolver args `{ ids, rights_mode, RBAC }` (arg `RBAC: $rbac`). Payload `{ message, itemCount }` consistent across SDL, resolver return, and gql selection set. Resolver key `${tableNamePlural}BulkUpdateRBAC` matches the SDL field name and the test lookup `documents_itemsBulkUpdateRBAC`. ✓

## Notes / assumptions

- The frontend shows "Set access" for every items context (matching the always-rendered per-item Access section; the `Context` type has no per-context RBAC boolean). If a context ever has `RBAC: false`, the mutation won't exist server-side and Apply would surface a GraphQL error toast — acceptable, and gating can be added later if such contexts appear.
- `createMutations` is invoked in tests with the same 5-argument convention as the existing `validate-write-access.test.ts` (`createMutations(itemsTable, [], [], [], {} as any)`) for consistency with the known-passing sibling test.
