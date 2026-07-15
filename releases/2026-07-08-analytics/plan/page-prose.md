# Page prose — ANALYTICS (non-video sections)

Part of `releases/2026-07-08-analytics/`. Every fact below was verified in the
frontend code on 2026-07-08/09 (paths relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`). All quoted strings
are verbatim from `messages/en.json → analytics.*` or the component source.
Format reference: `releases/2026-07-08-admin-and-theming/plan/page-prose.md`
(kicker → benefit-led h2 → 2–3 verified sentences, snippet only where a real
developer surface earns it).

Files read: `app/(application)/analytics/components/breakdown-chart-card.tsx`,
`components/donut-view.tsx`, `components/ranked-list.tsx`,
`components/kpi-strip.tsx`, `components/analytics-view.tsx`, `lens.ts`,
`queries.ts`, `queries/queries.ts` (the six `*_BY_IDS` ops), and
`messages/en.json → analytics.*`.

Reference-only (already announced in `platform-roundup`,
`unattributed-spend-hint`): the KPI strip and the "+ … unattributed" spend
hint. One clause maximum — see section 4.

---

## 1. CSV export — "Every breakdown, one spreadsheet away"

Sources: `components/breakdown-chart-card.tsx` (`handleExport`, lines 253–310;
`csvEscape`, lines 95–101), `messages/en.json → analytics.header.*`.

Prose (2–3 sentences):

The Breakdown card's **"Export CSV"** button (aria label "Export the current
breakdown as a CSV file") downloads exactly the slice on screen as an
entity-by-day pivot: the top 10 entities as rows, one zero-filled column per
day in the window, and a trailing **Total** — so the header reads
`Entity, 2026-07-01, 2026-07-02, …, Total`. Row labels are the hydrated human
names (not the raw LiteLLM tag ids), spend cells keep six decimals
(`v.toFixed(6)`) while token and request cells stay integers, and the file is
written with a leading UTF-8 BOM "so Excel opens UTF-8 cleanly" (that comment
is in the source). The download is named
`analytics-{dimension}-{measure}-{start}-{end}.csv` — e.g.
`analytics-agents-spend-2026-06-25-2026-07-09.csv`.

Verified details for the writer:
- Header row is literally `["Entity", ...dates, "Total"]`
  (breakdown-chart-card.tsx:278); `dates` come from
  `eachDayOfInterval` over the requested window (line 265), so empty days are
  present and zero-filled, not skipped.
- Top-10 selection: `byTag.filter(startsWith(prefix)).slice(0, 10)`
  (lines 259–261); `byTag` is already sorted desc by value.
- Cell values chosen by measure key `spend | total_tokens |
  successful_requests` (lines 272–277).
- BOM: `new Blob(["﻿" + lines.join("\n")], { type:
  "text/csv;charset=utf-8" })` (line 299).
- Filename slices ISO dates to `yyyy-MM-dd` (line 305).
- `csvEscape` quotes + doubles internal quotes only when a value contains a
  comma/quote/CR/LF, otherwise leaves it raw.
- Export is disabled while data is loading or when there are zero rows
  (`exportDisabled`, lines 312–317).

No snippet — the export is a client download builder, not a callable API
surface, and the filename template in prose carries the message. (The one
genuine developer-facing op on this page is the hydration GraphQL in section 3.)

## 2. Donut "Share" view — "See the split, not just the ranking"

Sources: `components/breakdown-chart-card.tsx` (view toggle, lines 337–371),
`components/donut-view.tsx`, `messages/en.json → analytics.breakdown.*`.

Prose:

The Breakdown card carries a two-button toggle in its header — a ranked
**"List"** (aria "List view") and a **"Share"** donut (aria "Share view") — so
the same top-10 slice reads either as an ordered leaderboard or as a
proportional ring. The Share view draws a recharts donut plus a color-keyed
legend below it, where each row shows the entity name, its value, and its share
of the total as a whole-number percent (`· {pct}%`); slices under 5% drop their
inline label to stay legible. Spend is formatted as USD currency and
token/request measures as plain locale numbers, and the ring honors
`prefers-reduced-motion` by dropping the slice tween.

Verified details:
- View constants: `BREAKDOWN_VIEWS = ["list", "share"]`, default `"list"`
  (lens.ts:35, 43); the toggle writes `lens.view`, so the choice is a URL param.
- Donut: `innerRadius="45%"`, `outerRadius="75%"`, palette
  `hsl(var(--chart-1..10))` (donut-view.tsx:45–56, 137–138); labels under 5%
  return null (line 108).
- Legend percent is `Math.round((entry.value / total) * 100)` (line 166);
  spend rows omit the unit label and render the currency value alone
  (lines 180–183).
- List view is `RankedList` with `max={10}`, proportional `bg-primary/10` bars
  and medal-tinted top-3 rank bubbles (ranked-list.tsx:50–56, 87–88).

No snippet — this is a visual view toggle; the video section carries the motion.

## 3. Name hydration — "LiteLLM tags carry ids; you see names" (SNIPPET)

Sources: `components/breakdown-chart-card.tsx` (hydration hooks + `entityLabel`,
lines 81–204), `queries.ts` (re-exports), `queries/queries.ts`
(`GET_USERS_BY_IDS` line 1591, `GET_AGENTS_BY_IDS` line 772,
`GET_PROJECTS_BY_IDS` line 2015, `GET_ROUTINES_BY_IDS` line 3233,
`GET_ROLES_BY_IDS` line 3256, `GET_TEAMS_BY_IDS` line 3267).

Prose:

Analytics is 100% LiteLLM-driven, and LiteLLM tags carry only stable ids — so
every breakdown row arrives as `agent_id_…`, `user_id_…`, etc., and the
frontend reconciles those ids against Postgres names before you ever see them.
The card takes the top-10 ids for the active dimension and fires the matching
by-ids GraphQL query — one per dimension, six in total — then maps each id to a
human label (a user falls back name → "firstname lastname" → email → id, so a
row is never a bare id if a name exists). Both the ranked list and the CSV
export read from that same hydrated map, so the names you see on screen are the
names in the file.

Snippet — EARNED (the literal id→name reconciliation op, `GET_USERS_BY_IDS`,
queries/queries.ts:1591-1601; the label fallback is `entityLabel`,
breakdown-chart-card.tsx:81-88):

```graphql
query GetUsersByIds($ids: [ID!]!) {
  userByIds(ids: $ids) {
    id
    name
    firstname
    lastname
    email
  }
}
```

Verified details:
- Six hydration ops, one per dimension (breakdown-chart-card.tsx:133–156):
  `GET_AGENTS_BY_IDS` → `agentByIds`, `GET_USERS_BY_IDS` → `userByIds`,
  `GET_PROJECTS_BY_IDS` → `projectByIds`, `GET_ROUTINES_BY_IDS` →
  `workflow_templatesPagination`, `GET_ROLES_BY_IDS` → `rolesPagination`,
  `GET_TEAMS_BY_IDS` → `teamsPagination`.
- Only the top 10 ids are hydrated (`topIds = rows.slice(0, 10)`, lines
  124–131); each query is `skip`-gated to the active dimension.
- Roles and Teams are fetched full (`limit: 200`, no `$ids` variable) and
  matched client-side, because `FilterRole`/`FilterTeam` expose no id filter
  server-side (queries/queries.ts:3248-3255 comment).
- `entityLabel` fallback order: `name` → `firstname + lastname` → `email` →
  the id string itself (breakdown-chart-card.tsx:81-88).
- Names live in Postgres by design — queries.ts docblock: "Postgres is the
  source of truth for entity names; LiteLLM tags only carry stable ids."

## 4. KPI strip — reference-only clause (DO NOT RE-ANNOUNCE)

Sources: `components/kpi-strip.tsx`, `messages/en.json → analytics.kpi.*`.

Already shipped and announced this morning in `platform-roundup`
(`unattributed-spend-hint`, which explicitly covers "the analytics KPI strip").
On this page it may appear in ONE clause of connective tissue only — e.g. "the
Spend / Tokens / Requests KPI strip announced this morning now sits above a
fully hydrated, exportable breakdown." Do not re-describe the delta %, the
±25% emphasis, the click-to-deep-link, the LiteLLM admin link, or the
unattributed-spend hint as new.

Facts confirmed present (for the writer's context only, NOT to re-announce):
- Three `StatCard`s — Spend / Tokens / Requests — each with a delta vs the
  equal-length previous window; delta earns `emphasis` only past ±25%
  (`EMPHASIS_THRESHOLD_PERCENT = 25`, kpi-strip.tsx:34, 101).
- Each card deep-links to `/analytics` with the measure axis pre-seeded via
  `lensToSearchParams` (kpi-strip.tsx:128–135).
- `hint` shows `+ {gap} unattributed` when tagged spend trails the unfiltered
  total by >1% (kpi-strip.tsx:37–47, 144–148).
- The **"Open LiteLLM admin"** link sits in the page header, rendered only when
  `configContext.liteLLM.enabled` (analytics-view.tsx:105, 184–196; en.json
  `analytics.openLiteLLMAdmin`).

---

## EXCLUDED (not shipped, out of scope, or reference-only — do not claim)

1. **KPI strip + unattributed-spend hint as new** — announced in
   `platform-roundup` (`unattributed-spend-hint`). One connective clause is the
   ceiling (section 4). Never re-describe the delta %, ±25% emphasis,
   click-to-deep-link, or the LiteLLM admin link as this release's news.
2. **URL-driven lens / deep-linking / range presets** — the shareable-URL lens
   (range presets, `?dimension`, `?measure`, `?view`, the 30-day cap and its
   `deepLinkRangeReset` toast, legacy `?type=`/`?measure=count` remaps) is a
   separate `date-range-lens` section (see `plan/date-range-lens.md`); it is
   NOT one of the four prose sections in this brief. Do not fold it into the
   CSV/donut/hydration copy beyond noting that the CSV/donut reflect "the
   current slice."
3. **`trackingStatistics` / Postgres-sourced analytics** — `/analytics` is
   100% LiteLLM-driven and "does NOT touch trackingStatistics" (queries.ts:4-6
   docblock). Do not imply a second data source; GraphQL is used ONLY for
   id→name hydration.
4. **CSV of more than top-10 / a "download everything" export** — the export is
   hard-capped at `.slice(0, 10)` (breakdown-chart-card.tsx:261). Do not claim
   a full-population export.
5. **Trend chart / KPI values in the CSV** — the CSV is the per-entity daily
   pivot only. It does not include the trend line or the KPI totals. Do not
   describe it as a full dashboard export.
6. **Live "used_by"/attribution beyond LiteLLM tags** — names come from a
   by-ids GraphQL reconciliation, not any usage-tracking backend; do not imply
   richer attribution than id→name.
