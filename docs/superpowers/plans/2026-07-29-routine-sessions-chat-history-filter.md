# Keep Routine Sessions Out of Chat History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `run` column to `agent_sessions` holding the triggering routine/workflow id, stamp it when routine-run sessions are created, and filter the regular chat history to `run = null` so routine-run sessions no longer appear there.

**Architecture:** Backend adds a nullable `uuid` field `run` to `agentSessionsSchema` (auto-created on boot by `addMissingFields`, auto-exposed on the `Agent_session` type + `FilterAgent_session` input). `createRunSession` stamps `run: workflow.id`. The frontend chat-session list adds `run: { eq: null }` to its filter, which Knex compiles to `WHERE run IS NULL` — no backend filter change and no new operator.

**Tech Stack:** TypeScript, Knex/Postgres, GraphQL code-first auto-CRUD, jest (backend), Next.js + Apollo Client (frontend).

## Global Constraints

- `run` holds the triggering routine/workflow (`workflow_template`) id — the same value as `metadata.routine_id`. Nullable; null for real user chat sessions.
- **No backfill.** Existing routine-run sessions keep `run = NULL` and are not migrated. Only sessions created after this ships are filtered out. Do NOT add an `UPDATE … SET run = …` migration.
- **No new filter operator and no index** on `run`. `eq: null` already compiles to `IS NULL`; the chat query is already `agent`-scoped.
- Commit subjects must start lowercase (commitlint subject-case hook).
- SDL is regenerated via `npm run sdl` from `mintlify-docs/` — the script sets the EE license itself; never hand-edit `schema.graphql`, and never regenerate without the EE license (it strips ~500 gated types).
- Backend and frontend are deploy-coupled (the frontend filter references a field the backend must expose first).

---

### Task 1: Backend — `run` column, stamping, tests, SDL

**Files:**
- Modify: `backend/src/postgres/core-schema.ts:60-95` (add `run` field to `agentSessionsSchema.fields`)
- Modify: `backend/src/exulu/routines/run-session.ts:26-39` (add `run: workflow.id` to the insert)
- Modify: `backend/src/exulu/routines/run-session.test.ts` (assert `run` is stamped)
- Create: `backend/src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.test.ts` (prove `eq: null` → `IS NULL`)
- Regenerate: `backend/mintlify-docs/api-reference/graphql/schema.graphql` (via `npm run sdl`)

**Interfaces:**
- Consumes: `createRunSession(opts)` with `opts.workflow.id` (existing signature, unchanged).
- Produces: `agent_sessions` rows carry a `run` uuid column; the GraphQL `Agent_session` type has a `run` field and `FilterAgent_session` accepts `run: { eq: … }`. Task 2 (frontend) relies on `FilterAgent_session.run`.

- [ ] **Step 1: Add the failing assertion to `run-session.test.ts`**

In `backend/src/exulu/routines/run-session.test.ts`, in the first test ("creates the session with agent/user/title/rights_mode and run metadata"), after the existing `expect(row.metadata).toEqual(...)` line (currently line 55), add:

```ts
    expect(row.run).toBe("wf-1");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/exulu/routines/run-session.test.ts -t "creates the session"`
Expected: FAIL — `row.run` is `undefined` (the insert does not yet set `run`).

- [ ] **Step 3: Stamp `run` in `createRunSession`**

In `backend/src/exulu/routines/run-session.ts`, add `run: workflow.id` to the `.insert({ … })` object. Place it just after the `rights_mode` line and before the `metadata:` comment block:

```ts
      rights_mode: workflow.rights_mode ?? "private",
      // The routine/workflow this session is a run of; null for user chats.
      // Chat history filters run = null so run sessions do not appear there.
      run: workflow.id,
      // Session ⇄ run cross-link; the agent-run route uses job_result_id to
      // resume a paused run after an approval turn (spec §5.5).
      metadata: {
        routine_id: workflow.id,
        job_result_id: jobResultId ?? null,
        trigger,
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest src/exulu/routines/run-session.test.ts`
Expected: PASS (all cases, including the new `row.run` assertion).

- [ ] **Step 5: Add the `run` field to the schema**

In `backend/src/postgres/core-schema.ts`, in `agentSessionsSchema.fields`, add a new field after the `metadata` entry (currently lines 86-89) and before `currenttask`:

```ts
    {
      name: "metadata",
      type: "json",
    },
    {
      // The routine/workflow (workflow_template) this session is a run of.
      // Null for regular user chats; chat history filters run = null so
      // routine-run sessions do not appear there. Populated by createRunSession.
      name: "run",
      type: "uuid",
      required: false,
    },
    {
      name: "currenttask",
      type: "text",
      required: false,
    },
```

- [ ] **Step 6: Write the failing filter test proving `eq: null` → `IS NULL`**

Create `backend/src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.test.ts`:

```ts
import Knex from "knex";

import { convertGraphqlOperatorToPostgresQuery } from "./convert-graphql-filter-operator-to-pg-query";

// SQL-builder only (no connection): Knex compiles queries to strings without pg.
const knex = Knex({ client: "pg" });

describe("convertGraphqlOperatorToPostgresQuery", () => {
  it("compiles { eq: null } to an IS NULL clause (no dedicated null operator needed)", () => {
    const query = convertGraphqlOperatorToPostgresQuery(
      knex("agent_sessions"),
      "run",
      { eq: null },
    );
    const sql = query.toString().toLowerCase();
    expect(sql).toContain('"run" is null');
  });

  it("compiles { eq: value } to an equality clause", () => {
    const query = convertGraphqlOperatorToPostgresQuery(
      knex("agent_sessions"),
      "run",
      { eq: "wf-1" },
    );
    const sql = query.toString().toLowerCase();
    expect(sql).toContain('"run" =');
    expect(sql).not.toContain("is null");
  });
});
```

- [ ] **Step 7: Run the filter test**

Run: `cd backend && npx jest src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.test.ts`
Expected: PASS. (The production code already handles `eq: null` — this test locks in the "no new operator needed" contract against future regressions. If it does NOT pass, stop: the design assumption is wrong and the frontend approach in Task 2 would silently not filter.)

- [ ] **Step 8: Regenerate the SDL (with EE license)**

Run: `cd backend/mintlify-docs && npm run sdl`
Then verify the diff:

Run: `cd backend && git diff --stat mintlify-docs/api-reference/graphql/schema.graphql`
Expected: the file changes. Confirm the change ADDS a `run` field on the `Agent_session` type and a `run` operator on the `FilterAgent_session` input, and does NOT delete large numbers of gated types (a mass deletion means the EE license was not applied — do not commit it; re-run with the license set).

Run: `cd backend/mintlify-docs && npm run verify-sdl`
Expected: PASS (or, if the script requires no drift, it confirms the committed SDL matches generation).

- [ ] **Step 9: Run the full backend test suite**

Run: `cd backend && npm test`
Expected: no NEW failures versus baseline. (Pre-existing unrelated failures may exist — compare against `git stash` baseline if unsure; the two touched areas are `run-session` and the new filter test.)

- [ ] **Step 10: Commit**

```bash
cd backend
git add src/postgres/core-schema.ts \
        src/exulu/routines/run-session.ts \
        src/exulu/routines/run-session.test.ts \
        src/graphql/utilities/convert-graphql-filter-operator-to-pg-query.test.ts \
        mintlify-docs/api-reference/graphql/schema.graphql
git commit -m "feat(routines): add run column to agent_sessions for chat-history filtering"
```

(Stage only these files — the tree may hold unrelated uncommitted changes such as `src/exulu/email-inbound/intake.ts`; do NOT stage them.)

---

### Task 2: Frontend — filter chat history to `run = null`

**Files:**
- Modify: `frontend/app/(application)/chat/hooks.ts:1004-1015` (add `run: { eq: null }` to the sessions-list filter)

**Interfaces:**
- Consumes: `FilterAgent_session.run` from Task 1 (the backend must expose it first).
- Produces: the chat-session list query sends `agent = ? AND run IS NULL`.

- [ ] **Step 1: Add the `run` filter**

In `frontend/app/(application)/chat/hooks.ts`, in `useChatSessions`, add `run: { eq: null }` to the `filters` object (currently lines 1004-1015):

```ts
      filters: {
        agent: {
          eq: agentId,
        },
        // Exclude routine/workflow run sessions from chat history. Knex
        // compiles { eq: null } to WHERE run IS NULL (see backend
        // convert-graphql-filter-operator-to-pg-query). New run sessions carry
        // a non-null run; pre-existing ones (no backfill) still have run = null
        // and are not excluded.
        run: {
          eq: null,
        },
        ...(search && search.length >= 3
          ? {
              title: {
                contains: search,
              },
            }
          : {}),
      },
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no NEW type errors. (If the generated GraphQL filter type for `run` is present, `run: { eq: null }` typechecks. If the frontend uses generated types that lag the backend schema, regenerate them per the repo's codegen script before this step.)

- [ ] **Step 3: Lint the touched file**

Run: `cd frontend && npx eslint "app/(application)/chat/hooks.ts"`
Expected: clean.

- [ ] **Step 4: Build**

Run: `cd frontend && npm run build`
Expected: success.

- [ ] **Step 5: Manual smoke (documented for the human)**

With backend + frontend running against a DB that has at least one routine that produces sessions:
1. Trigger a routine run (or use an existing post-deploy run). Confirm its session does NOT appear in the agent's chat history list.
2. Confirm the same run session IS still visible/openable from the routine-runs view (`/workflows` runs console / routine detail Runs section).
3. Confirm a normal chat session still appears in chat history.

- [ ] **Step 6: Commit**

```bash
cd frontend
git add "app/(application)/chat/hooks.ts"
git commit -m "feat(chat): hide routine run sessions from chat history"
```

(Stage only this file — the frontend tree holds unrelated uncommitted changes; do NOT stage them.)

---

## Self-Review

- **Spec coverage:** schema field (Task 1 Step 5) ✓; populate (Task 1 Step 3) ✓; SDL regen with EE license (Task 1 Step 8) ✓; frontend `run = null` filter (Task 2 Step 1) ✓; no-backfill / no-index / no-new-operator honored as Global Constraints ✓; both test cases from the spec (`createRunSession` stamps `run`; `eq: null` → `IS NULL`) ✓.
- **Type consistency:** `run` is `uuid` in the schema and stamped from `workflow.id` (a `string` uuid); the filter uses `run: { eq: null }` matching the auto-generated `FilterAgent_session.run` operator.
- **No placeholders:** every code step carries the exact edit.
