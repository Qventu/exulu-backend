# Keep Routine Sessions Out of Chat History — Design

- **Date:** 2026-07-29
- **Status:** Approved (ready for implementation plan)
- **Repos:** `exulu/backend` (schema + session creation) and `exulu/frontend` (chat list filter) — deploy-coupled.

## Problem

Sessions created by routine/workflow runs (`createRunSession`) are ordinary
`agent_sessions` rows. The chat history list queries `agent_sessionsPagination`
filtered only by `agent`, so routine-run sessions appear in the regular chat
history alongside real user chats. The rows already carry
`metadata.routine_id`, but JSON filtering is awkward and there is no clean
column to filter on.

## Goal

Add a first-class `run` column to `agent_sessions` holding the id of the
routine/workflow (`workflow_template`) that triggered the session, and filter
the regular chat history to `run = null` so routine-run sessions no longer
appear there.

## Non-goals

- **No backfill of existing rows.** The `run` column is created on boot, but
  existing routine-run sessions keep `run = NULL` and will therefore continue
  to appear in chat history until they are deleted or age out. Accepted
  trade-off (explicit decision): only sessions created after this ships are
  filtered out.
- No index on `run` — the chat query is already `agent`-scoped and `run` is
  null for the large majority of rows, so a btree buys nothing. Add later only
  if profiling shows a need.
- No new filter operator — `eq: null` already expresses `IS NULL` (see below).
- No change to how routine sessions are stored, listed, or opened in the
  routine-runs UI (that surface reads sessions by their own ids and is
  unaffected).

## Design

Three changes.

### 1. Schema — `backend/src/postgres/core-schema.ts`

Add to `agentSessionsSchema.fields`:

```ts
{ name: "run", type: "uuid" },
```

Nullable uuid holding the triggering routine/workflow (`workflow_template`) id
— the same value as `metadata.routine_id`. Null for real chat sessions.

On boot, `addMissingFields` (in `init-exulu-db.ts`) issues
`ALTER TABLE agent_sessions ADD COLUMN run uuid` when the column is absent
(idempotent via `knex.schema.hasColumn`). No manual migration code is needed —
this is automatic column creation, not a data backfill.

The auto-CRUD SDL gains a `run` field on the `Agent_session` type and a `run`
entry on the `FilterAgent_session` input automatically. SDL must be regenerated
**with the EE license** (`EXULU_ENTERPRISE_LICENSE=EXULU_EE_DOCS_SDL`, canonical
`npm run sdl` in mintlify-docs) so license-gated types are not stripped.

### 2. Populate — `backend/src/exulu/routines/run-session.ts`

Add `run: workflow.id` to the `agent_sessions` insert in `createRunSession`,
alongside the existing `metadata`. Every new routine-run session is stamped at
creation.

### 3. Filter chat history — `frontend/app/(application)/chat/hooks.ts`

Add `run: { eq: null }` to the sessions-list filter (the query at
`GET_AGENT_SESSIONS`):

```ts
filters: {
  agent: { eq: agentId },
  run: { eq: null },
  ...(search && search.length >= 3 ? { title: { contains: search } } : {}),
},
```

**No backend filter change is required.** Traced end-to-end:
`applyFilters` (`backend/src/graphql/resolvers/apply-filters.ts`) forwards any
truthy operator object to `convertGraphqlOperatorToPostgresQuery`, whose `eq`
branch is entered whenever `operators.eq !== undefined` (`null !== undefined`
is `true`) and calls `query.where("run", null)`. Knex compiles a two-arg
`.where(col, null)` to `WHERE col IS NULL`. The resulting query is
`agent = ? AND run IS NULL AND …`. `FilterAgent_session` already carries the
`run` field once the schema change lands, so the frontend can pass it directly.

## Testing

- **Backend (jest):** `createRunSession` stamps `run` with `workflow.id` on the
  inserted row.
- **Backend (jest):** a filter test proving `run: { eq: null }` produces a
  `WHERE … is null` clause via `convertGraphqlOperatorToPostgresQuery` (guards
  the load-bearing "no new operator needed" assumption against regressions).
- **Frontend:** manual smoke — a routine run creates a session that is absent
  from chat history but still visible/openable in the routine-runs view; a
  normal chat session still appears.

## Sequencing

1. Backend: add `run` to `agentSessionsSchema`; populate `run: workflow.id` in
   `createRunSession`; jest tests; regenerate SDL (EE license).
2. Frontend: add `run: { eq: null }` to the chat-history filter; manual smoke.

Backend and frontend must deploy together (the frontend filter references a
field the backend must expose first).
