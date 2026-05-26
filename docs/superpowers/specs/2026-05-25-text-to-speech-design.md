# Text-to-speech for assistant messages

**Date:** 2026-05-25
**Status:** Approved (design)
**Scope:** Backend (`exulu/backend`) + Frontend (`exulu/frontend`)
**Companion:** [Speech-to-text transcription](./2026-05-24-speech-to-text-transcription-design.md) — this design mirrors that one in shape and gating; differences are called out where they matter.

## Problem

Users currently read assistant replies. Some users (visual fatigue, multitasking, accessibility, language learners) would benefit from having the reply read aloud. The platform already runs a LiteLLM proxy with provider plumbing for audio, so the upstream piece is in place — what's missing is the in-product entry point.

## Goal

Add a speaker icon button alongside the existing Copy / Retry / Feedback actions underneath each assistant message. Clicking it generates audio via a new backend `/speech` endpoint (which forwards to LiteLLM's `/v1/audio/speech`), then plays it inline. Click again to pause; click on a different message to switch playback.

## Non-goals

- **No streaming audio.** The backend buffers the full response and ships it as one binary payload. LiteLLM's TTS endpoints return small responses (10–100KB for a typical chat message); streaming proxy passthrough adds complexity for no perceptible win.
- **No persistence.** Audio blobs live in browser memory only — keyed by message id in a per-tab in-memory cache. Reload clears them. Never stored in S3 or anywhere else server-side.
- **No per-user voice picker.** Voice is a single global env var (`TTS_VOICE`). A picker would require per-user persistence and a per-provider voice enumeration that LiteLLM doesn't expose.
- **No per-agent toggle.** Feature is global, controlled by env vars. Either everyone has it or nobody does.
- **No per-user / per-agent rate limiting in v1.** Authentication is the only guard. LiteLLM's own master-key limits still apply upstream.
- **No token / cost accounting.** Speech requests aren't charged to any agent. Add later if it matters.
- **No language parameter in the API.** LiteLLM's `/v1/audio/speech` doesn't accept a language hint — TTS providers either auto-detect from the input text or use language-locked voices (e.g. Vertex `en-US-Wavenet-D`). Voice choice *is* the language choice.
- **No autoplay.** Audio only plays in response to a user click.
- **No download / share button.** Just play in place.
- **No reading of streaming-in-progress messages.** Button is rendered the same way as Copy — only on completed assistant messages (already gated by `showActions && message.role === 'assistant'` and the `placeholder` metadata check at `message-renderer.tsx:718-722`).

## Decisions

| Topic | Decision |
|---|---|
| Feature gate | `EXULU_USE_LITELLM === "true"` **and** `TTS_MODEL` non-empty. `TTS_VOICE` is optional — omitted from the LiteLLM call when unset; OpenAI requires a voice so admins targeting OpenAI must set it. |
| Env vars | Single shared `.env`. `TTS_MODEL` and `TTS_VOICE` read by the backend; frontend reads `TTS_MODEL` presence (same pattern as `TRANSCRIPTION_MODEL`). |
| Voice selection | Single global `TTS_VOICE` env var. No per-user, no in-chat picker. |
| Playback UX | Single shared `HTMLAudioElement`. Per-message state: idle → loading → playing ⇄ paused. Click on a *different* message stops the current one and starts the new one. |
| Cache | In-memory `Map<messageId, Blob>` per page. Cache hit on subsequent plays of the same message skips the backend call entirely. No eviction in v1. |
| Audio transport | Buffered binary. Backend returns `Content-Type: audio/mpeg` with the bytes; frontend wraps in a `Blob`, creates an object URL, plays. |
| Audio format | `response_format: "mp3"` sent in the LiteLLM request. Universally playable across browsers. |
| Text preprocessing | Frontend strips markdown formatting and replaces fenced code blocks with the literal phrase "(code omitted)". Stays on the frontend so the backend route is provider-shaped (text in, audio out). |
| Input length cap | 4000 chars after preprocessing. Truncated client-side with an informational toast; backend enforces the same cap defensively. Rationale: OpenAI TTS caps at 4096; 4000 is the round-number safe ceiling. |
| Auth | `requestValidators.authenticate(req)` — same JWT bearer check as `/transcribe` and other authenticated routes. |
| Failure surface | All errors come back as `{ detail: string }` JSON with an appropriate status code; frontend shows a toast with `detail` (or a generic fallback). |
| LiteLLM readiness | Route awaits `waitForLiteLLMReady()` with a 5s timeout before forwarding. 503 on timeout. |
| Boot-time warning | Mirror of the transcription warning: if `TTS_MODEL` is set but `EXULU_USE_LITELLM !== "true"`, log once at boot. |

## Architecture

### Data flow

```
User clicks the speaker icon on an assistant message
    └── handleTtsClick(message) decides based on current state for that message id:
          "playing"  → audio.pause(); state = "paused"
          "paused"   → audio.play();  state = "playing"
          else (idle / new message):
                Stop any currently playing audio (single shared element).
                Check ttsCacheRef for messageId:
                  HIT  → skip fetch
                  MISS → preprocessForTTS(message text):
                            - strip markdown
                            - replace ``` blocks with "(code omitted)"
                            - truncate at 4000 chars (toast if so)
                         If preprocessed text is empty → toast "Nothing to read", return.
                         POST {backend}/speech
                           Authorization: Bearer <jwt>, User: <user.id>
                           Content-Type: application/json
                           body: { text: <cleaned> }
                           └── routes.ts handler:
                                 - Feature gate (EXULU_USE_LITELLM + TTS_MODEL) → 503
                                 - requestValidators.authenticate → 401
                                 - Validate text present + length ≤ 4000 → 400 otherwise
                                 - await waitForLiteLLMReady() w/ 5s timeout → 503 on timeout
                                 - synthesizeSpeech({ text }) → Buffer
                                       POST http://${LITELLM_HOST}:${LITELLM_PORT}/v1/audio/speech
                                       JSON: { model, input: text, voice?, response_format: "mp3" }
                                       Authorization: Bearer ${LITELLM_MASTER_KEY}
                                       non-OK → throw SpeechError(status, body)
                                 - Response: Content-Type: audio/mpeg, body = Buffer
                                 - On error: { detail } JSON with mapped status
                         blob = await res.blob()
                         ttsCacheRef.set(messageId, blob)
                audio.src = URL.createObjectURL(blob); audio.currentTime = 0
                await audio.play(); state = "playing"
          audio.ended event → state = "idle"
```

### File map

**New files:**

| File | Purpose |
|---|---|
| `backend/src/exulu/speech.ts` | Exports `synthesizeSpeech({ text })` and `SpeechError`. Owns the LiteLLM-forwarding logic: reads env vars, builds the JSON body, calls `fetch`, returns `Buffer` or throws. |
| `frontend/lib/tts-text.ts` | Exports `preprocessForTTS(raw)`: strips markdown, omits code blocks, truncates to 4000 chars. Pure function — unit-testable. |

**Modified files:**

| File | Change |
|---|---|
| `backend/src/exulu/routes.ts` | Register `POST /speech` with `bodyParser.json({ limit: "64kb" })`. Feature gate, auth, validation, `waitForLiteLLMReady()`, call `synthesizeSpeech`, send `audio/mpeg` bytes, error mapping. |
| `backend/src/exulu/app/index.ts` | Extend the existing transcription boot-warning block to also warn when `TTS_MODEL` is set but `EXULU_USE_LITELLM !== "true"`. |
| `frontend/components/config-context.tsx` | Add `tts?: { enabled: boolean }` to `ConfigContextType`. |
| `frontend/app/(application)/layout.tsx` | Add `tts: { enabled }` block after `transcription`. |
| `frontend/components/message-renderer.tsx` | Add ttsState dict, cache ref, audio element ref, `handleTtsClick`, cleanup effect; render the speaker `MessageAction` (gated on `tts.enabled`) next to Copy/Retry. |

**Optional config (not code — admin step, documented in spec for completeness):** add a `tts-1` entry to `selise/config.litellm.yaml`, e.g.

```yaml
- model_name: tts-1
  litellm_params:
    model: tts-1
    api_key: os.environ/OPENAI_API_KEY
  model_info:
    mode: audio_speech
```

## Backend

### `src/exulu/speech.ts` (new)

```ts
export class SpeechError extends Error {
  constructor(
    public readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

/**
 * Forward a text string to the LiteLLM proxy's /v1/audio/speech endpoint and
 * return the MP3 bytes. Reads LITELLM_HOST / LITELLM_PORT / LITELLM_MASTER_KEY
 * / TTS_MODEL / TTS_VOICE from process.env.
 *
 * Caller is responsible for: feature-gate checks, auth, text validation,
 * waiting for the LiteLLM supervisor to be ready.
 */
export async function synthesizeSpeech(args: {
  text: string;
}): Promise<Buffer> {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  const model = process.env.TTS_MODEL;
  const voice = process.env.TTS_VOICE;

  if (!masterKey) throw new Error("LITELLM_MASTER_KEY is not set");
  if (!model) throw new Error("TTS_MODEL is not set");

  const body: Record<string, unknown> = {
    model,
    input: args.text,
    response_format: "mp3",
  };
  if (voice) body.voice = voice;

  const res = await fetch(`http://${host}:${port}/v1/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${masterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SpeechError(
      res.status,
      `LiteLLM speech failed (status ${res.status}): ${text}`.trim(),
    );
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}
```

### `src/exulu/routes.ts` — new route

Registered alongside `/transcribe` (mirrors its shape, but JSON instead of multipart):

```ts
import { synthesizeSpeech, SpeechError } from "./speech.ts";

const MAX_TTS_INPUT_CHARS = 4000;

app.post(
  "/speech",
  bodyParser.json({ limit: "64kb" }),
  async (req: Request, res: Response) => {
    if (!isLiteLLMEnabled() || !process.env.TTS_MODEL) {
      res.status(503).json({
        detail:
          "Text-to-speech is not enabled on this deployment. " +
          "Set EXULU_USE_LITELLM=true and TTS_MODEL in the environment.",
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

    const text =
      typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ detail: "Missing 'text' in request body." });
      return;
    }
    if (text.length > MAX_TTS_INPUT_CHARS) {
      res.status(400).json({
        detail: `Text too long (${text.length} chars). Max ${MAX_TTS_INPUT_CHARS}.`,
      });
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
        .json({ detail: "Speech service is not ready. Try again shortly." });
      return;
    }

    try {
      const audio = await synthesizeSpeech({ text });
      res.status(200);
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", String(audio.length));
      res.setHeader("Cache-Control", "no-store");
      res.send(audio);
    } catch (err) {
      if (err instanceof SpeechError) {
        const code = err.upstreamStatus >= 500 ? 502 : err.upstreamStatus;
        res.status(code).json({ detail: err.message });
        return;
      }
      console.error("[EXULU] /speech failed", err);
      res.status(500).json({
        detail: err instanceof Error ? err.message : "Speech generation failed.",
      });
    }
  },
);
```

### `src/exulu/app/index.ts` — extended boot warning

After the existing `TRANSCRIPTION_MODEL` warning block:

```ts
if (process.env.TTS_MODEL && !isLiteLLMEnabled()) {
  console.warn(
    "[EXULU] TTS_MODEL is set but EXULU_USE_LITELLM is not 'true'. " +
      "The /speech endpoint will return 503 until LiteLLM is enabled.",
  );
}
```

## Frontend

### `frontend/components/config-context.tsx`

Extend `ConfigContextType`:

```ts
transcription?: { enabled: boolean };  // existing
tts?: { enabled: boolean };
```

### `frontend/app/(application)/layout.tsx`

Add the `tts` block after `transcription`:

```ts
tts: {
  enabled:
    typeof process.env.TTS_MODEL === "string" &&
    process.env.TTS_MODEL !== "" &&
    process.env.EXULU_USE_LITELLM === "true",
},
```

### `frontend/lib/tts-text.ts` (new)

```ts
export const MAX_TTS_CHARS = 4000;

export function preprocessForTTS(raw: string): { text: string; truncated: boolean } {
  let s = raw;
  // Fenced code blocks → spoken placeholder.
  s = s.replace(/```[\s\S]*?```/g, " (code omitted) ");
  // Inline code: keep contents, drop backticks.
  s = s.replace(/`([^`]+)`/g, "$1");
  // Markdown links: keep label, drop URL.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Images: drop entirely.
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  // Bold / italic markers.
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  // Headings.
  s = s.replace(/^#{1,6}\s+/gm, "");
  // Blockquotes.
  s = s.replace(/^>\s?/gm, "");
  // Bulleted + ordered list markers.
  s = s.replace(/^[\s]*[-*+]\s+/gm, "");
  s = s.replace(/^[\s]*\d+\.\s+/gm, "");
  // Horizontal rules.
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();

  if (s.length > MAX_TTS_CHARS) {
    return { text: s.slice(0, MAX_TTS_CHARS), truncated: true };
  }
  return { text: s, truncated: false };
}
```

### `frontend/components/message-renderer.tsx`

**State + refs** added near the top of the component:

```ts
const ttsEnabled = configContext?.tts?.enabled === true;
type TTSState = "idle" | "loading" | "playing" | "paused";
const [ttsStateByMessage, setTtsStateByMessage] = useState<Record<string, TTSState>>({});
const ttsCacheRef = useRef<Map<string, Blob>>(new Map());
const audioElRef = useRef<HTMLAudioElement | null>(null);
const playingMessageIdRef = useRef<string | null>(null);
```

**Handler:**

```ts
const handleTtsClick = async (message: UIMessage) => {
  // Lazy-init the shared audio element.
  if (!audioElRef.current) {
    const el = new Audio();
    el.addEventListener("ended", () => {
      const id = playingMessageIdRef.current;
      if (id) setTtsStateByMessage((s) => ({ ...s, [id]: "idle" }));
      playingMessageIdRef.current = null;
    });
    audioElRef.current = el;
  }
  const audio = audioElRef.current;
  const currentState = ttsStateByMessage[message.id] ?? "idle";

  // Toggle pause/resume for the *currently playing* message.
  if (currentState === "playing") {
    audio.pause();
    setTtsStateByMessage((s) => ({ ...s, [message.id]: "paused" }));
    return;
  }
  if (currentState === "paused" && playingMessageIdRef.current === message.id) {
    await audio.play();
    setTtsStateByMessage((s) => ({ ...s, [message.id]: "playing" }));
    return;
  }

  // Fresh play. Stop whatever's currently playing first.
  if (playingMessageIdRef.current && playingMessageIdRef.current !== message.id) {
    audio.pause();
    audio.currentTime = 0;
    const prevId = playingMessageIdRef.current;
    setTtsStateByMessage((s) => ({ ...s, [prevId]: "idle" }));
  }

  // Cache hit → skip fetch.
  let blob = ttsCacheRef.current.get(message.id);
  if (!blob) {
    setTtsStateByMessage((s) => ({ ...s, [message.id]: "loading" }));
    const raw = message.parts?.map((p: any) => p?.text ?? "").join("\n") ?? "";
    const { text, truncated } = preprocessForTTS(raw);
    if (!text) {
      toast({ title: "Nothing to read", description: "Message has no readable text.", variant: "destructive" });
      setTtsStateByMessage((s) => ({ ...s, [message.id]: "idle" }));
      return;
    }
    if (truncated) {
      toast({ title: "Long message truncated", description: "Only the first 4000 characters will be read." });
    }
    try {
      const token = await getToken();
      if (!token) throw new Error("No valid session token available.");
      const res = await fetch(`${configContext?.backend}/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          User: user.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ detail: "Speech generation failed." }));
        throw new Error(errBody.detail || "Speech generation failed.");
      }
      blob = await res.blob();
      ttsCacheRef.current.set(message.id, blob);
    } catch (err) {
      toast({ title: "Couldn't play message", description: err instanceof Error ? err.message : "Please try again.", variant: "destructive" });
      setTtsStateByMessage((s) => ({ ...s, [message.id]: "idle" }));
      return;
    }
  }

  audio.src = URL.createObjectURL(blob);
  audio.currentTime = 0;
  playingMessageIdRef.current = message.id;
  try {
    await audio.play();
    setTtsStateByMessage((s) => ({ ...s, [message.id]: "playing" }));
  } catch {
    setTtsStateByMessage((s) => ({ ...s, [message.id]: "idle" }));
  }
};

// Cleanup on unmount: stop audio + revoke any object URLs + clear cache.
useEffect(() => () => {
  audioElRef.current?.pause();
  if (audioElRef.current?.src.startsWith("blob:")) {
    URL.revokeObjectURL(audioElRef.current.src);
  }
  audioElRef.current = null;
  ttsCacheRef.current.clear();
}, []);
```

**Button** — slotted in among the existing `MessageAction`s in `message-renderer.tsx:723-828`. Goes right after Copy:

```tsx
{ttsEnabled && showActions && message.role === 'assistant' && (
  <MessageAction
    className="mr-1"
    onClick={() => handleTtsClick(message)}
    label={
      (ttsStateByMessage[message.id] ?? "idle") === "playing"
        ? "Pause"
        : (ttsStateByMessage[message.id] ?? "idle") === "paused"
          ? "Resume"
          : "Read aloud"
    }
  >
    {ttsStateByMessage[message.id] === "loading" && <Loader2 className="size-3 animate-spin" />}
    {ttsStateByMessage[message.id] === "playing" && <Pause className="size-3" />}
    {(!ttsStateByMessage[message.id] || ttsStateByMessage[message.id] === "idle" || ttsStateByMessage[message.id] === "paused") && <Volume2 className="size-3" />}
  </MessageAction>
)}
```

New imports: `Volume2`, `Pause`, `Loader2` from `lucide-react`; `preprocessForTTS` from `@/lib/tts-text`.

## Error handling matrix

| Condition | Where caught | Status | User sees |
|---|---|---|---|
| `EXULU_USE_LITELLM !== "true"` OR `TTS_MODEL` empty | Frontend doesn't render the button | n/a | (no UI) |
| Backend feature gate trips anyway (defense-in-depth) | Route returns 503 | 503 | Toast: backend `detail` |
| Empty text after preprocessing | Frontend pre-check before fetch | n/a | Toast: "Nothing to read" |
| Message > 4000 chars after preprocessing | Frontend truncates + informational toast | 200 | Toast: "Long message truncated" + audio plays |
| Backend 400 (still too long somehow) | Route validation | 400 | Toast: backend `detail` |
| LiteLLM supervisor not ready within 5s | Route catches timeout | 503 | Toast: "Speech service is not ready…" |
| LiteLLM 4xx (e.g. invalid voice/model name) | `SpeechError` → forward status | upstream code | Toast: backend `detail` |
| LiteLLM 5xx / network error | `SpeechError` → mapped to 502 | 502 | Toast: backend `detail` |
| Browser autoplay blocked (rare — user just clicked) | `audio.play()` catch | n/a | State silently reverts to idle; user can click again |
| User clicks Play on B while A is playing | `playingMessageIdRef` swap | n/a | A stops, B starts from 0 |
| User navigates away while playing | Cleanup `useEffect` pauses + revokes URL + clears cache | n/a | (no leak) |
| Cache grows over a long session | Bounded by visible assistant messages on page. No eviction in v1. | n/a | ~50KB per played message. Acceptable. |

## Testing notes

- **Backend unit test** (`speech.test.ts`): mock global `fetch`; assert outbound URL, `Authorization` header, JSON body contains `model = ${TTS_MODEL}`, `input = <text>`, `response_format = "mp3"`, `voice` present iff `TTS_VOICE` set; assert `SpeechError` thrown with upstream status on non-OK; assert env-missing errors throw synchronously.
- **Backend route test** (extends `routes` test suite if one exists, else focused supertest): `/speech` with feature disabled → 503; no auth → 401; no text → 400; oversize text → 400; valid input + mocked `synthesizeSpeech` → 200 with `Content-Type: audio/mpeg` and the returned bytes as body.
- **Frontend unit test** (`tts-text.test.ts`): `preprocessForTTS` strips bold/italic/headings/lists, omits code blocks with the placeholder, drops URLs but keeps link labels, drops images entirely, truncates over 4000 chars and reports `truncated: true`.
- **Manual frontend QA**: feature hidden when env unset; play short message → audio plays end-to-end; click Pause mid-playback → audio pauses; click again → resumes from same position; click Play on a different message → first stops, second starts from 0; replay the first → starts from 0 again, no backend call (cache hit); message with only a code block → "Nothing to read" toast; message > 4000 chars → truncation toast and only the first 4000 chars read; mic / autoplay quirks across Chrome, Firefox, Safari.
