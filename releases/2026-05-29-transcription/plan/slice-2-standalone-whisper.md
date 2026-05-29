# Slice 2 — `npm run start:whisper` (the dev moment)

**The infra story.** The transcription server is standalone — devs can run it on a separate (typically GPU) box without splitting their repo. This slice exists so the technical reader understands "I can scale this independently."

Spec: `docs/superpowers/specs/2026-05-28-transcription-feature-design.md`
Implementation refs:
- Supervisor: `backend/src/exulu/transcription/supervisor.ts`
- CLI entry: `backend/src/cli/start-whisper.ts`
- npm scripts: `backend/package.json` (`start:whisper`, bin `exulu-start-whisper`)

## Hook (one line, benefit-language)

> **Same package. Separate machine. One env var.**

## Surface area

Infra / dev-experience feature → terminal-style demo + a small architecture sketch + an inline code snippet next to the video.

## Duration & aspect

**7.4s. 1920×1080 + 1080×1920.**

## Reconstruction notes

A terminal pane and an architectural sketch coexist on screen — not a fake mac terminal chrome, just a dark rounded rectangle with the brand mono font.

- **Terminal rectangle:** width ~720px in 1920 layout, height ~360px. Background `#0a0a0a`, text `#fafafa`, JetBrains Mono 14px, line height 1.55. Rounded corners `0.4rem`. Subtle border `1px solid #1e1e22`. Top-left: a small `npm` chip in primary purple `#6633ff`.
- **Architecture sketch:** two rounded boxes connected by a labeled arrow, **wrapped in an outer dashed boundary labelled "your environment".**
  - Outer boundary: dashed 1px `#525252` (muted), rounded corners, padding 32px, top-left label chip "your environment" in Inter 11/600 muted on accent `#dde6ff` background.
  - Left box: "Exulu app" — white card, `border #e8e8ee`, `radius 0.4rem`, padding 16px, label in Inter 600 14px, sub-label `Node` in muted gray 12px.
  - Right box: "Whisper server" — same chrome, but with a thin top stripe in primary purple `#6633ff`, label "Whisper server" + sub-label `GPU box`.
  - Arrow between them: 1px line, head right. Label above the arrow in Inter 12/500: `TRANSCRIPTION_SERVER`.

Frame composition (1920×1080):
- Terminal pane on the left half, ~880×460 centered vertically.
- Architecture sketch on the right half, both boxes side-by-side inside the "your environment" boundary, centered in the right half. Arrow horizontal between them.

## Beats

| t (s) | Frame |
|---|---|
| 0.0 – 0.4 | **Hook** fades in centered: "Same package. Separate machine. One env var." Inter 44px, primary purple on "Separate machine." |
| 0.4 – 1.8 | Hook holds still (**1.4s** — sentence fragment floor). |
| 1.8 – 2.2 | Hook fades out, terminal rectangle fades in (left side); architecture sketch fades in (right side) at the same time. Both arrive together so the viewer reads "code + diagram = related." |
| 2.2 – 3.0 | Terminal prompt `$ ` cursor blinks once, then **`npm run start:whisper`** types in (24 chars × ~30ms ≈ 720ms). |
| 3.0 – 3.1 | Enter. |
| 3.1 – 5.0 | Log lines stream in (one every ~250ms; each line fade-in 100ms then static). Use the actual log format from the supervisor: |
| | `[EXULU-WHISPER] Starting whisper server on 127.0.0.1:9876` |
| | `[EXULU-WHISPER] GPU support: enabled (Apple Silicon MPS)` |
| | `[EXULU-WHISPER] Model: large-v3 (loading…)` |
| | `[EXULU-WHISPER] Diarization: enabled (pyannote)` |
| | `[EXULU-WHISPER] Ready.` — this last line in primary purple `#6633ff`, bold |
| 5.0 – 5.6 | **Hold the terminal still (600ms breath).** Then on the right diagram, the labeled arrow between "Exulu app" and "Whisper server" lights up — the line transitions from gray to primary purple, the `TRANSCRIPTION_SERVER` label gets a subtle background highlight (accent `#dde6ff`). |
| 5.6 – 6.0 | The outer "your environment" dashed boundary glows once: stroke transitions from muted gray to primary purple over 200ms then back to muted gray; the "your environment" chip in the corner pulses (scale 1.0 → 1.04 → 1.0). Conveys "the audio stays inside this box." |
| 6.0 – 6.4 | **Hold (400ms)** before payoff. |
| 6.4 – 6.8 | Payoff caption fades in centered below: **"Your hardware. Your audio. Your environment."** Inter 22/500, "Your environment." in primary purple. |
| 6.8 – 7.4 | Hold for 600ms — resting frame, terminal still shows "Ready.", arrow still purple, boundary settled. |

## Why this arc

- The terminal demo reads as authentic dev experience — the actual log lines users will see when they run the command.
- The architecture sketch shows the punchline (separate box) without leaning on a cartoon — two boxes, one arrow, one env var label. Per `animation-recipes.md` recipe D ("backend / infra"), avoid dancing CPUs.
- The arrow "lighting up" connects the local terminal action to the remote consequence — that's the moment the reader gets it.
- We keep the architecture diagram on screen the entire time so the viewer can re-read it while the terminal logs are still settling.

## Code snippet (inline next to the slice, not animated)

Earns its spot — `npm run start:whisper` is the literal way devs invoke this.

```bash
# On the GPU host
npx @exulu/backend exulu-start-whisper

# On the main app
TRANSCRIPTION_SERVER=http://gpu-host:9876
```

Label above: **From the CLI**.

## Page copy (under the video, 2 short paragraphs)

> The Whisper + pyannote pipeline ships inside `@exulu/backend` but runs as its own process. Spin it up with `npm run start:whisper` on a GPU host inside your own infrastructure, point your main app at it with `TRANSCRIPTION_SERVER=http://...`, and the rest of the app picks up the new capability on its next boot — including a clear startup log line confirming the device and whether diarization is on.

> **Your audio never leaves your environment.** Both the main app and the Whisper server are processes you run, on machines you control. There's no Exulu-managed transcription endpoint, no third-party API key, and no traffic egress from your VPC. GPU support auto-detects CUDA, Apple Silicon MPS, and falls back to CPU; the first job downloads the `large-v3` model (~3 GB) and the pyannote checkpoints from Hugging Face, then subsequent boots are fast and fully local.
