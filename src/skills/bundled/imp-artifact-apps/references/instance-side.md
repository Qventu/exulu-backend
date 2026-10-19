# The instance side: what lives in code, what lives in the database

An artifact app is only the surface. Most apps also need a place to keep rows,
logic that runs with real credentials and models, and an agent to run that
logic from a Routine. Those pieces live in the IMP **instance repository**
(the Node project that imports `@exulu/backend`), not in the artifact.

The IMP documentation is the authority for every API named here; this file
says **which piece to reach for and why**, and shows the shapes the Tender
cockpit uses. Docs: https://docs.intelligence-management-platform.com — the
page paths below are relative to it.

## Decision table

| You need… | Use | Where | Why |
|---|---|---|---|
| a table the app reads and writes (per-item state, decisions, logs) | `ExuluContext` | code, `src/contexts/` | becomes a Postgres table + generated GraphQL with rights built in; columns are added by init-db on boot |
| logic that calls models, reads files, hits external APIs, writes many rows | `ExuluTool` | code, `src/tools/` | runs server-side with the tool's config/variables and the caller's rights; the agent calls it; the artifact never holds those credentials |
| something that takes longer than a request, or must run unattended | a **Routine** that calls the tool | database row (`workflow_templates`) | queued on a worker, visible as runs, schedulable, retryable; the app starts it with `runWorkflow` |
| the agent that runs the Routine's steps | `ExuluAgent` in code | code, `src/agents/` | a fixed id that survives every environment; the Routine references it by that id |
| an assistant people chat with, configured by non-developers | agent in the database | IMP UI → Agents | no deploy needed; but its id differs per environment, so do not point app Routines at it |
| background throughput for the tool's heavy work | `ExuluQueues.register(...)` | code, `src/queues/` | a dedicated queue with its own concurrency; the worker process consumes it |
| reusable instructions for agents (like this file) | a skill | skill library | versioned, installable, no deploy |
| the UI | the artifact | published file | the only piece that runs in the viewer's browser |

Rule of thumb from the cockpit: **state in contexts, logic in one tool with an
`action` switch, orchestration in Routines, UI in the artifact.** No custom
Express routes — if the app seems to need one, the logic belongs in the tool.

## The instance repository

Three files bootstrap it (docs: `/developers/getting-started`):

- `exulu.ts` — builds the app once: `new ExuluApp().create({ config, contexts, tools, agents, queues })`
- `server.ts` — the HTTP server (GraphQL, REST, MCP)
- `worker.ts` — the background worker that runs queues and Routines

Adding a context, tool or agent means exporting it from `src/contexts`,
`src/tools` or `src/agents` and listing it in `exulu.ts`. The database picks
up new contexts and new fields on the next boot (`init-db`); it never changes
an existing column's type, so pick types carefully the first time.

## ExuluContext (docs: `/developers/core/exulu-context/introduction`, `/developers/tutorials/defining-contexts`)

```ts
import { ExuluContext } from "@exulu/backend";

export const tendersContext = new ExuluContext({
  id: "tenders",                      // → table tenders_items, GraphQL tenders_items*
  name: "Tender Agent - Tenders",
  description: "One row per tender; the row id is the tender_id every tool action takes.",
  active: true,
  fields: [
    { name: "display_name", type: "shortText" },   // varchar(100): titles do not fit, use longText
    { name: "folder_path", type: "longText" },
    { name: "deadline", type: "date" },
    { name: "ko_status", type: "shortText" },      // a flat column for cross-row queries
    { name: "cockpit", type: "json" },             // the app's own state: one JSON overlay
    { name: "llm_calls", type: "number" },
  ],
  sources: [],
  configuration: { calculateVectors: "manual", languages: ["german", "english"], maxRetrievalResults: 20 },
});
```

- Field types: `text`, `shortText` (100 chars), `longText`, `number`,
  `boolean`, `date`, `json`, `enum` (+ `enumValues`), `markdown`, `code`,
  `file`, `uuid`. Core columns exist on every context and must not be declared:
  `id`, `name`, `description`, `tags`, `created_by`, `rights_mode`, `createdAt`,
  `updatedAt`.
- Give the app one `json` column for its own state and flat columns for
  whatever lists and filters need (status, deadline, verdicts). Flat columns
  are what `tenders_itemsPagination(filters: …)` can filter on.
- `calculateVectors: "manual"` unless the rows are knowledge to search; an
  embedder set to `"always"` together with a processor silently skips the processor.
- A context that an agent should search gets an `embedder` and a `chunker`;
  an app state table needs neither.

## ExuluTool (docs: `/developers/core/exulu-tool/introduction`, `/developers/tutorials/custom-tools`)

```ts
import { ExuluTool } from "@exulu/backend";
import { z } from "zod";

export const tenderTool = new ExuluTool({
  id: "tender",
  name: "Tender Agent",
  description: "Runs one action for one tender: status, ko_check, fit_eval, extract_requirements, …",
  type: "function",
  inputSchema: z.object({
    tender_id: z.string().optional().describe("The tenders_items row id."),
    action: z.enum(["status", "ko_check", "fit_eval", "scan"]).default("status"),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
  config: [],              // admin-configurable params, incl. type "variable" for secrets
  needsApproval: false,
  execute: async function* (input) {
    // input also carries: input.user (who runs it), input.model, input.sessionID,
    // input.exuluConfig, input.toolVariablesConfig
    yield* runAction(input);   // yield progress strings; the last value is the result
  },
});
```

- One tool with an `action` switch keeps the Routine step text stable
  ("call the tool exactly once with action {action}") and the agent's tool list short.
- Tools read and write contexts through the context object's own methods
  (`context.getItem`, `createItem`, `updateItem`, `search`), with the running
  user's rights. Rows a tool creates for an app should carry
  `rights_mode: "public"` (or an explicit scope) and a `created_by`; a
  `private` row with no creator is read-only for everyone but admins.
- A direct `updateItem` does not bump `updatedAt`; set it yourself when the
  app sorts by it.
- Keep the tool resumable and multi-user safe: write an audit entry per step,
  guard against two runs on the same row (a lock column with an expiry), and
  make every action idempotent — the app and the Routine may retry.
- Model calls go through the instance's LiteLLM model names; count calls and
  cost per step if the app shows them (the cockpit's `llm_calls`, `cost_eur`).

## ExuluAgent in code (docs: `/developers/core/exulu-app/configuration`, "agents")

```ts
import type { ExuluAgent } from "@exulu/backend";

export const TENDER_AGENT_ID = "6d1f9c20-5a7b-4e83-9c14-2f8ab3d5e701"; // a UUID, fixed forever

export const tenderAgent: ExuluAgent = {
  id: TENDER_AGENT_ID,
  type: "agent",
  source: "code",
  active: true,
  name: "Tender Agent",
  description: "Prepares public tenders for the bid team.",
  instructions: TENDER_AGENT_INSTRUCTIONS,
  model: "claude-sonnet-5",             // a LiteLLM model_name of the instance
  maxContextLength: 200000,
  max_tool_steps: 12,
  tools: [{ id: "tender", type: "function", name: "Tender Agent", description: "…", config: [] }],
};
```

- The id is a **UUID string**: Routines reference the agent through
  `workflow_templates.agent`, a uuid column, so a readable slug is rejected.
  Changing the id later breaks every Routine that names it.
- A code agent needs no database row, exists in every environment the code
  is deployed to, and defaults to public access. That is exactly what app
  Routines need. Database agents (created in the Agents workbench) are right
  for chat assistants that builders tune without a deploy.

## Routines are rows (docs: `/building/routines/overview`, `/api-reference/graphql/core-types/workflow-templates`)

A Routine is a saved conversation the agent replays: `steps_json` holds the
user step (with `{variables}`) and a placeholder assistant step; `agent` is the
agent id; `queue` the worker queue; `auto_approve_tools: true` so a queued run
never pauses for approval; `rights_mode: "public"` so every viewer may start it.

```json
[
  { "id": "<uuid>", "role": "user", "parts": [{ "type": "text",
    "text": "Call the Tender tool exactly once for tender {tender_id} with action {action} {options} and report briefly." }] },
  { "id": "<uuid>", "role": "assistant", "parts": [{ "type": "text", "text": "Placeholder — the agent's generated response will appear here when the routine runs." }],
    "metadata": { "type": "placeholder" } }
]
```

- The rows do not travel with a deploy. Create them **once per environment**
  with an idempotent script (SQL `INSERT … ON CONFLICT (id) DO UPDATE`, or
  the generic `workflow_templatesCreateOne` with `upsert: true` and an
  explicit `id`), keep the ids in one constants module of the app, and
  document them. The symptom of a missing row is the backend's
  "Workflow template not found in database." on any run.
- Every `{variable}` in the step text must receive a non-empty value, or the
  run fails before it starts; send a harmless phrase for unused options.
- One single-action Routine per tool is enough for an app; add dedicated
  rows only for scheduled runs (a daily scan, reminders) so they can be
  scheduled without touching code.

## How the pieces meet at runtime

```
artifact (viewer's token)                worker                       database
  runWorkflow(ROUTINE_ID, {tender_id, action})
        └──────────────── job ──────────► agent (code) runs the step
                                           └─ calls tool(action)
                                               └─ reads/writes contexts ──► tenders_items …
  poll routineRuns(workflow: ROUTINE_ID) ◄── state: active → completed
  re-read the rows the tool changed ◄──────────────────────────────────────┘
```

Rights flow: the artifact reads and writes with the viewer's token; the tool
runs with the rights of whoever started the run (`input.user`). Rows the tool
creates must be readable by the other viewers of the app — give them
`rights_mode: "public"` or the scope the app needs.

## Queues and the worker (docs: `/developers/tutorials/queues-and-workers`)

Register a queue for the tool's heavy work in `src/queues/index.ts`
(`ExuluQueues.register("tender_queue", { worker: 2, queue: 4 })`) and name it
on the Routine rows. Registering is what gives it a worker; listing it again in
`create({ queues })` starts a second one. Document-processing jobs stay on the
instance's default pipeline queue.
