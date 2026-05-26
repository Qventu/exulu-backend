# Speech-to-text transcription in chat

**Date:** 2026-05-24
**Status:** Approved (design)
**Scope:** Backend (`exulu/backend`) + Frontend (`exulu/frontend`)

## Problem

Users typing long chat messages would benefit from being able to speak instead. The platform already runs a LiteLLM proxy (`EXULU_USE_LITELLM=true`) with a `whisper` model registered in `selise/config.litellm.yaml` (`mode: audio_transcription`). All the upstream infrastructure for speech-to-text is in place; what's missing is the in-product entry point.

## Goal

Add a record button next to the chat submit button. Clicking it records microphone audio in the browser; clicking again stops recording, sends the audio to a new backend `/transcribe` endpoint, and appends the returned text to the chat input. The user reviews/edits the text and presses send themselves — no auto-submit.

## Non-goals

- **No streaming transcription.** Whole recording is uploaded at stop. LiteLLM's `/v1/audio/transcriptions` doesn't support streaming.
- **No client-side max recording duration.** The only hard cap is server-side at 25MB (~25 min at webm/opus 128kbps — well beyond any chat utterance).
- **No persistence of audio.** The `Blob` lives in browser memory only; the backend forwards as a stream and never writes to disk or S3.
- **No per-agent toggle.** Feature is global, controlled by env vars. Either everyone has it or nobody does.
- **No per-user / per-agent rate limiting in v1.** Backend auth is the only guard. LiteLLM's own master-key limits still apply upstream.
- **No token accounting / statistics.** Transcription cost isn't charged to any agent. We can add this later if it matters.
- **No replacement of input on transcription.** Transcribed text is *appended* to whatever the user already typed (with a separating space).
- **No language selection or transcription options.** Whisper auto-detects the language from the audio.

## Decisions

| Topic | Decision |
|---|---|
| Feature gate | Both `EXULU_USE_LITELLM === "true"` and `TRANSCRIPTION_MODEL` non-empty must be true. Either missing → frontend hides the button, backend returns 503. |
| Env vars | Single shared `.env` (frontend and backend are installed as npm packages by a parent project). `TRANSCRIPTION_MODEL` is read by both sides — backend uses the value, frontend uses presence. |
| Recording UX | Toggle: click to start, click to stop. Mic icon in `idle`; red square + pulse in `recording`; spinner in `transcribing` (button disabled). |
| Transcription result | Appended to existing input value with a leading space; input focused. Submit button is disabled while recording or transcribing. |
| Audio format | Browser default — `audio/webm;codecs=opus` on Chromium/Firefox, `audio/mp4` on Safari. Both are accepted by Whisper. |
| Empty recording | If captured bytes < 1KB, skip upload silently and reset state. |
| Backend ↔ LiteLLM transport | `multipart/form-data` forwarded through the backend via `fetch` to `http://${LITELLM_HOST ?? "127.0.0.1"}:${LITELLM_PORT ?? "4000"}/v1/audio/transcriptions`, `Authorization: Bearer ${LITELLM_MASTER_KEY}`. Backend appends the configured `model` field. |
| Multipart parsing | New dependency: `multer` (memory storage, single-file). The backend currently has no multipart middleware — Uppy uploads go browser→S3 via presigned URLs. |
| Auth | `requestValidators.authenticate(req)` — same JWT bearer check as every other route. No RBAC, no scope. |
| Failure surface | All errors come back as `{ detail: string }` with an appropriate status code; frontend shows a toast with `detail` (or a generic fallback). |
| LiteLLM readiness | Route awaits `waitForLiteLLMReady()` with a 5s timeout before forwarding. If the supervisor isn't ready, 503. |
| Boot-time warning | If `TRANSCRIPTION_MODEL` is set but `EXULU_USE_LITELLM !== "true"`, log a one-time warning at boot. Doesn't block boot. |

## Architecture

### Data flow

```
User clicks mic in chat input
    └── getUserMedia({ audio: true }) → MediaStream
          MediaRecorder.start() — chunks accumulate in audioChunksRef
          recordingState = "recording" (icon switches to red Square + animate-pulse)
User clicks mic again
    └── MediaRecorder.stop() → onstop fires with collected Blob
          stream.getTracks().forEach(t => t.stop())  (releases mic)
          recordingState = "transcribing"
          If total bytes < 1KB: reset to idle, no request.
          Otherwise:
            FormData: { file: <Blob "recording.webm|m4a"> }
            POST {backend}/transcribe
              Authorization: Bearer <jwt>
              User: <user.id>
              Content-Type: multipart/form-data (auto)
              └── routes.ts handler:
                    - Feature gate: EXULU_USE_LITELLM + TRANSCRIPTION_MODEL → 503 if missing
                    - requestValidators.authenticate → 401 if no user
                    - multer parses req → req.file
                    - Validate: present, mimetype ^audio/, size ≤ 25MB → 400/413 otherwise
                    - await waitForLiteLLMReady() (5s timeout) → 503 on timeout
                    - transcribeAudio({ file }) → POST upstream
                          LiteLLM 200 → { text }
                          LiteLLM non-OK → throw TranscriptionError(upstreamStatus, body)
                    - 200 { text } | upstream code | 502 on upstream 5xx
            ← response
          On 200: setInput(prev => prev ? `${prev} ${text}` : text); inputRef.focus()
          On error: toast { detail }
          recordingState = "idle"
```

### Why multer (and not something else)

The backend currently has no `multipart/form-data` parser. Uppy file uploads go from the browser directly to S3 via presigned URLs (`backend/src/uppy/index.ts:824` and friends), so the existing upload path doesn't help us. Options considered:

- `http-proxy-middleware` (already a dep): rejected because we need to inject the `model` form field and replace the `Authorization` header with the LiteLLM master key — proxy middleware makes that awkward and we'd still need to peek at the multipart body for size validation.
- Manual `busboy`: more code than warranted for one endpoint.
- `multer`: standard Express multipart middleware, ~70KB, single dependency, supports memory storage (no temp files on disk), trivial to use as route-scoped middleware. Chosen.

### File map

**New files:**

| File | Purpose |
|---|---|
| `backend/src/exulu/transcribe.ts` | Exports `transcribeAudio({ file })` and `TranscriptionError`. Owns the LiteLLM-forwarding logic: reads env vars, builds the outbound `FormData`, calls `fetch`, returns `{ text }` or throws. |

**Modified files:**

| File | Change |
|---|---|
| `backend/package.json` | Add `multer` (and `@types/multer` in devDependencies). |
| `backend/src/exulu/routes.ts` | Register `POST /transcribe` with route-scoped `multer().single("file")` middleware. Handler does feature gate, auth, validation, `waitForLiteLLMReady()`, call `transcribeAudio`, error mapping. |
| `backend/src/exulu/app/index.ts` | One-line boot warning when `TRANSCRIPTION_MODEL` is set but `EXULU_USE_LITELLM !== "true"`. |
| `frontend/app/(application)/layout.tsx` | Add `transcription: { enabled }` block to the `config` object, after `n8n`. |
| `frontend/components/config-context.tsx` | Extend `ConfigContext` type with `transcription?: { enabled: boolean }`. |
| `frontend/app/(application)/chat/[agent]/[session]/chat.tsx` | Add `recordingState` + refs, recording handlers, mic button (between textarea and submit, gated on `configContext?.transcription?.enabled`), disable submit while recording/transcribing, cleanup effect on unmount. |

## Backend

### `src/exulu/transcribe.ts` (new)

```ts
export class TranscriptionError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptionError";
  }
}

/**
 * Forward an audio file to the LiteLLM proxy's /v1/audio/transcriptions
 * endpoint and return the transcribed text. Reads LITELLM_HOST / LITELLM_PORT
 * / LITELLM_MASTER_KEY / TRANSCRIPTION_MODEL from process.env.
 *
 * Caller is responsible for: feature-gate checks, auth, file validation,
 * waiting for the LiteLLM supervisor to be ready.
 */
export async function transcribeAudio(args: {
  file: { buffer: Buffer; originalname: string; mimetype: string };
}): Promise<{ text: string }> {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  const model = process.env.TRANSCRIPTION_MODEL;

  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is not set");
  if (!model) throw new Error("TRANSCRIPTION_MODEL is not set");

  const form = new FormData();
  form.append(
    "file",
    new Blob([args.file.buffer], { type: args.file.mimetype }),
    args.file.originalname,
  );
  form.append("model", model);

  const res = await fetch(`http://${host}:${port}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${masterKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionError(
      res.status,
      `LiteLLM transcription failed (status ${res.status}): ${body}`.trim(),
    );
  }

  const json = (await res.json()) as { text?: string };
  return { text: typeof json.text === "string" ? json.text : "" };
}
```

### `src/exulu/routes.ts` — new route

Registered alongside the existing routes (placement: near the suggestions route, `routes.ts:943`):

```ts
import multer from "multer";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor.ts";
import { transcribeAudio, TranscriptionError } from "./transcribe.ts";

const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024; // 25MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIBE_BYTES },
});

app.post("/transcribe", upload.single("file"), async (req, res) => {
  if (!isLiteLLMEnabled() || !process.env.TRANSCRIPTION_MODEL) {
    res.status(503).json({
      detail:
        "Speech-to-text is not enabled on this deployment. " +
        "Set EXULU_USE_LITELLM=true and TRANSCRIPTION_MODEL in the environment.",
    });
    return;
  }

  const authenticationResult = await requestValidators.authenticate(req);
  if (!authenticationResult.user?.id) {
    res
      .status(authenticationResult.code || 401)
      .json({ detail: authenticationResult.message });
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ detail: "No audio file provided in 'file' field." });
    return;
  }
  if (!file.mimetype.startsWith("audio/")) {
    res
      .status(400)
      .json({ detail: `Unsupported mimetype: ${file.mimetype}. Expected audio/*.` });
    return;
  }

  try {
    await Promise.race([
      waitForLiteLLMReady(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("LiteLLM not ready")), 5_000),
      ),
    ]);
  } catch {
    res
      .status(503)
      .json({ detail: "Transcription service is not ready. Try again shortly." });
    return;
  }

  try {
    const { text } = await transcribeAudio({ file });
    res.status(200).json({ text });
  } catch (err) {
    if (err instanceof TranscriptionError) {
      const code = err.upstreamStatus >= 500 ? 502 : err.upstreamStatus;
      res.status(code).json({ detail: err.message });
      return;
    }
    console.error("[EXULU] /transcribe failed", err);
    res
      .status(500)
      .json({ detail: err instanceof Error ? err.message : "Transcription failed." });
  }
});
```

Note multer's own `LIMIT_FILE_SIZE` MulterError surfaces as a thrown error from the middleware; the route-scoped error handler chain (or a default Express handler) returns 413. If the codebase has a centralized error mapper, the spec implementer should route `MulterError.code === "LIMIT_FILE_SIZE"` to a 413 with `{ detail: "Recording too large. Please record a shorter clip." }`.

### `src/exulu/app/index.ts` — boot warning

After the existing LiteLLM supervisor start, add:

```ts
if (
  process.env.TRANSCRIPTION_MODEL &&
  process.env.EXULU_USE_LITELLM !== "true"
) {
  console.warn(
    "[EXULU] TRANSCRIPTION_MODEL is set but EXULU_USE_LITELLM is not 'true'. " +
      "The /transcribe endpoint will return 503 until LiteLLM is enabled.",
  );
}
```

## Frontend

### `frontend/app/(application)/layout.tsx`

Extend the `config` object (after `n8n`, before `...json`):

```ts
transcription: {
  enabled:
    typeof process.env.TRANSCRIPTION_MODEL === "string" &&
    process.env.TRANSCRIPTION_MODEL !== "" &&
    process.env.EXULU_USE_LITELLM === "true",
},
```

### `frontend/components/config-context.tsx`

Extend the `ConfigContext` type with `transcription?: { enabled: boolean }`.

### `frontend/app/(application)/chat/[agent]/[session]/chat.tsx`

**State (near the existing input state, ~line 126):**

```ts
const transcriptionEnabled = configContext?.transcription?.enabled === true;
const [recordingState, setRecordingState] =
  useState<"idle" | "recording" | "transcribing">("idle");
const mediaRecorderRef = useRef<MediaRecorder | null>(null);
const audioChunksRef = useRef<Blob[]>([]);
const streamRef = useRef<MediaStream | null>(null);
```

**Handlers (added near other handlers, ~line 600):**

```ts
const startRecording = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    audioChunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    mr.onstop = handleRecordingStop;
    mr.start();
    mediaRecorderRef.current = mr;
    setRecordingState("recording");
  } catch {
    toast({
      title: "Microphone access denied",
      description: "Allow microphone access in your browser to record.",
      variant: "destructive",
    });
  }
};

const stopRecording = () => {
  mediaRecorderRef.current?.stop();
  streamRef.current?.getTracks().forEach((t) => t.stop());
};

const handleRecordingStop = async () => {
  const mimeType = mediaRecorderRef.current?.mimeType ?? "audio/webm";
  const ext = mimeType.includes("mp4") ? "m4a" : "webm";
  const blob = new Blob(audioChunksRef.current, { type: mimeType });

  // Skip empty recordings silently (clicked stop before audio was captured)
  if (blob.size < 1024) {
    setRecordingState("idle");
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    return;
  }

  setRecordingState("transcribing");
  const formData = new FormData();
  formData.append("file", blob, `recording.${ext}`);

  try {
    const token = await getToken();
    if (!token) throw new Error("No valid session token available.");
    const res = await fetch(`${configContext?.backend}/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, User: user.id },
      body: formData,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ detail: "Transcription failed." }));
      throw new Error(errBody.detail || "Transcription failed.");
    }
    const { text } = (await res.json()) as { text?: string };
    if (text) {
      setInput((prev) => (prev ? `${prev} ${text}` : text));
      inputRef.current?.focus();
    }
  } catch (err) {
    toast({
      title: "Transcription failed",
      description: err instanceof Error ? err.message : "Please try again.",
      variant: "destructive",
    });
  } finally {
    setRecordingState("idle");
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
  }
};

// Cleanup any active recorder/stream on unmount.
useEffect(() => () => {
  if (mediaRecorderRef.current?.state === "recording") {
    mediaRecorderRef.current.stop();
  }
  streamRef.current?.getTracks().forEach((t) => t.stop());
}, []);
```

**Button placement** — inside the existing button column next to the textarea (`chat.tsx:1027`, between the `TextareaAutosize` and the submit/stop button). Wrapped in `{transcriptionEnabled && ...}`:

```tsx
{transcriptionEnabled && (
  <Button
    className="shrink-0"
    variant="secondary"
    size="icon"
    type="button"
    disabled={recordingState === "transcribing" || status === "submitted" || status === "streaming"}
    onClick={recordingState === "recording" ? stopRecording : startRecording}
    aria-label={
      recordingState === "recording"
        ? "Stop recording"
        : recordingState === "transcribing"
        ? "Transcribing"
        : "Start recording"
    }
  >
    {recordingState === "idle" && <Mic className="size-6 text-muted-foreground" />}
    {recordingState === "recording" && (
      <Square className="size-6 text-red-500 animate-pulse" />
    )}
    {recordingState === "transcribing" && <Loading className="size-6" />}
  </Button>
)}
```

Submit button (`chat.tsx:1027-1049`) gains an extra `disabled` clause: `recordingState !== "idle"` — prevents sending while a recording is in flight.

## Error handling matrix

| Condition | Where caught | Status | User sees |
|---|---|---|---|
| `EXULU_USE_LITELLM !== "true"` OR `TRANSCRIPTION_MODEL` empty | Frontend doesn't render the button | n/a | (no UI) |
| Backend feature gate trips anyway (defense-in-depth) | Route returns 503 | 503 | Toast: backend `detail` |
| Mic permission denied / no device | `getUserMedia` rejects | n/a | Toast: "Microphone access denied" |
| Empty recording (stop within ~250ms) | Frontend `onstop`, blob.size < 1KB | n/a | Silent reset |
| No `file` in form data | Route validation | 400 | Toast: "No audio file provided…" |
| Non-`audio/*` mimetype | Route validation | 400 | Toast: backend `detail` |
| File > 25MB | `multer` LIMIT_FILE_SIZE | 413 | Toast: "Recording too large…" |
| LiteLLM supervisor not ready within 5s | Route catches timeout | 503 | Toast: "Transcription service is not ready…" |
| LiteLLM 4xx (e.g. invalid model) | `TranscriptionError` → forward status | upstream code | Toast: backend `detail` |
| LiteLLM 5xx / network error | `TranscriptionError` → mapped to 502 | 502 | Toast: backend `detail` |
| Empty `text` in 200 response | Frontend `if (text)` check | 200 | Silent reset, no input change |
| User navigates away while recording | Cleanup `useEffect` stops recorder + tracks | n/a | (no leak) |
| User attempts submit while recording/transcribing | Submit button `disabled` | n/a | (no race) |

## Testing notes

- **Backend unit test** (`transcribe.test.ts`): mock global `fetch`; assert the outbound URL, the `Authorization` header value, the multipart body contains `model = ${TRANSCRIPTION_MODEL}` and the file with the right mimetype; assert `TranscriptionError` is thrown with the upstream status on non-OK; assert env-missing errors throw synchronously.
- **Backend route test** (extends `routes` test suite if one exists, otherwise a focused supertest): hit `/transcribe` with feature disabled → 503; with no auth → 401; with no file → 400; with non-audio mimetype → 400; with a valid stub file + mocked `transcribeAudio` → 200 `{ text }`.
- **Manual frontend QA**: record short utterance → text appended; record empty (instant stop) → no toast, no input change; deny mic permission → toast; record while offline → toast on `fetch` failure; verify mic button hidden when env vars unset.
