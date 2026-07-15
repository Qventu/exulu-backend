# Feature plan — Unattributed spend hint (SHORT)

## Sources of truth

- Spec: frontend repo `docs/superpowers/specs/2026-06-27-unattributed-spend-hint-design.md`
  (committed in `827d91a`; plan `c8dc6dc`)
- Components: `frontend/components/primitives/stat-card.tsx` (`hint` prop,
  `98f376d`), `frontend/app/(application)/(home)/components/home-dashboard.tsx`
  (`a8a3d12`, fix `cc7add5`), `frontend/app/(application)/analytics/components/kpi-strip.tsx`
  (`5e08396`), hooks `db08cc2`
- Strings: `frontend/messages/en.json` → `home.vitals.*`, `analytics.kpi.*`

## What shipped

Exulu's dashboards count only `user_id_*`-tagged LiteLLM requests, so platform
totals were always ≤ the LiteLLM global total — a gap with no explanation.
Now, when the unattributed gap exceeds 1% of the unfiltered total, a second
quiet caption line appears on the Spend / Tokens (Home vitals) and Spend /
Tokens / Requests (analytics KPI strip) cards: **"+ $12.34 unattributed"**.
Negative or ≤1% gaps are suppressed; the hint only renders once both queries
resolve (no flash of wrong values).

## Hook

**"Spend, fully accounted"** — the gap tagged totals miss, now on the card.

## Surface area

UI feature (recipe A / D hybrid) — a dashboard state change, no user action.
Single-state-change slice; the hint line appearing IS the demo.

## Reconstruction cues (exact, from the shipped code)

- Home section title (`WidgetSection`): **"Last 24 hours"**; grid
  `grid grid-cols-2 gap-4 md:grid-cols-4` of 4 StatCards, labels verbatim:
  **"Sessions"**, **"Spend"**, **"Tokens"**, **"Routine runs"**.
- StatCard anatomy (Card, `p-4`, border `#E7E7EE`, radius 6px, bg `#FCFCFC`):
  - label: `text-sm font-medium text-muted-foreground` (#525252)
  - value: `text-3xl font-bold tracking-tight` (#000), e.g. **"$106.42"**
  - delta row: `TrendingUp` icon `size-3.5` + `text-xs font-medium
    text-muted-foreground`, e.g. **"+8.3%"**
  - caption: `text-xs text-muted-foreground/70`, format verbatim
    **"vs 7-day avg: $98.31"** (en.json `home.vitals.vsAvg` = "vs 7-day avg: {value}")
  - hint (THE new line): `text-xs text-muted-foreground/50` —
    **"+ $12.34 unattributed"** (format from `unattributedHint()`:
    `` `+ ${format(gap)} unattributed` ``)
- Plausible neighbor values: Sessions "38", Tokens "1,284,502", Routine runs "12".

## Demo arc — `unattributed-spend-hint.mp4`, 1920×1080, 8.9s, ZERO user actions

| t (s) | What's on screen | Rule honored |
|---|---|---|
| 0.0–0.4 | Hook "Spend, fully accounted" fades in | entrance |
| 0.4–1.7 | Hook holds still (1.3s) | ≥1.0s short-phrase floor |
| 1.7–2.3 | Crossfade to Home: "Last 24 hours" + 4 StatCards settle in (stagger 80ms) | establish |
| 2.3–3.1 | Spotlight: Spend card scales to 1.03, siblings dim to 60% | focus |
| 3.1–3.4 | Hold | beat before change |
| 3.4–3.8 | Hint line "+ $12.34 unattributed" fades in below the caption | the state change |
| 3.8–5.3 | Hint holds still (1.5s) | ≥1.0s floor + breath after change |
| 5.3–5.9 | Hold (600ms), nothing moves | breath before payoff |
| 5.9–6.3 | Payoff "The gap tagged totals miss — now visible." fades in | entrance |
| 6.3–8.3 | Payoff holds still (2.0s) | ≥1.4s fragment floor |
| 8.3–8.9 | Fully still resting frame | loop rest |

## Code snippet — NOT EARNED

Pure-frontend computation over existing LiteLLM tag queries; no new endpoint,
SDK method, or GraphQL operation. Prose explains the ≥1% threshold and the
suppression rules instead.
