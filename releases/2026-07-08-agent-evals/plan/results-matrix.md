# Feature plan — Eval results matrix (cases × runs)

Part of `releases/2026-07-08-agent-evals/`.

## Sources of truth

- UI: `frontend/app/(application)/evals/[id]/runs/eval-runs.tsx` (Results tab
  body, `GET_EVAL_RUNS` poll 10s),
  `.../runs/components/eval-runs-table.tsx` (the CSS-grid matrix,
  `GET_TEST_CASES` poll 10s, last-3-runs default, result Sheet),
  `.../runs/components/eval-run-column.tsx` (one lane = one component; owns
  `GET_JOB_RESULTS`, average math, the overflow menu),
  `.../runs/components/score-cell.tsx` (the single cell primitive, all states)
- On-screen copy: `frontend/messages/en.json` → `evals.runs.matrix.*`,
  `evals.runs.column.*`, `evals.runs.startConfirm.*`,
  `evals.runs.resultSheet.*` (verbatim below)
- GraphQL: `RUN_EVAL` + `GET_JOB_RESULTS` in `frontend/queries/queries.ts`
  (`runEval` mutation at ~line 2385)
- Tokens: `releases/2026-07-08-agent-evals/hyperframes-design.md` +
  `frontend/app/globals.css` (`--info: 221.2 83.2% 53.3%` ≈ #2563EB;
  `.striped-background` = repeating 45° hairlines of muted-foreground @ 30%,
  10px tile)

## What shipped

A real cases × runs results matrix for an eval set:

- **CSS grid** `minmax(220px,280px) [60px rail] repeat(N, minmax(140px,1fr))`.
  Sticky left column lists test cases (name + id); every other column is a
  self-contained run lane with header (run name, date, agent name), an actions
  menu, a pinned **Average** row, and one cell per case. All rows are 60px.
- **Cells are semantic**: completed scores render `score.toFixed(1)` colored
  against the run's pass threshold — green (`text-success` #16A34A) at ≥
  threshold, amber (`text-warning` #D97706) within 20 points below, red
  (`text-destructive` #E54B50) under that. Live statuses render icon + label:
  **Waiting** (clock, muted), **Running** (spinning loader, `text-info`
  #2563EB), **Failed** (x-circle, red), **Delayed** (clock, amber). No job yet
  = muted **"Not started"**; case not in the run = striped cell with an
  em-dash (**"Not in this run"** aria label). Completed cells are real
  buttons — click opens the **"Test result details"** sheet.
- **Average row** per lane: completed numeric results only, never NaN — falls
  back to **"No results yet"** in muted text. Colored with the same
  threshold logic.
- **Last 3 runs by default**; a quiet **"Show older runs"** rail (60px,
  striped body) reveals 5 more at a time.
- **Lane overflow menu** (single `MoreVertical` button): **"Refresh
  results"** always; **"Start run" / "Copy run" / "Edit run" / "Delete run"**
  gated on write access (RBAC leak fix — readers used to see Delete).
- The runs list and case list poll every 10s (queue chip every 5s), so new
  runs and row changes appear without a reload; a lane's result cells refresh
  via its "Refresh results" action or any page-level refetch.

## Hook

**Every run, every case, side by side.**

## Surface area

UI feature (the matrix) + one real developer surface: the `runEval` GraphQL
mutation that schedules the queue jobs the matrix fills from. One short on the
live fill; menu actions, the result-details sheet, and the "Show older runs"
rail are page prose within this feature's section.

## Short — `results-matrix` (1920×1080, 9.5s)

One slice, ONE demo moment and zero clicks: the newest lane is already
mid-run — its cells flip live from spinning **Running** to colored scores
while the pinned **Average** updates (and recolors) after each landing.

Deliberate deviation from the brief: clicking **Start run** in the lane menu
is 3 clicks in the real app (menu → item → confirm dialog) — that breaks the
one-action rule, so we open on an already-running lane as the brief's fallback
allows. No cursor on screen (nothing is clicked).

### Demo arc (timed beats)

Demo run config: pass threshold **80** → green ≥ 80.0, amber ≥ 60.0, red
< 60.0. Live lane = "Prompt v3".

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Agent Evals" (#E2EBFF bg / #1E69DC text), H1 "Every run, every case, **side by side**." (em phrase #7033FF) | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor for 6-word phrase |
| 1.90–2.40 | Hook crossfades out; matrix card fades in. Lane "Prompt v3" mid-run: case 1 = **92.0** green, cases 2–3 = spinning **Running** (blue), cases 4–5 = **Waiting** (muted); lane Average = **92.0** green | Pivot; matrix reads instantly |
| 2.40–3.00 | Case-2 cell crossfades **Running → 74.5** (amber); Average ticks **92.0 → 83.3** (stays green) | First live landing |
| 3.00–3.70 | Case-3 cell flips **→ 88.0** (green); case-4 **Waiting → Running** (spinner starts); Average **→ 84.8** | Fill cascades down the lane |
| 3.70–4.40 | Case-4 cell flips **→ 55.0** (red); Average **→ 77.4** and recolors **green → amber** | Threshold coloring is live, even on the Average |
| 4.40–5.10 | Case-5 **Waiting → Running**; nothing else moves | Breath; the queue is visibly working |
| 5.10–5.70 | Case-5 flips **→ 91.5** (green); Average **→ 80.2**, recolors **amber → green** | Lane completes; average recovers past threshold |
| 5.70–6.60 | Finished lane holds completely still (900ms) | ≥600ms post-action hold |
| 6.60–7.00 | Payoff caption enters (lower third): "Scores land live — colored against your pass threshold." | Entrance |
| 7.00–9.50 | Payoff holds still (2.5s); last 600ms fully frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

Each cell flip is a 150–250ms crossfade (power2.out, no bounce, no glow); the
Average value swaps with a quick fade, its color changes with the swap.
Spinners rotate continuously (~1s/turn, linear) — they are the only motion
during holds before 5.70; from 5.70 the frame is fully static.

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash (same framing as the
07-07/07-08 shorts). Matrix inside a centered card ~1120px wide (radius ~6px,
border 1px #E7E7EE, bg #FCFCFC, subtle shadow). Inter everywhere, tracking
-0.025em. Purple #7033FF appears only in the hook em phrase and pill-adjacent
accents — the matrix itself uses semantic colors only.

**Grid** (from `eval-runs-table.tsx`): columns = case column 240px, "older
runs" rail 60px, then 3 equal lanes (~250px each inside the card). Every data
row 60px tall; cell borders `border-b border-r` 1px #E7E7EE. The Average row
has a **5px bottom border** (`border-b-[5px]`) separating it from the case
rows — reproduce it, it is a signature of the real UI.

**Sticky case column** (left):
- Header cell: **"Test case"** — text-xs #525252.
- Average cell: bg #F5F5F5 (`bg-muted`), **"Average"** — text-sm **bold**,
  left-aligned with slight indent; 5px bottom border.
- 5 case rows: name text-sm font-medium (truncate) + id below in text-xs
  #525252 truncated to ~120px. Neutral placeholder cases:
  1. "Refund policy question" — `1f4c9a2e-77b0-4…`
  2. "Multi-step order lookup" — `8a21d5c3-0e94-4…`
  3. "Password reset flow" — `c93b7f10-52aa-4…`
  4. "Ambiguous shipping query" — `4d6e02b8-b1c7-4…`
  5. "Escalation handoff" — `72f8e4a1-9d35-4…`

**"Show older runs" rail** (60px column, between cases and lanes): header
cell bg near-white (`bg-muted/30`) with a small ghost button — `«` chevrons
icon (ChevronsLeft, 12px) + **"Show older runs"** text-xs (it may wrap/crop in
60px — the real rail relies on the aria-label; render icon + cropped text
faithfully). All body cells: striped background (45° hairlines,
rgba(82,82,82,0.3), 10px tile) over `bg-muted/20`.

**Each lane, top to bottom**:
1. Metadata header (bg-muted/30, centered): run name text-xs font-semibold
   (#000), then date text-[10px] #525252 in format **"MMM d, yyyy · HH:mm"**,
   then agent name text-[10px] #525252.
2. Menu row (60px, bg-muted/20): one centered 28×28 ghost icon button with a
   `⋮` (MoreVertical, 16px) — aria "Run actions". Menu stays CLOSED in this
   short.
3. Average row (60px, 5px bottom border): value text-sm font-semibold,
   threshold-colored.
4. Five case cells (60px each).

Alignment note: in the app every column stacks its own fixed-height cells; the
lanes have the extra metadata header, so stretch the sticky "Test case" header
cell and the rail header cell to match the lane header total (metadata block +
60px menu row, ~110px) so Average rows and case rows align across all columns.

**Lane content** (threshold 80; agent "Support agent" on all three):

| Case | "Prompt v1" · Jul 6, 2026 · 09:12 | "Prompt v2" · Jul 7, 2026 · 14:30 | "Prompt v3" · Jul 8, 2026 · 09:00 (live) |
|---|---|---|---|
| Average | **67.6** amber | **85.6** green | 92.0 → 83.3 → 84.8 → 77.4 (amber) → 80.2 (green) |
| 1 | 78.0 amber | 84.0 green | 92.0 green (already landed at open) |
| 2 | 85.5 green | 88.5 green | Running → **74.5** amber @2.40 |
| 3 | striped **—** (not in run) | 79.0 amber | Running → **88.0** green @3.00 |
| 4 | 62.0 amber | 91.0 green | Waiting → Running @3.00 → **55.0** red @3.70 |
| 5 | 45.0 red | **Not started** (muted, clock icon) | Waiting → Running @4.40 → **91.5** green @5.10 |

**Cell state rendering** (from `score-cell.tsx`, verbatim labels from
`evals.runs.matrix.*`):
- Completed: score with one decimal (`92.0`), text-sm font-semibold; green
  #16A34A / amber #D97706 / red #E54B50 per threshold rule above.
- Running: 12px spinner (Loader2, `animate-spin`) + **"Running"** text-xs,
  both #2563EB.
- Waiting: 12px clock icon + **"Waiting"** text-xs, both #525252.
- Not started: 12px clock icon + **"Not started"** text-xs, #525252.
- Not in run: striped cell with a centered **"—"** text-xs #525252.
- Average fallback (unused in demo, for reference): **"No results yet"**
  text-xs #525252.

Hook pill/H1 and payoff caption use the same type treatment as the sibling
07-08 shorts (pill #E2EBFF/#1E69DC; payoff as a lower-third caption, dark text
on the canvas, no card).

## Code snippet decision

**Yes — GraphQL.** Every cell in the matrix is a queued job created by the
real `runEval` mutation — the same operation the Start-run confirm fires, and
the way to trigger eval runs from CI. Actual operation, verbatim from
`frontend/queries/queries.ts`:

Anchor line: "Every cell is a queue job — start runs from the API and watch
the matrix fill:"

```graphql
mutation RunEval($id: ID!, $test_case_ids: [ID!]) {
  runEval(id: $id, test_case_ids: $test_case_ids) {
    jobs
    count
  }
}
```

(6 lines, real operation and field names; `id` is the run config,
`test_case_ids` optionally narrows the run to a subset of cases.)

## Page prose within this feature's section (beyond the video)

- Defaults + history: the matrix shows the **last 3 runs**; **"Show older
  runs"** reveals 5 more at a time. Runs are sorted oldest → newest, so the
  freshest lane is always at the right edge.
- Lane actions (single overflow menu): **"Refresh results"** for everyone;
  **"Start run"**, **"Copy run"**, **"Edit run"**, **"Delete run"** only for
  writers. Start confirms first — **"Start eval run?"** / "This will schedule
  {count} test cases in "{name}" to run against the configured agent and eval
  functions." Delete is destructive and warns: **"Already-scheduled queue
  jobs are not removed. Check the queue panel to manage them."**
- Clicking a completed score opens the **"Test result details"** sheet:
  Overview (score, duration, status, job ID, token usage split into input /
  output), Messages (the full conversation transcript), Functions (per
  eval-function scores + config), Raw (metadata JSON).
- Average math is honest: only completed numeric results count — a lane with
  nothing finished says **"No results yet"** instead of NaN.
- Full status vocabulary in cells: Waiting, Running, Failed, Delayed, Paused,
  Stuck — plus muted "Not started" and a striped "Not in this run" dash for
  cases outside the run's selection.
- Freshness: the runs and cases lists poll every 10 seconds (the queue chip
  every 5), so new runs and row changes appear without a reload; a lane's
  cells update on any refetch or its "Refresh results" action. Do NOT claim
  per-cell 10-second polling — the per-lane `GET_JOB_RESULTS` query has no
  poll interval.
- Accessibility note worth a line: completed cells are real keyboard-focusable
  buttons with visible focus rings (a P0 fix — they used to be inert divs).
