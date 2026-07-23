# Research — Usage & Budgets release (2026-07-22)

Features: PERSONAL USAGE VIEW + PROJECT BUDGET VISIBILITY + BUDGET RESET DATE.
Repos: backend `develop` (HEAD 9359c12), frontend `main` working tree.
All file:line refs verified against the working trees on 2026-07-22.

> NOTE (frontend branch state): the budget-reset-date UI commits (89b944d,
> 00fb51d, 0e2e352, e794955, 52f1289, db07d35) live on branch
> `feature/budget-reset-date`, but `git merge-base --is-ancestor` confirms
> e794955 (picker) and 0e2e352 (i18n) are ALREADY contained in `main`, and
> `components/budget-editor.tsx` on the branch is byte-identical to the
> working tree. Everything below was read from the working tree.

---

## What shipped & why it matters

### A. Personal usage view — see your own spend, per model, per day
A user literally asked: *"kann man irgendwo sehen, welche Modelle man zuletzt
genutzt hat und wie viel?"* (spec, frontend
`docs/superpowers/specs/2026-07-16-personal-usage-details-design.md`). Until
now the only per-user surface was the single spend/budget chip in the top bar;
the detailed per-model / per-day data existed only on the super-admin
analytics page.

Now every user gets a **Usage** section on `/settings` (`id="usage"`): a
7/30/90-day range toggle, a daily spend area chart, totals (Spend / Tokens /
Requests), and a per-model table — all scoped to *their own* LiteLLM activity
via the new `GET /me/usage` endpoint. The top-bar budget popover gains a
"Details" deep link straight to `/settings#usage`. Deliberately simple by
design: "no stacked charts, no lens switcher, no donut — one chart, one
table."

- Backend: 70eeb64 (route), 1d197e8 (getMyUsageView), 9f3de7c (pure helpers), 2026-07-22
- Frontend: a941381 (Usage section), bfb8bf8 (data layer), 89becf8 (details link), 2026-07-22

### B. Project budget visibility — members see budget health without asking an admin
Project budget data used to be visible only on the admin-only `/budgets` page
(guarded by `budget_management:read`); the backend nulled the `budget` field
for everyone else. Now **every user who can open a project** sees a compact,
read-only budget indicator in the project detail header — bar + "NN% ·
Budget" face, with a click/keyboard popover showing used, remaining,
burn-rate projection, and the reset date. No edit affordances by design;
orgs that don't want raw cost figures exposed use the existing
percent-display mode (the member payload echoes `user_budget_display`).

- Backend: 272a45a "feat(budgets): project member view on the budget field", 2026-07-22
- Frontend: 6233fcd (indicator), e821f40 (labelled face), 4c7d101 (percent-aware BudgetBar + shared BudgetDetailLines), 29652d0 (hasCappedBudget + line model), 934c341 (reuse in TopBarBudget/admin popover)
- Spec: frontend `docs/superpowers/specs/2026-07-20-project-budget-visibility-design.md`

### C. Budget reset date — budgets reset on YOUR billing day
Origin: a real bug report. An admin set a project budget ("Hermes AVIS Tool",
€300) to weekly, switched it to monthly, and the reset date silently stayed on
the old weekly date — because LiteLLM's `update_budget` never recomputes
`budget_reset_at`, and its `/tag/*` endpoints *silently strip* the field
entirely. LiteLLM reset dates are also standardized calendar boundaries (1d →
next midnight, 7d → next Monday, 30d → 1st of next month), not rolling
windows from creation — which never matched the reporter's mental model.

The fix: the reset date is now an explicit, editable field. The budget editor
prefills the standardized smart default per duration and lets the admin
override it with any calendar date ("Reset date" picker). The backend accepts
`budget_reset_at` on all budget upsert endpoints and applies it via LiteLLM's
`/budget/update` (the only endpoint that doesn't strip it). Additive and
backward-compatible: omit the field and behavior is unchanged.

- Backend: b2e6c7c (budgetUpdate + budget_id, 07-10), ee2fbab (upsertBudget applies it, 07-10), dfcc2ec (endpoints accept it, 07-11)
- Frontend: 89b944d (defaultResetDate), 00fb51d (API client), 0e2e352 (i18n), e794955 (picker), branch `feature/budget-reset-date` (contained in main)
- Spec: backend `docs/superpowers/specs/2026-07-10-budget-reset-date-design.md`

---

## UI reconstruction cues

All frontend paths relative to `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`.

### Settings → Usage section
`app/(application)/settings/components/usage-section.tsx`; mounted last in
`app/(application)/settings/components/settings-view.tsx:114` (after the
Account section), preceded by its own `<Separator />`. FormSection layout, no
Cards. Renders NOTHING (separator included) when the backend returns
`usage: null`.

- Section header (i18n `settings.usage.*`, `messages/en.json:4009-4027`):
  - title: **"Usage"** — description: **"Which models you used recently and how much."**
- Range toggle (usage-section.tsx:98-121): shadcn `ToggleGroup type="single"`,
  default `"30"`. Items: **"7 days"** / **"30 days"** / **"90 days"**
  (`usage.range7/30/90`), aria-label **"Time range"**. Container classes:
  `grid w-full grid-cols-3 gap-2 rounded-lg bg-muted p-1 sm:inline-grid
  sm:w-auto sm:grid-cols-[repeat(3,minmax(6rem,1fr))] md:gap-1`; item:
  `h-11 min-w-0 rounded-md px-3 text-sm md:h-8` + `data-[state=on]:bg-background
  data-[state=on]:text-foreground data-[state=on]:shadow-sm` (segmented-control look).
- Totals row (TotalsRow, :169-201): `<dl class="flex flex-wrap gap-x-8 gap-y-2
  text-sm">` with dt `text-muted-foreground`, dd `font-mono tabular-nums`.
  Labels: **"Spend"** (`formatUsd`, hidden in percent mode), **"Tokens"**,
  **"Requests"** (compact Intl format, e.g. "1.5M").
- Chart (UsageChart, :207-288): **recharts `AreaChart`** inside
  `ChartContainer className="h-40 w-full"`. Monotone area, stroke
  `hsl(var(--chart-1))`, `strokeWidth={2}`, gradient fill id
  `settingsUsageFill` (stopOpacity 0.35 → 0.05), `CartesianGrid
  strokeDasharray="3 3" vertical={false}`, X ticks "Jul 21"-style short
  dates, Y ticks USD (or token counts in percent mode), `dot={false}`,
  `isAnimationActive={false}`. Daily series is zero-filled across the whole
  window (`fillDailySeries`, lib/my-usage.ts:88-104) so quiet days show as 0.
- Per-model table (ModelTable, :290-346): shadcn Table. Headers: **"Model"**,
  **"Requests"** (right), **"Failed"** (right, only if any model has
  failures), **"Tokens"** (right), **"Spend"** (right, hidden in percent
  mode). Model cell: `max-w-64 truncate font-mono text-xs`; numeric cells
  `text-right font-mono tabular-nums`. Percent mode re-ranks rows by
  total_tokens; amount mode keeps backend spend-desc order.
- Empty state: **"No usage in this period."** — error: **"Couldn't load your
  usage."** + outline **"Retry"** button.

### Top-bar budget chip + popover ("details" link)
`components/shell/top-bar-budget.tsx` (chip sits next to the ⌘K search in the
desktop TopBar, `components/shell/top-bar.tsx`).

- Chip (:80-97): `hidden md:flex h-8 ... rounded-md border border-input px-2
  text-xs text-muted-foreground` with a status dot `size-2 rounded-full` —
  DOT_COLOR (:38-42): ok `bg-emerald-500`, warn `bg-amber-500`, over
  `bg-red-500`. Face: `font-mono tabular-nums` — amount mode
  `"$12.34 / $50"`, percent mode `"{percent}% left"` (`bar.percentLeft`).
- Popover (:99-115): `w-64 space-y-1 text-xs`, body = shared
  `<BudgetDetailLines>`, footer = link-variant Button →
  `<Link href="/settings#usage">` with label **"Details"** (`bar.details`) +
  `ChevronRight` icon `size-3` (lucide). Popover is controlled so the link
  click closes it on navigation.

### Project detail header budget indicator
`app/(application)/projects/components/project-budget-indicator.tsx`; placed
in the PageHeader `meta` slot of
`app/(application)/projects/components/project-detail-view.tsx:247-255`
(next to the "instructions active" trust line), visible on every tab.

- Renders nothing unless `hasCappedBudget(budget)` (no "No budget" text for
  members).
- Trigger button (:47-58): `flex min-h-11 w-52 items-center gap-2 rounded-sm
  text-left ... md:min-h-0` (44px touch target below md), aria-label
  **"Budget details for {name}"** (`bar.detailsAria`).
  Contents: `<BudgetBar budget compact className="flex-1" />` + face
  `whitespace-nowrap text-xs tabular-nums`: **"{pct}% · Budget"**
  (`bar.label` = "Budget"; the face is mode-neutral — never USD).
- Popover: `align="start" w-64 space-y-1 text-xs` with `<BudgetDetailLines>`.

### BudgetBar (shared)
`components/budget-bar.tsx`.
- Track: `relative w-full overflow-hidden rounded-full bg-muted`, height
  `h-2` (compact) / `h-3`. Fill: `h-full rounded-full transition-[width]
  duration-500 ease-out` colored via FILL_COLORS (:19-23): ok
  `bg-emerald-500`, warn `bg-amber-500`, over `bg-red-500` (warn = ≥80% used
  OR projected over pace; over = spend ≥ max).
- Burn-rate projection marker (:81-87): `absolute top-0 h-full border-l-2
  border-dashed border-foreground/60` at `left: calc({projPct}% - 1px)`.
- Non-compact footer: `"$X / $Y"` left + `"NN%"` right (percent mode: single
  `"NN% used"`). Whole bar wrapped in a Tooltip whose content is
  `<BudgetDetailLines>`.

### BudgetDetailLines (shared detail block)
`components/budget-details.tsx` (render) + `lib/budget.ts:158-212`
(buildBudgetDetailLines, unit-tested line selection). Bare `<p>` siblings;
host owns `space-y-1` + text size. Lines in order (i18n `budgets.bar.*`,
en.json):
1. Headline (font-medium): **"{spend} of {max} used"** (`bar.usedOfMax`) —
   percent mode: **"{percent}% used"**.
2. **"{remaining} remaining · {duration}"** (duration = Daily/Weekly/Monthly)
   — percent mode: **"{percent}% left · {duration}"**.
3. Projection: **"Projected ≈ {amount} by reset"** / warn-toned (amber
   `text-amber-600 dark:text-amber-400`) **"Projected ≈ {amount} by reset
   (over pace)"** — percent variants use `{percent}%`.
4. Muted: **"Resets {date}"** (`bar.resetsOn`, toLocaleDateString).

Projection math: `computeBudgetProjection` (lib/budget.ts:78-107) — linear
burn rate: windowStart = reset − duration; projected = spend / elapsed ×
window, elapsed floored at 1h.

### Budget editor — reset date field (Feature C UI)
`components/budget-editor.tsx` (identical on `feature/budget-reset-date` and
working tree). Lives in the admin `/budgets` page dialogs (single + bulk).
Field order: **"Budget (USD)"** input (placeholder "e.g. 20") → **"Reset
period"** Select (Daily / Weekly / Monthly) → **"Reset date"** block
(:246-272):
- Label: **"Reset date"** (`budgets.editor.resetDateLabel`).
- Trigger: full-width outline Button, `CalendarIcon` (lucide) `mr-2 h-4 w-4` +
  `format(resetAt, "PPP")` (date-fns, e.g. "August 1st, 2026").
- Popover `w-auto p-0` containing shadcn `<Calendar mode="single">`; picks
  are normalised to UTC midnight (`toUtcDay`, :51-52).
- Hint below (`text-xs text-muted-foreground`): **"By default the budget
  resets at the start of each day, week, or month. Pick a date to set a
  custom reset."** (`budgets.editor.resetHint`).
- Behavior: changing the duration overwrites any custom pick with the smart
  default (`setResetAt(defaultResetDate(next))`, :226-230).
  `defaultResetDate` (lib/budget.ts:221-235): 1d → next UTC midnight, 7d →
  next Monday (UTC), 30d → 1st of next month (UTC).
- Save buttons: **"Save budget"** (single) / **"Apply to all"** (bulk), with
  `Wallet` icon; payload always includes `budget_reset_at:
  resetAt.toISOString()` (:129-133, :139-143).
- Admin reset-date visibility elsewhere: `/budgets` entity table shows the
  reset date column (`app/(application)/budgets/components/entity-budget-table.tsx:149-152`).

---

## Developer surfaces

All backend paths relative to `/Users/daniel.claessen/Desktop/Projects/exulu/backend`.

### GET /me/usage — the caller's own model/day usage
Route: `src/exulu/routes.ts:2710-2740`. Auth: standard session/API auth
(`requestValidators.authenticate`); no admin role needed — strictly
self-scoped via the `user_id_<id>` LiteLLM tag (`budgetTagFor("user", userId)`).

Query params (`resolveUsageWindow`, `src/exulu/litellm/usage-view.ts:72-91`):
- `start_date`, `end_date` — `YYYY-MM-DD` or any ISO datetime (normalised to
  the UTC date). Both optional; default = last 30 days ending today (UTC).
  Window clamped to `MAX_WINDOW_DAYS = 92` (usage-view.ts:19) by moving
  start_date. Malformed dates or start > end → 400:
  `"start_date and end_date must be YYYY-MM-DD or ISO datetimes, with start_date <= end_date."`

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$BACKEND/me/usage?start_date=2026-06-23&end_date=2026-07-22"
```

Response (types: usage-view.ts:22-52; `MyUsageView`):
```jsonc
{
  "usage": {                       // null when the admin hides spend data
    "window": { "start_date": "2026-06-23", "end_date": "2026-07-22" },
    "display": "amount",           // or "percent" (user_budget_display setting)
    "totals": {
      "spend": 12.34, "prompt_tokens": 1200000, "completion_tokens": 340000,
      "total_tokens": 1540000, "successful_requests": 412,
      "failed_requests": 3, "api_requests": 415
    },
    "daily": [                     // sorted by date asc; only days with traffic
      { "date": "2026-07-21", "spend": 0.84, "prompt_tokens": 90210,
        "completion_tokens": 20111, "total_tokens": 110321,
        "successful_requests": 31, "failed_requests": 0, "api_requests": 31 }
    ],
    "byModel": [                   // sorted by spend desc
      { "model": "claude-sonnet-4-5", "spend": 9.10, "prompt_tokens": 800000,
        "completion_tokens": 210000, "total_tokens": 1010000,
        "successful_requests": 300, "failed_requests": 1 }
    ]
  }
}
```
Errors: 502 with `{ detail }` on `LiteLLMAdminError`, 500 otherwise
(routes.ts:2730-2739). Orchestrator: `getMyUsageView`
(usage-view.ts:200-232) → `getTagDailyActivity` (LiteLLM
`/tag/daily/activity`, single tag) → pure `projectMyUsage`
(usage-view.ts:138-192). Gate: `getBudgetSettings().show_user_budget_in_chat`
off → `usage: null` (usage-view.ts:204-205) — same contract as `/me/budget`
(routes.ts:2695-2702).

### Budget upsert with budget_reset_at
Auth for all `/admin/budgets/*`: `authorizeBudgetAccess` (routes.ts:2651-2673)
— `super_admin` or `role.budget_management === "write"` (reads also accept
`"read"`); otherwise 403 `"Budget management access required."`.

Entity types (routes.ts:2596-2607): `user | role | team | project | agent |
routine`. Allowed durations (routes.ts:2608): `1d | 7d | 30d`.

**Single upsert** — `PUT /admin/budgets/:entityType/:entityId`
(routes.ts:2788-2814):
```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$BACKEND/admin/budgets/project/42" \
  -d '{ "max_budget": 300, "budget_duration": "30d",
        "budget_reset_at": "2026-08-01T00:00:00.000Z" }'
# → 200 { "budget": { name, spend, max_budget, budget_duration,
#                     budget_reset_at, budget_id } }   (TagInfo)
```

**Bulk upsert** — `PUT /admin/budgets/:entityType/bulk`
(routes.ts:2743-2781); same body plus `entityIds: string[]`; the same
`budget_reset_at` is applied to every entity:
```bash
curl -X PUT ... "$BACKEND/admin/budgets/project/bulk" \
  -d '{ "entityIds": ["42","43"], "max_budget": 300,
        "budget_duration": "30d", "budget_reset_at": "2026-08-01T00:00:00.000Z" }'
# → 200 { "results": [ { "entityId": "42", "ok": true },
#                      { "entityId": "43", "ok": false, "error": "..." } ] }
```

Validation: `parseBudgetBody` (routes.ts:2613-2623) + `parseResetAt`
(`src/exulu/litellm/budget-service.ts:279-287`) — `budget_reset_at` is
optional; absent/null/"" means "leave the reset date to LiteLLM"; any
parseable date string is normalised to ISO; anything else → 400
`"Invalid budget (max_budget, budget_duration, budget_reset_at)."`.

Apply path: `upsertBudget` (budget-service.ts:294-331) — `tagNew`/`tagUpdate`
for amount+duration, then (because LiteLLM's `/tag/*` endpoints silently
strip `budget_reset_at` — it's not in `LiteLLM_BudgetTable.model_fields`)
resolves the tag's `budget_id` and calls `budgetUpdate(budgetId,
{ budget_reset_at })` → `POST /budget/update`
(`src/exulu/litellm/admin-client.ts:85-92`). A failed follow-up surfaces as a
failed save so the admin retries (no silent stale date).

**Delete** — `DELETE /admin/budgets/:entityType/:entityId` → 204
(routes.ts:2817-2838).

### Project budget member view (GraphQL)
`src/graphql/utilities/budget-field.ts:53-93` (`addBudgetField`), commit
272a45a. Requesting the computed `budget` field on a project (frontend query:
`app/(application)/projects/queries.ts:83-90`, `projectById(id) { ...
budget }`):
- Budget admins (super_admin / budget_management read|write): full `TagInfo`
  including `budget_id` — unchanged.
- Any other requester, **projects only** (the query's row-level RBAC already
  decided they can see the project): reduced member view —
  ```ts
  { spend, max_budget, budget_duration, budget_reset_at,
    display: "amount" | "percent" }   // budget_id omitted
  ```
  (budget-field.ts:84-92; `display` echoes `getBudgetSettings().user_budget_display`).
- Every other entity type stays admin-only (`budget = null`).
- Backing data: `getTagBudgetMap()` cached ~30s — one LiteLLM call per page
  of rows.

---

## Demo-worthy moments

### A. Personal usage view
1. Top bar: click the little budget chip (green dot, `$12.34 / $50`) — the
   popover shows "…of…used / remaining / Projected ≈ … by reset / Resets …",
   then click **Details ›**.
2. Land on `/settings#usage` — the **Usage** section scrolls into view:
   totals row, area chart, model table already loaded for the last 30 days.
3. Flip the range toggle **7 days → 90 days** — the chart redraws with the
   zero-filled daily series (honest time axis, quiet days at 0).
4. Scan the per-model table — "which models did I use and how much": model
   names in mono, Requests / Tokens / Spend right-aligned, spend-desc.

### B. Project budget visibility
1. Open a project as a regular member (no budget role) — the header now
   carries a slim bar + **"38% · Budget"** right under the title, on every tab.
2. Click (or keyboard-focus) the indicator — popover: "$114 of $300 used",
   "$186 remaining · Monthly", "Projected ≈ $265 by reset", "Resets 8/1/2026".
3. Show pace-warning color: a project burning too fast flips the bar to amber
   with the dashed projection marker past 100%.
4. Percent mode kicker: flip the admin display setting to "Percentage only" —
   the same member popover shows only percentages, zero USD anywhere.

### C. Budget reset date
1. Admin opens `/budgets` → Edit budget on a project: amount, **Reset
   period** = Weekly — the new **Reset date** field already shows next
   Monday.
2. Switch Reset period to **Monthly** — the date snaps to the 1st of next
   month (the exact bug that used to silently keep the stale weekly date).
3. Open the calendar picker and choose the 9th — your billing day, not
   LiteLLM's calendar default. Hint text explains the default vs override.
4. Save — "Budget saved"; the entity table now shows the custom reset date,
   and every user-facing popover says "Resets 8/9/2026".

---

## Flags / requirements

- **LiteLLM is required** for all three features. Every call goes through the
  locally-spawned proxy (`LITELLM_HOST`/`LITELLM_PORT`, default
  127.0.0.1:4000) and needs `LITELLM_MASTER_KEY`
  (`src/exulu/litellm/env.ts:29-36` — missing key throws
  `LiteLLMAdminError`, routes translate to 502). The master key never leaves
  the backend.
- **Personal usage view gating:** admin toggle **"Show budget status to
  users"** (`show_user_budget_in_chat`, Default-policy dialog on `/budgets`,
  helper: "Users see their own budget in the app's top bar.") — off →
  `GET /me/usage` returns `{ usage: null }` and the Settings section renders
  nothing. Same gate as `/me/budget` / the top-bar chip; no new setting.
  Additionally the user needs a budget for the chip itself to show
  (top-bar-budget.tsx:52-54), but the Usage section only needs the toggle.
- **Display mode:** admin setting **"Budget display"** — "Exact amount ($)"
  vs "Percentage only" (`user_budget_display`). Percent is UI-only by product
  decision: payloads still carry spend; UIs guarantee no USD reaches the DOM
  (unit-tested in `lib/budget.test.ts`).
- **Project budget visibility:** always on, no new toggle (approved decision
  #3 in the 2026-07-20 spec) — row-level project access = budget read access,
  member view respects `user_budget_display` and omits `budget_id`. Projects
  are the ONLY entity type opened to members; everything else stays
  admin-null. No budget configured → indicator renders nothing.
- **Budget writes (incl. reset date):** `super_admin` or
  `role.budget_management === "write"` only. Reads of the full admin view:
  also `"read"`.
- **Personal usage window:** default 30 days, hard clamp at 92 days
  (`MAX_WINDOW_DAYS`, usage-view.ts:19).
- **budget_reset_at compatibility:** optional everywhere — older clients that
  omit it keep exactly the old behavior (no `/budget/update` call). No schema
  migration (the column already exists on LiteLLM's budget table).
