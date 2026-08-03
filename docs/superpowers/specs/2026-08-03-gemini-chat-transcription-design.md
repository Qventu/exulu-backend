# Gemini-via-chat speech-to-text for the composer

**Date:** 2026-08-03
**Status:** Design approved, pending implementation
**Related:** [2026-05-24-speech-to-text-transcription-design.md](./2026-05-24-speech-to-text-transcription-design.md) (original composer STT via LiteLLM `/audio/transcriptions`)

## Problem

The composer's speech-to-text feature (`frontend/app/(application)/chat/components/composer.tsx` →
`POST /transcribe` → `backend/src/exulu/transcribe.ts` → LiteLLM `/v1/audio/transcriptions`)
works when `TRANSCRIPTION_MODEL` resolves to an OpenAI-compatible transcription model
(e.g. `whisper-1`). It **fails** for a GCP-based model such as Chirp 3:

```
litellm.APIConnectionError: Unmapped provider passed in. Unable to get the response.
  File ".../litellm/main.py", line 6750, in transcription
    raise ValueError("Unmapped provider passed in. Unable to get the response.")
```

### Root cause (confirmed, LiteLLM 1.85.1)

LiteLLM has **no Vertex / Google Cloud Speech-to-Text support at all**. This is not a config
bug — no `config.litellm.yaml` entry can make it work through the transcription proxy.

- `litellm.transcription()` (`main.py:6619`) only dispatches to these providers:
  **openai (whisper/gpt-4o), azure, groq, deepgram, elevenlabs, fireworks_ai, hosted_vllm,
  watsonx, ovhcloud, scaleway, mistral, nvidia_riva** (see
  `ProviderConfigManager.get_provider_audio_transcription_config`, `utils.py:8505`).
- For `vertex_ai`, `get_provider_audio_transcription_config()` returns `None`, no
  `custom_llm_provider ==` branch matches, `response` stays `None`, and `main.py:6750` raises
  the "Unmapped provider" error. Exactly the observed stack trace.
- LiteLLM's Vertex integration ships only `text_to_speech` (the opposite direction). Grepping
  `litellm/llms/vertex_ai/` for `chirp` / `speech_to_text` / `BatchRecognize` returns nothing.
- `model_info.type: speech_to_text` is **our own UI/catalog filter**, not a LiteLLM routing
  hint. Whisper worked only because `whisper-1` maps to provider `openai`.
- Google's Chirp 3 uses the **Speech-to-Text v2 API** (`speech.googleapis.com`,
  `SpeechClient` / `BatchRecognize` / `Recognize`) — a different API shape on a different host
  than the `aiplatform` endpoint LiteLLM's Vertex passthrough targets, so even the passthrough
  cannot reach it.

Rejected alternative: a LiteLLM **custom provider** (`custom_provider_map`) cannot fix this
either — `CustomLLM` defines only `completion`/`acompletion`/`image_generation`, and the
custom-provider dispatch exists only in the completion (`main.py:4415`) and embedding
(`main.py:5788`) paths, never in `transcription()`. A custom handler would never be reached by
`/v1/audio/transcriptions`.

## Chosen approach: transcribe via Gemini chat completions

Vertex Gemini chat **does** accept audio input — LiteLLM's Vertex chat transformation handles
an `input_audio` content part (`vertex_ai/gemini/transformation.py:371`). So instead of the
transcription endpoint, the backend sends the audio to `/v1/chat/completions` with a
"transcribe verbatim" instruction. This reuses the existing `dx-newlift` Vertex service account
(already wired for every other Gemini/embedding/OCR model), adds no new infrastructure, and
keeps LiteLLM spend tracking.

**Scope:** this spec covers **only the composer's short-clip STT**. Replacing the separate
self-hosted Whisper server behind the transcriptions page
(`frontend/app/(application)/transcriptions/page.tsx`) is a **separate follow-up spec** — that
pipeline needs per-segment timestamps and speaker diarization (for the audio-scrubber review
UI and long meetings), which Gemini-via-chat does not reliably provide. Google STT v2 (Chirp)
batch is the natural candidate there and will be evaluated in its own document.

## Design

### 1. Routing by config metadata (no new env var)

`transcribe.ts` looks up `TRANSCRIPTION_MODEL` in the LiteLLM catalog
(`findLiteLLMModel()` → `fetchLiteLLMCatalog()`, `/model/info`, 30s cache) and routes on the
entry's `upstream_model`:

- upstream is a **Gemini/Vertex chat** model (e.g. `vertex_ai/gemini-2.5-flash`) →
  `POST /v1/chat/completions` with an `input_audio` part (new path).
- otherwise (`whisper-1`, deepgram, …) → `POST /v1/audio/transcriptions` (unchanged).
- catalog lookup empty/fails → **fall back to the audio endpoint** (today's behavior; zero
  regression for existing whisper deployments).

Detection rule: treat the upstream as a chat model when its provider is `vertex_ai` **and** the
model id contains `gemini` (Chirp's `vertex_ai/chirp-3` deliberately does **not** match — Chirp
is abandoned for the composer). The STT entry keeps `type: speech_to_text`, so it stays hidden
from the inference picker (`frontend/app/(application)/chat/hooks.ts:1191` filters
`speech_to_text` and `text_to_speech`). No frontend change to routing/filtering.

### 2. The chat transcription call

Raw `fetch` to `/v1/chat/completions` (same style as today's `transcribe.ts`), body:

```jsonc
{
  "model": "<TRANSCRIPTION_MODEL>",
  "temperature": 0,
  "reasoning_effort": "disable",   // Gemini 2.5/3 thinking counts against output → empty/slow without it
  "messages": [
    { "role": "system", "content": "<never-translate ASR instruction>" },
    { "role": "user", "content": [
      { "type": "text", "text": "Transcribe this audio." },
      { "type": "input_audio", "input_audio": { "data": "<base64>", "format": "wav" } }
    ]}
  ]
}
```

- **System prompt:** "You are a speech-to-text transcription engine. Detect the language actually
  spoken and transcribe it word-for-word in that same language. Never translate. Output only the
  transcript text — no quotes, labels, or commentary. If there is no intelligible speech, output
  nothing."
- **No language hint (fixed 2026-08-03).** The composer sends the user's UI locale as `language`,
  which is frequently `en` even when the speaker uses another language. Injecting it as
  "The audio language is en" was an authoritative pro-English signal that nudged Gemini into
  **translating** German speech to English. The chat path therefore ignores `args.language` and
  relies on Gemini's auto-detection plus the never-translate instruction (verified DE→DE / EN→EN
  on short and long clips). `args.language` remains meaningful only for the whisper
  `/audio/transcriptions` path.
- `reasoning_effort: "disable"` guards the Gemini thinking-token starvation failure mode
  (see reference memory `gemini3-thinking-token-starvation`).
- **Response:** read `choices[0].message.content`, trim, strip stray wrapping quotes/backticks;
  empty/whitespace → `{ text: "" }`.
- **Contract unchanged:** the `/transcribe` route, gating (`EXULU_USE_LITELLM=true` **and**
  `TRANSCRIPTION_MODEL` set), multer + 25 MB limit, `TranscriptionError(status, body)`, and the
  `{ text }` response shape are all identical. No route or GraphQL change.

### 3. Audio format — no conversion needed (verified)

The composer records `audio/webm;codecs=opus` (Chrome/Firefox) or `audio/mp4` (Safari). The
Gemini API *documents* only wav/mp3/aiff/aac/ogg/flac, which raised the concern that `webm`
would be rejected and require a conversion step.

**Verify-first result (2026-08-03, against the real newlkiag upstream `vertex_ai/gemini-3.5-flash`
via local LiteLLM :4000):** `webm/opus`, `mp4/aac`, `wav`, and `ogg` **all transcribe cleanly** —
each returned the exact verbatim transcript with `reasoning_effort: "disable"`. The `webm` sample
was a genuine opus-in-webm clip encoded via the backend's bundled PyAV. Vertex is more lenient
than the documented Gemini list.

**Consequence:** no audio conversion is needed and the composer requires **zero changes**. The
backend derives the `input_audio.format` from the upload's mimetype:
`mimetype.replace(/^audio\//, "").split(";")[0]` →
`audio/webm;codecs=opus` → `"webm"`, `audio/mp4` → `"mp4"`, `audio/ogg` → `"ogg"`,
`audio/wav` → `"wav"` — all verified working.

**Deferred fallback (not built):** if a future model/region rejects `webm`, the escape hatch is a
client-side re-encode to 16 kHz-mono WAV in the composer (WebAudio `decodeAudioData` +
`OfflineAudioContext`), with a raw-blob fallback on decode failure. Documented here so the option
is known; not implemented because verification showed it is unnecessary. No backend ffmpeg
dependency is added (`@exulu/backend` is self-hosted per client, so a server-side transcode is
avoided by design).

### 4. Config changes (newlkiag)

`config.litellm.yaml`: swap the broken `chirp3` entry's upstream and keep the type:

```yaml
- model_name: gemini-transcribe        # rename optional; keeping "chirp3" also works
  litellm_params:
    model: vertex_ai/gemini-2.5-flash  # was vertex_ai/chirp-3
    vertex_ai_project: "dx-newlift"
    vertex_ai_location: "eu"
  model_info:
    type: speech_to_text               # unchanged → stays hidden from the inference picker
    brand: "google"
    region: "eu"
```

Set `TRANSCRIPTION_MODEL` to that `model_name`. No env-var additions. selise's whisper config
is untouched.

### 5. Error handling & edge cases

- Catalog empty/fails → default to the audio endpoint (no regression).
- Detection relies on the upstream being a Gemini/Vertex chat model, which inherently supports
  audio input. The `supports_audio_input` catalog flag is **not** used as a hard gate — it is an
  optional config field authors frequently leave unset (→ `false`), so gating on it would wrongly
  reject valid Gemini models. A genuinely mis-pointed model surfaces as a normal
  `TranscriptionError` from the Gemini 4xx.
- Silent clip → Gemini returns empty → `{ text: "" }` (matches Whisper-on-silence).
- Non-200 from `/chat/completions` → `TranscriptionError(status, body)` (identical surface).

### 6. Testing & rollout

- **Step 1 (verify-first): DONE** — confirmed `webm/mp4/wav/ogg` all transcribe via
  `vertex_ai/gemini-3.5-flash`, and that the `input_audio` + `reasoning_effort: "disable"` shape
  returns clean verbatim text. Conversion dropped as a result.
- **Backend unit tests:** routing decision (catalog entry → endpoint choice, incl. fallback),
  chat request builder (incl. `format` derived from mimetype), response parsing/cleanup. Mock
  `fetch` + `findLiteLLMModel`.
- **Manual smoke:** record in Chrome + Safari against the newlkiag Gemini config; verify German +
  English short clips (and that the model stays hidden from the inference picker).

## Out of scope (YAGNI)

- Streaming / partial transcription.
- Diarization and per-segment timestamps (belong to the separate transcriptions-page spec).
- Replacing the self-hosted Whisper server (separate follow-up spec).
