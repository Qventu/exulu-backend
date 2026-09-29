# Transcripts redesign, stages 1–2: one library, one document — Design

**Date:** 2026-09-29
**Status:** Drafted (pending user review)
**Branches:** `feat/transcripts-redesign` in both repos (worktrees `../backend-transcripts-redesign`, `../frontend-transcripts-redesign`)
**Related:**
- Designer deliverable: `Projects/exulu/redesigns/Transcripts Redesign.pdf` (9 artboards) and `.html`
- Developer handoff: `Projects/exulu/redesigns/Transcripts redesign — developer handoff.md` (2026-09-29)
- Design brief the mockups were built from: Claude Doc "Transcripts Design Brief" (2026-09-24)
- Current page doc: `frontend/design/pages/transcriptions.md` (June 2026 redesign — queue mechanics)
- `docs/superpowers/specs/2026-05-28-transcription-feature-design.md` (the upload pipeline)
- `docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md` (meeting bot, post-processing)
- `docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md` (record mode — already shipped)
- `src/exulu/markdown-export.ts` + `src/exulu/routes.ts:2351` (the pandoc/LibreOffice export helper this reuses)

## Summary

Transcripts today is a job queue: three status groups, a review sheet, and a separate library at
`/data/transcriptions`. The redesign turns it into a document library — every recording is something you
read, correct, ask about and export. The handoff sequences that into four stages; **this spec covers
stages 1 and 2**:

1. **Stage 1 — the library.** One home list across jobs and saved transcripts, one composer dialog for all
   three sources, a reading-view page with summary and chapters, an "ask about this transcript" box with an
   agent picker, and the Transcripts/Transkripte vocabulary change.
2. **Stage 2 — the document.** Segment-level correction, find-and-replace, the review page with its
   checklist and speakers panel, and the five export formats.

Stage 3 (admin Transcript settings, summaries for uploads, workspace defaults) and stage 4 (speaker
suggestions and merge, usage breakdown, reminders, highlight actions, calendar scheduling) follow with
their own specs.

**Reuse first.** Record mode is already built and only gets re-housed. The export route reuses the pandoc
helper that landed in `cdbdeca`. The merged home needs no new resolver — `transcriptions_itemsPagination`
already exists generically. Summaries reuse `post_processing_outputs`. Ask reuses `session_items` pinning.
Bulk actions reuse `/data`'s action bar and `itemsBulkUpdateRBAC`. **No new tables** — five denormalised
columns and one corrections column on two existing tables.

## Decisions (from brainstorming, 2026-09-29)

| Topic | Decision |
|---|---|
| Scope | Stages 1 and 2 of the handoff's release order. Settings, speaker suggestions, usage and nudges are out. |
| Data spine | **Items-first (option A).** Home unions the existing jobs pagination (in-progress, creator-only) with `transcriptions_itemsPagination` (Ready, RBAC'd). Reading view and post-save correction are item-backed; pre-save review stays job-backed. Rejected: RBAC on `transcription_jobs` (a second rights store that can drift from the item's, and it forfeits reuse of the export route and retrieval), and a bespoke merged resolver (duplicates the generic pagination surface and still has to do the same union internally). |
| Review surface | **A full page**, per the mockups, with the right-hand speakers panel and pinned player. The reading view is the same component in read mode, so one component serves both screens. |
| Corrections | `raw_segments` stays the untouched engine output; a sibling `corrected_segments` json holds edits. Renderers prefer corrected, fall back to raw. Rejected: a `transcript_segments` table (a row per segment for a document that is always read whole), and editing `raw_segments` in place (loses the ability to reset and to re-run diarization). |
| Summaries and chapters | **No structured model in stage 1.** Reuse `post_processing_outputs`; render them as markdown into the reading view's Summary / Action items / Chapters slots. Action-item checkboxes are read-only markdown; interactive state is stage 4. |
| Passage references | **No backend model.** `renderTranscript` gains a `withTimestamps` option so post-processing prompts can cite `[mm:ss]`; a frontend linkifier turns those into seeks. |
| Export | **One new route** that builds the markdown per request and reuses `exportMarkdown()`. Not the generic field route: the Include options mean nothing can be stored, and csv/srt fall out of the same builder. |
| Agent access rule | **Already true, verified** (§5). No work needed. |
| Teams sharing | Stays hidden. The backend still does not store it (`ALLOWED_MODES` in `review-sheet.tsx` / `composer.tsx`). |
| Destructive actions | Discard, delete and reset-to-original confirm through the shared `ConfirmDialog`. |

## 1. Architecture

### 1.1 The two stores

| Store | Rights | Holds | Who reads it |
|---|---|---|---|
| `transcription_jobs` | **Creator-only** — `assertOwnsTranscriptionJob` (`src/exulu/transcription/authorize.ts`): super-admin, `rights_mode = public`, or `created_by` | pipeline state, `raw_segments`, audio/video keys, bot status, post-processing | the recorder, while the recording is in flight |
| `transcriptions_items` | **RBAC'd** per user/role via `applyAccessControl` | the document: `transcript_text`, `raw_segments`, `speakers`, `post_processing`, audio/video keys | everyone it is shared with, plus agent retrieval |

The redesign's merged home is a union of the two, not a migration of one into the other. A job that has been
saved contributes nothing to the list — its content is the item. That is what makes the union duplicate-free
and what makes "Shared with me" work without any new rights plumbing.

### 1.2 Routes

| Route | Backed by | Purpose |
|---|---|---|
| `/transcriptions` | both | home |
| `/transcriptions?new=1` | — | composer dialog (keeps today's `?new=1` deep-link convention, `navigation.md` §4) |
| `/transcriptions/review/<jobId>` | job | first review, before save |
| `/transcriptions/<itemId>` | item | reading view |
| `/transcriptions/<itemId>?edit=1` | item | correct text and speakers after save |

`review` is a static segment, so a job id and an item id can never be confused by the router
(`app/(application)/transcriptions/review/[jobId]/page.tsx` beats `[itemId]/page.tsx`).

Saving a first review redirects `review/<jobId>` → `<itemId>`. The old `?review=<jobId>` query parameter
redirects to `/transcriptions/review/<jobId>` on mount so existing links and bookmarks keep working.

## 2. Data model

No new tables. Two existing tables gain columns, both through idempotent blocks in
`src/postgres/init-exulu-db.ts` — **context tables are create-if-absent only**, `addMissingFields` never runs
for an existing context, so the `post_processing` migration at `init-exulu-db.ts:267` is the precedent to
follow.

### 2.1 `transcriptions_items` — five denormalised columns (stage 1)

Added to `transcriptionsContext.fields` in `src/templates/contexts/transcriptions.ts` **and** to the
migration block. New installs get them from the field definition; existing databases get them from the
migration.

| Field | Type | Why |
|---|---|---|
| `source` | text | row meta ("Upload · / Teams · / Recorded on phone ·") and the Source filter |
| `job_id` | uuid | back-link to the pipeline row (audio, video, re-review) |
| `recorded_at` | date | when it *happened*, so This week / Earlier groups correctly — `updatedAt` moves on every correction |
| `speaker_count` | number | "5 people" / "3 speakers" without parsing `raw_segments` per row |
| `project_id` | uuid | row meta and the Project filter. Denormalised: `projects.project_items` stays the source of truth for membership; this column is a read-side copy written at finalize and on Move to project |

`buildTranscriptItemInput` (`src/exulu/transcription/build-transcript-item.ts`) fills all five from the job
row. `speaker_count` is the count of distinct labels in `raw_segments`; `recorded_at` is `join_at` for
meeting jobs, otherwise the job's `createdAt`.

**Backfill.** The same migration block backfills existing rows by joining `transcription_jobs` on
`saved_item_id`. Idempotent: `WHERE transcriptions_items.source IS NULL`.

### 2.2 `corrected_segments` (stage 2)

One `json` column on **both** `transcription_jobs` (`core-schema.ts`, picked up by `addMissingFields`, which
*does* run for core tables) and `transcriptions_items` (context field + migration block). Null means
"never corrected".

Shape is the existing `RawSegment[]`: `{ start, end, text, speaker }`. Corrections only ever change `text`;
start/end/speaker stay, which is what makes "Timestamps stay in place" true and lets the audio ribbon and
seek logic run unchanged.

**Effective segments** is a single pure helper used everywhere a transcript is rendered:

```ts
// src/exulu/transcription/transcript-text.ts
export const effectiveSegments = (
  raw: RawSegment[] | null,
  corrected: RawSegment[] | null,
): RawSegment[] => corrected ?? raw ?? [];
```

Reset-to-original is `corrected_segments = null`.

### 2.3 What changes on save

`transcriptionService.finalize` (`src/exulu/transcription/service.ts`) renders `transcript_text` from
`effectiveSegments`, not from `raw_segments`. Because the transcriptions context is configured
`calculateVectors: "onInsert"`, the upsert re-embeds the corrected text automatically — no extra call.

Post-save correction takes a different path: the item is updated through the generic
`transcriptions_itemsUpdateOneById` mutation (`UPDATE_ITEM(context)` in `data/queries.ts`), which is already
gated by `validateWriteAccess` (`src/graphql/mutations/index.ts:222`). So "the owner and people with edit
rights may correct" needs **no new authorisation code** — it is the platform's existing item write rule.
This is why correction had to be item-backed: the job row's `assertOwnsTranscriptionJob` would have limited
it to the recorder.

## 3. Backend

### 3.1 Timestamped transcript rendering (stage 1)

`renderTranscript(segments, speakers)` gains an options argument:

```ts
renderTranscript(segments, speakers, { timestamps: true })
// → "Anja Keller [21:18]: Then let's fix the dates now…"
```

Default stays off, so `finalize`'s `transcript_text` is unchanged. `_runOnePrompt`
(`src/exulu/recall/service.ts:~600`) switches to `{ timestamps: true }` so a summary prompt can cite
`[mm:ss]`. Existing post-processing outputs are unaffected; new runs may contain timestamps, and the reading
view linkifies them whether they are there or not.

### 3.2 Export route (stage 2)

```
GET /transcription-items/:itemId/export
      ?format=md|docx|pdf|csv|srt
      &summary=1&timestamps=1&speakers=1     (all default on)
```

Lives in `src/exulu/routes.ts` next to the existing field-export route. Access follows the same pattern:
`context.getItems({ filters: [{ id: { eq } }], user, role })` — 404 when the user cannot read it.

Pipeline:

1. Load the item (`transcript_text`, `raw_segments`, `corrected_segments`, `speakers`, `post_processing`,
   `name`, `recorded_at`, `duration_seconds`, `source`).
2. `buildTranscriptMarkdown(item, options)` — a new pure module,
   `src/exulu/transcription/transcript-export.ts`: title, metadata line, summary and action items from
   `post_processing` when `summary=1`, then one paragraph per block as `**Speaker** [mm:ss]` + text.
3. `md` → send as `text/markdown`. `docx` / `pdf` → `exportMarkdown(markdown, format)` from
   `src/exulu/markdown-export.ts`, unchanged.
4. `csv` → `buildTranscriptCsv` — UTF-8, header row `start,end,speaker,text`, `hh:mm:ss` times, RFC-4180
   quoting.
5. `srt` → `buildTranscriptSrt` — one cue per segment, `hh:mm:ss,mmm` times.

All five read `effectiveSegments`, satisfying "exports use the corrected text, not the raw engine output".
With `speakers=0` the labels fall back to the raw `SPEAKER_NN`; with `timestamps=0` the `[mm:ss]` marker and
the csv `start`/`end` columns are omitted.

`ExportFormat` in `src/exulu/markdown-export.ts` widens from `"docx" | "pdf"` to include `"md" | "csv" |
"srt"`; `exportContentType` gains the three cases (`text/markdown`, `text/csv`, `application/x-subrip`) and
`exportMarkdown` keeps rejecting anything but docx/pdf — the new formats never reach it. Filenames reuse
`exportFilename(item.name, "transcript", format)` unchanged.

### 3.3 Nothing else

No new resolvers, no new mutations, no changes to the whisper, Recall or live-recording pipelines. Post-
processing for uploads is stage 3.

## 4. Frontend

Feature module `app/(application)/transcriptions/`, following `design/codebase-structure.md` §1.1: thin
pages, a `hooks.ts` that owns fetch policy, a `queries.ts` that owns the GraphQL, pure helpers in `types.ts`.

### 4.1 Home (stage 1)

`page.tsx` is rewritten. `useTranscriptionJobs` becomes `useTranscripts`, running two queries:

- **jobs** — today's `GET_TRANSCRIPTION_JOBS` with `ACTIVE_STATUSES`, unchanged, still polling at 5 s only
  while something is in motion.
- **items** — `GET_ITEMS("transcriptions", [...])` from `app/(application)/data/queries.ts`, which builds
  `transcriptions_itemsPagination(page, limit, filters: [FilterTranscriptions_items], sort)`. Sorted
  `recorded_at DESC`.

A pure `mergeTranscriptRows(jobs, items)` in `types.ts` maps both onto one `TranscriptRow` view type
(`kind: "job" | "item"`, title, state, summary line, meta line, access, primary action) and groups by
`recorded_at` into This week / Earlier. This is the piece that gets unit tests.

| Surface | Source |
|---|---|
| "N in progress" collapsed row, failed jobs with a recovery action | jobs (`recording`, `queued`, `transcribing`, `failed`) |
| Needs review tab and amber count | jobs (`awaiting_review`) |
| All / Mine / Shared with me, search, Source / Project / Date filters | items |
| Rows grouped This week / Earlier | both, merged |

**The People filter is deferred.** The design's Filter button offers Source, Project, Date and People, but
speaker names live in an unstructured `speakers` json map, so a People filter would be a `LIKE` over json
that silently misses renames. Stage 1 ships Source, Project and Date; People arrives with the speaker work
in stage 4. `speaker_count` still feeds the "5 people" row meta.

`findRecoveredJob` (the 2026-09-22 "4 recordings reported lost" fix) keeps working **against jobs, not
items**: a failed meeting job and the retry that recovered it are both creator-only rows, and only the
creator ever sees the failed one. When the merged list contains failed meeting jobs, the hook fires one
extra targeted query for `status: saved` jobs whose `meeting_url` is in that set, and feeds those to the
existing helper unchanged. No sixth column, no join.

Selection and the dark bulk bar reuse `data/[ctx]/components/items-action-bar.tsx` and
`bulk-access-dialog.tsx`, and the existing `itemsBulkUpdateRBAC` mutation (no re-embed, atomic). Bulk delete
reuses the items delete mutation. Bulk actions apply to item rows only; job rows render their checkbox
disabled with a tooltip.

`/data/transcriptions` is **not** removed — it is the generic knowledge view and stays reachable. The
"Open in library" links move into the reading view's "…" menu.

### 4.2 Composer (stage 1)

A new `components/new-transcript-dialog.tsx` (680 px `Dialog`) hosts the three existing composers
(`composer.tsx`, `meeting-composer.tsx`, `record-composer.tsx`) behind a three-way source switch. The
composers themselves change only where the dialog owns chrome they used to own (their own Cancel/footer).

Two behaviour changes:

- **Unconfigured sources stay visible.** Today `enabledModes` filters them out; now a disabled entry renders
  with "Not set up in this workspace yet. An admin can connect it in Transcript settings." plus an "Ask an
  admin" link. `showModeToggle` and the mobile-first ordering are kept.
- **One options summary row.** Project, sharing, summary presets and (for uploads) language and speaker
  count collapse into `<button aria-expanded>` showing the current values in one line, per the handoff's
  disclosure rule.

An active recording still pins the surface (`recordingActive` → `effectiveMode = "record"`, switch hidden) —
the close-out logic in `use-live-recorder` is untouched.

### 4.3 Reading view (stage 1)

`app/(application)/transcriptions/[itemId]/page.tsx` + `components/transcript-document.tsx`, the component
the review page also uses.

- **Header** — title, Share, Export ▾, "…" (Correct text and speakers → `?edit=1`, Move to project, Open in
  library, Delete). Meta line plus the access pill; the pill's popover reuses `ItemAccessSection` from
  `data/[ctx]/components/`.
- **Left** — chapters with timestamps, parsed from a `post_processing` output whose markdown has a
  `## Chapters` heading. Absent → the column collapses.
- **Centre** — Summary, Action items, Transcript. Summary and action items are `post_processing` outputs
  rendered as markdown; a `linkifyTimestamps` helper converts `[mm:ss]` / `mm:ss` into buttons that seek the
  player. Transcript blocks reuse the existing merge-consecutive-speakers logic and `speakerColor`.
- **Right** — the meeting video (`MeetingVideoPlayer`, unchanged) with its deletion date, then the ask box.

Audio and video play from the item's `audio_s3key` / `video_s3key`, so `AudioTimeline` works unchanged.

**Ask about this transcript.** The agent chip opens a picker listing agents with Transcriptions in their
retrieval config first ("Can search Transcriptions"), then the rest ("Gets this transcript attached to the
chat"). Send navigates to
`/chat/<agentId>?items=transcriptions/<itemId>&q=<question>`. Chat's composer already reads `searchParams`
(`promptId`, `composer.tsx:272`); this adds `items` (seeding `controller.sessionItems`, the same gid format
`agent_sessions.session_items` already stores) and `q` (seeding the textarea without sending). The last-used
agent is remembered in `localStorage`. Two suggested questions fill the input and do not send.

### 4.4 Review page (stage 2)

`app/(application)/transcriptions/review/[jobId]/page.tsx`, rendering `transcript-document.tsx` in edit
mode. `review-sheet.tsx` is deleted; its parts are reused:

| Kept from `review-sheet.tsx` | Where it goes |
|---|---|
| `TranscriptBlock` merge logic, `activeIndex`, `scrollToTime` | `transcript-document.tsx` |
| speakers state + `parseSpeakers` | the speakers panel |
| `AudioTimeline` + ribbon | pinned footer |
| `RBACControl` in a collapsible | the access row |
| `PostProcessingResults` (run / re-run / in-flight claim handling) | the summary row's "Re-run summary" |
| `onSave` → `FINALIZE_TRANSCRIPTION_JOB`, discard → `CANCEL_TRANSCRIPTION_JOB` | unchanged |

New:

- **Inline correction.** A block becomes a textarea on click; blur commits to local state. Saving writes
  `corrected_segments` — in job mode through `TranscriptionJobFinalizeInput` (one new optional field), in
  item mode (`<itemId>?edit=1`) through the generic item update mutation.
- **Find and replace.** Behind a button: find, replace, match count, Replace all. Pure function over the
  segment array; replaced words render green until save. The "remembered for the project" vocabulary list is
  **stage 4** — the control ships without it.
- **Status button / checklist.** Pure derivation from local state (title set, speakers named, summary
  present, sharing chosen). Nothing on it blocks saving.
- **Speakers panel.** One row per speaker, one open at a time: name input, "Hear" (seeks the player to that
  speaker's first block and plays ~4 s), talk share (share of total segment duration). Suggestions from
  earlier transcripts and Merge are **stage 4**.
- **Shortcuts** behind a "?" button: Esc play/pause, ⌘← −5 s, ⌘→ +5 s, ⌘F find.

### 4.5 Export menu (stage 2)

`components/export-menu.tsx`: Copy text plus five downloads and the three Include toggles (all default on,
persisted in `localStorage`). Each download hits the route in §3.2 via `window.location.href` so the browser
handles the attachment. Copy text fetches `format=md` and writes the response to the clipboard — one
builder, on the server, so the clipboard and the `.md` file can never diverge.

### 4.6 Vocabulary (stage 1)

`messages/en.json` and `de.json`: "Transcripts" / "Transkripte" in navigation, page title and library;
"the IMP" or "the agent" instead of a product brand; default bot name "IMP Notetaker". The knowledge base
keeps its name, "Transcriptions", because agents are already attached to it. The seven job states get the
German labels from the handoff's table.

## 5. Access model

**Verified 2026-09-29.** The handoff lists "agents use a transcript only for people who can see it" as a
pre-build assumption. It already holds: `vectorSearch` applies
`applyAccessControl(table, query, user, "items")` on both the full-text and semantic paths
(`src/graphql/resolvers/vector-search.ts:214`, `:465`, `:486`), and the agentic retrieval pipeline threads
the chatting user and role through (`ee/agentic-retrieval/pipeline/search.ts` → `context.search` →
`vectorSearch`). The session-items tool does the same
(`src/templates/tools/session-items-retrieval-tool.ts`).

**Caveat to carry into the UI copy:** this holds when the agent runs *on behalf of a user*. A caller that
passes no user skips access control entirely (`ExuluContext.getItems`: "When no `user` is passed, behavior
is unchanged"). An unattended routine summarising transcripts would therefore see everything. Stage 1 does
not add such a path; the "3 agents can search this" pill should say "when they answer someone who can see
it", not "never otherwise".

| Layer | Set where | Values |
|---|---|---|
| People | composer options, review access row, reading-view Share | private (default), users, roles, public. **Teams stays hidden.** |
| Storage | automatic on save | item in `transcriptions` with the same rights |
| Agents | the agent's retrieval config (stage 3 surfaces it in Transcript settings) | search; write is the summariser's KB-write tool |
| Project | options row, Move to project | project rules apply on top of the item's own |

## 6. Error handling

- **Export** — pandoc/LibreOffice failures return 500 with `{ detail: "Export failed." }` and log, matching
  the existing route. The menu shows a destructive toast and stays open.
- **Correction save conflict** — `transcriptions_itemsUpdateOneById` has no optimistic concurrency, so two
  people correcting the same transcript is last-write-wins. The review page refetches on window focus and,
  if `updatedAt` moved since load, warns "Someone else corrected this transcript. Reload to see their
  changes." before saving, rather than silently overwriting. A version column is not worth it for a surface
  this rarely contended.
- **Union list partial failure** — if the items query fails the jobs half still renders, with an inline
  error row for the missing half, and vice versa. A transcripts page that shows nothing because one of two
  queries failed is worse than a half list.
- **Missing item for a saved job** — a job with `status = saved` but a deleted item renders in the
  in-progress strip as a failed row with "The saved transcript was deleted" and a Dismiss action, instead of
  disappearing from both halves of the union.

## 7. Testing

Backend (jest):

- `transcript-text.test.ts` — `effectiveSegments` precedence and null handling; `renderTranscript` with and
  without timestamps.
- `transcript-export.test.ts` (new) — markdown structure, the three Include toggles, csv quoting and
  `hh:mm:ss` times, srt cue numbering and `,mmm` times, corrected text winning over raw.
- `build-transcript-item.test.ts` — the five new fields, including `recorded_at` from `join_at` vs
  `createdAt` and `speaker_count` from distinct labels.
- `service.test.ts` — finalize renders from `effectiveSegments`.
- Migration: the backfill SQL is idempotent (runs twice, same result) and only touches `source IS NULL`.

Frontend (vitest, node-only — there are no component tests in this repo):

- `types.test.ts` — `mergeTranscriptRows` (duplicate-free union, grouping boundary, tab filters), the
  find-and-replace pure function, `linkifyTimestamps`.
- Manual verification for every screen, on desktop and a phone.

**Known baselines — do not mistake these for regressions.** Backend: 9 tsc errors, 4 failing jest suites,
156 lint findings (one parse error per test file, by config). Frontend: 1 failing vitest
(`nav-config agents:read`) and a pre-existing eslint error in `data/components/entity-types.tsx`.

## 8. Release order and deploy notes

1. **Backend first, both stages.** The frontend degrades without it (no export route → hide the menu; no
   new columns → rows lose their meta line), so deploy backend then frontend, as with live recording.
2. Stage 1 and stage 2 are separately shippable. Stage 1 touches no schema except §2.1; stage 2 adds §2.2.
3. No new environment variables.
4. Where a stage-3/4 backend piece is missing, the control is **hidden, not disabled** — per the handoff.
   That applies to: speaker suggestions, Merge, the project vocabulary list, the "Never reviewed" nudge, and
   Transcript settings (the "…" menu entry appears only once stage 3 lands).

## 9. Out of scope

Stage 3 — admin Transcript settings, post-processing for uploads, workspace defaults for sharing and summary
presets, video retention configuration, per-deployment bot name and notice (still env vars).
Stage 4 — speaker suggestions and label merge, the **People filter** on home (§4.1), per-user and
per-project usage, unreviewed reminders, highlight actions (Add note, Turn into task), calendar scheduling,
interactive action-item checkboxes, the project vocabulary list.
Unchanged by this spec — the transcription engines, diarization, the Recall integration, chat dictation, the
training-guide flow, live transcripts across devices, and teams sharing.

**Still needs a number before stage 3:** storage cost per video hour from the Recall.ai contract, to replace
the handoff's `[RATE × hours]` placeholder.
