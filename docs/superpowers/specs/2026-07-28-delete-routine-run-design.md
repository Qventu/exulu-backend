# Delete a Routine Run — Design

- **Date:** 2026-07-28
- **Status:** Approved (ready for implementation plan)
- **Repos:** `exulu/backend` + `exulu/frontend`
- **Surface:** the routine runs list (`RoutineRunsList` — shown in the routine detail Runs section AND the global runs console)

## Problem

A routine run (a `job_results` row) can be **cancelled** (stop a live run) or
**retried**, but there is no way to **delete** a finished run. Users want to
remove finished runs from the list. A background `prune-job-results` job already
hard-deletes old **terminal** runs on a retention cap, but there is no manual
delete.

## Goals

- Add `deleteRoutineRun(id: ID!)` — delete a single **terminal** run.
- Delete both the run record (`job_results` row) **and** its linked
  `agent_session` (the run's transcript/conversation) with the same cascade the
  app already uses for session deletion (messages + RBAC snapshot).
- Surface a **Delete** action on terminal run rows in `runs-list.tsx`, with a
  confirm dialog, mirroring the existing cancel action.

## Non-goals

- No bulk delete / "clear all" (single run only — YAGNI).
- No soft-delete: it is a hard delete (consistent with the existing prune).
- No delete of **live** runs. Waiting / active / waiting_approval runs are
  cancelled first (delete complements cancel; the two never overlap).
- No change to cancel / retry / prune behavior.

## Decisions (settled)

| Question | Decision |
| --- | --- |
| Deletable states | **Terminal only**: `completed`, `failed`, `filtered`, `cancelled` (`TERMINAL_JOB_STATES`). Non-terminal → error "cancel it first". |
| What is deleted | The `job_results` row **and** the linked `agent_session` (cascade: `agent_messages` + the session's `rbac` snapshot). |
| Session cascade code | **Extract** the existing `agent_sessions` cascade out of `postprocessDeletion` into a shared helper; both it and the new resolver call it (no duplicated cascade that could drift). |
| RBAC | Same as cancel/retry: routine **write** access via `loadRoutineRunForWrite`. |
| UI gating | Delete button is **state-gated** (shown on terminal rows), mirroring how cancel/retry buttons are shown; the backend enforces write RBAC (a read-only user gets a rejection toast, same as cancel/retry today). |

## Design

### 1. Shared session-cascade helper — `src/exulu/routines/run-state.ts`

Extract the `agent_sessions` branch of `postprocessDeletion`
(`src/graphql/mutations/index.ts:81-112`) into a helper next to
`cancelRoutineRunRow`:

```ts
// deletes the side-effects of removing an agent_session (NOT the session row):
//   - agent_messages for the session
//   - cancels any still-live job_results runs for the session (cancelRoutineRunRow)
//   - the session's point-in-time rbac snapshot
export async function deleteAgentSessionData(
  db: any,
  sessionId: string,
  queues: { list: Map<string, { use: () => Promise<any> }> },
): Promise<void>
```

`postprocessDeletion`'s `agent_sessions` branch is rewritten to call this helper
(behavior byte-identical), so there is a single source of truth for the cascade.

### 2. Backend — `deleteRoutineRun(id: ID!)` mutation — `src/graphql/schemas/index.ts`

Declared in the SDL beside `cancelRoutineRun` / `retryRoutineRun` (~L688):

```graphql
deleteRoutineRun(id: ID!): ID
```

Resolver (beside `cancelRoutineRun` at ~L1641), mirroring its RBAC + state-gate:

1. `const { row } = await loadRoutineRunForWrite(db, user, args.id);` — routine
   **write** access (throws otherwise).
2. **State gate:** `if (!TERMINAL_JOB_STATES.includes(row.state)) throw new Error(
   \`Run is in state '${row.state}' and cannot be deleted — cancel it first.\`);`
3. **Delete** (a run maps 1:1 to a session):
   - if `row.session`: `await deleteAgentSessionData(db, row.session, ExuluQueues);`
     then `await db.from("agent_sessions").where({ id: row.session }).del();`
   - `await db.from("job_results").where({ id: row.id }).del();`
4. `return row.id;`

`filtered` runs may have no `row.session` (filtered before a session fired); the
`if (row.session)` guard handles that — only the `job_results` row is removed.

### 3. Frontend — `runs-list.tsx` + `lib/routine-runs/presentation.ts`

- **`presentation.ts`:** add `canDeleteRun(state: string): boolean` returning true
  for the terminal states (`completed`, `failed`, `filtered`, `cancelled`) —
  the mirror of the existing `canCancelRun` / `canRetryRun`.
- **`queries.ts`:** add `DELETE_ROUTINE_RUN` (`mutation($id: ID!){ deleteRoutineRun(id: $id) }`).
- **`runs-list.tsx`:**
  - Add a `deleteTarget` state + `DELETE_ROUTINE_RUN` mutation + a `handleDelete`
    that mutates, toasts `runs.toast.deleted` / `deleteFailed`, and refetches the
    runs list, mirroring the existing cancel wiring (`cancelTarget` + confirm).
  - `RunRow`: add an `onDelete` prop and, when `canDeleteRun(run.state)`, render a
    destructive **Delete** button next to Retry/Cancel.
  - A second destructive `ConfirmDialog` (`runs.deleteConfirm.*`), mirroring the
    cancel confirm, warns that the run **and its transcript** are permanently
    removed.
- Lands in both `RoutineRunsList` mount sites (routine detail Runs section + the
  global runs console) with no per-site change.

### 4. i18n — `messages/en.json` + `messages/de.json`

Add under `routines.runs` (or the existing runs namespace matching the current
`row.cancel` / `cancelConfirm.*` / `toast.cancelled` keys):
`row.delete`, `deleteConfirm.{title,description,confirmLabel}`,
`toast.{deleted,deleteFailed}`.

## Error handling

- Non-terminal state → thrown error (surfaced as the `deleteFailed` toast).
- No routine write access → `loadRoutineRunForWrite` throws (rejection toast).
- Missing/already-deleted run id → `loadRoutineRunForWrite` throws (not found).
- `row.session` null (filtered runs) → skip the session cascade; delete only the
  `job_results` row.

## Testing

- **Backend** (jest, following `ee/queues/prune-job-results.test.ts` /
  `run-state` test patterns):
  - `deleteAgentSessionData` removes messages + rbac snapshot and cancels live
    runs (its extraction is behavior-preserving for `postprocessDeletion`).
  - `deleteRoutineRun`: terminal run → session (messages + rbac + session row) and
    the `job_results` row are gone; non-terminal state → rejected; no write
    access → rejected; `filtered` run with no session → only the row removed.
- **Frontend:** `canDeleteRun` unit test (vitest) — true only for terminal
  states. The runs-list UI wiring is verified by tsc/lint/build + manual smoke
  (no component-test infra for this widget).

## Sequencing

1. Extract `deleteAgentSessionData`; rewrite `postprocessDeletion`'s
   `agent_sessions` branch to call it (behavior-preserving). Test.
2. Add the `deleteRoutineRun` SDL field + resolver (RBAC + terminal gate +
   cascade + row delete). Test.
3. Frontend: `canDeleteRun` (+ test), `DELETE_ROUTINE_RUN`, and the runs-list
   delete action + confirm + i18n.
4. Verify (backend jest; frontend tsc/lint/build + manual smoke).
