# Delete a Routine Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `deleteRoutineRun(id)` — delete a terminal run's `job_results` row and its linked `agent_session` transcript — with a Delete action + confirm on terminal run rows.

**Architecture:** Backend extracts the existing `agent_sessions` deletion cascade into a shared `deleteAgentSessionData` helper (reused by the generic delete path), adds a `deleteRoutineRunRow` helper and a `deleteRoutineRun` mutation (routine-write RBAC + terminal-state gate). Frontend adds a `canDeleteRun` gate, a `DELETE_ROUTINE_RUN` mutation, and a Delete button + confirm in `runs-list.tsx`, mirroring the existing cancel action.

**Tech Stack:** TypeScript, GraphQL (code-first SDL strings), Knex/Postgres, BullMQ, Jest (backend). Next.js, Apollo Client, next-intl, shadcn/ui, Vitest (frontend helper).

## Global Constraints

- **Deletable states = terminal only:** `completed`, `failed`, `filtered`, `cancelled` (`TERMINAL_JOB_STATES` from `@EXULU_TYPES/enums/jobs`). Non-terminal → thrown error "cancel it first". Never delete a live run.
- **Delete removes:** the `job_results` row **and** the linked `agent_session` (cascade: `agent_messages` + the session's `rbac` snapshot). A run maps 1:1 to a session; `filtered` runs may have no `session` (skip the session cascade then).
- **RBAC:** routine **write** access via the existing `loadRoutineRunForWrite(db, user, id)` (same as cancel/retry).
- **DRY:** the `agent_sessions` cascade lives in ONE helper (`deleteAgentSessionData`) used by both `postprocessDeletion` and the new delete path — no duplicated cascade.
- **UI:** the Delete button is state-gated (shown on terminal rows), mirroring how cancel/retry buttons are shown; backend enforces write RBAC.
- Backend tests: jest. Frontend helper: vitest (`lib/routine-runs/presentation.test.ts` exists). No component-test infra for `runs-list.tsx` (verify by tsc/lint/build + manual smoke).
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Verify repo+branch before each commit. **Backend repo has a commitlint hook — the queue-selection work found it flags commit subjects that start with an upper-case word; keep subjects starting lowercase.**

## File Structure

**Backend (`exulu/backend`)**
- `src/exulu/routines/run-state.ts` — add `deleteAgentSessionData` (shared cascade) + `deleteRoutineRunRow` (delete mechanics), next to `cancelRoutineRunRow`.
- `src/exulu/routines/run-state.test.ts` — add tests for both helpers.
- `src/graphql/mutations/index.ts` — rewrite `postprocessDeletion`'s `agent_sessions` branch to call `deleteAgentSessionData`.
- `src/graphql/schemas/index.ts` — add the `deleteRoutineRun` SDL field + resolver.

**Frontend (`exulu/frontend`)**
- `lib/routine-runs/presentation.ts` — add `canDeleteRun`.
- `lib/routine-runs/presentation.test.ts` — add `canDeleteRun` test.
- `lib/routine-runs/queries.ts` — add `DELETE_ROUTINE_RUN`.
- `components/widgets/routine-runs/runs-list.tsx` — delete state/mutation/handler + RunRow Delete button + confirm dialog.
- `messages/en.json`, `messages/de.json` — `routineRuns` delete keys.

---

### Task 1: Extract the shared `agent_sessions` deletion cascade

Behavior-preserving refactor: pull the cascade out of `postprocessDeletion` into a reusable helper.

**Files:**
- Modify: `src/exulu/routines/run-state.ts` (add `deleteAgentSessionData`)
- Modify: `src/graphql/mutations/index.ts` (`postprocessDeletion` agent_sessions branch)
- Test: `src/exulu/routines/run-state.test.ts`

**Interfaces:**
- Produces: `deleteAgentSessionData(db: any, sessionId: string, queues: { list: Map<string, { use: () => Promise<any> }> }): Promise<void>` — deletes `agent_messages` for the session, cancels any still-live runs for it (`cancelRoutineRunRow`), and deletes the session's `rbac` snapshot. Does NOT delete the `agent_sessions` row itself.

- [ ] **Step 1: Write the failing test**

Add to `src/exulu/routines/run-state.test.ts` (after the existing imports, add `deleteAgentSessionData` to the `./run-state` import; append this block):

```ts
// A db mock that records terminal ops (delete/del/select) per table.
const makeCascadeDb = (opts: { liveRuns?: any[] } = {}) => {
  const ops: { table: string; where?: any; whereIn?: any[]; op: string }[] = [];
  const builder = (table: string) => {
    const b: any = {};
    b.where = (arg: any) => { b._where = arg; return b; };
    b.whereIn = (col: string, vals: any[]) => { b._whereIn = [col, vals]; return b; };
    b.select = async () => {
      ops.push({ table, where: b._where, whereIn: b._whereIn, op: "select" });
      return table === "job_results" ? (opts.liveRuns ?? []) : [];
    };
    b.delete = async () => { ops.push({ table, where: b._where, op: "delete" }); return 1; };
    b.del = async () => { ops.push({ table, where: b._where, op: "del" }); return 1; };
    return b;
  };
  const db: any = { from: (t: string) => builder(t) };
  return { db, ops };
};

describe("deleteAgentSessionData", () => {
  it("deletes the session's messages, checks for live runs, and removes its rbac snapshot", async () => {
    const { db, ops } = makeCascadeDb({ liveRuns: [] });
    await deleteAgentSessionData(db, "sess-1", queuesMock);
    expect(ops).toEqual([
      { table: "agent_messages", where: { session: "sess-1" }, op: "delete" },
      {
        table: "job_results",
        where: { session: "sess-1" },
        whereIn: ["state", [JOB_STATUS_ENUM.waiting, JOB_STATUS_ENUM.active, JOB_STATUS_ENUM.waiting_approval]],
        op: "select",
      },
      { table: "rbac", where: { entity: "agent_session", target_resource_id: "sess-1" }, op: "del" },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/routines/run-state.test.ts -t deleteAgentSessionData`
Expected: FAIL — `deleteAgentSessionData` is not exported.

- [ ] **Step 3: Add the helper**

In `src/exulu/routines/run-state.ts`, add after `cancelRoutineRunRow` (it already imports `JOB_STATUS_ENUM` and `cancelRoutineRunRow` is in-file):

```ts
/**
 * Side-effects of removing an agent_session (does NOT delete the session row):
 * its messages, cancelling any still-live runs for it (so an in-flight worker
 * becomes a no-op), and its point-in-time rbac snapshot. Shared by the generic
 * agent_sessions delete (postprocessDeletion) and deleteRoutineRunRow.
 */
export async function deleteAgentSessionData(
  db: any,
  sessionId: string,
  queues: { list: Map<string, { use: () => Promise<any> }> },
): Promise<void> {
  await db.from("agent_messages").where({ session: sessionId }).delete();
  const liveRuns = await db
    .from("job_results")
    .where({ session: sessionId })
    .whereIn("state", [
      JOB_STATUS_ENUM.waiting,
      JOB_STATUS_ENUM.active,
      JOB_STATUS_ENUM.waiting_approval,
    ])
    .select("*");
  for (const run of liveRuns) {
    await cancelRoutineRunRow(db, run, queues);
  }
  await db
    .from("rbac")
    .where({ entity: "agent_session", target_resource_id: sessionId })
    .del();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/exulu/routines/run-state.test.ts -t deleteAgentSessionData`
Expected: PASS.

- [ ] **Step 5: Rewrite `postprocessDeletion` to call the helper**

In `src/graphql/mutations/index.ts`, replace the `agent_sessions` branch body (the `agent_messages` delete + `liveRuns` loop + `rbac` del) with a single call:

```ts
    if (table.type === "agent_sessions") {
      if (!result.id) {
        return result;
      }
      const { db } = await postgresClient();
      await deleteAgentSessionData(db, result.id, ExuluQueues);
    }
```

Add `deleteAgentSessionData` to the existing import from `@SRC/exulu/routines/run-state...`. Then grep this file for `cancelRoutineRunRow` and `JOB_STATUS_ENUM` — if each is now unreferenced, remove it from its import (they were only used by the block you just replaced):

```bash
rg -n "cancelRoutineRunRow|JOB_STATUS_ENUM" src/graphql/mutations/index.ts
```

- [ ] **Step 6: Verify — type-check + full backend suite**

Run: `npx tsc --noEmit`
Expected: no new errors.
Run: `npm test`
Expected: the pre-existing failing suites are unchanged in count; `run-state.test.ts` passes including the new `deleteAgentSessionData` test.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected backend branch
git add src/exulu/routines/run-state.ts src/exulu/routines/run-state.test.ts src/graphql/mutations/index.ts
git commit -m "refactor(routines): extract shared agent_session deletion cascade

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `deleteRoutineRunRow` helper + `deleteRoutineRun` mutation

**Files:**
- Modify: `src/exulu/routines/run-state.ts` (add `deleteRoutineRunRow`)
- Test: `src/exulu/routines/run-state.test.ts`
- Modify: `src/graphql/schemas/index.ts` (SDL field ~L687 + resolver ~L1641)

**Interfaces:**
- Consumes: `deleteAgentSessionData` (Task 1); `loadRoutineRunForWrite(db, user, id): Promise<{ row, routine }>` (existing, `schemas/index.ts:1578`); `TERMINAL_JOB_STATES` (`@EXULU_TYPES/enums/jobs`).
- Produces: `deleteRoutineRunRow(db: any, row: { id: string; session?: string | null }, queues): Promise<void>`; GraphQL `Mutation.deleteRoutineRun(id: ID!): ID`.

- [ ] **Step 1: Write the failing test**

Add `deleteRoutineRunRow` to the `./run-state` import in `run-state.test.ts`, and append (reuses `makeCascadeDb` from Task 1):

```ts
describe("deleteRoutineRunRow", () => {
  it("deletes the linked session (data + row) and the run row", async () => {
    const { db, ops } = makeCascadeDb({ liveRuns: [] });
    await deleteRoutineRunRow(db, { id: "jr-1", session: "sess-1" }, queuesMock);
    expect(ops).toContainEqual({ table: "agent_messages", where: { session: "sess-1" }, op: "delete" });
    expect(ops).toContainEqual({ table: "rbac", where: { entity: "agent_session", target_resource_id: "sess-1" }, op: "del" });
    expect(ops).toContainEqual({ table: "agent_sessions", where: { id: "sess-1" }, op: "del" });
    expect(ops).toContainEqual({ table: "job_results", where: { id: "jr-1" }, op: "del" });
  });

  it("deletes only the run row when there is no linked session", async () => {
    const { db, ops } = makeCascadeDb({});
    await deleteRoutineRunRow(db, { id: "jr-2", session: null }, queuesMock);
    expect(ops).toEqual([{ table: "job_results", where: { id: "jr-2" }, op: "del" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/exulu/routines/run-state.test.ts -t deleteRoutineRunRow`
Expected: FAIL — `deleteRoutineRunRow` is not exported.

- [ ] **Step 3: Add the helper**

In `src/exulu/routines/run-state.ts`, after `deleteAgentSessionData`:

```ts
/**
 * Deletes a run and its transcript: the linked agent_session (via
 * deleteAgentSessionData + the session row) and the job_results row. Callers
 * (the deleteRoutineRun resolver) enforce RBAC + the terminal-state gate.
 */
export async function deleteRoutineRunRow(
  db: any,
  row: { id: string; session?: string | null },
  queues: { list: Map<string, { use: () => Promise<any> }> },
): Promise<void> {
  if (row.session) {
    await deleteAgentSessionData(db, row.session, queues);
    await db.from("agent_sessions").where({ id: row.session }).del();
  }
  await db.from("job_results").where({ id: row.id }).del();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/exulu/routines/run-state.test.ts -t deleteRoutineRunRow`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the SDL field**

In `src/graphql/schemas/index.ts`, in the `mutationDefs += ...` block that declares `cancelRoutineRun` / `retryRoutineRun` (~L687), add a line:

```graphql
    deleteRoutineRun(id: ID!): ID
```

- [ ] **Step 6: Add the resolver**

In `src/graphql/schemas/index.ts`, after the `retryRoutineRun` resolver, add:

```ts
  resolvers.Mutation["deleteRoutineRun"] = async (_, args, context) => {
    const user = context.user;
    const { db } = await postgresClient();
    const { row } = await loadRoutineRunForWrite(db, user, args.id);

    if (!TERMINAL_JOB_STATES.includes(row.state)) {
      throw new Error(
        `Run is in state '${row.state}' and cannot be deleted — cancel it first.`,
      );
    }

    await deleteRoutineRunRow(db, row, ExuluQueues);
    return row.id;
  };
```

Ensure the imports exist at the top of the file: add `TERMINAL_JOB_STATES` to the existing `@EXULU_TYPES/enums/jobs` import (which already brings in `JOB_STATUS_ENUM`), and add `deleteRoutineRunRow` to the existing `@SRC/exulu/routines/run-state...` import (which already brings in `cancelRoutineRunRow`). `ExuluQueues`, `postgresClient`, and `loadRoutineRunForWrite` are already in scope.

- [ ] **Step 7: Verify — type-check + focused tests**

Run: `npx tsc --noEmit`
Expected: no new errors.
Run: `npx jest src/exulu/routines/run-state.test.ts`
Expected: PASS (existing + `deleteAgentSessionData` + `deleteRoutineRunRow`).

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add src/exulu/routines/run-state.ts src/exulu/routines/run-state.test.ts src/graphql/schemas/index.ts
git commit -m "feat(routines): deleteRoutineRun mutation (terminal-only, cascade session)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontend delete action

**Files:**
- Modify: `lib/routine-runs/presentation.ts` (add `canDeleteRun`)
- Test: `lib/routine-runs/presentation.test.ts`
- Modify: `lib/routine-runs/queries.ts` (add `DELETE_ROUTINE_RUN`)
- Modify: `components/widgets/routine-runs/runs-list.tsx`
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:**
- Consumes: `deleteRoutineRun(id): ID` (Task 2); existing `isTerminalRunState`, `canCancelRun`, `canRetryRun`, `ConfirmDialog`, the `refetch` from `useQuery(ROUTINE_RUNS)`, and `t = useTranslations("routineRuns")`.

- [ ] **Step 1: Write the failing `canDeleteRun` test**

In `lib/routine-runs/presentation.test.ts`, add `canDeleteRun` to the import from `./presentation` and append:

```ts
describe("canDeleteRun", () => {
  it("is true for terminal states, false for live states", () => {
    for (const s of ["completed", "failed", "filtered", "cancelled"]) {
      expect(canDeleteRun(s)).toBe(true);
    }
    for (const s of ["waiting", "active", "waiting_approval"]) {
      expect(canDeleteRun(s)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/routine-runs/presentation.test.ts -t canDeleteRun`
Expected: FAIL — `canDeleteRun` is not exported.

- [ ] **Step 3: Add `canDeleteRun`**

In `lib/routine-runs/presentation.ts`, after `canRetryRun`:

```ts
/** deleteRoutineRun domain: terminal runs only (mirrors TERMINAL_JOB_STATES). */
export function canDeleteRun(state: string): boolean {
  return isTerminalRunState(state);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run lib/routine-runs/presentation.test.ts -t canDeleteRun`
Expected: PASS.

- [ ] **Step 5: Add the `DELETE_ROUTINE_RUN` mutation**

In `lib/routine-runs/queries.ts`, after `RETRY_ROUTINE_RUN`:

```ts
export const DELETE_ROUTINE_RUN = gql`
  mutation DeleteRoutineRun($id: ID!) {
    deleteRoutineRun(id: $id)
  }
`;
```

- [ ] **Step 6: Wire the delete state/mutation/handler in `runs-list.tsx`**

- Add `canDeleteRun` to the import from `@/lib/routine-runs/presentation`, and `DELETE_ROUTINE_RUN` to the import from `@/lib/routine-runs/queries`.
- Next to `const [cancelTarget, setCancelTarget] = React.useState<RoutineRun | null>(null);` add:
```tsx
  const [deleteTarget, setDeleteTarget] = React.useState<RoutineRun | null>(null);
```
- Next to `const [cancelMutate] = useMutation(CANCEL_ROUTINE_RUN);` add:
```tsx
  const [deleteMutate] = useMutation(DELETE_ROUTINE_RUN);
```
- After `handleRetry`, add (mirrors `handleConfirmCancel`):
```tsx
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutate({ variables: { id: deleteTarget.id } });
      toast.success(t("toast.deleted"));
      await refetch();
    } catch (err) {
      toast.error(t("toast.deleteFailed"), {
        description: (err as Error).message,
      });
      throw err; // keep ConfirmDialog open
    }
  };
```

- [ ] **Step 7: Add the RunRow Delete button + prop**

In `runs-list.tsx`:
- At the `<RunRow …>` mount, next to `onCancel={() => setCancelTarget(run)}`, add:
```tsx
              onDelete={() => setDeleteTarget(run)}
```
- In the `RunRow` props interface (where `onCancel: () => void;` / `onRetry: () => void;` are), add `onDelete: () => void;` and destructure `onDelete` in the component params.
- In the RunRow action row, after the `canRetryRun(run.state) ? (…) : null` button, add:
```tsx
            {canDeleteRun(run.state) ? (
              <Button variant="destructive" size="sm" onClick={onDelete}>
                {t("row.delete")}
              </Button>
            ) : null}
```

- [ ] **Step 8: Add the delete ConfirmDialog**

In `runs-list.tsx`, after the existing cancel `<ConfirmDialog … onConfirm={handleConfirmCancel} />`, add:

```tsx
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("deleteConfirm.title")}
        description={t("deleteConfirm.description")}
        variant="destructive"
        confirmLabel={t("deleteConfirm.confirmLabel")}
        onConfirm={handleConfirmDelete}
      />
```

- [ ] **Step 9: Add i18n keys (en + de)**

In `messages/en.json`, inside the `routineRuns` object (the one holding `cancelConfirm` / `toast.cancelled`, ~L4003-4011): add `row.delete`, a `deleteConfirm` object, and `toast.deleted` / `toast.deleteFailed`:

```json
        "delete": "Delete"
```
(inside `routineRuns.row`, alongside `cancel`/`retry`)
```json
      "deleteConfirm": {
        "title": "Delete this run?",
        "description": "The run and its transcript will be permanently deleted. This cannot be undone.",
        "confirmLabel": "Delete run"
      },
```
```json
      "deleted": "Run deleted",
      "deleteFailed": "Could not delete run"
```
(inside `routineRuns.toast`, alongside `cancelled`/`cancelFailed`)

In `messages/de.json`, add the German equivalents in the matching `routineRuns` object:
```json
        "delete": "Löschen"
```
```json
      "deleteConfirm": {
        "title": "Diesen Lauf löschen?",
        "description": "Der Lauf und sein Transkript werden dauerhaft gelöscht. Dies kann nicht rückgängig gemacht werden.",
        "confirmLabel": "Lauf löschen"
      },
```
```json
      "deleted": "Lauf gelöscht",
      "deleteFailed": "Lauf konnte nicht gelöscht werden"
```

- [ ] **Step 10: Verify — helper test, type-check, lint**

Run: `npx vitest run lib/routine-runs/presentation.test.ts`
Expected: PASS (incl. `canDeleteRun`).
Run: `npx tsc --noEmit`
Run: `npm run lint`
Run: `node -e "require('./messages/en.json'); require('./messages/de.json'); console.log('json ok')"`
Expected: all clean for touched files (pre-existing unrelated issues are not yours).

- [ ] **Step 11: Manual smoke (author confirms)**

On a routine with terminal runs: terminal rows show a **Delete** button (a failed/cancelled row shows both Retry and Delete); confirming deletes the run + its session (the "Open session" link 404s afterward), the row disappears, and a success toast shows. A live (active/waiting) run shows Cancel, not Delete.

- [ ] **Step 12: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # confirm expected frontend branch
git add lib/routine-runs/presentation.ts lib/routine-runs/presentation.test.ts \
        lib/routine-runs/queries.ts \
        "components/widgets/routine-runs/runs-list.tsx" \
        messages/en.json messages/de.json
git commit -m "feat(routines): delete a terminal run from the runs list

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** shared cascade helper → Task 1. `deleteRoutineRun` mutation (RBAC + terminal gate + cascade + row delete) → Task 2. Frontend `canDeleteRun` + `DELETE_ROUTINE_RUN` + runs-list delete action/confirm + i18n → Task 3. Terminal-only, session-cascade, RBAC parity, filtered-run-no-session guard all covered. Testing: `deleteAgentSessionData` + `deleteRoutineRunRow` (jest), `canDeleteRun` (vitest); resolver RBAC/gate is thin wiring over the tested helper + existing `loadRoutineRunForWrite`, verified by tsc + manual smoke.
- **Placeholder scan:** none — every code step has real code; the `mutations/index.ts` import cleanup is a concrete grep-confirmed removal of two named symbols.
- **Type consistency:** `deleteAgentSessionData(db, sessionId, queues)` (Task 1) matches its calls in `postprocessDeletion` (Task 1) and `deleteRoutineRunRow` (Task 2). `deleteRoutineRunRow(db, row, queues)` (Task 2) matches the resolver call (Task 2). `deleteRoutineRun(id): ID` (Task 2 SDL) matches `DELETE_ROUTINE_RUN` (Task 3). `canDeleteRun(state)` (Task 3) matches the RunRow usage (Task 3). i18n keys used (`row.delete`, `deleteConfirm.*`, `toast.deleted/deleteFailed`) are all added in Task 3 Step 9 under the `routineRuns` namespace the widget uses.
