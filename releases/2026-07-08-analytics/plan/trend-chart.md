# Feature plan — Daily spend/token/request trend chart

Part of `releases/2026-07-08-analytics/`.

## Sources of truth

- UI: `frontend/app/(application)/analytics/components/trend-chart-card.tsx`
  (the recharts `AreaChart` card, `useActivityDaily`, `measureFromDaily`
  projection), `.../components/explore-region.tsx` (the measure Tabs
  `[Spend | Tokens | Requests]` that write `lens.measure`),
  `.../components/analytics-view.tsx` (page shell / lens wiring),
  `.../hooks.ts` + `.../lens.ts` (`Measure`, `resolveWindow`, URL is the
  single source of truth), `frontend/components/primitives/chart-card.tsx`
  (the frame: title + description + `CardContent`),
  `frontend/components/ui/tabs.tsx` (segmented-control primitive),
  `frontend/components/ui/chart.tsx` (`ChartContainer`).
- On-screen copy: `frontend/messages/en.json` → `analytics.explore.*` and
  `analytics.title` (verbatim below).
- Tokens: `releases/2026-07-08-analytics/hyperframes-design.md` +
  `frontend/app/globals.css` (`--chart-1: 148.0952 53.3898% 53.7255%` =
  **#4AC885**, a green — this is the trend area color, NOT purple).

## What shipped

The `/analytics` redesign's trend card — a recharts `AreaChart` time-series
showing the selected measure per day across the lens window, driven off
LiteLLM's daily endpoint (via `/admin/litellm/tag-activity`), never the
deprecated `components/dashboard` chart:

- **One card, titled "Trend"**, with a live description
  **"Daily {measure} across the selected range."** that names the active
  measure so the y-axis flip is never silent (Spend → "Daily Spend across the
  selected range."; Tokens → "Daily Tokens across the selected range.").
- **A monotone AreaChart**: stroke `hsl(var(--chart-1))` (#4AC885) at 2px,
  fill a vertical gradient of the same green (0.35 → 0.05 opacity, id
  `analyticsTrendFill`), dashed horizontal-only `CartesianGrid` (`3 3`), an
  x-axis of `"MMM dd"` day labels, and a y-axis whose tick formatter follows
  the measure — currency (`Intl.NumberFormat` `style: "currency"`, USD) for
  Spend, plain locale number for Tokens / Requests. `dot={false}`,
  `activeDot r=4`. The area tween is `isAnimationActive` with
  `animationDuration={300}` (disabled under prefers-reduced-motion).
- **The measure switch is a field projection, not a refetch.** LiteLLM's
  daily rows carry explicit `spend` / `prompt_tokens` + `completion_tokens` /
  `successful_requests`, so `measureFromDaily(row, lens.measure)` reprojects
  the SAME loaded rows — the area re-draws instantly to the new series with no
  network round-trip.
- **The control lives above the card**, not in its toolbar: a right-aligned
  Radix `Tabs` segmented control `[Spend | Tokens | Requests]` (aria-label
  **"Measure"**) rendered by `ExploreRegion`. Selecting a tab calls
  `onLensChange({ measure })`, which `router.replace`s the URL
  (`?measure=tokens`) — the URL is the single source of truth and the whole
  Explore region (trend + breakdown) re-derives from it.

## Hook

**Every dollar, every day, at a glance.**

## Surface area

Pure-UI feature: a chart card driven by a URL-backed measure Tabs control.
The one short is the measure switch (Spend → Tokens) re-drawing the area. The
range picker, the breakdown card beside it, the empty/error/loading states,
and the currency-vs-count y-axis formatting are page prose within this
feature's section. No developer surface earns a snippet (see decision below).

## Short — `trend-chart` (1920×1080, 9.0s)

ONE action: click the **Tokens** tab in the measure segmented control; the
green area chart re-draws from the Spend series to the Tokens series (a single
picker selection). No other control moves; the menu/tabs stay otherwise
untouched.

Deviation from the brief: the brief called the control a "statistic-type +
unit selector," but the real UI is a three-way segmented **Tabs** control
`[Spend | Tokens | Requests]` (there is no separate unit dropdown — the unit
follows the measure automatically: currency for Spend, plain count for Tokens/
Requests). We reproduce the real Tabs control. Also: the area color is the
`--chart-1` **green #4AC885**, not purple — purple (#7033FF) appears ONLY in
the hook em-phrase, per house rules (charts use the `--chart-*` ramp).

### Demo arc (timed beats)

The chart is seek-safe: it holds the SPEND series still before the click and
freezes on the fully re-drawn TOKENS series for the resting frame. The area
re-draw is a 300ms `power2.out` morph of the path + gradient (recharts'
`animationDuration={300}`), matched to the real component. The cursor is the
only motion during the demo; nothing else animates.

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.30 | Empty canvas (#FDFDFD + radial purple wash). Nothing animates yet. | Never start at t=0 |
| 0.30–0.70 | Hook enters (fade + 8px rise, power2.out): pill "Analytics" (#E2EBFF bg / #1E69DC text), H1 "Every dollar, every day, **at a glance**." (em phrase "at a glance" in #7033FF) | Entrance |
| 0.70–2.30 | Hook holds completely static (1.6s) | ≥1.4s floor for 7-word phrase |
| 2.30–2.70 | Hook crossfades out; the Trend card fades in already populated — title **"Trend"**, description **"Daily Spend across the selected range."**, measure Tabs above with **Spend** active (white pill + shadow), the green (#4AC885) SPEND area filling the plot | Pivot; card reads instantly, resting on real data |
| 2.70–3.40 | Card holds static (0.7s); the SPEND series is legible | ≥0.6s read of the starting state before any action |
| 3.40–3.90 | Cursor glides in from lower-right toward the **Tokens** tab | Click affordance |
| 3.90–4.10 | Cursor presses **Tokens**: tab depresses (95% scale, 120ms); active pill slides Spend→Tokens (white bg + shadow move right one cell) | The ONE action lands |
| 4.10–4.45 | Description crossfades **"Daily Spend across the selected range." → "Daily Tokens across the selected range."**; y-axis tick labels swap from currency ($) to plain counts | Measure flip is visible, not silent |
| 4.10–4.40 | Green area MORPHS from the Spend path to the Tokens path (300ms power2.out); the gradient fill re-flows under the new curve; x-axis day labels unchanged | The re-draw — same series color, new shape |
| 4.45–5.30 | Cursor eases back out of frame; TOKENS area holds completely still (≥0.85s) | ≥600ms post-action hold, cursor cleared |
| 5.30–5.80 | Payoff caption enters (lower-third, dark text on canvas, no card): "Switch the measure — the trend redraws instantly." | Entrance |
| 5.80–9.00 | Payoff + TOKENS chart hold fully static (3.2s); last ~600ms completely frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

Beat sums: hook 0.30–2.30, pivot/read 2.30–3.40, demo 3.40–5.30, payoff
5.30–9.00 — total 9.00s (≤10s cap). Only motion during holds: none (no
spinners on this surface; recharts is frozen at each resting state).

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg **#FDFDFD** + house radial purple wash (same framing as
the sibling 07-08 shorts). Chart inside a centered card ~1120px wide (radius
~6px, border 1px **#E7E7EE**, bg **#FCFCFC**, subtle shadow
`0px 2px 3px rgba(0,0,0,0.16)`). Inter everywhere, tracking **-0.025em**.
Render at ~1.3–1.5× product type scale for 1080p legibility. Purple #7033FF
appears ONLY in the hook em-phrase and pill-adjacent accent — the chart
surface is semantic green only.

**Measure Tabs** (from `explore-region.tsx` + `tabs.tsx`), right-aligned above
the card, its own row:
- Track: `inline-flex`, rounded-md (~6px), bg **#F5F5F5** (`bg-muted`),
  padding 4px (`p-1`), three equal triggers.
- Trigger label text-sm font-medium (#525252 when inactive). Active trigger:
  bg **#FCFCFC/#FFFFFF** (`bg-background`), text **#000** (`text-foreground`),
  `shadow-sm`, rounded-sm (~4px). Order and verbatim labels:
  **"Spend"** · **"Tokens"** · **"Requests"** (aria-label **"Measure"**).
- At open, **Spend** is active. The action moves the active pill to
  **Tokens**.

**Card header** (from `chart-card.tsx`):
- Title: **"Trend"** — `CardTitle` text-base, #000, font-semibold.
- Description: `CardDescription` text-sm, **#525252** —
  starts **"Daily Spend across the selected range."**, becomes
  **"Daily Tokens across the selected range."** after the click.
- No toolbar on this card (the Tabs live in ExploreRegion above it).

**Chart body** (from `trend-chart-card.tsx`; `ChartContainer` height ~h-72,
full width):
- **Area**: `type="monotone"`, stroke **#4AC885** (`hsl(var(--chart-1))`),
  strokeWidth **2**, `dot={false}`. Fill = vertical linearGradient
  `analyticsTrendFill`: stop 5% #4AC885 @ opacity **0.35**, stop 95% #4AC885 @
  opacity **0.05**.
- **CartesianGrid**: `strokeDasharray="3 3"`, horizontal lines only
  (`vertical={false}`), stroke `border/50` (~#E7E7EE at 50%).
- **XAxis**: `dataKey` = day label in **"MMM dd"** format, no tick line,
  tickMargin 6, fontSize 12, tick text fill **#525252**
  (`.recharts-cartesian-axis-tick text` → muted-foreground).
- **YAxis**: no tick line, no axis line, fontSize 12, fill #525252. Tick
  formatter follows the measure — **Spend** = USD currency (e.g. `$12`,
  `$48`), **Tokens** = plain locale integers (e.g. `40k`, `120k` — render the
  formatted `Intl.NumberFormat` grouping, no unit suffix).
- No legend; no tooltip visible in the short (tooltip is hover-only —
  `cursor={false}`, don't show it).

**Placeholder data** — two 14-day day-series (x-axis = 14 consecutive
`"MMM dd"` labels, e.g. **Jun 25 … Jul 08**). Both are the SAME days; only the
y-values differ per measure (the real switch reprojects the same rows):

- **Spend series** (active at open; small USD numbers, y-axis ticks ~$0–$60):
  a gently rising line — e.g. `$8, $11, $9, $14, $18, $16, $22, $19, $27, $31,
  $28, $35, $41, $48`. Curve reads as a modest upward drift.
- **Tokens series** (after the click; large counts, y-axis ticks ~0–200k): a
  differently-shaped, taller curve — e.g. `62k, 74k, 58k, 90k, 130k, 110k,
  145k, 128k, 172k, 150k, 138k, 165k, 188k, 176k`. It must be visibly a
  DIFFERENT shape than Spend (a mid-window peak, not a clean climb) so the
  re-draw is obvious, and the y-axis magnitude jumps ($ → 100k+).

Keep both curves inside the same plot rect; the morph interpolates the green
path from the Spend shape to the Tokens shape over 300ms. The gradient fill
re-flows under the new curve. X-axis labels and the green stroke color stay
constant across the switch — only the shape and the y-axis scale change.

**Cursor**: a simple system arrow; visible only 3.40–4.45s (glide in, press,
glide out). No cursor during the hook, the resting read, or the payoff.

Hook pill/H1 and payoff caption use the same type treatment as the sibling
07-08 shorts (pill #E2EBFF bg / #1E69DC text; payoff as a lower-third caption,
dark #000 text on the canvas, no card).

## Code snippet decision

**None — pure UI.** The measure switch is a client-side field projection over
already-loaded rows: `ExploreRegion`'s Tabs write `lens.measure` to the URL,
and `measureFromDaily(row, lens.measure)` reprojects the same
`/admin/litellm/tag-activity` daily rows — no GraphQL op, no per-measure REST
call, no SDK method fires on the switch. The data source is a backend REST
proxy (`GET /admin/litellm/tag-activity`) that attaches
`LITELLM_MASTER_KEY` server-side and is deliberately NOT a browser-callable
developer surface, so it doesn't earn the spot. Per the earn-the-spot rule
(real developer surfaces only), this short carries no code snippet.

## Page prose within this feature's section (beyond the video)

- The measure control is a single segmented **Tabs** — **Spend** (USD
  currency), **Tokens** (prompt + completion), **Requests** (successful) —
  and it is the ONLY in-region scope control after the legacy `LensType`
  Select retired. The dimension picker moved up to the page header.
- Measure is URL-backed (`?measure=tokens`); the URL is the single source of
  truth, so a switch is deep-linkable and drives BOTH the trend card and the
  breakdown card beside it in one `router.replace`. Legacy `?measure=count`
  deep links map to **Requests**.
- The switch never refetches: LiteLLM's daily rows carry `spend`,
  `prompt_tokens`/`completion_tokens`, and `successful_requests` explicitly,
  so the measure is a field projection over the already-loaded window — the
  area re-draws instantly.
- The y-axis unit follows the measure automatically — currency formatting for
  Spend, plain locale counts for Tokens/Requests — and the card description
  names the active measure ("Daily {measure} across the selected range.") so
  the axis flip is never silent.
- States the card owns via `ChartCard`: a layout-mirroring skeleton while the
  first window loads, an inline error with a **Retry** button
  ("We couldn't load this chart."), and a quiet empty state
  (**"No activity in this window"** / "Try a wider range or a different event
  type.") when the window has zero total.
- Motion respects `prefers-reduced-motion`: under reduce, `isAnimationActive`
  is off and the area swaps with no tween.
