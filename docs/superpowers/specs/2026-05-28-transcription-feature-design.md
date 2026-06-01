# Transcription Feature — Design

**Date:** 2026-05-28
**Status:** Drafted (pending user review)
**Related work:** Builds on the litellm supervisor pattern (`src/exulu/litellm/supervisor.ts`) and reuses the existing `ee/python/.venv` Python infrastructure.

## Goal

Let an Exulu IMP user upload an audio file, run a Whisper-based transcription with pyannote diarization, review and rename auto-detected speakers, and save the resulting diarized transcript as an item in a built-in `transcriptions` ExuluContext — optionally attached to a project and with a chosen RBAC mode. The transcription compute runs in a **standalone Python HTTP server** that ships in the same `@exulu/backend` package, runnable on a separate (typically GPU-equipped) machine, so devs can scale transcription independently from the main app while keeping a single-package "one npm install" developer experience.

## Background

Three existing patterns in the repo shape the design:

- **Whisper pipeline reference:** `audio-transcription/` uses `whisperx==3.2.0` + `pyannote.audio==3.1.1`, configurable across CUDA / MPS / CPU via a `DEVICE` env var. Output is a list of segments with `start`, `end`, `text`, `speaker` (e.g., `SPEAKER_00`). Pyannote diarization requires `HF_AUTH_TOKEN`.
- **Python integration in `@exulu/backend`:** Postinstall hook (`scripts/postinstall.cjs` → `ee/python/setup.sh`) sets up a shared venv at `ee/python/.venv`. Two existing patterns: **litellm** runs as a long-running supervised sidecar via `src/exulu/litellm/supervisor.ts`; **docling** runs as a per-call subprocess via `src/utils/python-executor.ts`.
- **Persistence and access control:** Schemas are declared in `src/postgres/core-schema.ts`; tables with `RBAC: true` get `rights_mode` + `created_by` from `addCoreFields()`, and the existing GraphQL access layer filters them per-user automatically. The frontend already has a `<RBACControl/>` component, an Uppy/S3 upload hook, a `main-nav` component, and a `/data/[contextId]` page that lists ExuluContext items.

## Scope

**In scope:**

- A standalone Whisper HTTP server (Python, FastAPI) at `ee/python/transcription/`, launched with `npx @exulu/backend exulu-start-whisper`, supervised the same way LiteLLM is supervised.
- Main app integration that talks HTTP to whichever URL `TRANSCRIPTION_SERVER` points at. Feature is fully off if that env var is unset.
- A new `transcription_jobs` table (declared in `core-schema.ts`, `RBAC: true`) holding in-flight and awaiting-review jobs.
- A built-in `transcriptions` ExuluContext exported from `src/templates/contexts/transcriptions.ts` and merged into `ExuluApp.create()` ahead of user-defined contexts.
- GraphQL mutations/queries: `transcriptionJobStart`, `transcriptionJobs` (list), `transcriptionJob` (get), `transcriptionJobFinalize`, `transcriptionJobCancel`.
- A new frontend page `app/(application)/transcriptions/page.tsx` with: upload panel (Uppy/S3 + project + RBAC + language + speaker-count selectors), in-progress list, inline review-and-save panel for `awaiting_review` jobs.
- Main-nav entry pointing at `/transcriptions`.
- Startup capability surfacing: clear `[EXULU-WHISPER]` lines on the whisper server, and a one-liner on main-app boot summarizing transcription status (device, GPU on/off, diarization on/off).
- Conditional torch wheel install via `WHISPER_GPU` env var; auto-detects CUDA / Apple Silicon.

**Out of scope (explicitly):**

- Listing previously-saved transcripts on the new page — `/data/transcriptions` already does that.
- Real-time progress percentage during transcription. We show `transcribing` / `awaiting_review` / `failed`; not a percent bar. WhisperX doesn't expose progress cheaply.
- Per-user rate limiting on job submission. (Add later if abuse appears.)
- Idempotent `transcriptionJobStart` via a client-supplied request id. Frontend just disables the Start button after click.
- Auto-migration of audio cleanup. The job row holds the S3 key; on discard we delete the S3 object (gated by `cleanupAudioOnDiscard`, default `true`).
- Streaming transcripts back to the frontend mid-run. Polling is enough.
- Pushing GPU/queue metrics into the existing Statistics tables.

## Architecture

Three independent units:

```
┌─────────────────────────────────┐         ┌─────────────────────────────────┐
│ Frontend (Next.js)              │         │ Whisper Server (Python, FastAPI)│
│ - /transcriptions page          │         │ - One process, model loaded once│
│ - main-nav item                 │         │ - POST /jobs, GET /jobs/:id,    │
│ - Upload → review → save UI     │         │   GET /jobs, DELETE /jobs/:id   │
└──────────────┬──────────────────┘         │ - Sequential job execution      │
               │ GraphQL                    │ - GPU detection at boot         │
               ▼                            └──────────────▲──────────────────┘
┌─────────────────────────────────┐                        │  HTTP (poll)
│ @exulu/backend (Node)           │  presigned S3 URL +    │  TRANSCRIPTION_SERVER
│ - transcriptions ExuluContext   │  options               │
│ - transcription_jobs table      ├────────────────────────┘
│ - TranscriptionService (client) │
│ - Supervisor (only when run via │
│   exulu-start-whisper) + GPU log│
└─────────────────────────────────┘
```

**Invariants:**

- Whisper server is a **standalone HTTP service**. It ships in the `@exulu/backend` package but runs as its own process group. The main app does **not** auto-spawn it.
- Main app uses transcription only if `TRANSCRIPTION_SERVER` is set; otherwise the feature is off and clearly logged.
- Whisper server is **stateless w.r.t. persistence** — in-memory job dict. On restart, the backend treats unknown jobs as failed.
- Backend is the **source of truth** for what jobs exist, who owns them, and which project / RBAC they target.
- Audio flows **S3 → whisper directly** via a presigned URL. The backend never relays audio bytes.
- Whisper server processes jobs **sequentially** (GPU-safe; simple).

## Whisper Python server

**Location:** `ee/python/transcription/`

```
ee/python/transcription/
├── server.py        # FastAPI app + HTTP routes
├── pipeline.py      # WhisperX + pyannote pipeline (lifted from audio-transcription/src/transcription.py)
├── worker.py        # asyncio.Queue + single consumer loop
└── tests/
    ├── test_server.py
    └── test_pipeline.py
```

**Dependencies added to `ee/python/requirements.txt`:**

- `whisperx==3.2.0`
- `pyannote.audio==3.1.1`
- `fastapi`
- `uvicorn`
- `python-multipart`

Torch is installed conditionally by `ee/python/setup.sh`:

- `WHISPER_GPU=cuda` (or `nvidia-smi` detected) → `torch==2.5.0+cu124` from the PyTorch index.
- `WHISPER_GPU=mps` (or `darwin-arm64`) → default `torch` (MPS support is built in).
- `WHISPER_GPU=cpu` or no detection → default CPU `torch`.

Model files download lazily on first job (~3 GB to `~/.cache/huggingface`). First-run log warns about this.

**HTTP API (small by design):**

| Method | Path | Body / Response |
|---|---|---|
| `POST` | `/jobs` | `{ audio_url, language?, num_speakers?, hotwords? }` → `{ job_id, status: "queued" }` |
| `GET` | `/jobs/:id` | `{ job_id, status, progress?, segments?, language?, duration_seconds?, error? }` |
| `GET` | `/jobs` | `[{ job_id, status, started_at, ... }, ...]` |
| `DELETE` | `/jobs/:id` | Cancels a queued job; running jobs receive a cancel flag and bail between stages. Returns 200. |
| `GET` | `/healthz` | `{ ok, device, model, gpu: { available, name?, vram_gb? }, diarization: bool }` |

Status values returned by the whisper server: `queued`, `running`, `completed`, `failed`, `cancelled`. These are **whisper-side** states. The backend maps them onto its own (broader) row-level lifecycle: `queued → transcribing → awaiting_review → saved` (plus `failed` and `cancelled`). The backend's `awaiting_review` has no whisper-side counterpart — it's the state between whisper reporting `completed` and the user clicking Save.

**Process lifecycle:**

1. On startup: detect device (`auto` resolves to `cuda` → `mps` → `cpu`), log it.
2. Load the whisper model (`large-v3` by default) and the pyannote diarization pipeline (only if `HF_AUTH_TOKEN` set; otherwise diarization disabled and all segments get `speaker="unknown"`).
3. Start a single asyncio worker task that drains the queue one at a time.
4. Serve HTTP.

Cancellation between stages: the worker checks an in-memory cancel flag after each whisperx stage (load → transcribe → align → diarize); on set, it aborts and marks the job `cancelled`.

**GPU detection at boot (visible-startup-message contract):**

```
[EXULU-WHISPER] Starting whisper server on 127.0.0.1:9876
[EXULU-WHISPER] GPU support: enabled (CUDA, NVIDIA RTX 4090, 24 GB VRAM)
[EXULU-WHISPER] Model: large-v3 (loading… ~30s first run)
[EXULU-WHISPER] Diarization: enabled (pyannote)
[EXULU-WHISPER] Ready.
```

Disabled-path version:

```
[EXULU-WHISPER] GPU support: disabled (CPU only). Transcription will be slow.
[EXULU-WHISPER]   To enable on Linux/Windows: install CUDA + re-run `WHISPER_GPU=cuda npm install`
[EXULU-WHISPER]   To enable on macOS Apple Silicon: no setup needed (will auto-use MPS)
[EXULU-WHISPER] Diarization: disabled (HF_AUTH_TOKEN not set). All segments will get speaker="unknown".
[EXULU-WHISPER]   To enable: accept ToS at huggingface.co/pyannote/speaker-diarization and set HF_AUTH_TOKEN
```

**Whisper server env vars:**

| Var | Purpose | Default |
|---|---|---|
| `WHISPER_HOST` | Bind host | `127.0.0.1` |
| `WHISPER_PORT` | Bind port | `9876` |
| `WHISPER_MODEL` | Model id | `large-v3` |
| `WHISPER_DEVICE` | `auto` / `cuda` / `mps` / `cpu` | `auto` |
| `WHISPER_BATCH_SIZE` | Inference batch size | `4` |
| `HF_AUTH_TOKEN` | Hugging Face token for pyannote. Unset → diarization off. | (unset) |

## Supervisor and CLI

**Module:** `src/exulu/transcription/supervisor.ts`

Structural copy of `src/exulu/litellm/supervisor.ts`:

- Spawns `<packageRoot>/ee/python/.venv/bin/python -m uvicorn server:app --host $WHISPER_HOST --port $WHISPER_PORT` with cwd `ee/python/transcription/`.
- Exponential-backoff respawn (1 s → 30 s, cap 5 crashes).
- Liveness poll on `GET /healthz` every 200 ms for up to 30 s; memoized ready promise.
- Stdout/stderr piped, lines prefixed `[EXULU-WHISPER]`.
- SIGINT/SIGTERM graceful shutdown with 5 s grace before SIGKILL.
- Pins `DEBUG=false` and strips the parent `DEBUG` env var to avoid uvicorn's click CLI tripping on it (mirrors the litellm guard).

**CLI entry:** `src/cli/start-whisper.ts` resolves the package root via the existing `getPackageRoot()` helper, launches the supervisor, and wires signal handlers.

**`package.json` additions:**

```jsonc
{
  "scripts": {
    "start:whisper": "node ./dist/cli/start-whisper.js"
  },
  "bin": {
    "exulu-start-whisper": "./dist/cli/start-whisper.js"
  }
}
```

The main `ExuluApp.create()` does **not** call the supervisor. It only:

1. Logs the transcription status on boot (see below).
2. Starts the polling loop if `TRANSCRIPTION_SERVER` is set.

## Backend integration

### Schema

Added to `src/postgres/core-schema.ts`:

```ts
const transcriptionJobsSchema: ExuluTableDefinition = {
  type: "transcription_jobs",
  name: { plural: "transcription_jobs", singular: "transcription_job" },
  RBAC: true,  // picks up rights_mode + created_by from addCoreFields(); GraphQL filters by them
  fields: [
    { name: "audio", type: "file" },                  // → audio_s3key
    { name: "title", type: "text" },
    { name: "status", type: "text", index: true },     // queued|transcribing|awaiting_review|saved|failed|cancelled
    { name: "whisper_job_id", type: "text" },
    { name: "raw_segments", type: "json" },
    { name: "speakers", type: "json" },                // { SPEAKER_00: "Daniel", ... } from review step
    { name: "language", type: "text" },
    { name: "duration_seconds", type: "number" },
    { name: "project_id", type: "uuid" },              // null = no project
    // INTENT fields — applied to the resulting ExuluContext item on finalize:
    { name: "target_rights_mode", type: "text", default: "private" },
    { name: "target_rbac_users", type: "json" },
    { name: "target_rbac_roles", type: "json" },
    { name: "saved_item_id", type: "uuid" },
    { name: "error", type: "text" },
  ],
};
```

Then registered alongside the other schemas in `coreSchemas.get()`.

### Built-in context

New file `src/templates/contexts/transcriptions.ts`:

```ts
export const transcriptionsContext = new ExuluContext({
  id: "transcriptions",
  name: "Transcriptions",
  description: "Diarized audio transcripts",
  fields: [
    { name: "transcript_text", type: "longText", editable: true },
    { name: "audio", type: "file" },                  // → audio_s3key
    { name: "language", type: "text" },
    { name: "duration_seconds", type: "number" },
    { name: "speakers", type: "json" },
    { name: "raw_segments", type: "json", editable: false },
  ],
  sources: [],
  active: true,
  configuration: {
    calculateVectors: "onInsert",
    defaultRightsMode: "private",
  },
});
```

New file `src/templates/contexts/index.ts`:

```ts
import { transcriptionsContext } from "./transcriptions";

export const builtInContexts = {
  transcriptions: transcriptionsContext,
};
```

In `src/exulu/app/index.ts`:

```ts
import { builtInContexts } from "@/templates/contexts";

// inside ExuluApp.create, before user-provided contexts:
const contexts = { ...builtInContexts, ...(config.contexts ?? {}) };
if (config.contexts && "transcriptions" in config.contexts) {
  console.warn("[EXULU] User-defined 'transcriptions' context overridden by built-in. Rename your context to avoid the collision.");
}
```

### Transcription module

`src/exulu/transcription/`:

- `client.ts` — HTTP client for the whisper server: `submitJob(audioUrl, opts)`, `getJob(id)`, `cancelJob(id)`, `health()`. Reads `TRANSCRIPTION_SERVER` from env. Throws typed `TranscriptionServerUnavailable` when unset or unreachable.
- `service.ts` — `TranscriptionService`:
  - `startJob({ userId, s3Key, filename, project_id?, target_rights_mode?, target_rbac_users?, target_rbac_roles? })` → inserts `transcription_jobs` row (`status="queued"`), signs a presigned download URL for the S3 key, calls `client.submitJob`, updates row with `whisper_job_id` and `status="transcribing"`.
  - `pollOnce()` → queries all rows in `transcribing`; for each calls `client.getJob`. On `completed` → store `raw_segments`, `language`, `duration_seconds`, set `status="awaiting_review"`. On `failed` → `status="failed"`, copy error. On 404 → `status="failed"` with `error="lost on server restart"`.
  - `cancelJob(id)` → calls `client.cancelJob`, sets `status="cancelled"`.
  - `finalize(id, { title, speakers, project_id?, target_rights_mode?, target_rbac_users?, target_rbac_roles? })` → renders speaker-labeled transcript text from `raw_segments` + `speakers`, creates a `transcriptions` ExuluContext item via `context.createItem(...)` with the final RBAC + title, optionally appends `transcriptions/{newItemId}` to the chosen project's `project_items`, sets `status="saved"` + `saved_item_id`. On `createItem` failure → keep `status="awaiting_review"` with `error` populated so the user can retry Save.
- `transcript-text.ts` — pure function `renderTranscript(segments, speakers): string` producing `"Daniel: Hello.\nAlex: How are you?\n..."`. Consecutive segments by the same speaker collapse into one block. Used by both backend `finalize` and a frontend live preview (shared via the types package).
- `polling-loop.ts` — `setInterval` loop started from `ExuluApp.create()` *only if* `TRANSCRIPTION_SERVER` is set. Calls `TranscriptionService.pollOnce()` every 5 seconds. Stops on SIGTERM. Caps at 50 jobs per tick.

### Boot wiring in `ExuluApp.create()`

Near the litellm supervisor block:

```ts
if (process.env.TRANSCRIPTION_SERVER) {
  try {
    const health = await transcriptionClient.health();
    console.log(
      `[EXULU] Transcription: enabled (server=${process.env.TRANSCRIPTION_SERVER}, ` +
      `device=${health.device}, GPU=${health.gpu.available ? "enabled" : "disabled"}, ` +
      `diarization=${health.diarization ? "enabled" : "disabled"})`
    );
    startTranscriptionPollingLoop();
  } catch (err) {
    console.warn(
      `[EXULU] TRANSCRIPTION_SERVER set but unreachable: ${err.message}. ` +
      `Transcriptions will fail until the server is up.`
    );
  }
} else {
  console.log(
    "[EXULU] Transcription: disabled (TRANSCRIPTION_SERVER not set). " +
    "Start a whisper server with `npx @exulu/backend exulu-start-whisper`."
  );
}
```

### GraphQL surface

Added to the existing GraphQL schema (uses the same auto-generated CRUD scaffolding the other RBAC tables use, plus a small handful of custom resolvers):

- `query transcriptionJobs` — user-scoped via RBAC; default filter to non-terminal states for the transcriptions page.
- `query transcriptionJob(id)` — single row including `raw_segments`.
- `mutation transcriptionJobStart(input)` — calls `service.startJob`, returns the row.
- `mutation transcriptionJobFinalize(id, input)` — calls `service.finalize`, returns the created `transcriptions` item.
- `mutation transcriptionJobCancel(id)` — calls `service.cancelJob`.

Resolvers guard on `process.env.TRANSCRIPTION_SERVER` and return a typed `TRANSCRIPTION_DISABLED` error when unset (frontend uses this to show a friendly inline message).

## Frontend

### Main nav

`frontend/components/custom/main-nav.tsx`: add a `Transcriptions` entry with icon `FileAudio` (already imported), path `transcriptions`, label key `navigation.transcriptions`. Placement near the existing Knowledge/Agents entries.

### Page

`frontend/app/(application)/transcriptions/page.tsx`. Two stacked sections; no list of past transcripts.

```
┌─────────────────────────────────────────────────────┐
│ Transcriptions                                      │
│                                                     │
│ [ New transcription ]                               │
│                                                     │
│ ╭─ New transcription panel (expands inline) ─────╮  │
│ │ Title:      [Meeting 2026-05-28          ]     │  │
│ │ Audio file: [ Uppy drop / click to upload ]    │  │
│ │ Project:    [ ▼ none ]                         │  │
│ │ RBAC:       [ <RBACControl modalMode/> ]       │  │
│ │ Language:   [ auto-detect ▼ ]                  │  │
│ │ Speakers:   [ auto ▼ ]   (or specify number)   │  │
│ │                            [ Cancel ] [ Start ]│  │
│ ╰────────────────────────────────────────────────╯  │
│                                                     │
│ ─── In progress ─────────────────────────────────── │
│                                                     │
│ ▸ Meeting 2026-05-28.m4a                            │
│   Transcribing… 1m 42s elapsed       [ Cancel ]     │
│                                                     │
│ ▸ Standup recording.wav            ⓘ Awaiting review│
│   Diarized into 3 speakers     [ Review & save ] ▾  │
│                                                     │
│   ╭─ expanded review panel ──────────────────────╮  │
│   │ Title:   [ Standup recording           ]     │  │
│   │ Project: [ ▼ none ]                          │  │
│   │ RBAC:    [ <RBACControl/> ]                  │  │
│   │                                              │  │
│   │ Speakers (rename to save with real names):   │  │
│   │   SPEAKER_00  [ Daniel               ] ▶ 0:03│  │
│   │   SPEAKER_01  [ Alex                 ] ▶ 0:17│  │
│   │   SPEAKER_02  [ Pat                  ] ▶ 0:42│  │
│   │                                              │  │
│   │ Preview (live-rendered):                     │  │
│   │   Daniel: morning, where are we on the…      │  │
│   │   Alex:   we got blocked on the API…         │  │
│   │   …                                          │  │
│   │                          [ Discard ] [ Save ]│  │
│   ╰──────────────────────────────────────────────╯  │
└─────────────────────────────────────────────────────┘
```

### Wiring

- **Upload** uses the existing `useUppy` hook. On `upload-success`, capture the returned S3 key and call `transcriptionJobStart` with `{ audio_s3key, title, project_id, target_rights_mode, target_rbac_users, target_rbac_roles, language, num_speakers }`. Add the returned row to the in-progress list immediately.
- **In-progress list** is populated by the `transcriptionJobs` GraphQL query, polled every 5 s while the page is open. RBAC filtering means each user sees only their own jobs (super_admin sees all).
- **Review panel** is `<TranscriptionReviewPanel jobId=… />`. It fetches the full job (including `raw_segments`) on expand. The `▶ 0:03` buttons play short audio snippets from the original S3 file (signed download URL, played via `<audio>`, seeked to the first segment for that speaker). Live preview uses the shared `renderTranscript(segments, speakerMap)` function. Save calls `transcriptionJobFinalize`; on success the row leaves the list (terminal state) and a toast links to `/data/transcriptions/{itemId}`. Discard calls `transcriptionJobCancel`.
- **Reused components:** Uppy dashboard, `<RBACControl/>`, project selector (same pattern as agents/sessions). No custom CRUD — finished transcripts live entirely on `/data/transcriptions`.
- **Empty state:** "New transcription" button + small hint pointing at `/data/transcriptions` for previously-saved transcripts.

### Diarization-off UX

If `health.diarization === false` on the server (no `HF_AUTH_TOKEN`), the review panel shows a banner "Diarization disabled on the server — only one speaker available" and renders a single rename input.

## Error handling and edge cases

| Failure | Where caught | User sees |
|---|---|---|
| `TRANSCRIPTION_SERVER` unset, user tries to start a job | GraphQL resolver guard | Typed `TRANSCRIPTION_DISABLED` error; UI shows "Transcription is not configured on this server" with a docs link |
| Whisper server unreachable mid-job | `client.getJob` throws on timeout | Polling marks job `failed` with `error="server unreachable"`; UI Retry button |
| Whisper server returns `failed` | Polling maps it through | Job `failed`, whisper-side error copied |
| Whisper server restart drops in-memory jobs (404) | Polling | `failed` with `error="lost on server restart"`; UI Retry |
| Upload to S3 fails | Existing Uppy error path | Existing toast; no job row created |
| `context.createItem` fails at finalize | `service.finalize` | Job stays in `awaiting_review` with `error` populated; review panel shows error; user can retry Save |
| Project assignment fails after item is created | `service.finalize` (post-create) | Item saved; job `saved` with `error` warning the user; UI toast suggests manual attach via `/data` |
| `HF_AUTH_TOKEN` missing → diarization off | Whisper server `/healthz` | Review panel shows diarization-off banner; single rename input |

**Cancellation semantics:**

- `queued` on whisper → `DELETE /jobs/:id` removes immediately; backend → `cancelled`.
- `running` on whisper → cancel flag set; worker bails between stages; backend → `cancelled` once whisper confirms.
- `awaiting_review` → backend deletes the job row; S3 audio deleted unless the consumer passes `cleanupAudioOnDiscard: false` in the `ExuluApp` config (default `true`).

**Retry on failure:** "Retry" reopens the new-transcription panel pre-filled from the failed row. The failed row stays in the DB so the user can read the error later. The default `transcriptionJobs` query excludes terminal `saved`/`cancelled` states but **includes** `failed` so the user sees what broke; each failed row has a "Dismiss" action that deletes it. No automatic TTL sweep in v1.

**Idempotency:** Not enforced server-side in v1. Frontend disables Start after click.

**Restart resilience:**

- Main app restart: `transcribing` rows re-polled on next tick.
- Whisper server restart: same — known jobs continue, unknown jobs marked `failed`.

## Configuration summary

| Var | Where | Purpose | Default |
|---|---|---|---|
| `TRANSCRIPTION_SERVER` | Main app | HTTP URL of whisper server. Unset = feature off. | (unset) |
| `WHISPER_HOST` | Whisper server | Bind host | `127.0.0.1` |
| `WHISPER_PORT` | Whisper server | Bind port | `9876` |
| `WHISPER_MODEL` | Whisper server | Model id | `large-v3` |
| `WHISPER_DEVICE` | Whisper server | `auto`/`cuda`/`mps`/`cpu` | `auto` |
| `WHISPER_BATCH_SIZE` | Whisper server | Inference batch | `4` |
| `HF_AUTH_TOKEN` | Whisper server | Hugging Face token for pyannote. Unset = diarization off. | (unset) |
| `WHISPER_GPU` | postinstall | Override torch wheel detection (`cuda`/`mps`/`cpu`) | (auto) |

## Testing

**Backend unit (`src/exulu/transcription/__tests__/`):**

- `transcript-text.test.ts` — pure function. Cases: standard rename, partial rename (unrenamed speaker keeps `SPEAKER_NN`), no diarization (single-speaker fallback), empty segments, same-speaker collapse.
- `service.test.ts` — HTTP client mocked. Cases: `startJob` writes row + submits + advances; `pollOnce` transitions on completion; `finalize` creates item with right RBAC + project linkage; `finalize` rollback when `createItem` fails; cancel paths per status.
- `client.test.ts` — minimal: request/response shapes.

**Backend integration (opt-in via `RUN_TRANSCRIPTION_INTEGRATION=1`):**

- `transcription.integration.test.ts` — uploads a fixture wav (`test/fixtures/audio/`), runs the full pipeline, asserts a `transcriptions` item exists with non-empty `transcript_text`. Requires a running whisper server. Never runs in default `npm test`.

**Python tests (`ee/python/transcription/tests/`):**

- `test_pipeline.py` — tiny audio fixture, pinned to CPU + `tiny` model. Asserts segment shape matches the Node client's expectations.
- `test_server.py` — FastAPI testclient. Pipeline monkey-patched to a stub. Cases: `POST /jobs` → job_id; `GET /jobs/:id` transitions; `DELETE` removes queued; `/healthz` shape.

**Frontend tests:**

- `<TranscriptionReviewPanel>` component test: typing rename updates live preview; Save calls mutation with right `speaker_map`; Discard calls cancel mutation.
- No e2e in v1 — natural fit for the `uat-testing` skill once we want it.

**Not tested:**

- WhisperX / pyannote correctness (upstream libraries).
- Supervisor restart logic for the whisper supervisor — kept structurally in sync with the litellm supervisor, which has its own tests.

## Open questions

None at design time. All architectural decisions are settled. Implementation may surface minor questions about specific GraphQL resolver wiring (auto-generated vs custom) — to be addressed in the implementation plan.
