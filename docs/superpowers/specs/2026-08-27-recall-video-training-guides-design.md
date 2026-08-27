# Recall video link-through and Alfredo Teacher training guides

Date: 2026-08-27
Status: Design approved, not yet implemented

## Problem

Employees at ALGI record themselves running through a process on their desktop
by inviting the Recall.ai bot to a 1:1 call and narrating what they do. Today
only the transcript survives: the meeting video is recorded by Recall but the
Exulu backend never reads it, so the screen content — which is most of the
information in a process recording — is thrown away.

The goal is to turn such a recording into a training document that another
employee can follow, stored in a new "Training" knowledge base.

## Verified findings

These were confirmed against the live ALGI workspace and the code, not assumed.

**Video already exists and is already retained.** Recall enables mixed video by
default for every bot. Bot `6a2f9b4a-3708-42a0-8304-6ba5bc91aa2f` (2026-08-24,
Teams) returned:

```
recording_config: { video_mixed_mp4: {}, video_mixed_layout: "speaker_view",
                    retention: { type: "forever" } }
media_shortcuts.video_mixed: { format: "mp4", size_bytes: 140010262, status: done }
expires_at: null
```

Because the workspace was created after 2025-06-12, the default retention is
`forever`. Every recording ever made is still addressable. Storage is billed at
$0.000069 per recording-hour per hour beyond the first 7 days — small, but
unbounded and never deliberately chosen.

**The authoritative download path** is
`media_shortcuts.video_mixed.data.download_url` (confirmed in the Recording
Control and Bot Recording docs). The signed S3 URL carries
`X-Amz-Expires=21600` — six hours — so it must be resolved at point of use and
never cached.

**Three gaps block the feature:**

1. `RecallRecording.media_shortcuts` (`src/exulu/recall/client.ts:180-183`)
   declares only `transcript`. `video_mixed` arrives in the same payload and is
   discarded.
2. `transcriptionsContext` (`src/templates/contexts/transcriptions.ts:15-26`)
   has no `recall_recording_id`. The id exists only on the `transcription_jobs`
   row, which a consuming project cannot reach. Without carrying it onto the
   saved item there is no path from a transcript to its video.
3. Neither `Dockerfile.backend` nor `Dockerfile.worker` in algikiag installs
   ffmpeg.

**Audio is not needed.** `audio_mixed` is `null` on these recordings — not
enabled by default. The diarized transcript already provides the narration with
timestamps, which is what the guide needs. Enabling `audio_mixed` would add
storage cost for no gain.

**Dependency shape.** algikiag consumes `@exulu/backend` from npm at `^3.2.0`;
published latest is `3.6.0`. Backend changes reach algikiag through a release,
not a file edit.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Video access | Link-through, resolved per use | No storage cost; URL expires in 6h so caching is not an option anyway |
| Retention | `timed`, 2160 hours (90 days) | Deliberate, bounded; replaces the accidental `forever` default |
| Review gate | Draft, then human approves | An auto-published guide from a noisy recording is authoritative-looking and wrong |
| Guide visibility | Inherit from recording, widen on approval | Process recordings can incidentally expose customer or pricing detail; nothing widens without a deliberate act |
| Recording length | Design for up to 2h | Employees will record what they record |
| Sampling | Scene-gated, windowed map-reduce | Screen content is static then changes abruptly; the changes are the actions |
| Embedding UX | Modal on save | User's call, overriding a recommendation for an inline toggle |

## Sub-project A — Backend: video link-through

Ships as a `@exulu/backend` release.

### A1. Widen the recording types

`src/exulu/recall/client.ts:157-183`. Add to both `RecallRecording.media_shortcuts`
and `RecallBot.recordings[].media_shortcuts`:

```ts
video_mixed?: {
  id: string;
  format?: string | null;
  status?: { code?: string | null } | null;
  data?: { download_url?: string };
};
```

Runtime behaviour is unchanged; the field is already present in every response.

### A2. Send `recording_config` explicitly

`createBot` (`client.ts:210-229`) currently sends no `recording_config` and
relies on server-side defaults. It must now send the observed defaults verbatim
plus retention:

```ts
recording_config: {
  video_mixed_mp4: {},
  video_mixed_layout: "speaker_view",
  participant_events: {},
  meeting_metadata: {},
  retention: { type: "timed", hours: 2160 },
}
```

The Recall docs do not state whether a partial `recording_config` merges with or
replaces the defaults. Sending only `retention` would, under replace semantics,
silently disable video recording — a failure that would surface weeks later as
"the guide job can't find an MP4". Sending the full config is correct under
either semantics.

**Verification task:** after deploying, create a bot and confirm the returned
`recording_config` still contains `video_mixed_mp4` and now shows
`retention: { type: "timed", hours: 2160 }`.

**Not retroactive.** Existing recordings remain `forever`. Capping the back
catalogue is a separate one-off sweep, explicitly out of scope here.

### A3. Expose a URL resolver

A public helper on the recall service:

```ts
getRecordingVideoUrl(recordingId: string): Promise<string | null>
```

Calls `retrieveRecording` and returns
`media_shortcuts.video_mixed.data.download_url`, or `null` when the recording is
missing, expired, still processing, or has no video artifact.

Callers must not cache the result. The six-hour expiry makes resolve-at-use the
only correct pattern.

### A4. Carry the recording id onto the saved item

- Add `{ name: "recall_recording_id", type: "text" }` to `transcriptionsContext`
  (`src/templates/contexts/transcriptions.ts`).
- Populate it at finalize in `src/exulu/transcription/service.ts:338-431`, where
  the job row is turned into a knowledge item.

This is what makes link-through usable from a consuming project.

## Sub-project A2 — Backend: export a model surface

Added 2026-08-27 during planning. Not part of the original design; discovered
while writing Plan B.

**The gap.** B's pipeline makes roughly 40 vision calls per guide and has no
way to make any of them. `ExuluApp` exposes `tool()`, `agent()`, `context()`,
`embeddings`, `bullmq` and `queues()` — no model route — and `resolveModel`
(`src/exulu/resolve-model.ts:141`) is not exported. `src/index.ts` is the
package's only entry point, so nothing else is reachable. algikiag has never
hit this because it only calls `ExuluDocumentProcessor.process()`, which
resolves models internally from its own config.

**Why not just build a provider in algikiag.** It has `PROXY_BASE_URL` and
`LITELLM_MASTER_KEY` in its environment, so it could construct an
OpenAI-compatible provider directly. Rejected: `resolveModel` embeds
caller-identity tags via `getLiteLLMProvider` (`resolve-model.ts:162-172`), and
those tags are what per-team LiteLLM budgets attribute against. A pipeline
burning tokens without them is spend nobody can see — the exact blind spot the
Value Ledger work exists to close.

**The change.** A minimal namespace on `src/index.ts`:

```ts
ExuluModels.resolve({ modelId, userId? }): Promise<LanguageModel>
ExuluModels.providerOptions(model): Record<string, Record<string, string>> | undefined
```

`resolve` takes a `userId` rather than a `User` because that is what a context
processor actually receives; it loads the row the same way
`src/exulu/recall/service.ts:553` does. It returns the `LanguageModel` alone —
the `ModelRow` half of `resolveModel`'s return is synthetic
(`resolve-model.ts:175-182`) and exporting it would be surface to support for
no gain.

`providerOptions` re-exports `microCallProviderOptions`
(`ee/agentic-retrieval/pipeline/micro-call.ts:27`), which returns
`{ litellm: { reasoningEffort: "disable" } }` for Gemini models. B's map stage
is a constrained structured-output call, which is exactly the shape that
returns an empty 200 when thinking tokens eat the output budget.

Ships in the same release as A, so algikiag bumps the dependency once.

## Sub-project B — algikiag: Alfredo Teacher

### B1. Training context

New `trainingContext` in `src/contexts/context.ts`, alongside the existing
document contexts.

| Field | Type | Notes |
|---|---|---|
| `guide` | `markdown` | Human-readable user guide |
| `action_log` | `json` | `[{ t_start, t_end, action, narration, confidence }]` |
| `status` | `enum` | `draft` \| `approved` \| `failed` |
| `source_recording_item_id` | `text` | Back-link to the transcriptions item |
| `source_description` | `text` | The employee's up-front description |
| `processing_notes` | `longText` | What was skipped, budget actually used |

Configuration:

- `calculateVectors: "manual"` — **load-bearing.** A draft is written to the
  items table but never chunked or embedded, so it is physically absent from the
  chunks table and no retrieval path can reach it. This gives the review gate for
  free, with no `status = 'approved'` filter to remember at every call site.
- `defaultRightsMode: "private"` — a draft is visible only to its author.
- `embedder: { model: "gemini-embedding-001", queue: embeddingQueue }`, matching
  the existing algikiag contexts.
- `languages: ["german"]` — ALGI's content and recordings are German.

### B2. Draft to publish lifecycle

Publishing is one deliberate act performed by the `publish_training_guide` tool:

```ts
context.updateItem(
  { id, status: "approved", rights_mode, ...rbac },
  exuluConfig, user.id, user.role.id,
  /* generateEmbeddingsOverwrite */ true,
)
```

`updateItem` accepts that override (`src/exulu/context.ts:745-795`), so status,
audience and discoverability all move together. There is no window in which a
guide is approved but unsearchable, or searchable but still private.

RBAC subject ids are strings while `user.id` is a number — use the
`sameEntityId` helper rather than comparing raw ids, and always grant the
creator write access explicitly.

### B3. Pipeline

Runs in the Training context's `processor` on `processingQueue`, following the
shape of `createDocumentContext` (`src/contexts/context.ts:86-140`).

- `trigger: "onInsert"` — **not** `always`. Publishing calls `updateItem`, and an
  `always` trigger would re-run the whole pipeline on every edit.
- `timeoutInSeconds: 5400` — the existing 2400 used for PDFs is too tight for a
  2h recording.
- `generateEmbeddings: false` — drafts must not embed.

**Step 0 — Resolve.** Read `recall_recording_id` from the source transcriptions
item; call `getRecordingVideoUrl()`. On `null`, set `status: "failed"` with a
message naming the cause. RBAC on the source recording is checked in the *tool*,
before the draft exists, because that is where the calling user is known.

**Step 1 — Probe and budget.** `ffprobe` the URL for duration without
downloading. Reject over 2h with a message asking the employee to record shorter
processes. Allocate a global budget of ~600 frames across windows, weighted by
transcript density so narrated stretches get more frames than silence.

**Step 2 — Download once.** Fetch the MP4 to a temp file; delete in a `finally`.
Not streamed per-window: the job makes a dozen ffmpeg passes, re-fetching ~500 MB
each time is wasteful and the URL could expire mid-job. Requires ~500 MB of
scratch disk on the worker.

**Step 3 — Window.** Fixed ~10-minute windows; up to 12 for a 2h recording.

**Step 4 — Map.** Per window, ffmpeg selects frames at scene changes with a
minimum interval and a per-window cap, downscaled to ~1024px JPEG. Frames go to
the vision model in batches of ~12, each batch carrying frame timestamps, the
transcript slice for that window, and the employee's description as steering.
Output is structured action events.

- **Model: `vertex-gemini-2.5-flash`**, the same model the document processor
  uses. Not Gemini 3.x: thinking tokens count against `maxOutputTokens`, and a
  structured-output call under a token cap is exactly the shape that returns an
  empty 200-OK. Using 3.5-flash would require `reasoningEffort: "disable"` via
  LiteLLM.
- **Concurrency capped at 8.** The document processor uses 40, but that is a
  single-tenant burst. Sustained parallelism here risks 429 cooldowns, which in
  this stack surface as a misleading "not allowed to access model due to tags
  configuration" error rather than a rate-limit message.

**Step 5 — Reduce.** Merge action events, collapse adjacent near-duplicates, then
one call takes the description, merged log and full transcript and emits both a
chaptered markdown guide and the cleaned timestamped action log. If the merged
log exceeds one call's budget at 2h, fall back to a hierarchical reduce.

**Step 6 — Write back.** `guide`, `action_log`, `processing_notes`,
`status: "draft"`.

**Failure posture.** A failed window is recorded in `processing_notes` and the
job continues. Total failure sets `status: "failed"` with a reason.
`processing_notes` always states what was skipped and what budget was used, so a
guide never silently overstates its coverage.

**Envelope, 2h worst case — superseded by measurement.** The original estimate
(~500 frames, 15–30 minutes of wall clock) was pessimistic. Measured: decode runs
at ~60× realtime, so a 2h recording scans in ~100 s, and the chosen threshold
yields roughly 240 frames, i.e. ~20 vision calls at a batch size of 12. See
Calibration results below. Neither cost nor wall clock is a binding constraint;
the vision calls now dominate the runtime, not ffmpeg.

### B4. Tools

Registered in `src/tools/index.ts`.

| Tool | Params | Approval |
|---|---|---|
| `list_meeting_recordings` | filters | `false` |
| `create_training_guide` | `source_recording_item_id`, `description` | `true` |
| `publish_training_guide` | `item_id`, `rights_mode` (`"public"` \| `"private"`) | `true` |

`list_meeting_recordings` uses
`contexts["transcriptions"].getItems({ filters, fields, user, role })`, filtered
to items with a `recall_recording_id`, annotated with whether a guide already
exists.

`create_training_guide` verifies the caller can read the source recording,
rejects if a draft already exists for it, creates the draft, returns the job id.

**Audience is public-or-private only** (decided 2026-08-27, revising B2 above).
`handleRBACUpdate` is not exported from `@exulu/backend`, and
`context.createItem`/`updateItem` ignore RBAC entirely — there is no `rbac`
handling anywhere in `context.ts`. A consuming project can set `rights_mode`,
which is a plain column, but cannot write per-user or per-role rows. Narrower
audiences are therefore set afterwards using the existing bulk "Set access"
dialog on `/data`.

This narrows the "inherit from the recording, widen on approval" model: publish
and audience-scoping become two acts rather than one. Accepted rather than
exporting an RBAC surface, on the grounds that public-or-private covers the
common case and the `/data` dialog already exists. If role-scoped guides turn
out to matter in practice, the fix is an `ExuluRBAC` export mirroring A2.

**On "the tool asks for a description":** a tool cannot ask the user anything —
it receives arguments and runs. This is implemented as `description` being a
*required* parameter with a pointed schema description, plus an instruction in
Alfredo Teacher's system prompt, so the model must obtain it before it can call.
`needsApproval: true` reinforces it: the approval card shows the employee the
description the agent extracted, making a hallucinated one visible before
anything expensive runs.

### B5. Deploy

Add `ffmpeg` to `Dockerfile.worker`. This is a deploy change, not just code.

## Sub-project C — Embedding-on-save UX

Independent of A and B; folded into this spec at the user's request.

### C1. The problem

`UpdateOneById` accepts only `input` (`src/graphql/mutations/index.ts:554-764`).
There is no embedding parameter on any create/update mutation, and the frontend
sends none (`use-item-editor.ts:296-318`). Embedding on save is decided entirely
by `calculateVectors`.

Consequence: with `calculateVectors: "manual"`, an approver edits a published
guide, saves successfully, and the embeddings silently retain the old text.
Search returns the superseded version indefinitely, with nothing on screen
indicating staleness. This affects every manual-vectors context, not just
Training.

An escape hatch exists — Embeddings section overflow → "Generate embeddings"
(`item-embeddings-section.tsx:95-107`) → `GenerateChunks` — but it is
undiscoverable and nothing signals when it is needed.

**Relationship to sub-project B.** The publish step in B2 is unaffected: it calls
`context.updateItem(..., true)` server-side and bypasses GraphQL entirely, so it
works today for any user. C exists for what happens *after* publishing, when an
approver edits an already-approved guide through the `/data` UI. B does not
depend on C and is not blocked by it.

### C2. Thread `generateEmbeddings` through the mutations

Add an optional `generateEmbeddings: Boolean` argument to `CreateOne`,
`UpdateOne` and `UpdateOneById`, passed to `context.createItem` /
`context.updateItem` as `generateEmbeddingsOverwrite`.

The backend semantics are already tri-state (`src/exulu/context.ts:790-795`):

| Value | Behaviour |
|---|---|
| `true` | Force embedding regardless of config |
| `false` | Suppress embedding even when config says `onUpdate` |
| `undefined` | Defer to `calculateVectors` |

This maps exactly onto "modal not shown / toggle on / toggle off" with no new
logic underneath.

### C3. Modal on save

When a context has an embedder configured, saving an item opens a dialog with an
explicit on/off toggle for regenerating embeddings, defaulted from the context's
`calculateVectors`. Follow the `BulkAccessDialog` / `ConfirmDialog` pattern in
the data section.

Recorded trade-off: this places a modal on the common save path, including for
contexts configured `always` where the outcome is not actually in question. An
inline toggle plus a staleness badge was recommended and not chosen; noted here
so the decision is revisitable rather than mysterious.

### C4. Fix access control on `GenerateChunks`

`GenerateChunks`'s where-filtered branch (`src/graphql/mutations/index.ts:1095`)
applies `applyFilters` but never `applyAccessControl`. Its sibling
`DeleteChunks` does (`:1141`). Only the regenerate-everything branch is
super-admin gated.

So any authenticated user can trigger embedding regeneration against any item in
any context, including items they cannot read. Not a content leak — the response
is a count — but it lets any user burn embedding spend on the largest context and
stamp `embeddings_updated_at` on items they should not touch.

Fix: add `applyAccessControl(table, query, context.user)` to match
`DeleteChunks`.

## Sequencing

1. **Backend** (A ✅, A2 ✅, C2 ✅, C4 ✅ — all merged to develop) → release `@exulu/backend`
2. **algikiag** bumps the dependency
3. **B1 — foundations** (windowing, budget, frame selection, ffmpeg, calibration).
   Needs no release: it touches no `@exulu/backend` API.
4. **B2 — pipeline and tools** (Training context, processor, map/reduce stages,
   three tools, ffmpeg in `Dockerfile.worker`). Written *after* B1's calibration,
   so its frame budget, batch size and cost model come from measurements.
5. **Frontend modal** (C3) — independent, can land any time

B was split into B1 and B2 on 2026-08-27. Writing B2 before calibration would
mean inventing the numbers calibration exists to discover: how many scene
changes a real ALGI recording yields, whether the scene detector fires usefully
on screen content at all, and what frame width keeps UI text legible. That last
one constrains the whole cost model, since it sets tokens per frame.

A2 is a hard prerequisite for B, not a nicety: without it the pipeline cannot
call a model at all. A and A2 ship together so algikiag bumps once.

Live-bot verification of A's `recording_config` (see Open items) is still
outstanding and can invalidate A2's release timing if it fails.

## Testing

| Area | Framework | Covers |
|---|---|---|
| Backend | jest, beside `src/exulu/recall/*.test.ts` | `recording_config` payload; `getRecordingVideoUrl` including null paths; `recall_recording_id` surviving finalize; `generateEmbeddings` tri-state; `applyAccessControl` on `GenerateChunks` |
| Frontend | vitest | Modal default-state given a context's `calculateVectors` |
| algikiag | vitest (to be added) | Window splitting, transcript-density budget allocation, transcript slicing, action-log merge and dedupe — all pure, TDD-able, no ffmpeg or LLM needed |

**Not unit-testable, handled by calibration:** the scene-change threshold and
minimum frame interval cannot be derived from first principles. Scrolling and
typing over-trigger scene detection; slow fades under-trigger it. Run the
extractor against one real ALGI process recording, tune, and write the resulting
values back into this spec. Guide quality is likewise assessed by reading one
real generated guide, not by assertion.

## Out of scope

- Video playback UI in the transcriptions review sheet
- Retroactive retention capping of existing `forever` recordings
- Regenerating a guide for a recording that already has one
- Conversational refinement of a draft guide with the agent
- `audio_mixed` — not needed; the transcript carries the narration

## Calibration results (measured 2026-08-27)

Run against recording `39509d8c-74cf-4362-a546-19d53e50e773` ("KDD-Besprechung",
2026-08-24, 31.2 min, 140 MB), which carries ~30 minutes of continuous
screenshare. **ffmpeg 7.1.1**, Apple Silicon. The scene filter's behaviour
varies across major versions, so these numbers are only valid for 7.x.

| threshold | candidates | /min | after 2s spacing | /min after spacing |
|---|---|---|---|---|
| 0.10 | 131 | 4.2 | 62 | 2.0 |
| 0.20 | 53 | 1.7 | 38 | 1.2 |
| 0.30 | 38 | 1.2 | 30 | 1.0 |

**Scene detection fires usefully on ALGI screen content.** This was the
question that could have invalidated approach A; it does not.

**Chosen values: threshold `0.10`, minimum interval `2s`, frame width `1024px`.**
0.10 gives the most detail while staying inside the 1–5 candidates/min band, and
under-sampling loses steps that over-sampling merely pays a little more for.

**Decode is ~60× realtime** — 26–32 s for a 31-minute recording, so a 2-hour
recording scans in roughly 100 s. The spec previously estimated 15–30 minutes of
wall clock dominated by decode; that was pessimistic by an order of magnitude.
The 5400 s processor timeout is comfortable, not tight.

**The 600-frame budget is not binding.** 62 frames at the chosen threshold for
31 minutes extrapolates to ~240 for a 2-hour recording. Budget allocation still
matters for pathological recordings, but in the normal case every candidate that
survives spacing is analysed.

**1024px is legible.** Verified by eye on two frames: a Windows Explorer window
(folder tree, file names, dates, status bar) and an Outlook message whose German
body text reads cleanly. 1536px was extracted for comparison and is not needed.
Token cost per frame therefore stays at the low end (~1.1k), so a 2-hour guide's
map stage is on the order of 250k input tokens.

**Caveat.** This is a *meeting* recording with screenshare, not a dedicated
process walkthrough. A real process recording — one person, likely a maximised
application, deliberately clicking through steps — should produce *more* scene
changes, not fewer. If the first real process recordings come back sparse, lower
the threshold before questioning the approach.

### A rejected data point, and what it taught us

A second recording (`a2b47a5f`, 14.2 min, 2026-08-27, titled "Test") was also
calibrated and its numbers **discarded**. It returned a suspiciously flat
response — 21 frames after spacing at every threshold from 0.10 to 0.30 — which
looked like reassuring insensitivity. Sampling frames showed why: the recording
is webcam footage and the bot's own "Company Notetaker" placeholder. The bot's
`participant_events` put total screenshare at **67.5 s of 851 s — 7.9% of the
recording**. The 21 "scene changes" were camera motion and view switches, not
screen content.

Had the flat response been taken at face value it would have supported a
threshold anywhere in 0.10–0.30 on evidence that contained almost no screen.

**This produces a concrete requirement for B2: a content probe before the
pipeline commits.** A recording with no screen content must fail with a clear
message rather than spend the full budget describing somebody's face.

**Not via `screenshare_on` events.** That was the first proposal and it was
withdrawn (Daniel, 2026-08-27). The Recall docs list `screenshare_on` /
`screenshare_off` among the participant-event types and say participant events
are captured by default, but they give **no per-platform guarantee** that
screenshare transitions are emitted for Zoom, Google Meet, Webex and Teams
alike. The only platform-specific table in that documentation covers re-join
behaviour, not screenshare. Every recording in the ALGI workspace is Microsoft
Teams, so the assumption cannot be tested here either. Building the gate on it
would mean a guard that silently passes everything on some platform we have
never tried.

**Instead, measure the thing itself.** Extract four frames at 10/35/60/85% of
the duration and send them to the vision model in a single call, asking whether
they show a computer screen with an application or a person/room/placeholder.
Structured output, roughly:

```
{ has_screen_content: boolean, screen_fraction: number, note: string }
```

This is platform-independent, tests what actually matters rather than a proxy
for it, and costs about one vision call (~5k tokens) against a pipeline that
spends ~20 calls. It also catches cases an event-based check would miss: a
shared window that is itself a video call, a "screenshare" that is one static
photo, or a share so brief the events fire but nothing useful was captured.

On the rejected recording above this probe would have been unambiguous — the
sampled frames were a black "Company Notetaker" card, an out-of-focus office,
and a colleague on webcam.

If `screenshare_on` events *are* present they are free corroboration and worth
recording in `processing_notes`. Nothing may gate on them.

## Verified: `recording_config` merges, it does not replace (2026-08-27)

A2 sent the full config because the docs never said which semantics applied,
and a retention-only body would have silently disabled video recording under
replace semantics. Settled empirically after releasing 3.7.0, by creating a bot
scheduled seven days out with the exact payload `buildCreateBotPayload`
produces, reading the config Recall echoed back, then deleting it
(bot `c60ceec9-18db-4a08-a740-1ecf619b97bf`, HTTP 204).

```json
{
  "realtime_endpoints": [],
  "retention": { "type": "timed", "hours": 2160 },
  "video_mixed_layout": "speaker_view",
  "video_mixed_mp4": {},
  "participant_events": {},
  "meeting_metadata": {},
  "video_mixed_participant_video_when_screenshare": "overlap",
  "start_recording_on": "participant_join"
}
```

`video_mixed_mp4` survived and retention is the requested 2160 hours, so 3.7.0
is correct. The stronger evidence is the shape of the response: **five keys were
sent, eight came back.** `realtime_endpoints`,
`video_mixed_participant_video_when_screenshare` and `start_recording_on` are
server defaults that were never in our payload and merged in anyway. Partial
configs therefore merge — demonstrated, not inferred.

Sending the full config remains the right call. It was correct under either
semantics, and it pins the two video defaults we depend on against a future
change to Recall's own defaults.

## Open items

- Verify `GenerateChunks` access control by hand, both the denied and the
  permitted case (a fix that locks out legitimate callers passes the first
  check and fails the point)
- Re-check the threshold against the first genuine process recordings, expected
  week of 2026-08-31 — the only calibration so far is a meeting with screenshare
