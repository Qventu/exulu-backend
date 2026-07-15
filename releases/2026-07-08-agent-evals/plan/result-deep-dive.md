# Feature plan — Per-result deep-dive sheet

Part of `releases/2026-07-08-agent-evals/`.

## Sources of truth

- Frontend commit: `e1e5073` (`feat(evals): runs matrix CSS-grid + queue Sheet +
  close RBAC leaks (5.1 part 2/2)`)
- UI (all paths relative to `frontend/`):
  - `app/(application)/evals/[id]/runs/components/eval-runs-table.tsx` — owns the
    Sheet + Tabs (lines 339–594); `handleCellClick` opens the sheet only for
    `state === "completed"` results
  - `app/(application)/evals/[id]/runs/components/score-cell.tsx` — the clickable
    completed cell (`<button>`, `score.toFixed(1)`, threshold coloring)
  - `app/(application)/evals/[id]/runs/components/eval-run-column.tsx` — one lane
    per run; average row; `onCellClick` wiring
  - Primitives: `components/ui/sheet.tsx` (side="right", `sm:max-w-2xl`),
    `components/ui/tabs.tsx`, `components/ui/card.tsx`, `components/ui/badge.tsx`,
    `lib/utils.ts` → `formatDuration` (seconds → `"1m 24s"` style)
- On-screen copy: `frontend/messages/en.json` → `evals.runs.resultSheet.*` and
  `evals.runs.matrix.*` (verbatim below)
- Data plumbing (prose only, no snippet): shared `GET_JOB_RESULTS` query in
  `frontend/queries/queries.ts` (`job_resultsPagination`, filter
  `label contains "eval-run-" + run.id`) — pre-existing, not a surface this
  feature introduces

## What shipped

Every cell in the eval runs matrix is now a door, not just a number. Clicking a
**completed** score cell opens a right-side detail sheet (shadcn Sheet,
`sm:max-w-2xl` ≈ 672px, title **"Test result details"**) with four tabs:

- **Overview** — big score card (`result.toFixed(1)`, neutral bold — NOT
  threshold-colored inside the sheet), duration card (`formatDuration(metadata.duration / 1000)`),
  status card with a Badge (**"Completed"** on `bg-primary` purple; failed =
  destructive) and a mono **Job ID**, an **"Error details"** JSON card only when
  the result carries an error object, and a **"Token usage"** card
  (Total tokens / Input / Output from `metadata.tokens`).
- **Messages** — the full eval conversation rendered with the real chat
  `MessageRenderer` inside a `Conversation` scroller (max-h 600px), assistant
  bubbles with a `border-l-2 border-primary/30` accent.
- **Functions** — one card per eval function: function name, mono function id,
  individual **Score** to two decimals (`result.toFixed(2)`), and the config
  key/value pairs it ran with. Empty state: "No eval function results available."
- **Raw** — the whole `metadata` blob as pretty-printed JSON in `CodePreview`
  (dark code surface #22253A). Empty state: "No metadata available."

Non-completed cells (Waiting / Running / Failed / Delayed / Paused / Stuck /
Not started) are never clickable — the sheet only opens on real, finished data.

## Hook

**Every score, explained.**

(Benefit-led, 3 words; the sheet turns a bare number into score + tokens +
messages + per-function breakdown.)

## Surface area

Pure UI feature: a click target (ScoreCell button) + a detail Sheet reading
already-fetched job-result data. No new API field, no new query. One short on
the click → Overview reveal; Messages / Functions / Raw tabs are page prose.

## Short — `result-deep-dive` (1920×1080, 9.5s)

One slice, ONE user action: clicking the red **42.0** score cell in the runs
matrix → the "Test result details" sheet slides in from the right showing the
Overview tab (score card, duration card, status + job id, token usage).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Agent Evals" (#E2EBFF bg / #1E69DC text), H1 "Every score, **explained**." (em word #7033FF) — no sub-line | Entrance |
| 0.40–1.60 | Hook holds static (1.2s) | ≥1.0s floor for 3-word phrase |
| 1.60–2.05 | Hook crossfades out, runs-matrix card fades in (centered ~1120px); the red **42.0** cell visible in the right lane | Pivot |
| 2.05–2.75 | Cursor glides toward the red 42.0 cell | Approach |
| 2.75–2.95 | Cursor hovers: 42.0 gets its real `hover:underline` | Click affordance |
| 2.95–3.30 | Click → overlay dims the matrix, sheet slides in from the right (350ms, power2.out), landing on the Overview tab | The one action |
| 3.30–4.30 | Sheet fully settled, everything still (1.0s): "Test result details", 4 tabs, Score 42.0, Duration 1m 24s, Status "Completed" badge, Job ID, Token usage | ≥600ms post-action hold |
| 4.30–4.70 | Soft highlight sweep (#E2EBFF wash, ~30% opacity) enters over the **Token usage** card | Draw the eye to the richest card |
| 4.70–6.20 | Highlight holds, everything else still (1.5s) | Read floor for short card labels (1–3 word labels ≥1.0s) |
| 6.20–6.50 | Highlight fades out | Clear stage |
| 6.50–7.10 | Breath (600ms), frame fully still | Breath before payoff |
| 7.10–7.50 | Payoff caption enters (lower third, over the dimmed matrix left of the sheet): "Score, tokens, and the full conversation — one click." | Entrance |
| 7.50–9.50 | Payoff holds still (2.0s); last 600ms completely still = loop resting frame | ≥1.8s floor for 8-word sentence + clean loop |

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. The runs matrix renders
as a centered card ~1120px wide (radius ~6px, border #E7E7EE, subtle shadow)
that acts as the "app viewport" — the sheet and overlay live INSIDE this card.
Inter everywhere, tracking -0.025em; JetBrains Mono for ids/JSON.

**Runs matrix (before the click)** — real CSS grid from `eval-runs-table.tsx`:
`gridTemplateColumns: "minmax(220px, 280px) repeat(3, minmax(140px, 1fr))"`
(3 visible runs → no "Show older runs" rail). All rows h-60px, cells
`border-b border-r` #E7E7EE, `p-3`.

- Sticky first column:
  - Header row: **"Test case"** (`text-xs text-muted-foreground` #525252)
  - Average row: **"Average"** (`text-sm font-bold`, row bg #F5F5F5,
    `border-b-[5px]` thick underline separating it from case rows)
  - Case rows: name `text-sm font-medium` + truncated id below in
    `text-xs text-muted-foreground` (`max-w-[120px] truncate`). Use:
    1. **"Refund policy lookup"** / `b3c9a1d2-44f7-4e…` ← the star row
    2. **"Quarterly report summary"** / `7e02f6c8-91ab-4d…`
    3. **"Order status check"** / `d54a8e10-3c6f-48…`
    4. **"Escalation handoff"** / `f19b7c33-a2d5-4b…`
- Three run lanes (left → right), each with a header row (run name
  `text-xs font-semibold`, date + agent in `text-[10px] text-muted-foreground`,
  bg muted/30), then the average row (`text-sm font-semibold`, colored,
  `border-b-[5px]`), then 4 score cells:
  - Lane 1 **"Nightly regression"** · "Jul 5, 2026 · 22:00" · "Support agent" —
    avg **82.4** (#16A34A); cells 88.0, 79.5, 90.0, 72.0 (all #16A34A)
  - Lane 2 **"Prompt v2"** · "Jul 6, 2026 · 10:32" · "Support agent" —
    avg **77.9** (#16A34A); cells 84.0, 66.0 (#D97706), 91.5, 70.0 (#16A34A)
  - Lane 3 **"Prompt v3"** · "Jul 7, 2026 · 09:14" · "Support agent" —
    avg **66.4** (#D97706); cells **42.0** (#E54B50 ← the star, row 1),
    61.0 (#D97706), 88.0, 74.5 (#16A34A)
- Score cells are the ScoreCell button: centered, `min-h-[48px]`,
  `text-sm font-semibold`, one decimal, `hover:underline` on the hovered cell
  only. Threshold logic (pass_threshold 70): ≥70 → #16A34A (text-success),
  ≥50 → #D97706 (text-warning), else #E54B50 (text-destructive).
- Simplification (record as such): the real app splits each lane top into a
  label block + a separate 60px kebab-menu row (`MoreVertical`); merge them
  into ONE 60px header row per lane and omit the kebab — it is not the star
  and keeps rows aligned with the sticky column.

**The click + sheet** (all from `eval-runs-table.tsx` + `sheet.tsx`):

- Overlay: real class is `bg-black/80` fade-in; soften to ~black/35 for the
  demo so the matrix stays legible behind the sheet (deviation, noted).
- Sheet: slides in from the right edge of the app card; width 672px
  (`sm:max-w-2xl`), full card height, `bg-background` #FDFDFD, `p-6`,
  `border-l` #E7E7EE, shadow-lg. Close ✕ icon (16px, 70% opacity) at
  top-right (`right-4 top-4`). Real animation is 500ms; compress to 350ms
  power2.out (deviation, noted).
- Sheet title: **"Test result details"** (`text-lg font-semibold`).
- Tabs (mt-6): TabsList `grid w-full grid-cols-4`, h-10, bg #F5F5F5,
  radius 6px, p-1, `text-muted-foreground`. Triggers, verbatim:
  **"Overview"** (active: bg #FDFDFD, `shadow-sm`, `text-foreground`),
  **"Messages"**, **"Functions"**, **"Raw"** (`text-sm font-medium`).
- Overview content (`space-y-4`, cards = `rounded-lg border` #E7E7EE,
  bg #FCFCFC, `shadow-sm`; CardHeader `p-6 pb-3`, CardContent `p-6 pt-0`):
  1. Two-up grid (`grid-cols-2 gap-4`):
     - Card **"Score"** (`text-sm font-medium text-muted-foreground`) →
       value **"42.0"** in `text-3xl font-bold`, PLAIN foreground black —
       the sheet does NOT threshold-color the score (verified; do not make
       it red).
     - Card **"Duration"** (Clock icon 16px + label, same muted style) →
       value **"1m 24s"** in `text-2xl font-semibold`.
  2. Card **"Status"** (`text-sm font-medium`), two `justify-between` rows
     (`space-y-3`):
     - "Status" (`text-sm text-muted-foreground`) ↔ Badge: pill
       (`rounded-full px-2.5 py-0.5 text-xs font-semibold`), bg #7033FF,
       white text, CheckCircle icon 12px + **"Completed"** — the only loud
       purple element in the sheet.
     - "Job ID" ↔ **"e7b421f9"** (`font-mono text-sm`, JetBrains Mono).
  3. Card **"Token usage"** (Zap icon 16px + `text-sm font-medium` title):
     - Row: "Total tokens" (`text-sm text-muted-foreground`) ↔ **"12,847"**
       (`text-lg font-semibold`)
     - 1px divider (`h-px` #E7E7EE)
     - Two-col grid: **"Input"** (`text-xs text-muted-foreground`) over
       **"9,512"** (`text-base font-medium`); **"Output"** over **"3,335"**.
  - No "Error details" card — it renders only for failed results with a
    non-empty error object; this result is completed.
- Cursor: house cursor asset, glide power2.out, click = 100ms press scale on
  the cell; motion mood 150–350ms, no bounce, no glow.

## Code snippet decision

**None — pure UI.** The sheet introduces no developer surface: it renders
job-result rows the matrix already fetches via the shared, pre-existing
`GET_JOB_RESULTS` query (`job_resultsPagination`). No new field, mutation, or
route ships with this feature, so a snippet would not earn its spot. (Page
prose may mention that everything in the sheet — `result`, `metadata.tokens`,
`metadata.messages`, `metadata.function_results` — is plain
`job_resultsPagination` data, queryable like any other Exulu collection.)

## Page prose within this feature's section (beyond the video)

- The other three tabs, briefly: **Messages** replays the eval conversation in
  the same `MessageRenderer` the chat page uses (assistant turns get a subtle
  `border-primary/30` left accent), so you audit exactly what the agent said —
  not a paraphrase. **Functions** breaks the composite score apart: one card
  per eval function with its name, id, individual score to two decimals
  (`toFixed(2)`), and the exact config it ran with. **Raw** is the full result
  metadata as pretty JSON for when you want everything.
- Only completed cells open the sheet — in-flight states (Waiting / Running /
  Delayed / Paused), Failed / Stuck, and "Not started" cells render as
  status labels and are never clickable, so you can't deep-dive into
  half-finished data.
- Failed-run forensics: when a result carries an error object, the Overview
  tab adds a destructive-bordered **"Error details"** card with the error
  JSON — the same deep-dive flow doubles as the debugging view.
- Accessibility note worth a line: completed cells are real `<button>`s with
  focus rings (previously plain `<div>`s), so the sheet is keyboard-reachable.
