# Plan — Speech-to-text in chat

Spec: `docs/superpowers/specs/2026-05-24-speech-to-text-transcription-design.md`
Implementation refs:
- Frontend mic button: `frontend/.../chat.tsx:1184-1212`
- Frontend handlers: `chat.tsx:621-720` (startRecording, stopRecording, handleRecordingStop)
- Backend route: `backend/src/exulu/routes.ts:1105-1188` (`POST /transcribe`)
- LiteLLM forwarder: `backend/src/exulu/transcribe.ts`

## Hook (one line, benefit-language)

> **Talk to your agent — we'll type it for you.**

(Alt options if this lands flat: "Speak instead of typing. Anywhere you chat." / "One click. Speak. Send.")

## Surface area

UI feature + a small developer-facing REST endpoint. → **One animated slice + an inline code snippet.**

## Slice 1 — The UI flow (the only animated short)

**Duration:** 7s. **Aspects:** 1920×1080 (page) and 1080×1920 (social).

**Reconstruction notes — copy the real UI, don't paraphrase:**

- Background: `hsl(0 0% 99.22%)` (page `--background`)
- Chat input row at the bottom — a `card` with `border` and small radius (~`0.4rem`)
- Textarea on the left, mic button + submit button on the right, both `variant="secondary" size="icon"`
- Mic button states (from `chat.tsx:1204-1210`):
  - **idle:** `<Mic size-6 text-muted-foreground />` (`hsl(0 0% 32.16%)`)
  - **recording:** `<Square size-6 text-red-500 animate-pulse />` (red `#ef4444`, pulsing)
  - **transcribing:** `<Loading size-6 />` (spinner)
- Submit button: `<ArrowUp size-6 text-muted-foreground />`
- Font: Inter, body weight 400, captions 500
- Placeholder text in textarea (from `chat.tsx:1179`): "Ask me anything..."

**Beats:**

| t | What's on screen |
|---|---|
| 0.0–1.0s | Hook line fades in centered above the input: "Talk to your agent." Inter 56–64px, primary purple `hsl(257.94 100% 60%)` on word "Talk", rest near-black. |
| 1.0–1.8s | Hook fades out. Camera "moves to" the input row (subtle scale-up). Reconstructed input row sits centered. Placeholder visible: "Ask me anything..." |
| 1.8–2.4s | A simulated cursor (small chevron pointer) glides from center to the mic button. |
| 2.4–2.7s | Click. Mic icon swaps to red `Square` with `animate-pulse` (1.5s loop). A *very* subtle waveform line ripples horizontally inside the textarea region — just enough to convey "we're listening." |
| 2.7–4.6s | Hold the recording state for ~2s. Below the input, a small `text-muted-foreground` caption fades in: "Listening…" |
| 4.6–4.9s | Cursor glides back to mic. Click. Square swaps to spinner (the `Loading` glyph) for ~0.4s. |
| 4.9–6.2s | Spinner disappears. Mic returns to idle. Text streams into the textarea, fast (≈ 25 chars per 100ms): **"What's the status of the Q4 launch?"** Cursor lands in the textarea, blinking. The submit button stays disabled-looking during the type-in, then enables (foreground color shifts from muted to default) when the stream finishes. |
| 6.2–7.0s | Caption fades in below the input: **"Auto-detects 50+ languages."** Hold still — this is the resting frame for the loop. |

**Why this arc:** the three button states are the load-bearing visual of the feature; we want each one to be readable. The typed-in text mirrors how the real product appends to existing input (with a space). The closing caption sells the under-the-hood Whisper benefit without code.

## Code snippet (inline, next to the slice, not animated)

The REST endpoint is genuinely usable from outside the product — it earns the spot.

```bash
curl -X POST "$EXULU_BACKEND/transcribe" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@recording.webm" \
  -F "language=en"

# → { "text": "What's the status of the Q4 launch?" }
```

Label above the snippet block: **From the API**.

## Page copy (what goes under the video, two short paragraphs)

> Speak instead of typing. The mic button next to send records your voice and turns it into text — no autosend, you stay in control. Press send when you're happy with what you said.

> Powered by the LiteLLM proxy and OpenAI-compatible Whisper, with an optional `language` hint for short clips. 25 MB cap, ~25 minutes of audio per recording. Mic permission is asked once per browser.

## Footer / CTA

- Feature flag note (smaller text): "Available when `EXULU_USE_LITELLM=true` and `TRANSCRIPTION_MODEL` is set."
- Link: "Read the design doc" → `docs/superpowers/specs/2026-05-24-speech-to-text-transcription-design.md` (internal — switch to a public docs link before publishing).
