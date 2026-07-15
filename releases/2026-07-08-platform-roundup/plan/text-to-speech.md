# Feature plan — Text-to-speech: read replies aloud (SHORT)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-05-25-text-to-speech-design.md`
- Backend: `src/exulu/speech.ts` (synthesizeSpeech), `src/exulu/routes.ts` `POST /speech`
  (commits `091e186`, `ab3af43`)
- Frontend UI: `frontend/components/message-renderer.tsx` (lines ~1210–1226, speaker
  MessageAction), `frontend/lib/tts-text.ts` (preprocessForTTS, chunkForTTS)
- Tooltip labels are hardcoded English in message-renderer.tsx: "Read aloud" /
  "Pause" / "Resume" (NOT in en.json)

## What shipped

A speaker button in the message-actions row under every completed assistant
message. Click → the reply is preprocessed (markdown stripped, code blocks
become "(code omitted)", 4000-char cap), sent to `POST /speech`, which forwards
to LiteLLM `/v1/audio/speech` and returns MP3 bytes; the frontend plays them
inline. Click again to pause, click a different message to switch. Per-message
blob cache means replays skip the backend entirely.

Shipped deviations from spec worth stating correctly:
- Gate requires **all three**: `EXULU_USE_LITELLM=true`, `TTS_MODEL`, **and
  `TTS_VOICE`** (LiteLLM's router rejects voiceless requests — commit `091e186`).
- Frontend chunks long messages into ~300-char sentence chunks
  (`TTS_CHUNK_TARGET_CHARS = 300`, max 500) with up to `TTS_MAX_CONCURRENT = 5`
  requests in flight — first audio in ~2–3s even on long replies.

## Hook

**"Read replies aloud"** — any assistant message becomes audio with one click.

## Surface area

UI feature (recipe A) + a real REST endpoint. The demo reconstructs the chat
message-actions row; the page prose earns a curl snippet for `POST /speech`.

## Reconstruction cues (exact, from the shipped code)

- Assistant message: markdown text block on light bg `#FDFDFD`, borders `#E7E7EE`,
  Inter, foreground `#000`.
- Actions row (`MessageActions`, mt-2) — small ghost icon buttons, each icon
  `size-3` (12px), muted-foreground, `mr-1` gap, in this exact order:
  1. Retry — `RefreshCcwIcon`
  2. Copy — `CopyIcon`
  3. **Read aloud — `Volume2`** ← the star
  4. Download — `DownloadIcon`
  5. Good response — `ThumbsUp`, Bad response — `ThumbsDown`
  6. trailing `<small class="text-muted-foreground">` token count, e.g.
     "1,284 tokens · 951 in / 333 out"
- Button states: idle `Volume2` → loading `Loader2` (spin) → playing `Pause`.
  Tooltip text: "Read aloud" → "Pause".
- The real app has NO waveform — the only product-chrome change is the icon
  swap. The 3-bar equalizer below lives in the CAPTION layer (next to the
  "Playing…" label), visually separate from the reconstructed UI card.

## Demo arc — `text-to-speech.mp4`, 1920×1080, 9.4s, ONE action (click speaker)

| t (s) | What's on screen | Rule honored |
|---|---|---|
| 0.0–0.4 | Hook "Read replies aloud" fades in | entrance |
| 0.4–1.6 | Hook holds still (1.2s) | ≥1.0s short-phrase floor |
| 1.6–2.2 | Crossfade to chat: assistant reply + actions row (all 6 actions visible) | pivot |
| 2.2–2.9 | Cursor glides to the speaker icon | approach |
| 2.9–3.2 | Click → icon swaps to `Loader2` spinner | the action |
| 3.2–3.8 | Spinner spins (~600ms, mirrors real time-to-first-audio) | honest rhythm |
| 3.8 | Icon swaps to `Pause` — playing state | state change |
| 3.8–4.4 | Hold the playing state completely still (600ms) | breath after action |
| 4.4–4.8 | Caption "Playing…" + tiny 3-bar equalizer fades in (caption layer, not UI) | ambient label |
| 4.8–6.0 | Caption holds (1.2s), bars animate subtly | ≥1.0s floor |
| 6.0–6.4 | Caption fades out | clear stage |
| 6.4–7.0 | Hold (600ms) | breath before payoff |
| 7.0–7.4 | Payoff "Any reply, spoken — one click." fades in | entrance |
| 7.4–9.4 | Payoff holds still (2.0s); final ~0.6s fully still | ≥1.4s fragment floor + loop rest |

## Code snippet — EARNED (REST, curl)

Real route: `app.post("/speech", ...)` at `src/exulu/routes.ts:1353`. Auth is the
standard JWT bearer; body `{ text }`; response `audio/mpeg`.

```bash
# Any authenticated client can synthesize speech:
curl -X POST "$EXULU_BACKEND/speech" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"text":"Here is the summary you asked for."}' \
  --output reply.mp3
```

Label on page: "REST — text in, MP3 out". Note in prose: gated on
`EXULU_USE_LITELLM=true` + `TTS_MODEL` + `TTS_VOICE`; 4000-char input cap.
