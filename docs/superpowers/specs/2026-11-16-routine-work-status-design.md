# Routine work status — design

Date: 2026-11-16
Status: draft, agreed in conversation with Daniel Claessen; not yet planned or built
Repos: `exulu/backend` (schema, API, tool context, built-in tool), `exulu/frontend` (runs list, routine settings)

## Why

ALGI's Kundendienst uses the routine runs list as an inbox: a mail arrives, the
"Ersatzteil Angebot" routine runs, the row says "Abgeschlossen". That state is
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
- **`routine` is `undefined` outside a routine run** (a normal chat turn, MCP,
  the direct agent API). When it is set, `runs.current` always exists, so a
  tool needs exactly one `?.`.

### Behaviour of `update`

1. Reject unknown patch keys (throw, naming the allowed keys).
2. `status`: must be a key in `routine.statuses`; otherwise throw with the list
   of allowed keys. When the routine has no statuses configured, throw
   "this routine has no work statuses configured" — a tool that sets a status
   on an unconfigured routine is a setup mistake that should be visible in the
   run, not swallowed. (Builder: the offer-XML tool should therefore guard with
   `routine?.statuses.some(s => s.key === …)` or catch; the spec for that tool
   change lives in the ALGI project.)
3. All-or-nothing: validate every field before writing any.
4. **Human wins.** When `work_status_updated_by.kind === "user"`, an `update`
   coming from a tool or the agent does not change the status. It resolves
   without error and logs one line. Rationale: a routine step retry re-runs
   tools.
5. Write `work_status`, `work_status_updated_at = now()`,
   `work_status_updated_by = { kind: "tool", id: <tool id> }` (or
   `{ kind: "agent" }` when called through the built-in tool below).
6. Idempotent: setting the current value again is a no-op that still succeeds.

### Where the handle is built

The worker knows the run: `processUiMessagesFlow` in `ee/workers.ts` has the
workflow row and `jobResultId`, and passes `routine: { id, name }` to
`generateStream` for cost attribution already. Thread the job result id
alongside it down to `convertExuluToolsToAiSdkTools`, build the handle there
once per turn (one read of the routine's `work_statuses` and the run's current
status), and add it to the object passed to `execute`.

Do not derive the run from the session alone: a session can be continued by a
person in the chat UI after the run finished. See open question 2.

## Built-in agent tool: `set_routine_status`

Injected automatically, like the other session-scoped tools, when **both** hold:
the turn has a `routine` handle and `routine.statuses.length > 0`.

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

Hard facts should not depend on the model. For ALGI, the offer-XML tool sets
`angebot_im_erp` itself (a real run showed the agent claiming an XML it never
generated). That is a project change, outside this spec.

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
  `updated_by = { kind: "user", id }`.
- `work_statuses` is a normal field on the routine and is saved through the
  existing routine update mutation, with the validation above (immutable keys,
  default must exist).

**Rights:** whoever may read the routine's runs may set a run's work status.
`job_results` has no RBAC of its own; the resolvers already restrict to the
access-filtered routine ids — reuse exactly that check. Editing the status
*list* needs write access to the routine, like any other routine setting.
(This is my call: the people working the inbox are usually not the routine's
editors. Flagged as open question 1.)

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
- Tooltip on the badge: who set it and when ("gesetzt von Laura Büttner,
  16.11. 09:12" / "gesetzt vom Tool Generate offer XML").
- A filter for work status. When the routine has statuses, the list opens with
  "open" preselected (everything not flagged `done`); a visible chip shows the
  filter is on and clears it.
- Routines without statuses: no badge column, no filter — unchanged.

Routine settings (a new block in `sections/basics.tsx` or its own section —
builder's call): an editable list of statuses with label, colour, a "counts as
done" switch, drag to reorder, a default selector. The key is derived from the
label on creation, shown read-only afterwards.

All new strings in `messages/de.json` and `messages/en.json`.

## Tests

Backend (jest):

- `update`: unknown patch key throws; unknown status throws and lists the
  keys; valid status writes all three columns; human-set status is not
  overwritten by tool or agent; same value twice is a no-op; routine without
  statuses throws.
- Handle construction: `routine` is undefined for a non-routine turn; present
  with `runs.current` for a routine turn.
- `set_routine_status`: only injected when statuses exist; enum equals the
  configured keys.
- Resolver: `setRoutineRunWorkStatus` rejects a run the caller cannot read,
  rejects an unknown status, accepts null; `routineRuns` filters by
  `workStatuses` and `workStatusOpen`.
- Config validation: duplicate keys, bad key format, default not in list, an
  existing key changed → rejected.
- Run creation writes the default; filtered runs get none.

Frontend (vitest): badge renders label and colour; menu calls the mutation;
"open" preselected only when the routine has statuses; a removed status
renders the neutral fallback.

## Open questions for Daniel

1. **Who may set a run's status** — everyone who can see the runs (assumed
   here), or only people with write access to the routine?
2. **Continued sessions.** When a person continues a routine run's session in
   the chat and the agent calls a tool there, should `routine` still be set
   (so the XML tool can still flip the status on a corrected offer), or only
   during the worker's run? Assumed here: only during the worker's run; the
   person sets the status by hand afterwards. ALGI's "erstelle das Angebot im
   ERP" follow-ups in the chat argue for the former.
3. **Default view.** Is "open only" the right default for the runs list when
   statuses exist, or should it stay "all" with one click to "open"?

## Left to the builder

- Index choice for the new filter.
- Whether the settings UI is its own section or part of "basics".
- The exact colour palette type (reuse the existing badge colour tokens).
- Migration mechanics for the new columns (the core schema's usual path).
