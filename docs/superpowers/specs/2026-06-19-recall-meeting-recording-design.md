# Meeting Recording & Transcription via Recall.ai — Design

**Date:** 2026-06-19
**Status:** Approved (design)
**Related:** `RECALL-AI.AGENT.md` (integration guide), `docs/superpowers/specs/2026-05-28-transcription-feature-design.md` (Whisper transcription feature this extends)

## Summary

Add the ability to send a Recall.ai bot to a meeting URL, record it, and produce a
post-meeting (async) transcript that flows through the **existing** transcription
pipeline: a needs-review step (confirm/rename speakers), then save into the
`transcriptions` ExuluContext with a chosen project + RBAC sharing.

On top of that, add **post-processing**: when adding a meeting the user can attach
one or more `{prompt, agent}` pairs (prompt taken from the existing `prompt_library`,
agent chosen explicitly). These run automatically when the transcript is ready and
their outputs are stored on the transcript record and shown in the review view.

The design maximizes reuse of the Whisper transcription feature. Recall jobs are the
same `transcription_jobs` rows with `source='recall'`; the same review sheet,
`finalize()`, and `transcriptions` context are reused. The only genuinely new
plumbing is the Recall API client, webhook verification, the webhook-driven state
machine (Recall is push/webhook-based — polling is explicitly forbidden), and the
post-processing runner.

## Decisions (from brainstorming)

- **Transcription mode:** post-meeting (async) only. Recall.ai Transcription provider,
  `language_code: "auto"`, separate-stream diarization. Real-time is out of scope.
- **Review step:** needs-review (mirror Whisper) — transcript lands as `awaiting_review`,
  user confirms/renames speakers and clicks Save.
- **Join timing:** "Join now" (default) or a user-picked `join_at`. Calendar
  auto-detection of meeting start is out of scope (requires Recall calendar integration).
- **Post-processing config:** reuse `prompt_library` for prompts (RBAC'd, full CRUD UI
  already exists at `/prompts`). No new templates table. The agent is chosen explicitly
  per prompt in the meeting composer (the prompt's `assigned_agents` field is **not** used).
- **Post-processing selection:** per-meeting; the picker defaults to **nothing selected**.
- **Post-processing run trigger:** automatically when the transcript is ready; manual
  re-run available from the review sheet.
- **Post-processing storage:** on the transcript record (and carried into the saved item).
- **Post-processing scope:** Recall meeting transcripts only for now (design generalizes
  to Whisper transcripts later).
- **Architecture:** extend `transcription_jobs` (not a new table); in-process async
  webhook processing (not bullmq); reuse the existing agent-run path for post-processing.

## 1. Configuration & feature gating

New module `src/exulu/recall/env.ts` reads and validates:

| Variable | Source | Notes |
|---|---|---|
| `RECALL_REGION` | env | one of `us-west-2`, `us-east-1`, `eu-central-1`, `ap-northeast-1` |
| `RECALL_API_KEY` | env | region-specific |
| `RECALL_WORKSPACE_VERIFICATION_SECRET` | env | webhook/callback verification |
| `PUBLIC_API_BASE_URL` | `process.env.BACKEND` | already the public base URL for this app |

- `recallEnabled()` — true when all four are present and the region is valid.
- On startup the app **always prints the Recall region** and a one-line
  "Recall meeting bots: enabled/disabled".
- Meeting-bot mutations/routes return **503** with a clear setup message when Recall is
  not configured (mirrors the gating of `/transcribe`, `/speech`, `/images/*`).

### Human-required setup (operator action, cannot be automated)

These follow `RECALL-AI.AGENT.md` and must be completed before end-to-end use:

1. Choose `RECALL_REGION` and use the same region everywhere.
2. Stable public URL for the backend — production `BACKEND`, or a **static ngrok URL**
   for local development (Recall returns 403 from CloudFront for `localhost`/IPs).
3. Create the `RECALL_API_KEY` and `RECALL_WORKSPACE_VERIFICATION_SECRET` in that region.
4. Add a dashboard webhook endpoint at `PUBLIC_API_BASE_URL/recall/webhooks`, subscribed
   to: `bot.*`, `recording.done`, `recording.failed`, `transcript.done`, `transcript.failed`.

Account is assumed created on/after 2025-12-15, so the **workspace verification secret**
is used for dashboard webhooks (no separate per-endpoint Svix secret).

## 2. Data model

### 2.1 Extend `transcription_jobs` (additive, nullable)

Migration lives in the initdb path, gated by column-existence checks (existing convention).

| Column | Type | Notes |
|---|---|---|
| `source` | text, default `'whisper'` | `'whisper' \| 'recall'` |
| `meeting_url` | text | recall only |
| `recall_bot_id` | text | |
| `recall_recording_id` | text | |
| `recall_transcript_id` | text | |
| `bot_status` | text | last bot lifecycle code (e.g. `in_call_recording`, `done`, `fatal`) |
| `join_at` | timestamp | always set (= now for "join now") |
| `post_processing_prompts` | json | selected for this meeting: `[{prompt_id, agent_id}]` |
| `post_processing_outputs` | json | results (see §5) |

The Whisper polling loop already filters `status='transcribing' AND whisper_job_id NOT NULL`,
so `recall` rows are naturally ignored by it. Recall rows are driven only by webhooks.

### 2.2 `transcriptions` context

Add one field so post-processing results carry into the saved item:

- `post_processing` — `json` (array of `{prompt_id, agent_id, prompt_name, output, ran_at}`).

### 2.3 Reuse `prompt_library`

No new table. Post-processing prompts are `prompt_library` items
(`content` = prompt text; RBAC for sharing). The associated agent is chosen explicitly in
the composer and snapshotted onto the job as `agent_id` (so later edits to the library
prompt do not change what already ran). The prompt's `assigned_agents` field is not used.

## 3. Recall API client & verification

### 3.1 `src/exulu/recall/client.ts`

- `fetch_with_retry` exactly as specified in `RECALL-AI.AGENT.md`: honors `Retry-After`
  on 429, waits ~10s on 503, ~30s on 507, with jitter, capped attempts. **Every** Recall
  request goes through it.
- Base URL derived from region: `https://${RECALL_REGION}.recall.ai/api/v1`.
- Methods:
  - `createBot({ meeting_url, join_at, bot_name, chat })`
  - `createAsyncTranscript(recordingId)` — provider `recallai_async`,
    `language_code: "auto"`, `diarization.use_separate_streams_when_available: true`
  - `retrieveTranscript(transcriptId)`, `retrieveRecording(recordingId)`
  - `downloadTranscript(downloadUrl)` — GET the signed URL, returns transcript JSON

### 3.2 `src/exulu/recall/verify.ts`

- Verifies Svix-style signature headers against `RECALL_WORKSPACE_VERIFICATION_SECRET`
  using the **raw request body** bytes (not the parsed JSON).
- Rejects any request that fails verification; logs the request + body for debugging but
  never enqueues/stores/processes an unverified payload.

## 4. Webhook route, async processing & lifecycle

### 4.1 Route

`POST /recall/webhooks`, mounted with a **raw body parser** (signature verification needs
the exact bytes — ordered before/around the global `express.json`). Flow:

1. Verify signature. If invalid → log, reject (401), stop.
2. Persist the state transition (minimal DB write).
3. **Return `200` immediately.**
4. Process the remainder fire-and-forget (in-process), wrapped in try/catch.

In-process processing works whether or not Redis workers are enabled. It is recoverable
because every bot/recording/transcript ID is persisted on the job row.

### 4.2 State machine (on the `transcription_jobs` row)

Keyed/idempotent on the Recall IDs so duplicate or out-of-order webhooks are safe.

```
meetingBotStart    → insert row (source=recall, status=queued, bot_status=null,
                     join_at set, recall_bot_id from createBot)
bot.* lifecycle    → update bot_status (joining → in_waiting_room →
                     in_call_recording ⇄ in_call_not_recording → done)
recording.done     → store recall_recording_id; call createAsyncTranscript(recording_id);
                     status = transcribing
transcript.done    → store recall_transcript_id; download transcript JSON →
                     map to RawSegment[] → store raw_segments, language,
                     duration_seconds; status = awaiting_review;
                     then auto-run post_processing_prompts (§5)
recording.failed /
transcript.failed /
bot.fatal          → status = failed, error = code/sub_code/reason
```

### 4.3 Transcript mapping

Recall's downloaded JSON transcript maps onto the existing
`RawSegment { start, end, text, speaker }` shape, where `speaker` is the participant name
from diarization (real names where the platform provides them — which is why renaming is
usually unnecessary but still available). The existing `renderTranscript()` and `finalize()`
are reused unchanged; finalize additionally writes the new `post_processing` field.

## 5. Post-processing execution

When the row enters `awaiting_review`, the async path runs each selected
`{prompt_id, agent_id}` in `post_processing_prompts`:

1. Load the prompt `content` from `prompt_library`; load the agent via `exuluApp.agent(agent_id)`.
2. Build the model input as **prompt content + the rendered transcript text**.
3. Resolve the model with `resolveModel` **as the job's `created_by` user** (for model
   access checks + spend attribution/tags), then run `provider.generateSync` (non-streaming)
   — the same path used by the `/agents/suggestions` route.
4. Append to `post_processing_outputs`:
   `{prompt_id, agent_id, prompt_name, status: 'done' | 'failed', output, error, ran_at}`.
   Each entry runs in its own try/catch so one failure does not block the others.

- **Idempotent:** skip auto-run if outputs already exist for the run (duplicate
  `transcript.done` must not double-spend).
- **Manual re-run:** `runTranscriptPostProcessing(job_id, prompt_id, agent_id)` mutation
  lets the user add/re-run a prompt from the review sheet (e.g. after renaming speakers);
  it appends/updates the matching entry in `post_processing_outputs`.
- Outputs carry into the saved item's `post_processing` field at `finalize`.

## 6. Frontend

### 6.1 Composer (`/transcriptions`)

Add a mode switch: **Audio file** (existing) / **Meeting**. Meeting mode fields:

- Meeting URL (required)
- Join timing: **Join now** (default) or a date/time picker → `join_at`
- Optional bot name (default e.g. "Exulu Notetaker")
- Optional "notify participants in chat that the meeting is being recorded" toggle →
  `chat.on_bot_join`
- Title (optional)
- Project (reuse existing project select)
- Sharing (reuse `RBACControl`; `private | users | roles | public`)
- **Post-processing list** — a repeatable list, each row = a prompt search/picker over
  `prompt_library` (read-access filtered) + an agent picker. Defaults to empty.

Start → `meetingBotStart` mutation.

### 6.2 Queue / JobRow

Meeting jobs appear in the same three groups. Bot lifecycle maps to existing buckets:

- `queued` / joining / in-call / `transcribing` → **Processing** (with a humanized
  `bot_status` line, e.g. "In call — recording")
- `awaiting_review` → **Needs review**
- `saved` → **Saved**
- `failed` → **Failed**

A small source icon distinguishes meeting vs audio jobs.

### 6.3 Review sheet

Existing transcript view + speaker-rename, plus a new **post-processing results** section:
cards showing prompt name, agent, output, status, and a re-run action. Save → existing
`finalize` (carries `post_processing` into the saved item).

### 6.4 GraphQL & types

- New mutations: `meetingBotStart`, `runTranscriptPostProcessing`.
- Extend `TRANSCRIPTION_JOB_FIELDS` + the `Job` type with: `source`, `meeting_url`,
  `recall_bot_id`, `bot_status`, `join_at`, `post_processing_prompts`,
  `post_processing_outputs`.
- Prompt picker reuses the existing `prompt_library` pagination query; agent picker reuses
  the existing agents query.

## 7. Error handling & testing

- All Recall calls go through `fetch_with_retry`; terminal failures set `status='failed'`
  + `error`.
- Webhook verification failures → reject (401), log, never process.
- State transitions are idempotent and tolerate out-of-order/duplicate delivery.
- Mutations/routes return 503 when Recall is not configured.

### Unit tests

- Recall transcript-JSON → `RawSegment[]` mapping (alongside `transcript-text.test.ts`).
- `fetch_with_retry`: 429 + `Retry-After`, 503, 507, max-attempts.
- Signature verification: valid, invalid, raw-body correctness.
- State-machine transitions: `recording.done` → `createAsyncTranscript`,
  `transcript.done` → store + auto-run, duplicate-webhook idempotency.
- Post-processing runner: per-entry failure isolation; skip when outputs already exist.

### Manual / E2E

Requires the human Recall setup (region, static ngrok URL, dashboard webhook). Verify a
real meeting URL: bot joins, records, `recording.done` triggers transcript creation,
`transcript.done` stores the transcript + runs post-processing, review + save produces a
`transcriptions` item with the expected RBAC, project, and `post_processing` results.

## Out of scope (future)

- Real-time (in-meeting) transcription.
- Calendar integration / auto-detecting meeting start time / scheduled recurring bots.
- Applying post-processing to Whisper-sourced transcripts.
