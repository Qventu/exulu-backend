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
    { "role": "system", "content": "<verbatim-ASR instruction>" },
    { "role": "user", "content": [
      { "type": "text", "text": "Transcribe this audio.<optional: The language is de.>" },
      { "type": "input_audio", "input_audio": { "data": "<base64>", "format": "wav" } }
    ]}
  ]
}
```

- **System prompt:** "You are an automatic speech recognition engine. Transcribe the audio
  verbatim in its original language. Output only the transcript text — no quotes, labels,
  commentary, or translation. If there is no intelligible speech, output nothing." The
  optional `language` hint from the composer is appended to the user text part.
- `reasoning_effort: "disable"` guards the Gemini thinking-token starvation failure mode
  (see reference memory `gemini3-thinking-token-starvation`).
- **Response:** read `choices[0].message.content`, trim, strip stray wrapping quotes/backticks;
  empty/whitespace → `{ text: "" }`.
- **Contract unchanged:** the `/transcribe` route, gating (`EXULU_USE_LITELLM=true` **and**
  `TRANSCRIPTION_MODEL` set), multer + 25 MB limit, `TranscriptionError(status, body)`, and the
  `{ text }` response shape are all identical. No route or GraphQL change.

### 3. Audio format — client-side WAV re-encode

The composer records `audio/webm;codecs=opus` (Chrome/Firefox) or `audio/mp4` (Safari).
Gemini's API documents only **wav, mp3, aiff, aac, ogg, flac** — `webm` (the Chrome/Firefox
majority) is not supported, and no single browser can natively record a Gemini-supported format
cross-browser (Chrome cannot record ogg/wav; Safari cannot record webm). A conversion step is
therefore required.

**Verify first (implementation step 1):** a tsx repro against local LiteLLM sends a real `webm`
clip to the Gemini model. If it transcribes cleanly, conversion is dropped entirely. If it
400s (expected), we implement the conversion below.

**Conversion location: client-side.** The composer decodes the recording via WebAudio
(`AudioContext.decodeAudioData`) and re-encodes to **16 kHz mono 16-bit PCM WAV** before upload
(~40-line util). Rationale:

- No backend system dependency. `@exulu/backend` is self-hosted per client (Dokploy etc.);
  a server-side ffmpeg transcode would force ffmpeg onto every client install.
- Works cross-browser (WebAudio decodes both webm/opus and mp4/aac).
- 16 kHz mono is optimal for speech models and yields a smaller payload.
- WAV is also accepted by the whisper `/audio/transcriptions` path, so the existing (selise)
  deployments keep working after the upload format changes webm → wav (harmless).
- **Fallback:** if `decodeAudioData` throws (exotic codec), upload the original blob unchanged
  and let the backend/model attempt it — no hard failure.

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
- Entry routed to chat but `supports_audio_input` is false → fail fast with a clear config
  error rather than a confusing Gemini 400.
- Silent clip → Gemini returns empty → `{ text: "" }` (matches Whisper-on-silence).
- Non-200 from `/chat/completions` → `TranscriptionError(status, body)` (identical surface).

### 6. Testing & rollout

- **Step 1 (verify-first):** tsx repro against local LiteLLM — confirm whether `webm` needs
  conversion, and that the `input_audio` + `reasoning_effort: "disable"` shape returns clean
  text.
- **Backend unit tests:** routing decision (catalog entry → endpoint choice, incl. fallback),
  chat request builder, response parsing/cleanup. Mock `fetch` + `findLiteLLMModel`.
- **Frontend test:** WAV encoder produces a valid 16 kHz-mono WAV header from a known buffer.
- **Manual smoke:** record in Chrome + Safari against a newlkiag-style Gemini config; verify
  German + English short clips.

## Out of scope (YAGNI)

- Streaming / partial transcription.
- Diarization and per-segment timestamps (belong to the separate transcriptions-page spec).
- Replacing the self-hosted Whisper server (separate follow-up spec).
