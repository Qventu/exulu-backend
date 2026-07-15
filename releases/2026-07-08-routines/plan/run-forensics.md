# Feature plan — Run history with error forensics

Part of `releases/2026-07-08-routines/` (the /workflows Routines workbench).

## Sources of truth

- Frontend commits: `9e63d8e` (promote routine panel to `/workflows/[id]`
  subpage — RunsSection wrapper + onRetry wiring), `58e5010` (workflows
  redesign 2.12 — flat-list inline-disclosure runs pattern), `b5c75ec`
  (RunRoutineDialog render-loop fix; dialog honors `prefill`)
- UI: `frontend/app/(application)/workflows/[id]/sections/runs.tsx`
  (RunsSection + RunRow — the whole surface), wired in
  `[id]/components/routine-workbench.tsx:188`
  (`onRetry={(prefill) => workbench.openRun(prefill)}`);
  `workflows/components/run-routine-dialog.tsx` (the retry target)
- Primitives: `components/primitives/status-dot.tsx` (8px dot, semantic
  colors, `motion-safe:animate-pulse`), `components/primitives/detail-section.tsx`
  (section header + meta), `components/primitives/relative-time.tsx`
  (Intl narrow, e.g. "2h ago"), `components/ui/badge.tsx` (outline pill),
  `components/custom/text-preview.tsx` (metadata value cells),
  `components/ai-elements/code-block.tsx` (Raw payload)
- On-screen copy: `frontend/messages/en.json` → `routines.runs.*`
  (verbatim below); `common.somethingWentWrong` for the detail-error fallback
- GraphQL: `GET_JOB_RESULTS_LIGHT` (list, last 50) and `GET_JOB_RESULT_BY_ID`
  (lazy detail) in `frontend/app/(application)/workflows/queries.ts`

## What shipped

The routine workbench's **Runs** section lists the last 50 executions as flat
rows that expand **in place** — no second navigation altitude:

- **Collapsed row** — 8px status dot (green completed, red failed/stuck, blue
  pulsing for active), a tinted state pill ("Completed" / "Failed"), and a
  relative timestamp ("2h ago"). Clicking anywhere on the row toggles it; at
  most one run is expanded at a time.
- **Expanded disclosure** — full timestamp ("Jul 8, 2026, 7:02:11 AM"), a red
  **Error** block with the complete error message, a **Metadata** key/value
  table (inputs, queue, …), a **"Show raw payload"** toggle (copyable JSON
  CodeBlock of `{ result, error, metadata }`), and **"Retry with edits"** —
  which reopens the Run dialog prefilled with the failed run's recorded
  `metadata.inputs`.
- **Lazy forensics** — the list query fetches only `id/state/label/createdAt`;
  the heavy detail (`error`, `result`, `metadata`) is fetched on first expand
  (cache-first), and the row stays mounted so re-collapse/re-expand is instant.
  Once fetched, a failed row also shows a truncated one-line red error preview
  while collapsed.

## Hook

**See exactly why a run failed.**

## Surface area

UI feature (workbench Runs section, inline disclosure) + one real developer
surface (the `job_resultById` GraphQL query that returns the same forensics).
One short on the row-expand moment; retry flow, raw payload, and lazy-fetch
mechanics are page prose within this feature's section.

## Short — `run-forensics` (1920×1080, 8.6s)

One slice, ONE user action: clicking the failed run row — it unfolds in place
revealing the red error block and the metadata table (Retry button visible).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Routines" (#E2EBFF/#1E69DC), H1 "See exactly **why** a run failed." (em word #7033FF) — no sub-line | Entrance |
| 0.40–1.85 | Hook holds static (1.45s) | ≥1.4s floor for 6-word line |
| 1.85–2.30 | Hook crossfades out, Runs section card fades in: header "Runs · 6 runs", bordered list of 6 rows; row 2 is the failed one (red dot + "Failed" pill + "2h ago") | Pivot |
| 2.30–2.95 | Cursor glides to the failed row; row hover tint (bg #F5F5F5 at 50%) | Approach + click affordance |
| 2.95–3.20 | Click → row unfolds in place (~250ms height reveal, power2.out): chevron rotates 180°, disclosure shows full timestamp, red Error block, Metadata table, "Show raw payload" + "Retry with edits" buttons | The one action |
| 3.20–5.40 | Expanded state holds completely still (2.2s), cursor rests just below the row | ≥600ms post-action hold + ≥1.8s read floor for the error sentence |
| 5.40–5.80 | Payoff caption enters (lower third, below the card): "The error, the inputs, and a retry — one click." | Entrance |
| 5.80–8.60 | Payoff holds still (2.8s); last 600ms fully still = loop resting frame | ≥1.8s floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Runs section** (`runs.tsx`; in the real workbench it sits in a `max-w-3xl`
column beside a 200px SectionNav — for the short, render the section as a
centered card ~1120px wide on the #FDFDFD canvas with the house radial purple
wash, matching the 07-07/07-08 shorts' framing):

- Section header (DetailSection, open): chevron-down icon (16px, #525252) +
  h3 **"Runs"** (`text-sm font-medium`) + meta **"6 runs"** (`text-xs
  text-muted-foreground` #525252). (Meta comes from `routines.runs.count`:
  `"{count, plural, =0 {no runs} one {# run} other {# runs}}"` — render 6
  rows, so "6 runs".)
- List container: `ul` — 1px border #E7E7EE, radius ~6px (`rounded-md`),
  `overflow-hidden`, 1px #E7E7EE dividers between rows.
- Collapsed row (a full-width button): `flex items-center gap-3 px-3 py-2.5`,
  min-height 44px, hover bg `#F5F5F5/50`. Contents left→right:
  1. Status dot — 8px circle (`size-2 rounded-full`): #16A34A completed,
     #E54B50 failed. (Active runs pulse — do NOT include an active row; the
     loop resting frame must be completely still.)
  2. State pill — Badge outline: `rounded-full border px-2.5 py-0.5 text-xs
     font-semibold`, `capitalize` on the raw state string. Completed:
     text/border #16A34A (bg 15%, border 30% alpha). Failed: text/border
     #E54B50 (bg 15% ≈ #FCEDED, border 30%). Renders **"Completed"** /
     **"Failed"**.
  3. Relative time — `text-xs` #525252, Intl narrow style. Use (top→bottom,
     newest first): "26m ago", **"2h ago"** (the failed row), "5h ago",
     "1d ago", "2d ago", "3d ago". Rows 1, 3–6 are Completed.
  4. Flex spacer, then chevron-down (16px, #525252) right-aligned; rotates
     180° when expanded.
  - NO error preview on the collapsed failed row pre-click: the preview
    derives from the lazily-fetched detail, so on a fresh page load failed
    rows show only dot + pill + time (deviation from the survey — see notes).
- Expanded state (after the click): row button bg `#F5F5F5/30`; below it a
  disclosure div — top border #E7E7EE, bg near-white (`muted/10`), padding
  12px, 12px vertical rhythm (`space-y-3`):
  1. Full timestamp: `text-xs` #525252 — **"Jul 8, 2026, 7:02:11 AM"**
     (date-fns `PPpp`).
  2. Error block: radius ~6px, 1px border #E54B50 at 40%, bg #E54B50 at 10%
     (≈ #FCEDED), padding 12px. Heading line: alert-circle icon (16px) +
     **"Error"** (`text-sm font-medium`, #E54B50), 4px below it the message
     (`text-xs`, #E54B50): **"Step 2 failed: fetch to
     https://api.example.com/reports returned 429 Too Many Requests"**.
  3. Metadata: h4 **"Metadata"** rendered ALL-CAPS ("METADATA" — `text-xs
     font-medium uppercase tracking-wide` #525252), then a table in a
     ~6px-radius 1px #E7E7EE border, white bg. Header row: **"Key"** (col
     width 1/3) | **"Value"** (`text-muted-foreground` header cells, muted
     header row per shadcn Table). Body rows (key cell `font-medium`,
     `text-sm`): `inputs` → `{ "quarter": "Q3", "recipient":
     "user@example.com" }` · `queue` → `default`.
  4. Button row (`flex gap-2`): ghost sm button **"Show raw payload"**
     (nudged left ~8px), then outline sm button **"Retry with edits"**
     (1px #E7E7EE border, radius ~6px). Do NOT click either — they are
     payoff furniture only.
- Real app renders the disclosure instantly (plain conditional, no Radix
  animation) and flashes a skeleton on first expand while the detail query
  runs. For the short: one fast 200–250ms height reveal (power2.out), no
  skeleton — cache-first detail reads as instant.

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. Inter,
tracking -0.025em. Cursor + motion conventions identical to the 07-07/07-08
shorts (power2.out, 150–350ms, no bounce, no glow); #7033FF appears only in
the hook em-word and the "Routines" pill accent — the card itself is
green/red/neutral like the real product.

## Code snippet decision

**Yes — GraphQL.** The forensics aren't UI-only: every run's error, result,
and metadata is queryable via the public GraphQL API — the section's own lazy
detail query. Excerpt of the actual operation (trimmed of `job_id`, `label`,
`updatedAt`), from `frontend/app/(application)/workflows/queries.ts`
(`GET_JOB_RESULT_BY_ID`):

Anchor line: "The same forensics are one query away — pull any run's error and
inputs programmatically:"

```graphql
query GetJobResultById($id: ID!) {
  job_resultById(id: $id) {
    id
    state
    error
    result
    metadata
    createdAt
  }
}
```

(10 lines, real operation and field names; `metadata.inputs` is exactly what
"Retry with edits" prefills.)

## Page prose within this feature's section (beyond the video)

- **Retry with edits**: the button builds a prefill from the run's recorded
  `metadata.inputs` and reopens the Run dialog (`RunRoutineDialog`) — title
  **"Run {name}"**, quiet mode line **"Runs immediately"** or **"Queued on
  {queue}"**, every input field pre-filled with the failed run's values so you
  fix only what broke. Submit fires the `RunWorkflow` mutation; toasts read
  **"Routine queued"** / **"Routine run started"**.
- **Raw payload**: **"Show raw payload"** / **"Hide raw payload"** toggles a
  copyable JSON CodeBlock (dark #22253A code surface) of
  `{ result, error, metadata }` — the whole record, not just the error.
- **Lazy + cached**: the list fetches only light fields for the last 50 runs
  (`GET_JOB_RESULTS_LIGHT`, newest first); the detail is fetched on first
  expand (`GET_JOB_RESULT_BY_ID`, cache-first) and the row stays mounted, so
  re-collapse/re-expand is instant. Once loaded, a collapsed failed row keeps
  a truncated one-line red error preview inline.
- **States**: dots and pills cover completed / failed / stuck / active
  (pulsing dot) / waiting / delayed / paused; only one run expands at a time.
  Empty state: **"No runs yet"** — **"Press Run to try this routine."**
