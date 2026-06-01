# Slice 1 — Review panel: timeline + rename + save

**The product moment.** This is the marquee short. Lead with it on the page.

Spec: `docs/superpowers/specs/2026-05-28-transcription-feature-design.md`
Implementation refs:
- Review panel + AudioTimeline: `frontend/app/(application)/transcriptions/page.tsx`
- Speaker color palette: same file, `SPEAKER_COLORS` constant
- Renderer: `frontend/app/(application)/transcriptions/page.tsx` `renderTranscript` + backend `src/exulu/transcription/transcript-text.ts`

## Hook (one line, benefit-language)

> **Transcripts that know who's talking.**

(Alts if it lands flat: *"Real names, not SPEAKER_00."* / *"Speaker-aware transcripts in three clicks."*)

## Surface area

Pure UI feature → **one animated slice, no code snippet inside the slice.** The standalone-server snippet lives next to slice 2.

## Duration & aspect

**8.5s. 1920×1080 (page-embed) + 1080×1920 (vertical social).**

## Reconstruction notes — copy the real UI, don't paraphrase

The slice rebuilds the expanded review panel, isolated against the page background (no need to render the full nav chrome).

Layout (top-to-bottom):
- White card with `border-radius: 0.4rem`, `border: 1px solid #e8e8ee`, `padding: 16px`, on the page background `#fdfdfd`.
- **Audio player row:** native `<audio>` element style — a thin rounded rectangle ~40px tall, gray track with a play/pause icon on the left.
- **Speaker timeline:** 40px-tall ribbon, `bg-muted/40 #f5f5f5` with a 1px border. Inside: contiguous colored blocks per segment using the speaker palette from `design.md` (`hsl(210, 80%, 55%)`, `hsl(150, 60%, 45%)`, `hsl(40, 90%, 55%)`). A thin 1px `#000` vertical line marks the current playhead.
- **Hover popup:** appears above a segment when hovered. White card (`#fcfcfc`), `border #e8e8ee`, shadow-md, ~280px wide. Two lines: top line = colored dot + speaker name + timestamp range in muted gray; bottom line = the segment text in 12px.
- **Speakers section:** label "Speakers (rename to save with real names)" in Inter 14/500 muted, then 3 rows: each row is `[code SPEAKER_NN]` (muted gray monospace, fixed width 112px) + `<Input>` (white, `border #e8e8ee`, `radius 0.4rem`, full-width).
- **Buttons row:** right-aligned. "Discard" (ghost, muted text) and "Save" (primary, `bg #6633ff`, white text).

Speakers in the demo: 3 speakers, named after pyannote convention `SPEAKER_00`, `SPEAKER_01`, `SPEAKER_02`. The demo will rename them to **Daniel**, **Alex**, **Pat**.

Sample text (use as the segment text in popups and the live preview):
- SPEAKER_00 → "morning team, where are we on the launch checklist?"
- SPEAKER_01 → "API is signed off — frontend lands today, docs go out tomorrow."
- SPEAKER_02 → "marketing copy is locked, just waiting on legal."

## Beats

| t (s) | Frame |
|---|---|
| 0.0 – 0.4 | **Hook** fades in centered on the brand background: "Transcripts that know who's talking." Inter 56px, line height 1.05, tight tracking. "who's talking" in primary `#6633ff`, rest near-black. |
| 0.4 – 2.2 | Hook holds still (**1.8s** — full sentence floor). |
| 2.2 – 2.6 | Hook fades out; the review panel card fades+scales up into the frame (subtle, 0.95 → 1.0). |
| 2.6 – 3.2 | Audio player row is drawn; immediately the **speaker timeline ribbon paints in** left-to-right, segments appearing in order, ~50ms each. End state: a ribbon with ~12 colored blocks. |
| 3.2 – 3.9 | **Cursor glides** to a block in the middle of the ribbon (a green SPEAKER_01 block). |
| 3.9 – 4.2 | Hover lands. Popup appears: dot + "SPEAKER_01 · 0:18 – 0:23" + text "API is signed off — frontend lands today, docs go out tomorrow." Hold popup visible. |
| 4.2 – 5.0 | **Hold the hover state (800ms)** so the snippet text is readable. |
| 5.0 – 5.2 | Popup fades; cursor moves down to the first rename input next to `SPEAKER_00`. |
| 5.2 – 6.0 | Text types into row 1: **"Daniel"** (8 chars × ~70ms). The matching SPEAKER_00 blocks in the ribbon don't change color (color is keyed to the raw label, not the rename — this is intentional brand behavior). |
| 6.0 – 6.6 | Cursor jumps to row 2; **"Alex"** types (4 chars × ~70ms). |
| 6.6 – 7.2 | Cursor jumps to row 3; **"Pat"** types (3 chars × ~70ms). |
| 7.2 – 7.5 | **Hold the renamed state for 300ms.** |
| 7.5 – 7.7 | Cursor moves to the primary "Save" button. |
| 7.7 – 7.9 | Click. Button briefly inverts. |
| 7.9 – 8.5 | A small toast slides in top-right: **"Transcript saved"** with a tiny link underline "View in /data". Hold for 600ms — this is the resting frame. |

## Why this arc

- The hover-on-timeline beat is the **novel UX hook** — it's the moment a viewer goes "oh, I can see who said what at a glance." It lands before the rename so the viewer understands what the colors mean before we ask them to associate names with them.
- We do all three renames sequentially without scroll because the brand's restraint asks for a still frame, not a busy montage.
- The toast lands AFTER a 200ms breath after the save click, so the payoff doesn't get stepped on.
- Color-stability rule (`speakerColor()` hashes the raw label, not the typed name) is shown implicitly — the green segments stay green when SPEAKER_01 becomes "Alex". This is a quiet detail but it sells "this team thought about it."

## Page copy (under the video, 2 short paragraphs)

> Upload an audio file at `/transcriptions` and the new pipeline returns a fully diarized transcript — Whisper for the words, pyannote for the speakers. The review panel pairs the audio with a colored timeline of who-spoke-when, and you rename `SPEAKER_NN` to real names before the transcript becomes a context item.

> Each rename is reversible. Saved transcripts get their own section on the page and can be re-opened to revise speaker names later; the existing context item updates in place and re-embeds automatically.
