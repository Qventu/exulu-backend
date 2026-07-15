# Feature plan — Date-range lens (deep-linkable analytics window)

Part of `releases/2026-07-08-analytics/`.

## Sources of truth

- UI: `frontend/app/(application)/analytics/components/range-picker.tsx`
  (the segmented preset Tabs + the date-pill Popover with a max-30-day
  range Calendar), `.../components/analytics-view.tsx` (page shell:
  PageHeader → KPIStrip → ExploreRegion; `updateLens` calls
  `router.replace(lensToSearchParams(...))` so the URL is the lens),
  `.../components/explore-region.tsx` (measure Tabs + the two chart cards),
  `.../components/trend-chart-card.tsx` (the Area chart on the left),
  `.../components/kpi-strip.tsx` (the three StatCards)
- Pure lens contract: `.../lens.ts` — `lensToSearchParams` (sorted keys,
  emits `from` / `range` / `to` for a custom range), `resolveWindow`,
  `MAX_RANGE_DAYS = 30`, `DEFAULT_PRESET = "14d"`
- On-screen copy: `frontend/messages/en.json` → `analytics.range.*`,
  `analytics.explore.*`, `analytics.kpi.*` (verbatim below)
- Tokens: `releases/2026-07-08-analytics/hyperframes-design.md` +
  `frontend/app/globals.css` chart ramp — **`--chart-1` (light) =
  `hsl(148.0952 53.3898% 53.7255%)` ≈ `#4AC885` (mint-green)** is the trend
  area color; `--chart-2 = #7033FF`, `--chart-3 = #FD822B`,
  `--chart-4 = #3276E4`, `--chart-5 = #747474`

## What shipped

The whole analytics view is URL-driven, so any view is a shareable link:

- **Segmented range presets** — a Tabs row `[24h | 7d | 14d | 30d]`
  (verbatim `preset24h` … `preset30d`). The active preset earns the purple
  primary tint — one of only two purple touches on the page (the other is
  the measure Tabs in Explore). **There is no "Custom" tab trigger** — see
  the deviation below.
- **A date-pill button** beside the tabs: a calendar-icon outline button
  whose label is the active preset name, OR — once a custom range is
  chosen — a formatted range string `"Jun 24 – Jul 08, 2026"` (from
  `` `${format(fromDate,"LLL dd")} – ${format(toDate,"LLL dd, y")}` ``).
  Clicking it opens a Popover with a single-month range **Calendar**
  (`mode="range"`, `numberOfMonths={1}`) and a footnote
  **"Maximum range: 30 days"** under a top border.
- **Selecting a start + end date** in that calendar flips the lens to
  `preset: "custom"` and writes `customFrom` / `customTo` as ISO. The
  popover closes and every chart + KPI recomputes to the new window
  (`resolveWindow` + the `useActivity*` hooks re-fetch off the new lens).
- **Over-30-day ranges downgrade with a toast** — picking an end date more
  than 30 days after the start fires `toast.error` with title
  **"Date range too large"** / description **"Please select a date range
  of 30 days or less."** (days past the start are also visually disabled in
  the calendar). A deep-linked `?range=custom` over 30 days is reset to the
  last 14 days on load, with the toast **"The deep-linked range exceeded 30
  days and was reset to the last 14 days."**
- **The lens is the URL.** `lensToSearchParams` serializes the window into
  sorted query params, so a custom two-week view is a stable, bookmarkable,
  shareable link. `router.replace(..., { scroll: false })` writes it;
  `useSearchParams` reads it back — no local mirror.

## Hook

**Bookmark the exact cost view. Send it to _anyone_.**

(em-word "anyone" in brand purple `#7033FF`.)

## Surface area

Pure-UI feature: a URL-driven analytics lens. The ONE short is the custom
range selection (one calendar pick → popover closes → charts refresh),
with the shareable URL as the payoff. The preset tabs, the >30-day toast,
the measure Tabs, and the deep-link reset are page prose within this
feature's section. No code snippet earns the spot (see decision below).

## Short — `date-range-lens` (1920×1080, 9.0s)

ONE user action: a single custom range selection in the calendar popover.
The demo opens with the popover already open and the **start date already
picked** (Jun 24 highlighted) so the ONE on-screen click is choosing the
**end date** (Jul 08) — which completes the range, closes the popover, and
refreshes the charts. Everything before that click is the pre-clicked
state; everything after is the resulting window + the shareable-URL payoff.

Deliberate deviation from the brief: the real UI has **no "Custom" tab** —
the segmented row is `[24h | 7d | 14d | 30d]` only, and a custom range is
entered by opening the date-pill Popover and picking dates in the Calendar
(`handleCalendarSelect` flips `lens.preset` to `"custom"`). We reconstruct
that real flow: the click lands on a calendar day, not a tab. Also
faithful: pre-selecting the start date so the whole range is chosen in one
click (a range needs two clicks in reality; we open on the first already
done, which is a valid mid-interaction state the calendar renders).

### Demo arc (timed beats)

Anchor "today" = **Jul 08, 2026**. Opening lens = default **14d** preset,
measure = **Spend**. The custom pick is **Jun 24 → Jul 08** (a 14-day
window, exactly at the two-week ask). Trend area is `#4AC885` (chart-1).

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.35 | Hook enters: pill "Analytics" (#E2EBFF bg / #1E69DC text), H1 "Bookmark the exact cost view. Send it to **anyone**." (em-word "anyone" #7033FF) | Entrance (never at t=0) |
| 0.35–2.15 | Hook holds static (1.8s) | ≥1.8s floor (full sentence) |
| 2.15–2.55 | Hook crossfades out; analytics card fades in. Header shows range Tabs `[24h · 7d · **14d** · 30d]` (14d active, purple tint) + date-pill button reading **"14d"**, its Popover **already open** below it with a single-month **July 2026** calendar; **Jun 24 already highlighted** as range start, days after Jul 24 dimmed (disabled). KPI strip + Trend area (mint `#4AC885`) fill the body behind the popover. | Pivot; the pre-clicked state reads instantly |
| 2.55–3.55 | Static hold (1.0s): cursor rests over the calendar, popover open on the pre-picked start | Let the "pick an end date" affordance register |
| 3.55–3.95 | Cursor moves to **Jul 08** cell; day-cell hover tint appears (power2.out, 200ms) | Cursor affordance for the one click |
| 3.95–4.15 | **Click** on Jul 08: the range Jun 24→Jul 08 fills with the calendar's range band; brief press-state on the day | The ONE action lands |
| 4.15–4.55 | Popover closes (fade + 4px rise out, 200ms). Range Tabs deselect (14d loses its purple tint — no preset is active now). Date-pill label swaps **"14d" → "Jun 24 – Jul 08, 2026"** | Custom range commits; preset clears |
| 4.55–5.25 | Charts refresh to the new window: Trend area re-tweens to the Jun 24–Jul 08 shape (Recharts area, ~300ms); the three KPI values (Spend / Tokens / Requests) cross-fade to new numbers | Whole view recomputes off the lens |
| 5.25–6.05 | Resulting state holds completely still (800ms) | ≥600ms post-action still hold |
| 6.05–6.45 | Payoff enters: a subtle URL pill slides up as a lower-third — mono text `/analytics?from=…&range=custom&to=…` with the `range=custom` segment tinted `#7033FF`; small caption above it "This exact window is a link." | Entrance; the shareable payoff |
| 6.45–9.00 | Payoff + card hold still (2.55s); last ~600ms fully frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

Motion: every transition power2.out, 150–300ms, no bounce, no glow. The
calendar range band and the day hover use the calendar's own accent (a
muted neutral, NOT purple). Purple appears only in: the hook em-word, the
`14d` active-tab tint (before the click), and the `range=custom` segment of
the payoff URL pill. Nothing else is loud.

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg `#FDFDFD` + the house radial purple wash (same framing
as the sibling 07-08 shorts). The analytics surface sits in a centered card
~1120px wide (radius ~6px, border 1px `#E7E7EE`, bg `#FCFCFC`, subtle
shadow `0px 2px 3px rgba(0,0,0,0.16)`). Inter everywhere, tracking
-0.025em. Render at ~1.3–1.5× product type scale for 1080p legibility.

**Header row** (PageHeader, title left / action right):
- Title **"Analytics"** (`analytics.title`), text-lg font-semibold `#000`;
  under it the muted description **"Usage across agents, users, and
  projects."** (`analytics.purpose`), text-sm `#525252`. (Keep the
  description short or drop it below the fold — the popover is the focus.)
- Action cluster, right-aligned: the range **Tabs** then the date-pill
  **Button**. (The real header also has a "View by" DimensionPicker and an
  "Open LiteLLM admin" button — omit both to keep the ONE action clean; if
  rendered, keep them muted and inert.)

**Range Tabs** (from `range-picker.tsx`, `analytics.range.*`): a bordered
segmented `TabsList` with four triggers left→right — **"24h"**, **"7d"**,
**"14d"**, **"30d"** (verbatim). Trigger text-sm. The active trigger (14d
before the click) carries the purple primary tint (bg `#7033FF` region /
white text is too loud for a real Radix tab — use the app's actual active
state: a subtly raised white segment with `#7033FF` text/underline accent).
After the click, NO trigger is active (custom range clears the preset).

**Date-pill Button** (outline, size sm): a `CalendarIcon` (16px, lucide) +
label. Label = **"14d"** before the pick (the active preset name), swapping
to **"Jun 24 – Jul 08, 2026"** after. Border 1px `#E7E7EE`, radius ~6px,
text-sm.

**Popover / Calendar** (from `range-picker.tsx`): a popover card
(`align="end"`, `p-0`, radius ~6px, border `#E7E7EE`, stronger shadow than
the base card) anchored under the date-pill. Inside:
- A single month **"July 2026"** header with `‹` / `›` nav chevrons
  (react-day-picker default), weekday row Su Mo Tu We Th Fr Sa, and the
  July grid (Jul 1 = Wednesday). It is a **range** calendar
  (`mode="range"`, `numberOfMonths={1}`).
- **Jun 24 is the range start** (highlighted). Because the month shown is
  July, render June's tail so Jun 24–30 are visible as leading/adjacent
  days, OR show June+July compactly — simplest faithful option: show the
  **June 2026** month (start month = `fromDate`, so `defaultMonth` is June)
  with Jun 24 selected and Jul 08 reachable by paging; to keep ONE click,
  show a month view where **both Jun 24 and Jul 08 are visible in one grid**
  — use a **single grid spanning the selection** by rendering July with
  June's trailing week, and place Jun 24 (selected start) + Jul 08 (the
  click target) in the same visible grid. Days **after Jul 24** are dimmed
  (disabled — the `MAX_RANGE_DAYS` window from the Jun 24 start).
- Footnote under a top border (`border-t p-3`): **"Maximum range: 30 days"**
  (`analytics.range.footnote`, text-xs `#525252`).

**KPI strip** (from `kpi-strip.tsx`, `analytics.kpi.*`): three StatCards in
a row — labels **"Spend"**, **"Tokens"**, **"Requests"** (text-xs `#525252`
uppercase-ish label), each with a large value and a small `vs previous:`
delta caption. Neutral placeholder values (choose plausible finance-flavored
numbers, no real brands):
- Spend: `$1,284.60` — delta `+8.2%` (up)
- Tokens: `4,912,730` — delta `−3.1%` (down)
- Requests: `18,204` — delta `+1.4%` (up)
Deltas earn semantic color only past ±25% (StatCard rule) — at these small
percentages the deltas are **neutral/muted**, NOT green/red. On the refresh
(t 4.55–5.25) cross-fade these to slightly different numbers for the
narrower window (e.g. Spend `$611.40`, Tokens `2,338,110`, Requests
`8,760`).

**Trend card** (from `trend-chart-card.tsx`): a ChartCard titled
**"Trend"** (`analytics.explore.trendTitle`), description **"Daily Spend
across the selected range."** (`trendDescriptionMeasure` with
measure="Spend"). Body = a recharts **Area** chart: stroke + gradient fill
in **`#4AC885`** (`--chart-1`), 2px stroke, gradient 0.35→0.05 opacity,
dashed horizontal CartesianGrid, x-axis of `MMM dd` date ticks, no dots.
On refresh the area re-tweens (~300ms) to the new 14-day shape. To the
right sits the **Breakdown** card (title **"Breakdown"**), which can be
rendered as a quiet secondary card (a small ranked list / mini bars in the
chart ramp `#4AC885` / `#7033FF` / `#FD822B`) — keep it low-contrast; it's
context, not the subject.

**Measure Tabs** (above the charts, from `explore-region.tsx`,
`analytics.explore.*`): a right-aligned segmented `[Spend | Tokens |
Requests]` with **"Spend"** active (purple tint). Verbatim triggers:
`measureSpend` = "Spend", `measureTokens` = "Tokens", `measureRequests` =
"Requests". Inert in this short.

**Payoff URL pill** (payoff beat only): a lower-third rounded pill
(`#FCFCFC` bg, border `#E7E7EE`, radius ~6px) with a small leading globe/
link glyph and JetBrains Mono text:
`/analytics?from=2026-06-24&range=custom&to=2026-07-08` — the real
serializer sorts keys alphabetically (`from`, `range`, `to`) and emits
`range=custom`; tint just the `range=custom` token `#7033FF`, the rest
`#525252`. (The live app writes full ISO timestamps
`…from=2026-06-24T00:00:00.000Z&…to=2026-07-08T00:00:00.000Z`; truncate to
the `YYYY-MM-DD` date for legibility and add a trailing `…` if you want to
signal the timestamp — a faithful abbreviation, not a fabrication.) Caption
above the pill (text-sm, dark on canvas): **"This exact window is a link."**

### Placeholder discipline

No real brands or people anywhere. KPI numbers are neutral finance-flavored
figures. If the Breakdown card lists rows, use neutral labels: "Support
agent", "Finance", "Quarterly report", `user@example.com`. Dates are the
real anchor dates (Jun 24 / Jul 08 2026) — those are structural, not PII.

## Code snippet decision

**None — pure-UI feature.** The load-bearing surface here is the URL shape
itself, and the earn-the-spot rule reserves the code slot for GraphQL /
REST / SDK developer operations. The analytics data does ride a real REST
proxy (`GET /admin/litellm/tag-activity?start_date=…&end_date=…`, backend
`src/exulu/routes.ts` ~L3003; frontend builder `buildTagActivityPath` in
`lib/litellm-activity.ts`), but that endpoint is a browser-side proxy the
range picker parameterizes, not a hand-authored developer call — surfacing
it would misrepresent the feature, which is "the view IS the URL." The
shareable URL is already the short's payoff (the lower-third pill), so no
separate code block is warranted. If the page section later wants a
developer note, the honest one is the URL contract from `lensToSearchParams`
(`?from=…&range=custom&to=…`, sorted keys), not a REST snippet.

## Page prose within this feature's section (beyond the video)

- **Presets + custom, one lens.** The range row is `24h / 7d / 14d / 30d`
  (default **14d**); a custom window is entered from the date-pill's
  calendar. Picking any two dates flips the lens to a custom range and
  drops the active preset. The whole page — KPIs, Trend, Breakdown —
  recomputes off that one window via `resolveWindow`.
- **Every view is a link.** The lens is serialized into the URL
  (`lensToSearchParams`, sorted keys); `router.replace` writes it without
  scrolling and `useSearchParams` reads it back, so there's no local state
  to drift. Copy the URL and the exact window — range, measure, dimension,
  and breakdown view — travels with it.
- **30-day guardrail.** A custom range is capped at 30 days
  (`MAX_RANGE_DAYS`). Picking an end more than 30 days past the start is
  blocked with the toast **"Date range too large" / "Please select a date
  range of 30 days or less."**, and days beyond the cap are disabled in the
  calendar. A deep-linked `?range=custom` that exceeds 30 days (or has
  missing/unparseable dates) is reset on load to the last 14 days, with a
  one-shot toast: **"The deep-linked range exceeded 30 days and was reset
  to the last 14 days."**
- **Backwards-compatible deep links.** Legacy `?type=AGENT_RUN` /
  `?type=USER_BUDGET` / etc. URLs still resolve — they're remapped to the
  equivalent `dimension` (agents / users / …) with a quiet one-shot
  "Filter updated" toast, and the URL canonicalizes on the next replace
  (`lensToSearchParams` never emits `?type`).
- **Measure + dimension are part of the lens too.** The `[Spend | Tokens |
  Requests]` measure Tabs and the header "View by" dimension picker also
  serialize to the URL, so a shared link reproduces not just the date
  window but the full analytical framing.
