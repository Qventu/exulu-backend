# Routines release page — prose sections (non-video)

Research doc for the page writer. Every fact below was verified in the frontend code
(paths relative to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`); every
quoted string is verbatim from `messages/en.json` (the `"routines"` block) or from
hardcoded component copy. Route: `/workflows` (nav label "Routines").

Brand/format reference: `releases/2026-07-08-routines/hyperframes-design.md` and the
prose-section pattern in `releases/2026-07-08-platform-roundup/index.html`
(kicker → h2 → one-liner → 2–3 paragraphs → optional labelled snippet).

---

## Section 1 — One list, every routine's pulse

**Suggested one-liner:** Name, last run, next run — the whole automation estate in one table.

The new `/workflows` index is a real operations view, not a bare list. The page header
reads "Routines" — "Saved conversations that run on demand or on a schedule." — with a
debounced "Search routines…" box and a live count ("3 routines"). Each row shows four
columns: **Name** (with description and a visibility chip), **Last run**, **Schedule**,
and an inline **Run** button. The list re-polls every 30 seconds (`LIST_POLL_MS = 30_000`
in `app/(application)/workflows/hooks.ts`), and all per-row data is resolved by batched
page-level lookups — the redesign explicitly killed the old per-row query storm.

Status is a colored dot that stays quiet until it isn't: completed runs get a green dot
with a relative timestamp, failures a red one, and a currently **active** run gets a blue
dot that gently pulses (`motion-safe:animate-pulse` — it respects reduced-motion). A
routine that has never run shows a muted dot labelled "Never run". The Schedule column is
a monospace cron chip (e.g. `0 9 * * 1-5`) whose tooltip shows "Next run" plus the
relative time; unscheduled routines show an em dash. The visibility chip appears only
when a routine isn't private: "Public" with a globe, "Users ({count})", or
"Roles ({count})" — private stays unmarked, because private is the default, not a badge.

The inline Run button fires from the row without leaving the page; when it can't run it
says why in a tooltip — "No agent attached" or "You don't have permission to run this
routine". And notably there is **no create button** here: routines are created
exclusively from chat. The empty state says it outright: "No routines yet" — "Save any
chat conversation as a routine to run it again — on demand or on a schedule." with an
"Open chat" link.

Files: `app/(application)/workflows/routines-client.tsx`, `components/routine-list.tsx`,
`components/routine-row.tsx`, `components/cron-chip.tsx`, `components/visibility-chip.tsx`,
`hooks.ts`, `components/primitives/status-dot.tsx`.

---

## Section 2 — Run it now, or queue it — the dialog tells you which

**Suggested one-liner:** One form, honest about what happens when you press the button.

Pressing Run opens a single dialog titled "Run {name}". Directly under the title, one
quiet line tells you exactly what will happen: "Runs immediately" (lightning icon) when
the agent has no queue, or "Queued on {queue}" (clock icon) when the run will be enqueued
on the agent's queue. The submit button matches: "Run now" vs "Queue routine" (and
"Starting…" while in flight). Even the success toast is honest — "Routine queued" vs
"Routine run started" — replacing the legacy toast that claimed completion before a
queued run had even started.

Every `{variable}` in the routine's steps becomes a labelled form field with a required
asterisk, a placeholder like "Enter company name…", and inline validation ("Required") —
no toast-only errors. Routines without inputs state it plainly: "No input variables
required for this routine."

The same dialog powers failure recovery. In the workbench's Runs section, every expanded
run has a "Retry with edits" button that reopens this dialog with the fields **pre-filled
from that run's recorded `metadata.inputs`** — fix the one bad value and re-run, instead
of retyping everything (`[id]/sections/runs.tsx`, `handleRetry`).

Under the hood it is one GraphQL mutation — the same call any authenticated client can
make against the API (`app/(application)/workflows/queries.ts`):

```graphql
mutation RunWorkflow($id: ID!, $variables: JSON!) {
  runWorkflow(id: $id, variables: $variables) { result job metadata }
}
```

Files: `components/run-routine-dialog.tsx`, `queries.ts` (RUN_WORKFLOW),
`[id]/sections/runs.tsx`.

---

## Section 3 — The routine workbench: one page, seven rungs

**Suggested one-liner:** Everything about a routine — settings, steps, schedule, history,
queue — on a single scrollable page.

Clicking a routine opens `/workflows/[id]`, a full workbench that replaced the old
edit dialog. A sticky section nav (scroll-spy driven) walks a fixed ladder — verbatim
section labels: "Basics", "Access", "Steps", "Schedule", "Runs", "Queue", "Danger zone"
(`ROUTINE_SECTION_IDS` in `[id]/components/routine-workbench.tsx`). The header carries a
breadcrumb back to Routines, the agent it "Uses", the visibility chip, a primary Run
button, and a "Copy routine ID" overflow action. Edits to Basics and Access ride a
page-level save bar ("Unsaved changes to this routine") with an unsaved-changes guard
that intercepts navigation.

Scheduling is built in: pick from seven cron presets ("Every day at 00:00", "Weekdays at
09:00", "Every 15 minutes", "Monthly on 1st at 09:00", …) or write a custom expression
with inline validation ("Invalid CRON expression. Format: minute hour day month weekday").
An existing cron that matches a preset reopens on the preset — the round-trip is
prefilled, not forgotten (`cron-presets.ts`, `matchPreset()`). Saving fires
`upsertWorkflowSchedule(workflow, schedule)`; "Remove schedule" deletes only the cron,
with the confirm copy spelling it out: "The routine stays — only the automatic schedule
is removed."

Runs is a forensic history, not a link list: the last 50 runs expand **in place** with a
state badge, timestamp, full error block, a key/value metadata table, a "Show raw
payload" JSON toggle, and the "Retry with edits" button. The Danger zone appears only for
users who can actually delete, and deleting is type-to-confirm: "This permanently deletes
the routine. To confirm, type its name".

Files: `[id]/components/routine-workbench.tsx`, `[id]/components/routine-header.tsx`,
`[id]/sections/{basics,access,steps,schedule,runs,queue,danger}.tsx`, `cron-presets.ts`,
`queries.ts` (UPSERT_WORKFLOW_SCHEDULE, DELETE_WORKFLOW_SCHEDULE).

---

## Section 4 — Edit steps like the conversation they are

**Suggested one-liner:** A routine's steps are chat messages — so the editor is a chat.

From the Steps section, "Edit steps" opens a wide right-side sheet titled "Edit
conversation steps" — "Add or remove steps. Use {variable_name} syntax to create reusable
variables." The steps render as a real conversation: your user messages are editable and
removable bubbles, and between them sit assistant placeholders that read "Placeholder —
the agent's generated response will appear here when the routine runs." — marked with a
primary-tinted left border and no action row, so it's unmistakable which turns you wrote
and which turns the agent will fill in at run time. Removing a user message removes its
paired placeholder automatically.

The composer at the bottom works like chat too: "Add user message", placeholder "Type the
user's message…", and "Press Enter to add, Shift+Enter for a new line. You can attach
files." Attachments go through the platform's Uppy file picker (up to 10 files per
message; images, PDFs, Office documents, CSVs, audio, and video), with a heads-up shown
under selected files: "Make sure the selected agent supports these file types (images,
documents, audio)."

The sheet owns its own save bar ("Unsaved step changes") independent of the page-level
form, and closing with pending edits is gated by a confirm — "Discard step changes?" —
"Your changes to this routine's steps will be lost. This does not affect anything that
has already been saved." Saving persists only `steps_json` (plus the routine's agent), so
a half-finished rename elsewhere on the page can't leak through.

Files: `[id]/components/steps-editor-sheet.tsx`, `[id]/sections/steps.tsx`,
`components/message-renderer.tsx`, `components/primitives/file-picker.tsx`.

---

## Section 5 — The queue, without leaving the routine

**Suggested one-liner:** Pause, inspect, and retry queued runs from a sheet on the
routine itself.

When a routine's agent runs on a queue, the workbench's Queue section names it and offers
"Manage queue" (and states the alternative honestly: "No queue configured for this
routine's agent."). The button opens a right-side sheet titled "Queue: {name}" hosting
the platform's shared `QueuePanel`, scoped to exactly that agent queue — the same
oversight surface used elsewhere in Exulu, so nothing here is a one-off.

Inside: jobs grouped by state tab (active, waiting, completed, failed, delayed, paused),
queue-level pause and resume with confirms, and per-job retry with a "Delete original
after retrying" option. Retry here is routine-aware — each job row is labelled
"Routine run: {workflow}", and retrying re-fires the `runWorkflow` mutation with the
job's **original recorded inputs** (`job.data.workflow` + `job.data.inputs`), so a failed
scheduled run is re-executed with the exact variables it had. If a job's payload lost its
routine reference, the panel says so instead of guessing: "Cannot retry — original
routine reference missing".

Files: `[id]/sections/queue.tsx`, `[id]/components/routine-workbench.tsx` (queue Sheet +
retryJob wiring), `components/primitives/queue-panel.tsx`.

---

## EXCLUDED — not shipped or not verifiable (do not use on the page)

- **Team-based visibility/sharing chips** — gated behind
  `ROUTINES_RBAC_TEAMS_SUPPORTED = false` (`schema-flags.ts`); the "Teams ({count})"
  chip and team sharing summaries never render today.
- **Status filtering on the index toolbar** — `ROUTINES_STATUS_FILTER_SUPPORTED = false`;
  the toolbar is search-only. Don't claim "filter by run status".
- **Sorting by last run** — `ROUTINES_LAST_RUN_SORT_SUPPORTED = false`; the Last Run
  column deliberately has no sort affordance.
- **"Real-time"/"live-streaming" run status on the index** — softened to "re-polls every
  30 seconds". The routine list itself polls (`pollInterval: LIST_POLL_MS`), but the
  per-row last-run and schedule lookups are cache-first batches keyed to the visible page
  (`useLastRunForPage`, `useSchedulesForPage`), not a live feed. The pulsing dot for an
  active run IS verified.
- **"Ghosted"/faded styling on assistant placeholders** — the actual treatment is a
  primary-tinted left border (`border-l-2 border-primary/30`) with the message action row
  suppressed; there is no opacity/dimming class. Described accurately in Section 4.
- **Embedded `lastRun`/`schedule` fields on the list query** —
  `ROUTINES_LAST_RUN_EMBEDDED_SUPPORTED` and `ROUTINES_SCHEDULE_EMBEDDED_SUPPORTED` are
  both `false`; the chips are fed by the batched fallback path. Don't describe the
  GraphQL list response as carrying these fields.
- **Cron preset i18n** — preset labels ("Every day at 00:00", …) are hardcoded in
  `cron-presets.ts`, English-only by design ("i18n integration is a follow-up"). Fine to
  quote, but don't claim localized presets.
- **Duration column / run duration** — the runs list shows state + relative time; a
  duration value only appears "if available" per the code comment and no duration field
  is selected in `GET_JOB_RESULTS_LIGHT`. Don't promise run durations.
