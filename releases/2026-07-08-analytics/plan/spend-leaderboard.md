# Feature plan — Spend leaderboard: breakdown by dimension

Part of `releases/2026-07-08-analytics/`.

## Sources of truth

- UI: `frontend/app/(application)/analytics/components/breakdown-chart-card.tsx`
  (the ChartCard "Breakdown", header toggle `[List | Share]`, id→name
  hydration via six `*_BY_IDS` GraphQL queries),
  `.../components/ranked-list.tsx` (the leaderboard: top-N `<ol>` with
  proportional `bg-primary/10` bars + medal-tinted rank numerals — the
  literal successor to the legacy `Leaderboard`),
  `.../components/donut-view.tsx` (the Share view — NOT toggled in this
  short, page prose only),
  `.../components/dimension-picker.tsx` (the page-level "Split by:" `Select`
  that drives `lens.dimension`),
  `.../queries.ts` + `frontend/queries/queries.ts` (`GET_*_BY_IDS`),
  `.../lens.ts` (dimension order + defaults),
  `frontend/components/primitives/chart-card.tsx` (the card frame).
- On-screen copy: `frontend/messages/en.json` → `analytics.breakdown.*`,
  `analytics.header.*` (verbatim below).
- GraphQL: `GET_TEAMS_BY_IDS` in `frontend/queries/queries.ts` (~line 3267).
- Tokens: `releases/2026-07-08-analytics/hyperframes-design.md` +
  `frontend/app/globals.css` (`--chart-1..10`, light theme, below).

### Verified facts (reality over brief)

- **Defaults** (`lens.ts`): `DEFAULT_MEASURE = "spend"`,
  `DEFAULT_DIMENSION = "agents"`, `DEFAULT_VIEW = "list"`. So the card opens
  already on the leaderboard, showing spend split by Agents. No need to set
  the measure or view — the star (RankedList) is the default state.
- **The dimension picker is NOT in the card.** It moved to the page header
  (`analytics-view.tsx` header, next to the range picker) — the card only
  consumes `lens.dimension`. So the action is: the page-header "Split by:"
  `Select` opens and switches Agents → Teams, and the card below re-ranks.
  Frame both the header control and the card in one centered surface.
- **`GET_TEAMS_BY_IDS` takes no `$ids`** — unlike agents/users/projects it
  fetches all teams (`teamsPagination(page:1, limit:200)`) and the card
  filters client-side. Reflected in the snippet.
- The Breakdown card **description** is `"{dimension} · by spend"` — literally
  `"Agents · by spend"` before, `"Teams · by spend"` after (built from
  `t("breakdown.dim*")` + `t("breakdown.subtitleBySpend")` in
  breakdown-chart-card.tsx). This is the second thing that changes on switch.
- The DimensionPicker `<label>` is `"Split by:"` (`header.splitByLabel`),
  NOT "View by" — `header.dimension` ("View by") is only the empty-state
  placeholder and is never shown here. Use "Split by:".

## What shipped

A **Breakdown** card that splits the active measure (spend, by default) by a
**page-level dimension picker** — Agents, Users, Projects, Teams, Roles,
Routines. Two views toggle in the card header:

- **List** (`LayoutList` icon) → **RankedList**: a top-10 `<ol>`, each row a
  bordered card with a proportional purple bar (`bg-primary/10`, width =
  `value / topValue × 100%`), a rank-numeral bubble (medal-tinted #1 amber,
  #2 gray, #3 amber-light, rest neutral), the entity name, and the value
  right-aligned (USD-formatted for spend) over the unit label. This is the
  **leaderboard** — literally the successor to a legacy `Leaderboard`
  component (see the docblock in `ranked-list.tsx`).
- **Share** (`PieIcon` icon) → **DonutView**: a recharts `Pie` on the
  `--chart-1..10` ramp with a color-keyed legend below (page prose only in
  this short).

LiteLLM tags carry only stable ids, so the top-10 ids are hydrated to human
names via **six `*_BY_IDS` GraphQL queries** (agents/users/projects/teams/
roles/routines) — Postgres is the source of truth for names.

## Hook

**Who is burning the budget? Now you can see.**

(em-word: **budget** in brand purple `#7033FF`.)

## Surface area

UI feature (the Breakdown leaderboard) + one real developer surface: the
`GET_TEAMS_BY_IDS` GraphQL query that hydrates the top-10 tag ids to team
names when the switch lands. One short on the dimension switch; the List↔Share
donut toggle, the six-way dimension menu, CSV export, and the by-ids
hydration for the other five dimensions are page prose within this feature's
section.

## Short — `spend-leaderboard` (1920×1080, 9.0s)

One slice, ONE action: open the header **"Split by:"** picker and pick
**Teams**; the leaderboard below re-ranks from agent names to team names with
new proportional bars. The ranked list stays on screen as the star — the
donut/Share view is NOT toggled here.

### Demo arc (timed beats)

Framing: measure = **spend** (USD), view = **List** throughout. Before =
Agents; after = Teams. Bars are proportional to the top (rank-1) value, so the
rank-1 bar is always full width and every other bar is `value/top`.

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.30 | Hook enters (lower third on canvas): pill "Analytics" (#E2EBFF bg / #1E69DC text); H1 "Who is burning the **budget**? Now you can see." (em-word **budget** #7033FF) | Entrance (never at t=0) |
| 0.30–2.10 | Hook holds static (1.8s) | ≥1.8s floor (full sentence, 8+ words) |
| 2.10–2.45 | Hook fades out; surface fades in — page-header row ("Split by:" Select reading **"Agents"**) above the **Breakdown** card, description **"Agents · by spend"**, RankedList showing agent leaderboard (rows 1–6 below) | Pivot; leaderboard reads instantly |
| 2.45–3.25 | Static hold on the Agents leaderboard (0.8s) | Let the "before" state land + read (>600ms) |
| 3.25–3.75 | Cursor moves to the "Split by:" Select and clicks; the Select opens as a popover listing **Agents · Users · Projects · Teams · Roles · Routines** (Agents checked) | The ONE action (part 1: open) |
| 3.75–4.45 | Popover holds open (0.7s); cursor drops to hover-highlight **Teams** | Read the 6 options (7 words, ≥1.4s across open+hover) |
| 4.45–4.75 | Cursor clicks **Teams**; popover closes; trigger now reads **"Teams"** | The ONE action (part 2: select) |
| 4.75–5.55 | Card re-ranks: description crossfades **"Agents · by spend" → "Teams · by spend"**; each row's name crossfades agent→team name, value swaps, bar width animates to the new proportion (power2.out, ~300ms, staggered ~40ms top→down) | The re-rank — the payoff moment |
| 5.55–6.55 | Re-ranked Teams leaderboard holds completely still (1.0s) | ≥600ms post-action settle |
| 6.55–6.95 | Payoff caption enters (lower third): "Split spend by team, project, or agent — top 10, ranked." | Entrance |
| 6.95–9.00 | Payoff holds still (2.05s); last ~600ms fully frozen = loop resting frame (bars at final width, no spinner, no cursor) | ≥1.8s full-sentence floor + clean seek-safe loop |

Bar-width tweens and the description/name crossfades are 250–300ms power2.out,
no bounce, no glow. The Select-open is a 150ms fade+2px-rise popover. The
cursor is the only moving element during 3.25–4.75; after 5.55 the frame is
fully static (freeze bars at final width for the resting frame — seek-safe).

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg **#FDFDFD** + house radial purple wash (same framing as
the sibling 07-08 shorts). The surface is a centered column ~1120px wide: a
**page-header row** on top, then the **Breakdown card** below it, at ~1.3–1.5×
product type scale for 1080p legibility. Inter everywhere, tracking −0.025em.
Purple **#7033FF** appears only in the hook em-word, the payoff (none), and
the leaderboard bars (`bg-primary/10` = purple at 10% — a soft wash, not
loud). No other loud color.

**Page-header row** (from `dimension-picker.tsx`, left-aligned or right of a
title; render just the picker cluster):
- `<label>` **"Split by:"** — text-sm #525252 (muted-foreground).
- `Select` trigger — 160px wide, height ~36px, border 1px #E7E7EE, radius
  ~6px, bg #FCFCFC, a chevron-down glyph at right. Reads **"Agents"** before,
  **"Teams"** after.
- Open popover (SelectContent): white card, border #E7E7EE, radius ~6px,
  subtle shadow; six `SelectItem` rows in this exact order (from
  `DIMENSIONS`): **Agents**, **Users**, **Projects**, **Teams**, **Roles**,
  **Routines** — each text-sm, ~32px tall, hover bg #E2EBFF/40 (accent). The
  selected item shows a left check glyph (Agents at open, then Teams).

**Breakdown card** (from `chart-card.tsx`): a `Card` — border 1px #E7E7EE,
radius ~6px, bg #FCFCFC, subtle shadow (0px 2px 3px rgba(0,0,0,0.16)).
- **CardHeader** (p-4, row on desktop): left = title **"Breakdown"** (text-base,
  #000, font-semibold) with description below it **"Agents · by spend"** →
  **"Teams · by spend"** (text-sm, #525252). Right = toolbar cluster:
  1. **"Export CSV"** button — outline, small, a download glyph + label text-sm
     (`header.exportCsv`). Static, never clicked.
  2. A 2-segment **ToggleGroup** — `[LayoutList icon | PieIcon icon]`
     (`breakdown.viewListAria` "List view" / `breakdown.viewShareAria`
     "Share view"). The **List** segment (first, LayoutList) is selected/active
     (bg #EDF1F5 secondary, subtle inset) throughout — we never touch it.
- **CardContent** (p-4 pt-0): the **RankedList** `<ol>` (`space-y-2`).

**RankedList rows** (from `ranked-list.tsx`) — each `<li>`:
- Container: `rounded-md border bg-card p-3`, border #E7E7EE, radius ~6px,
  bg #FCFCFC, `overflow-hidden`, `relative`.
- Proportional **bar**: an absolutely-positioned div, `inset-y-0 left-0`,
  `bg-primary/10` (= #7033FF @ 10% ≈ #F1ECFF fill), `width: {pct}%` where
  `pct = value / topValue × 100`. The rank-1 row's bar is 100% (full width);
  all others are shorter. Animate width on the re-rank (300ms ease-in-out).
- Foreground row (flex, justify-between, gap-3):
  - Left: rank-numeral **bubble** — `size-6` (~24px) rounded-full, centered
    numeral text-xs font-medium tabular-nums. Tints:
    - #1 → `bg-warning/20 text-warning` (amber bubble, #D97706 numeral)
    - #2 → `bg-muted-foreground/20 text-muted-foreground` (gray)
    - #3 → `bg-warning/10 text-warning` (faint-amber bubble)
    - #4+ → `bg-muted text-muted-foreground` (neutral #F5F5F5 / #525252)
    — then the entity **name** (text-sm font-medium, #000, truncate).
  - Right (text-right, shrink-0): the **value** (text-sm font-semibold,
    tabular-nums, #000) — USD-formatted for spend (e.g. `$1,204.50`) — over
    the **unit label** **"spend"** (`breakdown.valueLabelSpend`, text-xs
    #525252).

**Leaderboard data** (neutral placeholders; spend in USD; rows sorted desc so
the bars descend). Show the **top 6** rows (real UI shows up to 10; 6 keeps
1080p legible). The rank-1 value is the 100%-width bar; each bar =
`value / 1204.50 × 100%`.

Before — **Agents · by spend** (bars: 100 / 74 / 55 / 41 / 30 / 22 %):

| # | Name (agent) | Value |
|---|---|---|
| 1 | Support agent | $1,204.50 |
| 2 | Research agent | $892.30 |
| 3 | Onboarding agent | $661.80 |
| 4 | Billing agent | $498.10 |
| 5 | Triage agent | $358.90 |
| 6 | Summary agent | $265.40 |

After — **Teams · by spend** (bars: 100 / 68 / 52 / 39 / 27 / 18 %):

| # | Name (team) | Value |
|---|---|---|
| 1 | Finance | $2,041.70 |
| 2 | Support | $1,388.20 |
| 3 | Engineering | $1,061.40 |
| 4 | Sales | $796.30 |
| 5 | Operations | $551.90 |
| 6 | Marketing | $367.50 |

(Team totals are larger than agent totals — teams aggregate many agents — so
the re-rank visibly reshuffles both names AND magnitudes. Keep the medal tints
on the new top-3. The full-width bar stays on rank 1 in both states.)

**Chart tokens** (`globals.css`, light theme) — recorded for fidelity even
though the RankedList itself uses only `bg-primary/10`; the Share/DonutView
(page prose) is the recharts surface that consumes them:

```
--chart-1: hsl(148.10 53.39% 53.73%)   green
--chart-2: hsl(257.94 100%   60%)      purple (== --primary #7033FF)
--chart-3: hsl(24.86  98.13% 58.04%)   orange
--chart-4: hsl(217.08 76.72% 54.51%)   blue
--chart-5: hsl(0      0%     45.49%)   gray
--chart-6: hsl(173    80%    40%)      teal
--chart-7: hsl(330    81%    60%)      pink
--chart-8: hsl(45     93%    47%)      yellow
--chart-9: hsl(292    84%    61%)      magenta
--chart-10: hsl(84    81%    44%)      lime
```

Hook pill/H1 and payoff caption use the same type treatment as the sibling
07-08 shorts: pill #E2EBFF bg / #1E69DC text; the payoff as a lower-third
caption (dark #000 text on the canvas, no card).

## Code snippet decision

**Yes — GraphQL.** The switch to Teams is exactly what fires the id→name
hydration: the top-10 LiteLLM tag ids get resolved to team names via
`GET_TEAMS_BY_IDS`. It's the real developer surface behind the on-screen
re-rank, and (unlike the agents/users/projects variants) it fetches the whole
team set and reconciles client-side — worth showing. Verbatim from
`frontend/queries/queries.ts` (~line 3267):

Anchor line: "Tag ids carry no names — the leaderboard hydrates them from
Postgres on switch:"

```graphql
query GetTeamsByIds {
  teamsPagination(page: 1, limit: 200) {
    items {
      id
      name
    }
  }
}
```

(7 lines, real operation and field names; the card maps these `id → name`
rows onto the top-10 tag ids from LiteLLM. Show this once, statically, beneath
or beside the surface — do not animate it.)

## Page prose within this feature's section (beyond the video)

- **Six dimensions, one control.** The page-header **"Split by:"** picker
  re-scopes the whole Breakdown card: **Agents**, **Users**, **Projects**,
  **Teams**, **Roles**, **Routines**. It lives in the page header (next to the
  range picker), not inside the card, so the scope is reachable at-a-glance
  regardless of which card has focus.
- **Two views, one card.** The header toggle flips **List** (the leaderboard)
  ↔ **Share** (a recharts donut on the `--chart-1..10` ramp with a color-keyed
  legend, so slice identity is never hover-only).
- **The leaderboard is the successor to the legacy `Leaderboard`.** RankedList
  keys rows by stable id (no display-name collisions), draws proportional
  bars with the `bg-primary/10` token (no hardcoded hex), and marks the top 3
  by rank numeral + a subtle medal tint — color is never the only carrier of
  meaning (the numeral is).
- **Names come from Postgres, not LiteLLM.** LiteLLM tags carry only stable
  ids, so the top-10 ids are hydrated to human names via six `*_BY_IDS`
  GraphQL queries (`GET_AGENTS_BY_IDS`, `GET_USERS_BY_IDS`,
  `GET_PROJECTS_BY_IDS`, `GET_TEAMS_BY_IDS`, `GET_ROLES_BY_IDS`,
  `GET_ROUTINES_BY_IDS`); an unresolved id falls back to the raw id string.
- **Measure-aware formatting.** Spend renders as USD currency (`$1,204.50`);
  tokens/requests render as plain locale numbers. The unit label under each
  value follows the measure ("spend" / "tokens" / "requests").
- **Export CSV.** The toolbar's **"Export CSV"** button pivots the same
  top-10 into a per-day matrix (Entity × dates × Total) with hydrated names,
  BOM-prefixed for clean Excel UTF-8; disabled while loading or empty.
- **Empty state.** With no data for the current lens the card shows a quiet
  **"No data for this lens"** / "Try a wider range or a different event type."
