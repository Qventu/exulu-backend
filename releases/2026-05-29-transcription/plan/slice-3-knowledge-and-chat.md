# Slice 3 — From transcript → knowledge → answer

**The payoff moment.** The reason diarized transcripts matter is that they don't sit in a folder — they're saved into a built-in `transcriptions` ExuluContext, auto-embedded on insert, and immediately retrievable by any agent. This slice closes the loop from "audio uploaded" to "the agent quoted the meeting at me."

Spec: `docs/superpowers/specs/2026-05-28-transcription-feature-design.md`
Implementation refs:
- Built-in context registration: `backend/src/templates/contexts/transcriptions.ts` (note `calculateVectors: "onInsert"`)
- Knowledge / data page: `frontend/app/(application)/data/[[...query]]/page.tsx`
- Chat page: `frontend/app/(application)/chat/[agent]/[session]/chat.tsx`
- The merge that ensures the built-in context is always present: `backend/src/exulu/app/index.ts` (the `builtInContexts` block)

## Hook (one line, benefit-language)

> **From audio to answers.**

(Alts if it lands flat: *"Your transcripts, ready for your agents."* / *"Searchable the moment you save."*)

## Surface area

UI + payoff feature. No code snippet inside this slice — the knowledge story is best told visually. The `calculateVectors: "onInsert"` detail can live in the page copy under the video.

## Duration & aspect

**8.5s. 1920×1080 + 1080×1920.**

## Reconstruction notes — three connected vignettes in one shot

We're not cutting between three separate scenes. We're showing **three stacked surfaces** that fade in left-to-right (or top-to-bottom on vertical), each labelled with a tiny breadcrumb, so the viewer follows the data through the system.

Pane layout (1920×1080):
- **Pane A — left third, "Saved":** a miniature card showing the bottom of the review panel from slice 1 — title field reads "Meeting 2026-05-28", a small chip below the title reading "Project: Q4 Launch" in accent purple `#dde6ff` / `#6633ff`, and a Save button. Greyed-out to indicate "this happened."
- **Pane B — middle third, "/data/transcriptions":** a small slice of the data page. Just one row in a table: name "Meeting 2026-05-28", a subdued language tag "de", a small chip "Q4 Launch" in accent purple, and a tiny ✓ "embedded" badge in primary purple. The row sits on a white card.
- **Pane C — right third, "Chat":** a chat message exchange inside the Q4 Launch project.
  - Tiny breadcrumb above the chat in muted gray 11/500: `Q4 Launch · chat`.
  - User bubble (right-aligned, light grey background `#f5f5f5`): "What did Alex say about the API yesterday?"
  - Agent bubble (left-aligned, white with border): an answer that quotes a snippet, with a small inline citation link "Meeting 2026-05-28" in primary purple, underlined.

Connecting glue: thin curved arrows in muted gray (`#525252`, 1px) flowing **A → B → C** as each pane lights up. The arrow heads are small chevrons; the labels above the arrows read `auto-embed` (A → B) and `retrieve via Q4 Launch` (B → C), in Inter 11/500 muted.

On vertical (1080×1920) the three panes stack top-to-bottom and the arrows are vertical.

Sample exchange (use verbatim — keep it short so the chat bubble doesn't overflow):
- User: **"What did Alex say about the API yesterday?"**
- Agent: **"Alex confirmed the API is signed off — the frontend lands today and docs go out tomorrow.** _(from Meeting 2026-05-28)_"

The italicized "(from Meeting 2026-05-28)" is a styled citation: italic Inter 13px, primary purple `#6633ff`, with a subtle underline.

## Beats

| t (s) | Frame |
|---|---|
| 0.0 – 0.4 | **Hook** fades in centered: "From audio to answers." Inter 56px, primary purple on "answers". |
| 0.4 – 1.5 | Hook holds still (**1.1s** — 4-word phrase floor). |
| 1.5 – 1.8 | Hook fades out; Pane A (Saved card) fades in from the left. |
| 1.8 – 2.6 | **Hold Pane A still (800ms)** so the viewer registers "the transcript was saved." The "Project: Q4 Launch" chip pulses subtly once (scale 1.0 → 1.04 → 1.0 over 300ms) drawing attention to the project assignment. A tiny "Saved to Q4 Launch" caption appears above the pane, primary purple, 14/600. |
| 2.6 – 3.0 | Pane B (data row) fades in to the right of A. The arrow A → B draws itself in (~250ms), the label "auto-embed" fades in above it. |
| 3.0 – 3.8 | **Hold B still (800ms).** The "embedded ✓" badge in Pane B pulses once (scale 1.0 → 1.04 → 1.0 over 350ms, primary purple). The "Q4 Launch" chip on the row stays visible. |
| 3.8 – 4.1 | Pane C (chat) fades in. Arrow B → C draws (~250ms), label "retrieve" fades in. |
| 4.1 – 4.4 | User bubble pops in (right side of Pane C), text already filled: "What did Alex say about the API yesterday?" Brief 100ms scale-in. |
| 4.4 – 5.4 | **Hold the user bubble for 1.0s** so the question lands. |
| 5.4 – 6.6 | Agent bubble appears on the left side, with the answer text typing in word-by-word (~120ms per word, ~6 words → ~720ms). |
| 6.6 – 7.0 | The citation "(from Meeting 2026-05-28)" types in last, in italic primary purple. |
| 7.0 – 7.6 | **Hold (600ms breath).** Then the citation gets a subtle highlight: background accent `#dde6ff` fades in briefly behind it, holds 300ms, fades out. Conveys "this is where the answer came from." |
| 7.6 – 8.0 | Payoff caption fades in centered below the three panes: **"Every saved transcript becomes project-scoped knowledge."** Inter 22/500, "project-scoped" in primary purple. |
| 8.0 – 8.5 | Hold (500ms resting frame) — all three panes still on screen, citation calm. |

## Why this arc

- The three-pane structure **physicalizes the data flow**. The viewer sees the artifact move from "you saved it" → "it's in your knowledge" → "your agent used it." No cuts; the reader doesn't lose continuity.
- The `auto-embed` label is the silent hero — it says "you don't do anything" without spelling it out.
- The citation is what closes the loop. Without it, the chat answer could be from anywhere; with it, the viewer reads "the agent literally quoted the meeting."
- We don't try to show vector embeddings or retrieval mechanics — those would be lies of detail. We show the result: a cited answer from a transcript that didn't exist five seconds ago.

## Page copy (under the video, 2 short paragraphs)

> The `transcriptions` context is built into `@exulu/backend` and registered automatically when your app boots. Every diarized transcript you save becomes an item in this context, embedded on insert via your configured embedder — no migration, no extra setup, no separate ingestion pipeline.

> If you picked a project at upload or review time, the transcript is also linked to that project's items, scoping it to the agents and chats that operate inside it. The same speaker names you typed in the review step are part of the embedded text, so queries like "what did Alex say" route directly to the right segments, with citations back to the source.
