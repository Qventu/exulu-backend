# Routine Queue Selection — Design

- **Date:** 2026-07-28
- **Status:** Approved (ready for implementation plan)
- **Repos:** `exulu/backend` (this repo) + `exulu/frontend` (sibling worktree)

## Problem

Workflows (called **routines** in the UI) can be triggered — via API, schedule,
or inbound email — but a routine can only *run* if it is assigned to a BullMQ
queue. The queue-registration refactor already lets a dev registering queues
through `ExuluApp.create({ queues })` expose them at runtime via
`exuluApp.get().queues()` (`ExuluQueueConfig[]`, each with `.queue.name`). All
three run paths already read the routine's own `workflow.queue` column and hard-
throw if it is empty or not a registered queue:

- manual run — `runWorkflow` resolver (`src/graphql/schemas/index.ts` ~L1363)
- schedule — `upsertWorkflowSchedule` resolver (~L1064)
- email — `fireRun` (`src/exulu/email-inbound/intake.ts` ~L246)

Retry/resume re-read the queue name from `job_results.metadata.queue_name`
(`src/exulu/routines/run-state.ts`, `ee/workers.ts`).

**What's missing:**

1. There is no API to *list* the registered queues, so the frontend cannot
   offer the user a choice.
2. The routine editor never sends `queue`, so `workflow.queue` is never set and
   routines throw "No queue selected" at run time.
3. The UI currently *derives* a displayed queue from the selected **agent**
   (`agent.workflows.queue.name`), read-only. That concept is **deprecated** —
   `agent.workflows` is dead code (a GraphQL type + provider-field entry that is
   never populated by any resolver). It must be removed, not merely bypassed.

## Goals

- Expose the set of registered queues over GraphQL for a routine editor select.
- Let a user pick a queue per routine; persist it to `workflow_templates.queue`
  (the single source of truth) via the existing auto-CRUD update mutation.
- Remove all agent-derived queue plumbing (`agent.workflows` /
  `AgentWorkflows` / the `workflows` provider field / the frontend's agent-
  sourced queue reads) across both repos.

## Non-goals

- No change to how the three run paths resolve or validate the queue — they
  already read `workflow.queue`.
- No DB migration and **no backfill**: `workflow_templates.queue` already exists
  (added by `addMissingFields`), stays nullable. Existing routines keep a null
  queue and are prompted to pick one; they remain blocked at run time (existing
  backend behavior) until set.
- No write-time validation of the queue name in the generic mutation layer — the
  select only offers valid queues, and the run paths already validate.

## Decisions (settled)

| Question | Decision |
| --- | --- |
| Source of truth | `workflow_templates.queue` (routine's own field). Agent-derived queue is deprecated and removed. |
| Scope | Full-stack, both repos. Frontend in a sibling worktree with symlinked `node_modules`. |
| Required / backfill | Required in the editor going forward. **No backfill**; existing null routines get a "pick a queue" prompt and stay run-blocked until set. |
| Placement | **Repurpose** the existing read-only Queue section (`sections/queue.tsx`) into the editable select — keep the section, overlay/QueuePanel, and i18n keys; flip only the data source and make it editable. |
| Queue-list API shape | New lightweight `queues: [AvailableQueue!]!` returning just `{ name }`, sourced from `exuluApp.get().queues()`. |

## Architecture / data flow

```
Registered queues (ExuluApp.create({ queues }))
        │  exuluApp.get().queues() → ExuluQueueConfig[] (.queue.name)
        ▼
GraphQL Query: queues → [{ name }]              ← NEW
        │
        ▼  (frontend select options)
Routine editor  ── select ──►  workflow_templates.queue (TEXT, nullable)
        │                         │ via workflow_templatesUpdateOne(Input.queue)  ← already writable
        ▼                         ▼
Run paths (runWorkflow / upsertWorkflowSchedule / fireRun)
   read workflow.queue → find in exuluApp.get().queues() by .queue.name
   → enqueue; persist queue_name in job_results.metadata (retry/resume)   ← UNCHANGED
```

Why source the list from `exuluApp.get().queues()` (not `ExuluQueues.list` or the
build-time `QueueEnum`): it is the exact set the run paths validate against, so a
value offered in the select can never fail queue lookup at run time.

## Backend changes (`exulu/backend`)

### B1 — Feature: list registered queues

`src/graphql/schemas/index.ts`

- Add to the type defs:
  ```graphql
  type AvailableQueue { name: String! }
  ```
  and a Query field `queues: [AvailableQueue!]!`.
- Add `resolvers.Query["queues"]`:
  ```ts
  resolvers.Query["queues"] = async () => {
    const configs = exuluApp.get().queues();           // ExuluQueueConfig[]
    return configs.map((c) => ({ name: c.queue.name }));
  };
  ```
  Guard against the app/Redis not being initialized (e.g. `_queues` empty or
  `exuluApp.get()` throwing) by returning `[]`. Reuse the same `exuluApp`
  accessor already imported for `runWorkflow`/`upsertWorkflowSchedule`.
- `workflow_template.queue` is already in the generated object type and
  `workflow_templateInput` (it has no `hidden` flag), so `workflow_templatesUpdateOne`
  / `...UpdateOneById` already accept and persist it — **no mutation/schema/DB work**.

### B2 — Teardown: remove dead `agent.workflows` plumbing

All of the below is dead code — `agent.workflows` is declared in GraphQL and
listed as a provider field but no resolver ever populates it.

- `src/graphql/schemas/index.ts`
  - Delete the `fields.push("  workflows: AgentWorkflows");` line (~L126).
  - Delete `type AgentWorkflows { enabled queue }` and
    `type AgentWorkflowQueue { name }` (~L2635–2642).
  - Delete the `import { getQueue } ...` line (~L67).
  - Delete the stray `// todo allow setting queue on agent provider ...` comment (~L1464).
- `src/graphql/utilities/provider-fields.ts` — remove `"workflows"` from
  `exuluProviderFields` (~L11); fix trailing comma if needed.
- `src/graphql/utilities/sanitize-and-hydrate-fields.ts` — remove the unused
  `import { getQueue } ...` (~L15).
- `src/exulu/get-queue.ts` — delete the file (empty `// tbd` stub, never called;
  currently untracked).
- `ee/workers.ts` — delete the stray `// todo allow setting queue on agent Provider ...`
  comment (~L748). **Do not touch L504** (`queue_name: bullmqJob.queueName`).
- Regenerate the SDL with `scripts/print-sdl.ts` so the generated
  `mintlify-docs/api-reference/graphql/schema.graphql` drops the `AgentWorkflows`
  types/field (never hand-edit the generated file). Rebuild `dist`.

### B3 — KEEP (must not be removed)

Flagged by a searcher but confirmed as unrelated/essential:

- `ee/workers.ts:504` and `src/exulu/routines/run-state.ts` (`queue_name` in
  `job_results.metadata`) — this is how retry/resume re-enqueue on the routine's
  own queue. Core plumbing.
- `role.workflows` RBAC permission — unrelated authorization field.
- `src/graphql/resolvers/job-queues.ts` (`getJobsByQueueName`) — generic queue
  infra.
- `workflow_templates.queue` — the source of truth we are wiring up.
- eval queue-management UI/queues (`eval_runs`) — separate concern.

### B4 — Tests

- Unit test for `resolvers.Query["queues"]`: with a mocked
  `exuluApp.get().queues()` returning configs, it maps to `[{ name }]`; with an
  uninitialized app it returns `[]`. Follow existing resolver test patterns.

## Frontend changes (`exulu/frontend`, sibling worktree)

### F1 — Teardown: remove agent-derived queue sourcing

- Remove the `workflows { enabled queue { name } }` selection from all 5 agent
  queries:
  - `queries/queries.ts`
  - `app/(application)/chat/queries.ts`
  - `app/(application)/workflows/queries.ts` (`GET_AGENT_BY_ID`)
  - `app/(application)/agents/edit/[id]/queries.ts`
  - `app/(application)/agents/queries.ts`
- `types/models/agent.ts` — remove the `workflows` field from the agent interface.
- `app/(application)/workflows/hooks.ts` — remove `AgentRecord.queueName` and the
  `data.agentById.workflows?.queue?.name` extraction and the inline `workflows`
  type annotation. **Keep the hook** — it still supplies `agentName`.
- `app/(application)/workflows/types.ts` — remove the dead `agentQueueName` field
  from `Routine`.

### F2 — Feature: repurpose Queue section → editable select bound to `routine.queue`

- `app/(application)/workflows/queries.ts`
  - Add `GET_AVAILABLE_QUEUES` (`query { queues { name } }`).
  - Add `queue` to the template list selection and the by-id selection.
  - Add `$queue: String` to `UPDATE_WORKFLOW_TEMPLATE` and pass it in the input.
  - `CREATE_WORKFLOW_TEMPLATE` stays without `queue` (new routines start null;
    the editor requires a queue before the routine can run).
- `app/(application)/workflows/types.ts` — add `queue?: string | null` to `Routine`.
- `app/(application)/workflows/[id]/hooks.ts`
  - `useRoutineEditor`: add `queue` to `RoutineFormValues` and the zod schema as
    **required**; initialize from `routine.queue`; include it in the `save()`
    payload to `UPDATE_WORKFLOW_TEMPLATE`.
  - `useRoutineWorkbench`: source `queueName` from `routine.queue` instead of the
    agent record. Keep `openQueue`, the queue overlay variant, and the QueuePanel
    (they now manage the selected queue).
- `app/(application)/workflows/[id]/sections/queue.tsx` — rewrite as an editable
  `FormField` + `Select`:
  - Options from `GET_AVAILABLE_QUEUES` (fetch pattern mirrors `BasicsSection`'s
    agent dropdown).
  - Bound to the editor form's `queue` field via the shared `editor.form.control`
    (the section must render inside the same RHF form context as Basics).
  - Keep the "Manage queue" button (opens QueuePanel) when a queue is selected.
  - Empty state renders a required "Select a queue" prompt.
  - Disabled + "No queues available" when the query returns `[]`.
- `app/(application)/workflows/routines-client.tsx` — `queueNameOf` reads
  `routine.queue` (not the agents map). The run dialog wiring
  (`RunRoutineRequest.queue`) is otherwise unchanged; `run-routine-dialog.tsx`
  already handles `request.queue`.
- i18n (`messages/en.json` + `messages/de.json`) — keep the `routines.queue.*`
  keys and extend with: select placeholder, required-validation message, and a
  "no queue set" prompt.
- List/detail — surface a clear "no queue set" indicator on legacy null routines
  (the section empty state plus a subtle list badge).

### F3 — Tests

- The queue select renders options from `GET_AVAILABLE_QUEUES`, is required
  (cannot save empty), and `save()` sends `queue`.
- Update existing routine editor tests for the new field.

## Edge cases / error handling

- **No queues registered / Redis down:** `queues` returns `[]`; the select is
  disabled with "No queues available"; save is blocked by the required
  validation. (A routine cannot run without a queue anyway.)
- **Legacy routine with null queue:** editor shows the required prompt; run paths
  continue to throw the existing "No queue selected" error until the user sets one.
- **Stored queue no longer registered:** unchanged existing behavior — run paths
  throw "Queue &lt;name&gt; not found as a registered queue". The select shows the
  stored value even if absent from the current options (so the user can see and
  change it); consider rendering it as a distinct "unavailable" option.

## Sequencing

1. Backend B1 (queues query) + B2 (teardown) + B4 (test); regenerate SDL, rebuild
   dist; verify the running server exposes `queues` and no longer exposes
   `AgentWorkflows`.
2. Frontend F1 (teardown) + F2 (repurpose) + F3 (tests) against the updated
   backend schema.
3. Manual smoke: register a custom queue via `ExuluApp.create`, confirm it appears
   in the select, save a routine with it, trigger a run, confirm it enqueues on
   that queue.

## Open points (resolved defaults)

- `get-queue.ts`: **delete** the stub rather than build the list helper there —
  the design reuses the existing `exuluApp.get().queues()` pattern.
- Create flow leaves `queue` null; the editor enforces selection before run
  (matches "required, no backfill").
