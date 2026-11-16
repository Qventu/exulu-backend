# Routine work status — design

Date: 2026-11-16
Status: agreed with Daniel Claessen 2026-11-16; not yet planned or built
Repos: `exulu/backend` (schema, API, tool context, built-in tool), `exulu/frontend` (runs list, routine settings)

## Why

A service team uses the routine runs list as an inbox: a mail arrives, a
mail-triggered offer routine runs, the row says "Abgeschlossen". That state is
purely technical. It does not say whether the run produced an ERP offer, only
prepared a clarification mail, or needs a human — and nobody can tick a run off
as handled. The team asked for a working list: see what each run produced, and
set it to done themselves.

A routine run today has one status, `job_results.state`
(`types/enums/jobs.ts`: completed, failed, active, waiting, waiting_approval,
filtered, cancelled, …). It drives retries, cancellation, pruning and the
"needs attention" filter. It must stay technical.

## Goals

1. Each routine can define its own list of **work statuses** (key, label,
   colour), a default, and which of them count as done.
2. Each run carries a work status, separate from `state`, that
   - a **person** can set from the runs list,
   - a **tool** can set from code when a hard fact is established
     (the offer XML was uploaded),
   - the **agent** can set through a built-in tool for soft outcomes
     ("clarification prepared").
3. The runs list can be filtered by work status and defaults to "open" when the
   routine has statuses, so it works as an inbox.

## Non-goals

- No workflow engine: no transitions, no rules about which status may follow
  which. Any configured status can be set at any time.
- No assignment, comments or due dates. The API shape leaves room for them
  (see "The patch type"), nothing is built now.
- No change to `job_results.state` or anything that reads it.
- No per-platform status list. Statuses belong to one routine.

## Anti-goals

- A tool or the agent must never be able to change the technical state, the
  run's result, its session, or the routine definition through this feature.
- An automated write must never undo a person's decision (a retry must not turn
  "Erledigt" back into "Angebot im ERP").
- A routine without configured statuses must look and behave exactly as today.

## Data model

### On the routine — `workflow_templates.work_statuses` (jsonb, nullable)

Stored on the routine rather than in `platform_configurations`: that table is
a global key/value store, while this list belongs to exactly one routine and
should be copied, exported and deleted with it.

```json
{
  "statuses": [
    { "key": "neu",             "label": "Neu",                     "color": "gray"   },
    { "key": "angebot_im_erp",  "label": "Angebot im ERP angelegt", "color": "blue"   },
    { "key": "rueckfrage",      "label": "Rückfrage vorbereitet",   "color": "orange" },
    { "key": "erledigt",        "label": "Erledigt",                "color": "green", "done": true }
  ],
  "default": "neu"
}
```

Rules:

- `key`: `^[a-z][a-z0-9_]{1,39}$`, unique within the routine, **immutable once
  saved**. Project code and tool mappings refer to keys; renaming one in the UI
  would silently break them. Label, colour, order and `done` stay editable.
  Enforced in the settings UI (key field read-only after the first save); the
  API cannot tell a rename from remove + add, which is allowed, so it only
  checks format and uniqueness.
- `default` must be one of the keys. It is written to a run when the run is
  created.
- `color` is one of the design system's named badge colours (builder: reuse
  the palette the team-colour picker offers).
- `null` or an empty `statuses` array means the feature is off for the routine.
- Deleting a status that runs still carry is allowed; those runs keep the
  stored key and the UI shows it as a neutral badge with the raw key and a
  "removed" hint. No migration of old runs.

Declare the shape with the typed-json mechanism from
`2026-11-09-typed-json-fields-design.md` if that has landed; otherwise validate
in the resolver.

### On the run — three columns on `job_results`

| Column | Type | Meaning |
|---|---|---|
| `work_status` | text, nullable, indexed | a key from the routine's list |
| `work_status_updated_at` | timestamptz, nullable | last change |
| `work_status_updated_by` | jsonb, nullable | `{ "kind": "user", "id": 14 }`, `{ "kind": "tool", "id": "generate_offer_xml" }`, `{ "kind": "agent" }` or `{ "kind": "default" }` |

Extend the composite index used by `runs-query.ts` or add
`(workflow, work_status, createdAt)` — builder's call after looking at the
query plan.

## Tool context: `routine`

`ExuluTool.execute` already receives injected context next to the model inputs
(`sessionID`, `user`, `contexts`, `exuluConfig`, `upload`, … — see the call in
`src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`). One more field
is added. Existing tools are unaffected.

```ts
type RoutineRunPatch = {
  /** Work status: a key from routine.statuses. */
  status?: string;
  // Room for later fields (note, assignee, data). Each new field = one line
  // here + one validation rule in update(); no new method.
};

type RoutineHandle = {
  id: string;
  name: string;
  /** From the routine's work_statuses config; [] when none are configured. */
  statuses: { key: string; label: string; done?: boolean }[];
  runs: {
    current: {
      id: string;              // job_results.id
      status: string | null;   // current work status
      update(patch: RoutineRunPatch): Promise<void>;
    };
  };
};
```

Usage in a project tool:

```ts
execute: async ({ lineItems, routine }) => {
  // … build and upload the offer XML …
  await routine?.runs.current.update({ status: "angebot_im_erp" });
}
```

Decisions made in the conversation:

- The field is called **`routine`** (not `run`), with the run under
  **`routine.runs.current`**. `routine` itself is read-only; everything that
  writes hangs off the current run. `runs` is an object so `list()` or
  `previous` can be added later without breaking the signature. Only `current`
  is built now.
- **One generic `update(patch)`** instead of a method per field, with a closed
  patch type. Unknown keys are a TypeScript error and a runtime error.
- **`routine` is set whenever the session belongs to a routine run** — during
  the worker's run *and* when a person later opens that run's session in the
  chat and continues it (decided 2026-11-16). The agent has the same tools in
  both cases. It is `undefined` everywhere else (a normal chat, MCP, the direct
  agent API on a non-run session). When it is set, `runs.current` always
  exists, so a tool needs exactly one `?.`.

### Behaviour of `update`

1. Reject unknown patch keys (throw, naming the allowed keys).
2. `status`: must be a key in `routine.statuses`; otherwise throw with the list
   of allowed keys. When the routine has no statuses configured, throw
   "this routine has no work statuses configured" — a tool that sets a status
   on an unconfigured routine is a setup mistake that should be visible in the
   run, not swallowed. (Builder: the offer-XML tool should therefore guard with
   `routine?.statuses.some(s => s.key === …)` or catch; the spec for that tool
   change lives in the project that owns the tool.)
3. All-or-nothing: validate every field before writing any.
4. **Human wins — during the worker's run.** When
   `work_status_updated_by.kind === "user"`, an `update` from a tool or the
   agent *inside the worker's run* does not change the status. It resolves
   without error and logs one line. Rationale: a step retry re-runs tools and
   must not undo a person's decision.
   In a **chat turn a person started** on the run's session the write applies
   normally: the person asked for the action ("erstelle das Angebot im ERP"),
   so the resulting status is theirs. `updated_by` records the tool or agent
   plus the acting user: `{ kind: "tool", id, user }`. (My call — it follows
   from decision 2 but was not spelled out.)
5. Write `work_status`, `work_status_updated_at = now()`,
   `work_status_updated_by = { kind: "tool", id: <tool id> }` (or
   `{ kind: "agent" }` when called through the built-in tool below).
6. Idempotent: setting the current value again is a no-op that still succeeds.

### Where the handle is built

Two entry points reach `convertExuluToolsToAiSdkTools`, and both must build the
handle:

- **Worker run** — `processUiMessagesFlow` in `ee/workers.ts` has the workflow
  row and `jobResultId`; pass them down (it already passes
  `routine: { id, name }` to `generateStream` for cost attribution).
- **Chat turn on a run session** — the chat route (`routes.ts`) loads the
  session; `isRunSessionMetadata(session.metadata)`
  (`src/exulu/routines/run-session.ts`) says it is a run and the metadata
  carries `routine_id`. Resolve the run with
  `job_results WHERE session = <session id>` (one row per run session).

Put the resolution in one helper (`resolveRoutineHandle({ sessionId, jobResultId?, toolId, actingUser?, origin: "worker" | "chat" })`)
so both paths share validation and the human-wins rule. If the run row cannot
be found (pruned by retention), `routine` is `undefined`.

## Built-in agent tool: `set_routine_status`

Injected automatically, like the other session-scoped tools, when **both** hold:
the turn has a `routine` handle and `routine.statuses.length > 0` — so it is
available in the worker's run and in a chat a person continues on that run.

- Input: `{ status: enum(<keys of routine.statuses>) }` — the enum is generated
  per turn, so the model cannot invent a value. The description lists each key
  with its label.
- Execute: `routine.runs.current.update({ status })` with
  `updated_by = { kind: "agent" }`.
- `needsApproval: false`. It changes a label on the run, nothing external.
- Result text names the label that was set, or says that a person already set
  a status and it was left unchanged.

Routine authors then steer it in the step text, e.g. "Wenn du eine Rückfrage
vorbereitet hast, setze den Status auf Rückfrage vorbereitet."

Hard facts should not depend on the model. In an offer routine, the tool that
creates the offer sets `angebot_im_erp` itself (a model can claim an action it
never performed). That is a project change, outside this spec.

## API

GraphQL, next to the existing routine-run operations in
`src/graphql/schemas/index.ts` (`cancelRoutineRun`, `retryRoutineRun`):

- `RoutineRun` gains `work_status`, `work_status_updated_at`,
  `work_status_updated_by`.
- `routineRuns(...)` filter args (`RoutineRunsFilterArgs` in
  `src/exulu/routines/runs-query.ts`) gain `workStatuses: [String!]` and
  `workStatusOpen: Boolean` (true = status is null or not flagged `done`).
- `setRoutineRunWorkStatus(id: ID!, status: String): RoutineRun` — `status:
  null` clears it. Validates against the routine's list. Writes
  `updated_by = { kind: "user", id }`. This is the manual path from the runs list.
- `work_statuses` is a normal field on the routine and is saved through the
  existing routine update mutation, with the validation above (immutable keys,
  default must exist).

**Rights:** whoever may read the routine's runs may set a run's work status.
`job_results` has no RBAC of its own; the resolvers already restrict to the
access-filtered routine ids — reuse exactly that check. Editing the status
*list* needs write access to the routine, like any other routine setting.
(Confirmed, decision 1.)

## Run creation

When a run row is created for a routine with configured statuses (email
trigger intake, cron, manual `runWorkflow`, `testFireWorkflowTrigger`), set
`work_status = default` and `updated_by = { kind: "default" }`. Filtered runs
(`state = filtered`) get no work status.

Existing runs are not backfilled; they show no badge.

## Frontend

`app/(application)/workflows/[id]/sections/runs.tsx` (runs list):

- A work-status badge per row, next to the technical state badge. Clicking it
  opens a small menu with the routine's statuses; choosing one calls
  `setRoutineRunWorkStatus`. Optimistic update, revert with a toast on error.
- Tooltip on the badge: who set it and when ("gesetzt von Erika Mustermann,
  16.11. 09:12" / "gesetzt vom Tool Generate offer XML").
- **Two areas** when the routine has statuses (decided 2026-11-16): "Offen"
  (work status null or not flagged done) on top, "Erledigt" (flagged done)
  below, collapsed by default with its count. Setting a done status moves the
  row down, setting an open one moves it back. Each area pages separately via
  `workStatusOpen: true / false`. An additional filter narrows by individual
  status.
- Routines without statuses: no badge column, no filter — unchanged.

Routine settings (a new block in `sections/basics.tsx` or its own section —
builder's call): an editable list of statuses with label, colour, a
**"Erledigt" checkbox per status** (the `done` flag — it decides which area a
run appears in; several statuses may be done, at least one should be, warn if
none is), drag to reorder, a default selector (the default may not be a done
status). The key is derived from the
label on creation, shown read-only afterwards.

All new strings in `messages/de.json` and `messages/en.json`.

## Tests

Backend (jest):

- `update`: unknown patch key throws; unknown status throws and lists the
  keys; valid status writes all three columns; human-set status is not
  overwritten by tool or agent; same value twice is a no-op; routine without
  statuses throws.
- Handle construction: `routine` is undefined for a non-run session; present
  for a worker run and for a chat turn on a run session; undefined when the
  run row was pruned.
- Human-wins applies with origin "worker" and not with origin "chat".
- `set_routine_status`: only injected when statuses exist; enum equals the
  configured keys.
- Resolver: `setRoutineRunWorkStatus` rejects a run the caller cannot read,
  rejects an unknown status, accepts null; `routineRuns` filters by
  `workStatuses` and `workStatusOpen`.
- Config validation: duplicate keys, bad key format, default not in list, an
  existing key changed → rejected.
- Run creation writes the default; filtered runs get none.

Frontend (vitest): badge renders label and colour; menu calls the mutation;
two areas only when the routine has statuses; a done status moves the row; a removed status
renders the neutral fallback.

## Decisions (Daniel, 2026-11-16)

1. Everyone who can see a routine's runs may set a run's work status, by hand
   in the runs list.
2. The agent has the same tools — including `routine` and
   `set_routine_status` — whenever the session is part of a routine run, also
   when a person opens and continues that session in the chat.
3. The runs list shows two areas, open and done; each configured status has a
   checkbox that says whether it represents "done".

## Left to the builder

- Index choice for the new filter.
- Whether the settings UI is its own section or part of "basics".
- The exact colour palette type (reuse the existing badge colour tokens).
- Migration mechanics for the new columns (the core schema's usual path).
