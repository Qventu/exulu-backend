# Live recording on the Transcripts page — Design

**Date:** 2026-09-23
**Status:** Drafted (pending user review)
**Related:**
- `2026-05-28-transcription-feature-design.md` (the `transcription_jobs` pipeline, review sheet, `finalize()`)
- `2026-06-19-recall-meeting-recording-design.md` (second `source`, post-processing prompts)
- `2026-08-03-gemini-chat-transcription-design.md` (Gemini `input_audio` path in `transcribe.ts`)
- `2026-05-24-speech-to-text-transcription-design.md` (composer mic + `/transcribe`)

## Summary

A customer wants to put a phone on the meeting table, press **Record**, and get a
transcript. Today the Transcripts page (`/transcriptions`) creates transcripts two ways —
upload an audio file (Whisper server) or send a Recall.ai bot to a meeting — and both
converge on one `transcription_jobs` row that reaches `awaiting_review`, is reviewed in
the same sheet, and is saved by the same `transcriptionService.finalize()`.

This design adds a third composer mode, **Record on this device**. The browser records
the microphone, cuts the audio into self-contained chunks at silence boundaries every
30–60 s, and POSTs each chunk to a new backend route that transcribes it through the
existing `transcribeAudio()` (Gemini chat `input_audio` for Vertex Gemini models,
`/audio/transcriptions` for everything else) and appends the text to the job's
`raw_segments`. The chunk response *is* the interim transcript: the device that records
is the device that shows the running text, so no WebSocket/SSE infrastructure is needed.
When the user stops, the full recording (kept in memory by a second, continuous
`MediaRecorder`) is uploaded to S3 through the existing Uppy path, the row flips to
`awaiting_review`, post-processing prompts run, and everything downstream is unchanged.

**Zero new environment variables.** The mode is gated on the same flags as the composer
mic (`EXULU_USE_LITELLM=true` and `TRANSCRIPTION_MODEL`).

## Decisions (from brainstorming, 2026-09-23)

| Topic | Decision |
|---|---|
| Transcription engine | Chunked batch through the existing `transcribeAudio()`. Rejected: true realtime streaming (Gemini Live / Google STT v2 — no LiteLLM support, needs a WebSocket relay, no spend tracking) and record-then-upload-to-Whisper (no interim text, loses everything if the browser dies, needs `TRANSCRIPTION_SERVER`). |
| Interim delivery | Each chunk POST returns its text; the recording tab renders it. Other tabs/devices see progress through the existing 5 s queue poll. |
| Full audio | **Kept.** A continuous master `MediaRecorder` holds the whole recording in memory and uploads it at stop (Uppy → S3 → `audio_s3key`) so the review sheet's audio timeline works. If the browser dies mid-recording the transcript survives server-side; the audio does not. |
| Diarization | **None in v1.** Every segment gets `speaker: "unknown"`, which already triggers the review sheet's diarization-off notice and single rename input. A later "re-transcribe with speakers" action can feed the uploaded audio through the Whisper `startJob()` when a whisper server exists. |
| Post-processing prompts | **Yes.** The record composer offers the same `{prompt, agent}` picker as the meeting composer; `recallService.runPostProcessing()` is generic on the job id and is reused as-is. |
| Spend attribution / caps | Chunk calls carry LiteLLM `metadata.tags` built with `buildTags()` (user, project) like `resolve-ocr.ts`. Live recordings do **not** count against `TOTAL_MAX_RECORDINGS_DURATION_PER_MONTH` (that counter is `source='recall'` only and stays so). |
| Interrupted / abandoned recordings | **No server sweep.** A row left in `recording` shows a **Finish** action (flips to `awaiting_review` with whatever transcript exists, no audio) and **Discard**. The client auto-stops after 4 h. |
| Chunk boundaries | Silence-aligned cuts (min 20 s, max 60 s) plus a prior-text hint to Gemini for continuity. |
| Data model | Extend `transcription_jobs` (new `source='live'`, new status `recording`, two columns). No new table. |
| Transport for chunks | REST multipart (mirrors `/transcribe`), not GraphQL — the backend has no GraphQL upload scalar and the existing audio path is REST. |

## 1. Architecture

```
┌──────────────────────────── Browser (/transcriptions, mode "record") ────────────────────────────┐
│ getUserMedia ──► MediaStream ──┬──► segment MediaRecorder (restarted at silence, 20–60 s)         │
│                                │        └─► chunk queue (seq, blob, offset, duration) ──┐        │
│                                ├──► master MediaRecorder (continuous, in memory) ──┐     │        │
│                                └──► AnalyserNode (level meter + silence detector)  │     │        │
│ Wake Lock (screen) · timer · live transcript panel · Stop                          │     │        │
└────────────────────────────────────────────────────────────────────────────────────┼─────┼────────┘
                                   at stop: Uppy → S3 (audio_s3key)                 │     │ sequential, retried
                                                                                     ▼     ▼
┌──────────────────────────── @exulu/backend ──────────────────────────────────────────────────────┐
│ GraphQL  liveRecordingStart(input) ─► transcription_jobs row {source:'live', status:'recording'}   │
│ REST     POST /transcription-jobs/:id/chunks ─► transcribeAudio(chunk, priorText, tags)           │
│              └─► CAS append to raw_segments, chunk_count = seq+1, duration_seconds, last_chunk_at │
│              └─► 200 { seq, text, chunk_count }                                                   │
│ GraphQL  liveRecordingStop(id, {audio_s3key, duration_seconds}) ─► status 'awaiting_review'       │
│              └─► runPostProcessing(id) (fire-and-forget, as Recall does)                          │
│ unchanged: review sheet → transcriptionJobFinalize → transcriptions context item                  │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Invariants**

- The `transcription_jobs` row is the source of truth for the transcript from the first
  chunk on. A dead browser never loses text that was acknowledged.
- The Whisper polling loop (`status='transcribing' AND whisper_job_id IS NOT NULL`) and the
  Recall reconcile sweep (`source='recall'`) never touch `live` rows.
- `finalize()` is untouched; it already refuses anything but `awaiting_review`/`saved`, so a
  `recording` row cannot be saved early.
- The chunk route is the only writer of `raw_segments` while `status='recording'`, and it
  writes with a compare-and-swap on `chunk_count` (see §3.3), so retries and duplicates are
  idempotent.

## 2. Data model

Additive changes to `transcriptionJobsSchema` in `src/postgres/core-schema.ts`.
`addMissingFields` migrates existing databases on boot — no hand-written migration.

| Column | Type | Notes |
|---|---|---|
| `chunk_count` | number, default `0` | Next expected `seq`. CAS target for the chunk route. |
| `last_chunk_at` | date | Heartbeat; shown in the row ("last audio 2 min ago") and useful for support. |

New values on existing columns:

- `source`: `'live'` (alongside `'whisper'`, `'recall'`).
- `status`: `'recording'` — the client is actively streaming chunks. Lifecycle:
  `recording → awaiting_review → saved`, plus `cancelled` (Discard) and `failed`
  (only if `liveRecordingStart` itself fails, e.g. feature disabled mid-flight).
- `raw_segments`: one `RawSegment` per chunk, `{ start, end, text, speaker: "unknown" }`,
  `start`/`end` in seconds from the recording's origin (`offset_ms/1000`,
  `(offset_ms+duration_ms)/1000`). Silent chunks are stored with `text: ""` so the array
  index always equals `seq`; `renderTranscript()` already skips empty text.
- `duration_seconds`: updated on every chunk to `(offset_ms+duration_ms)/1000`, then set
  from the client's authoritative total at stop.
- `audio_s3key`: `null` while recording; set by `liveRecordingStop` (or stays `null` after
  **Finish** on an abandoned row).
- `post_processing_prompts` / `post_processing_outputs`: same shapes as Recall.

`JobStatus` in `src/exulu/transcription/service.ts` gains `"recording"`; `JobRow` gains
`chunk_count`, `last_chunk_at`, `source`.

No change to the `transcriptions` ExuluContext: `audio`, `raw_segments`, `speakers`,
`duration_seconds`, `post_processing` all exist and `buildTranscriptItemInput()` already
carries them.

## 3. Backend

### 3.1 Feature gate

`liveRecordingEnabled()` = `isLiteLLMEnabled() && !!process.env.TRANSCRIPTION_MODEL` — the
composer-mic gate, reused. Mutations throw
`LIVE_RECORDING_DISABLED: Speech-to-text is not enabled on this deployment. Set EXULU_USE_LITELLM=true and TRANSCRIPTION_MODEL.`;
the chunk route returns 503 with the same message (mirrors `/transcribe`).

`GET /config` (the live one at `routes.ts:557`, **not** the shadowed duplicate near line 3171)
gains `whisper: { enabled: transcriptionClient.isConfigured() }`. This fixes a pre-existing
gating bug on the page (see §4.1): the *upload* mode is currently shown whenever the
composer-mic flag is on, even when no Whisper server exists.

### 3.2 GraphQL (`src/graphql/schemas/index.ts`)

```graphql
input LiveRecordingStartInput {
  title: String
  language: String                      # stored for the record; the Gemini path ignores hints
  project_id: ID
  target_rights_mode: String
  target_rbac_users: [RBACUserInput!]
  target_rbac_roles: [RBACRoleInput!]
  post_processing_prompts: [PostProcessingPromptInput!]
}

input LiveRecordingStopInput {
  audio_s3key: String                   # null when finishing an abandoned row
  duration_seconds: Float               # client-side authoritative total; null → keep server value
}

extend type Mutation {
  liveRecordingStart(input: LiveRecordingStartInput!): transcription_job
  liveRecordingStop(id: ID!, input: LiveRecordingStopInput): transcription_job
}
```

Resolvers follow `meetingBotStart` / `transcriptionJobCancel` exactly: authentication,
feature gate, `assertOwnsTranscriptionJob` for `stop`. **Discard** reuses
`transcriptionJobCancel` (its `cancelJob()` already tolerates a null `whisper_job_id`).

`assertOwnsTranscriptionJob` is currently a closure inside the schema builder. Extract it to
`src/exulu/transcription/authorize.ts` as `assertOwnsTranscriptionJob(db, user, id)` so the
REST chunk route and the resolvers share one implementation (same super-admin / public /
string-compared-creator rules, same error text).

### 3.3 Live recording service (`src/exulu/transcription/live-recording.ts`, new)

Kept out of `service.ts` (already ~500 lines). Exports `liveRecordingService`:

- `start({ userId, title, language, project_id, target_rights_mode, target_rbac_users, target_rbac_roles, post_processing_prompts })`
  → inserts `{ source: 'live', status: 'recording', chunk_count: 0, raw_segments: '[]', rights_mode: 'private', created_by: userId, ... }`
  with the same JSON-stringify / empty-prompts-to-NULL normalisation as
  `recallService.createMeetingBot`. Returns the row. No single-active-recording
  constraint server-side: two devices may record two rows concurrently; each row is
  independent.

- `appendChunk({ id, seq, text, offsetMs, durationMs })` → **one** compare-and-swap UPDATE:

  ```sql
  UPDATE transcription_jobs
     SET raw_segments     = COALESCE(raw_segments, '[]'::jsonb) || $segment::jsonb,
         chunk_count      = $seq + 1,
         duration_seconds = GREATEST(COALESCE(duration_seconds, 0), $end_seconds),
         last_chunk_at    = now(),
         "updatedAt"      = now()
   WHERE id = $id AND status = 'recording' AND chunk_count = $seq
  ```

  - 1 row updated → `{ kind: "appended" }`.
  - 0 rows: re-read the row. `status !== 'recording'` → `{ kind: "not_recording" }` (route
    → 409). `chunk_count > seq` → `{ kind: "duplicate", text: raw_segments[seq].text }`
    (route → 200 with the stored text; a retried chunk never appends twice).
    `chunk_count < seq` → `{ kind: "out_of_order" }` (route → 409; the client queue is
    sequential so this only happens if a client bug skips a seq).

  `raw_segments` is `jsonb` (`map-types.ts` maps `json` → `t.jsonb`), so the `||` append is
  atomic and needs no row lock.

- `stop(id, { audio_s3key, duration_seconds })` → requires `status='recording'`, sets
  `status: 'awaiting_review'`, `audio_s3key` (if given), `duration_seconds` (if given),
  `updatedAt`. Then `void recallService.runPostProcessing(id).catch(log)` — fire-and-forget
  like `_onTranscriptDone`. If the row has zero non-empty segments it still moves to
  `awaiting_review` (the user can discard from the sheet); it is not auto-failed.

`transcriptionService.cancelJob` is unchanged and handles `recording` rows (Discard).

### 3.4 Chunk route (`src/exulu/routes.ts`)

`POST /transcription-jobs/:id/chunks` — multipart, registered next to `/transcribe` and
reusing its `transcribeUpload` multer instance (memory storage, `MAX_TRANSCRIBE_BYTES` =
25 MB; a 60 s Opus chunk is well under 1 MB).

| Field | Type | Validation |
|---|---|---|
| `file` | audio blob | mimetype must start with `audio/` (same rule as `/transcribe`) |
| `seq` | int ≥ 0 | required |
| `offset_ms` | int ≥ 0 | required; chunk start relative to recording origin |
| `duration_ms` | int > 0 | required |
| `skipped` | `"true"` | optional; the client gave up on this chunk — append an empty placeholder without transcribing |

Handler order (same shape as `/transcribe`):

1. Feature gate → 503.
2. `requestValidators.authenticate` → 401.
3. `assertOwnsTranscriptionJob(db, user, id)` → 403.
4. Read the row once (`status`, `raw_segments`, `project_id`); `status !== 'recording'` → 409.
5. Field validation → 400. `skipped=true` short-circuits to step 9 with `text: ""` and no
   file required (see §4.4 for when the client sends a skip).
6. `waitForLiteLLMReady()` raced against 5 s → 503.
7. Build the prior-text hint: last ≤ 300 characters of the most recent non-empty segment's
   text from the row read in step 4.
8. `transcribeAudio({ file, priorText, tags })` where `tags = buildTags({ user_id, user_name, project_id })`.
9. `liveRecordingService.appendChunk(...)` → map result to 200 `{ seq, text, chunk_count }`
   / 409.
10. `TranscriptionError` → upstream status (5xx → 502), else 500 — identical to `/transcribe`.

A chunk whose transcription fails is **not** recorded server-side; the client retries the
same `seq` (or sends a skip for it), so the CAS sequence never has holes.

### 3.5 `transcribe.ts` changes

`TranscribeArgs` gains two optional fields; the `/transcribe` route passes neither, so the
composer mic is byte-for-byte unchanged.

- `priorText?: string` — on the Gemini chat path the user text becomes:
  *"Transcribe this audio. It is one part of a longer recording. The previous part ended with:
  «…». Continue from there — do not repeat that text, do not summarise, do not add speaker
  labels."* The system prompt is unchanged (never translate, output only the transcript).
  On the `/audio/transcriptions` path `priorText` is passed as Whisper's `prompt` form field
  (the OpenAI-compatible hint parameter), which is what it exists for.
- `tags?: string[]` — on the chat path sent as `metadata: { tags }` (the same mechanism
  `resolve-ocr.ts` uses); on the audio path ignored (unchanged behaviour).

**Verify-first before implementation (plan step 0):** run the prior-text prompt against the
newlkiag `gemini-transcribe` config with two consecutive real chunks and confirm Gemini
neither repeats the hint nor drops the first words of the new chunk. If it misbehaves, the
fallback is to drop the hint (boundary quality then rests on silence-aligned cuts alone).
The 2026-08-03 spec used the same verify-first pattern for `webm` support.

### 3.6 Startup log

One line in `ExuluApp.create()` next to the existing transcription summary:
`[EXULU] Live recording (Transcripts page): enabled|disabled (TRANSCRIPTION_MODEL …)`.

## 4. Frontend

### 4.1 Feature flags and gating

Three independent flags now drive the page; each mode is gated by its own:

| Mode | Flag | Source |
|---|---|---|
| Upload a file | `config.whisper.enabled` (**new**) | backend `/config` → `TRANSCRIPTION_SERVER` |
| Invite a meeting bot | `config.recall.enabled` | backend `/config` (unchanged) |
| Record on this device | `config.transcription.enabled` | frontend env (unchanged: `TRANSCRIPTION_MODEL` + `EXULU_USE_LITELLM`) |

Touch points: `lib/api/config.ts` (`BackendConfigType.whisper`), `components/shell/config-context.tsx`,
`lib/route-guard.tsx` (read `whisper` from the backend JSON like `recall`),
`components/shell/nav-config.ts` `flagEnabled("transcriptions")` → any of the three,
`lib/demo/config.ts` (`whisper.enabled: false`, `transcription.enabled` stays `false` — the
demo has no `/transcribe`).

Behaviour change to call out in the release notes: a deployment with `TRANSCRIPTION_MODEL`
but **no** Whisper server loses the upload mode it could never use and gains the record
mode.

### 4.2 Page (`app/(application)/transcriptions/page.tsx`)

- `composerMode: "audio" | "meeting" | "record"`. The `ToggleGroup` renders one item per
  enabled mode and is shown when two or more are enabled.
- Default mode: `record` when `useIsMobile()` and it is enabled (the phone-on-the-table job
  should be one tap), otherwise the first enabled of `audio`, `meeting`, `record`.
- `recording` rows are grouped under **Processing**; `hasRunning` in `hooks.ts` includes
  `recording` so a second tab keeps polling while a phone records.
- Labels (both locales): rename `composer.modeMeeting` from "Record a meeting" /
  "Meeting aufnehmen" to **"Invite a meeting bot"** / "Meeting-Bot einladen" — it would
  otherwise collide with the new **"Record on this device"** / "Auf diesem Gerät aufnehmen".
  `composer.modeAudio` becomes "Upload a file" / "Datei hochladen".

### 4.3 Record composer (`components/record-composer.tsx`, new) and `components/live-recording-provider.tsx` (new)

Same props as `MeetingComposer` (`onCancel`, `onStarted`). Two phases in one component:

**Setup** (mirrors the meeting composer's layout): title, collapsible Options with project,
sharing (`RBACControl`), language (stored only), and the post-processing picker. The
picker is **extracted** from `meeting-composer.tsx` (lines ~320–390) into
`components/post-processing-picker.tsx` and used by both composers — no behavioural
change for the meeting composer. Primary action: a large **Start recording** button
(`size="lg"`, full-width below `md`). On click: `liveRecordingStart` → job id → recorder
`start(jobId)`. Microphone permission is requested *before* the mutation so a denied
permission never creates a row; error toasts reuse the `chat.composer.mic*` strings.

**Recording surface** (replaces the setup card in place; full-height on mobile):

```
┌────────────────────────────────────────────┐
│ ● Recording   00:42:17         [ Stop ]    │  ← pulsing StatusDot, mono timer
│ ▂▃▅▇▅▃▂ level meter                        │
│ ⓘ Keep this screen on. Recording pauses    │
│   if the phone locks.                      │
│ ─────────────────────────────────────────  │
│ live transcript, auto-scrolling, one       │
│ paragraph per chunk; the newest chunk      │
│ shows a subtle "transcribing…" shimmer     │
│ until its text arrives                     │
│ ─────────────────────────────────────────  │
│ 14 parts sent · 1 pending                  │  ← queue status; turns amber when
└────────────────────────────────────────────┘     retries are in progress
```

**Stop** confirms (`ConfirmDialog`), then: stop both recorders → drain the chunk queue
(progress: "sending last parts 2/3") → upload the master blob via a dedicated
`useUppy` instance (`id: "transcriptions-record"`, `allowedFileTypes: [".webm", ".mp4", ".m4a", ".ogg"]`,
`maxNumberOfFiles: 1`; the shared `AUDIO_FILE_TYPES` constant is **not** widened because it
documents what the Whisper pipeline accepts) → `liveRecordingStop({ audio_s3key, duration_seconds })`
→ toast "Recording finished — review it below" → `onStarted()` (closes the composer, refetches).
If the audio upload fails after retries, `liveRecordingStop` is still called with
`audio_s3key: null` and a warning toast says the transcript was kept but the audio was not.

A `beforeunload` handler warns on tab close / reload while recording. In-app navigation
must **not** end the recording: the recorder state lives in a `LiveRecordingProvider`
mounted in `app/(application)/layout.tsx` (see §4.4), so leaving `/transcriptions` keeps
both recorders and the queue alive. While a recording is active the shell shows a small
"● Recording 12:34" pill (mobile topbar and sidebar header) that links back to
`/transcriptions`, where the page reopens the recording surface automatically because the
provider reports an active job.

### 4.4 Recorder hook (`app/(application)/transcriptions/hooks/use-live-recorder.ts`, new)

Owns all media state; the composer only renders. The hook is instantiated **once** in
`components/live-recording-provider.tsx` (mounted in the application layout) and exposed
through `useLiveRecording()`; this is what lets a recording survive navigation (§4.3).
A single active recording per browser tab; a second Start while one is active is refused
with a toast. Public surface:

```ts
type LiveRecorder = {
  state: "idle" | "starting" | "recording" | "stopping" | "interrupted";
  elapsedMs: number;            // from the recording origin
  level: number;                // 0..1 RMS for the meter
  chunks: Array<{ seq: number; text: string | null; status: "pending" | "sent" | "retrying" }>;
  start(jobId: string): Promise<void>;
  stop(): Promise<{ blob: Blob | null; mimeType: string; durationMs: number }>;
  discard(): void;              // stop everything, drop blobs, no upload
};
```

Internals:

- **Stream:** `getUserMedia({ audio: true })` (same constraints as the composer mic; tuning
  `noiseSuppression`/`autoGainControl` for far-field pickup is a follow-up, not v1).
- **MIME:** first of `audio/webm;codecs=opus`, `audio/mp4`, browser default that
  `MediaRecorder.isTypeSupported` accepts; `audioBitsPerSecond: 64_000`. Chunk blobs are
  re-wrapped as `new Blob([b], { type: mimeType })` so the `audio/*` check on the server
  always passes (Chrome sometimes reports `video/webm` on raw blobs).
- **Segment recorder:** cut rule evaluated every 100 ms from an `AnalyserNode` RMS: after
  `MIN_CHUNK_MS = 20_000`, cut at the first ≥ 500 ms window under the silence threshold
  (−50 dBFS, adaptive to the running noise floor); cut unconditionally at
  `MAX_CHUNK_MS = 60_000`. A cut **starts the next recorder first, then stops the current
  one**, so boundaries overlap by a few ms instead of gapping. Each stopped blob is enqueued
  with `seq`, `offsetMs` (from the origin), `durationMs`.
- **Master recorder:** `start(60_000)` timeslice on the same stream; blobs accumulate in
  memory and are joined into one `Blob` at stop (timeslice blobs of one recorder concatenate
  into a valid file; independent recorder outputs do not, which is why two recorders exist).
  Memory at 64 kbps ≈ 29 MB per hour.
- **Queue:** strictly sequential; one in-flight POST; a chunk is never skipped past, so
  the server's `chunk_count` sequence never has holes. Retry policy by failure class:
  network errors, 429, 502/503/504 and other 5xx → exponential backoff 1 s → 30 s,
  **retried indefinitely** (the blob stays in memory; interim text simply stalls until the
  outage ends). Deterministic rejections (400, 413, 415) → the chunk is unrecoverable, so
  the client immediately POSTs the same `seq` with `skipped=true` and moves on; the audio
  is still in the master recording. 409 `not_recording` (row was finished/discarded from
  another device) aborts the recording with a toast; 409 `out_of_order` is a client bug
  and is surfaced as an error toast.
- **Wake lock:** `navigator.wakeLock?.request("screen")` on start, re-requested on
  `visibilitychange` → visible, released on stop. Unsupported browsers just show the notice.
- **Interruptions:** on `MediaRecorder.onerror`, a track `ended` event, or the
  `AudioContext` reporting `interrupted` (iOS during calls/Siri), the hook enters
  `interrupted`, tries once to re-acquire the stream and restart both recorders (the master
  blob list keeps growing, so the final file has a gap but stays valid), and if that fails
  behaves as **Stop** with whatever was captured.
- **Auto-stop:** `MAX_RECORDING_MS = 4 h` → behaves as Stop with a toast.

**Verify-first before implementation (plan step 0):** on iOS Safari (Safari tab and the
installed PWA) confirm that two `MediaRecorder`s on one `MediaStream` both produce playable
output and that stop/start cycling the segment recorder works for 10+ cycles. Fallback if a
browser refuses two recorders on one stream: `stream.clone()` and give each recorder its
own clone.

### 4.5 Queue and sheet

- `types.ts`: `JobStatus` + `"recording"`; `ACTIVE_STATUSES` + `"recording"`; `Job` +
  `chunk_count`, `last_chunk_at`; `isLiveJob(job) = job.source === "live"`;
  `hasPostProcessing(job)` = prompts or outputs non-empty.
- `queries.ts`: `TRANSCRIPTION_JOB_FIELDS` + `chunk_count last_chunk_at`; new
  `LIVE_RECORDING_START`, `LIVE_RECORDING_STOP` documents.
- `job-row.tsx`: `recording` → pulsing `StatusDot`, status line
  "Recording · 42:17 · 14 parts · last audio 1 min ago" (`duration_seconds`, `chunk_count`,
  `last_chunk_at` via `RelativeTime`), a `Mic` source icon, actions **Finish**
  (`liveRecordingStop` with `audio_s3key: null`, confirm) and **Discard**
  (`transcriptionJobCancel`, confirm). The row for the job *this tab* is recording (matched
  by the provider's `jobId`) hides Finish/Discard — the recording surface owns those
  controls — and shows "recording on this device" instead.
- `review-sheet.tsx`: post-processing cards render when `hasPostProcessing(job)` (today:
  `isMeetingJob`), and a neutral `review.noAudio` string replaces `review.meetingNoAudio`
  for live jobs without audio. Nothing else changes: the audio timeline, speakers strip,
  transcript blocks, and Save all work from `audio_s3key` + `raw_segments`.
- `hooks.ts`: `hasRunning` includes `recording`.

### 4.6 i18n

New keys under `transcriptions.composer.*` (mode labels, `startRecording`, `stopRecording`,
`keepScreenOn`, `partsSent`, `partsPending`, `sendingLastParts`, `confirmStop.*`),
`transcriptions.row.*` (`recording`, `parts`, `lastAudio`, `finish`), `transcriptions.review.noAudio`,
`transcriptions.toasts.*` (`recordingStarted`, `recordingFinished`, `recordingInterrupted`,
`audioUploadFailedKeptTranscript`, `recordingStartFailed`). Both `messages/en.json` and
`messages/de.json`, per `I18N_GUIDE.md`.

## 5. Error handling

| Failure | Where | User sees |
|---|---|---|
| STT flag off | resolver / route gate | `LIVE_RECORDING_DISABLED` / 503; mode is hidden anyway |
| Mic permission denied / no device / insecure context | hook, before the mutation | existing `chat.composer.mic*` toasts; no row created |
| Chunk fails transiently (network, 429, 5xx) | queue | chunk marked "retrying", amber queue status; recording continues; text for that part arrives when the outage ends |
| Chunk rejected deterministically (400/413/415) | queue | skip marker sent, empty placeholder stored; toast "part N could not be transcribed"; recording continues |
| Offline at Stop | composer stop flow | "Sending last parts…" keeps retrying with a visible count; **Discard** remains available; nothing is finalised until the queue drains |
| Row finished/discarded from another device (409 `not_recording`) | route → hook | recording stops, toast, composer closes |
| Screen locks / app backgrounded (iOS) | hook `interrupted` path | one re-acquire attempt, else the recording ends with what was captured; notice explains it |
| Browser/tab dies | — | row stays `recording`; the queue row offers **Finish** / **Discard**; transcript up to the last acknowledged chunk is intact, audio is lost |
| Master audio upload fails | composer stop flow | `liveRecordingStop` with `audio_s3key: null`; warning toast; sheet shows "no audio" |
| `runPostProcessing` crashes after stop | fire-and-forget | never-ran prompts appear as **Run** cards in the sheet (existing Recall-recovery UI); the Recall reconcile sweep does **not** cover `live` rows by design |
| 4 h reached | hook | auto-stop + toast |

## 6. Testing

**Backend (jest)**

- `live-recording.test.ts`: `start` row shape (source/status/chunk_count/prompt
  normalisation); `appendChunk` in-order append, duplicate seq returns stored text without
  appending, out-of-order → `out_of_order`, non-recording status → `not_recording`,
  `duration_seconds` monotonic; `stop` transitions, keeps server duration when input is
  null, refuses non-recording rows, triggers `runPostProcessing` (mocked).
- `transcribe.test.ts` additions: `priorText` lands in the chat user text and in the audio
  path's `prompt` field; `tags` land in `metadata.tags` on the chat path only; both absent →
  request bodies identical to today's (regression lock for the composer mic).
- `authorize.test.ts`: the extracted `assertOwnsTranscriptionJob` (creator / super-admin /
  public / stranger).
- Route test for `/transcription-jobs/:id/chunks` if a `/transcribe` route test exists;
  otherwise covered by the service tests plus a manual smoke.

**Frontend**

- `use-live-recorder.test.ts` with mocked `MediaRecorder`/`AnalyserNode`: silence cut after
  `MIN_CHUNK_MS`, forced cut at `MAX_CHUNK_MS`, sequential queue with retry and backoff,
  `stop()` drains the queue before resolving, `discard()` uploads nothing.
- `record-composer` component test: Start requests mic before calling the mutation; Stop →
  upload → stop mutation order; upload failure still calls stop with `null`.
- `job-row` snapshot for the `recording` status line and actions.

**Manual / verify-first (plan step 0, before any product code)**

1. iOS Safari + Chrome Android: two recorders on one stream, 10+ segment restarts, wake
   lock holds, screen-lock behaviour observed and documented.
2. Gemini prior-text hint on two consecutive real chunks (newlkiag `gemini-transcribe`).
3. A 20-minute real recording end-to-end: interim text cadence, boundary word loss, spend
   visible under the user's tags in LiteLLM, review + save produces a `transcriptions`
   item with playable audio.

## 7. Configuration summary

No new variables. Existing ones that matter:

| Var | Effect on this feature |
|---|---|
| `EXULU_USE_LITELLM=true` + `TRANSCRIPTION_MODEL` | enables the mode (same as the composer mic) |
| `TRANSCRIPTION_SERVER` | now also gates the *upload* mode via `/config.whisper.enabled` |
| `LITELLM_*` | as today |

## Out of scope (future)

- Resuming a recording from another device or after a reload (v1: Finish / Discard only).
- Speaker diarization for recorded meetings (Whisper re-run of the uploaded audio when a
  whisper server exists; needs `.webm`/`.mp4` accepted by that pipeline).
- Server-side stale sweep for abandoned `recording` rows.
- Far-field microphone tuning (`noiseSuppression`, `autoGainControl`) and gain control UI.
- True realtime streaming (sub-second interim text).
- Counting live recordings against a monthly cap.
