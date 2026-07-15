# Feature plan — Feedback review console + filtering

Part of `releases/2026-07-08-feedback-management/`.

## Sources of truth

- UI: `frontend/app/(application)/feedback/page.tsx` (PageShell + PageHeader
  with the summary-stat in `meta`, then FeedbackList),
  `.../components/feedback-summary-stat.tsx` (the "% positive · N negative"
  line; the negative count is a link-button that filters to negative),
  `.../components/feedback-toolbar.tsx` (search + Type tabs + agent/user
  comboboxes, wrapped in the shared `Toolbar` primitive),
  `.../components/feedback-list.tsx` (the md+ data table + <md card list, name
  hydration, bulk delete), `.../components/use-feedback-query.ts` (Apollo
  owner; `type: "negative"` pushes `{ score: { eq: 0 } }` into `filters`)
- Shared primitives: `frontend/components/primitives/page-header.tsx`
  (`h1 text-2xl font-semibold tracking-tight`, `meta` = quiet
  `text-sm text-muted-foreground` line), `.../primitives/toolbar.tsx`
  (search left `md:max-w-sm`, inline filters at `md+`, 300ms debounce),
  `frontend/components/ui/tabs.tsx` (segmented control: `TabsList` =
  `h-10 rounded-md bg-muted p-1`; active `TabsTrigger` =
  `bg-background text-foreground shadow-sm` — a WHITE pill, not purple)
- On-screen copy: `frontend/messages/en.json` → `feedbackReview.*` and
  `common.*` (verbatim below)
- GraphQL: `GET_FEEDBACK` (`GetFeedback`) in `frontend/queries/queries.ts`
  (~line 189); `FEEDBACK_FIELDS` fragment at ~line 97
- Tokens: `releases/2026-07-08-feedback-management/hyperframes-design.md` +
  `frontend/app/globals.css`

## What shipped

The `/feedback` admin review console (the P3 console, not the footer's "Send
feedback" dialog). RBAC-gated: `layout.tsx` wraps the page in
`guardRoute("feedback")`, so non-admins get `<AccessDenied/>` server-side.

- **Summary stat header**: a quiet inline sentence in the PageHeader `meta`
  slot — `"{percent}% positive · {negative} negative"` — where the negative
  count is a link-button; clicking it sets the type filter to negative
  (`onSelectType("negative")`). Renders nothing while loading or when total 0.
- **Filtering toolbar** (shared `Toolbar`): a debounced search input
  ("Search feedback…", 300ms), a **Type** segmented control (All | Negative |
  Positive), and async agent + user `EntityCombobox`es ("Filter by agent" /
  "Filter by user", server-filtered, 20/page). A **Reset** affordance appears
  once any filter is active (`activeFilterCount > 0`).
- **Feedback list** with **name hydration**: the raw `agent`/`user` ids on each
  row are resolved to display names via one batched `GET_AGENTS_BY_IDS` /
  `GET_USERS_BY_IDS` query per page (fixes the raw-id fallback). Rows render a
  **thumbs icon** by score — ThumbsUp on `success/10` for positive (`score===1`),
  **ThumbsDown on `destructive/10`** for negative (`score===0`).
- **Responsive layout**: a real data table at `md+` (Checkbox · Type · Feedback
  · Agent · User · Date), collapsing to a **card list** below `md`.
- **Multi-select bulk delete**: per-row checkboxes + a page-level select-all
  drive a `BulkActionBar` ("Delete {count}") and a destructive `ConfirmDialog`.
- Data: `useFeedbackQuery` drives `GetFeedback` (`cache-and-network`, 30s poll,
  20/page, sort `createdAt DESC`); two `limit:1` probes back the summary counts.

## Hook

**Every thumbs-down, in one place.**

## Surface area

UI feature (the review console + the one filter action) + one real developer
surface: the `GetFeedback` GraphQL query the console runs, whose `filters`
argument is how you'd pull negative feedback from the API. One short on the
filter action; hydration, bulk delete, the detail sheet, comboboxes, and the
responsive card list are page prose within this feature's section.

## Short — `feedback-triage` (1920×1080, 8.6s)

One slice, ONE user action: click the **Negative** type tab in the toolbar.
The list narrows to negative rows and the summary stat updates. A single
cursor-driven click; no other interaction.

Deliberate choice: the brief offered the tab OR the summary-stat negative link
as the filter action — both set the same `negative` filter. We use the **Type
tab** because it is the always-visible, unambiguous control and its active
state is a clean visual payoff (the "Negative" segment becomes a white pill).
The summary stat still updates as a secondary confirmation, which is honest —
in the app both reflect the same query state.

### Demo arc (timed beats)

Before the click (type = "All"): the summary stat reads
**"72% positive · 5 negative"**; the table shows a **mixed** list — 6 rows, a
blend of ThumbsUp (green) and ThumbsDown (red) icons. The Negative tab is
inactive (muted, flat). After the click (type = "negative"): the table shows
only the **5 ThumbsDown rows**; the "Negative" segment is the active white
pill; the summary stat is unchanged (the counts are global, not page-scoped) —
it stays **"72% positive · 5 negative"**, so we let it sit still.

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.30 | Hook enters: pill "Feedback console" (#E2EBFF bg / #1E69DC text), H1 "Every thumbs-down, **in one place**." (em phrase #7033FF) | Entrance (never at t=0) |
| 0.30–1.80 | Hook holds static (1.5s) | ≥1.4s floor for the 5-word em phrase |
| 1.80–2.20 | Hook crossfades out; console card fades in — PageHeader ("Feedback" H1, description, summary stat), toolbar (All active), mixed 6-row table | Pivot; console reads instantly |
| 2.20–2.90 | Card holds static (700ms) so the mixed list + "All" tab register | ≥600ms read of the starting state |
| 2.90–3.40 | Cursor glides from list into the toolbar, resting on the **"Negative"** tab (subtle hover: tab lightens) | Click affordance |
| 3.40–3.55 | Cursor press on "Negative" (150ms press dip) | The one action lands |
| 3.55–3.90 | "Negative" becomes the active white pill (`bg-background`+shadow, 200ms); "All" goes flat. The two positive (ThumbsUp) rows crossfade out; the remaining ThumbsDown rows settle up to fill (200–250ms) | Result of the click |
| 3.90–4.60 | List resolves to 5 ThumbsDown rows; cursor lifts away | Filtered state forms |
| 4.60–5.50 | Filtered console holds completely still (900ms) | ≥600ms post-action hold; the payoff reads |
| 5.50–5.90 | Payoff caption enters (lower third): "Every thumbs-down, filtered in one click." | Entrance |
| 5.90–8.60 | Payoff holds still (2.7s); last ~600ms fully frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

Motion: power2.out, 150–250ms, no bounce, no glow. The tab-activation pill
slide and the row crossfade are the only motion at the action; from 4.60 the
frame is fully static until the payoff caption enters. The cursor is the only
element that moves during the demo reach.

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg **#FDFDFD** + house radial purple wash (same framing as
the sibling 07-08 shorts). Console inside a centered card ~1120px wide (radius
~6px, border 1px **#E7E7EE**, bg **#FCFCFC**, subtle shadow
`0px 2px 3px rgba(0,0,0,0.16)`). Inter everywhere, tracking **-0.025em**.
Purple **#7033FF** appears ONLY in the hook em phrase — the console itself uses
neutral/semantic colors, NOT purple (the active tab is a white pill, not
purple; verify in `tabs.tsx`). Render at ~1.3–1.5× product type scale for 1080p
legibility.

**PageHeader** (top of card, from `page-header.tsx` + `page.tsx`):
- H1: **"Feedback"** — `text-2xl font-semibold tracking-tight`, `#000`.
- Description line: **"What users said about agent responses."** —
  `text-sm` **#525252**.
- Meta (summary stat) line below, `text-sm` #525252: renders
  `"{percent}% positive · {negative} negative"` = **"72% positive · 5 negative"**.
  The **"5"** is a link-button — `text-sm font-normal` #525252, `underline-offset-2`,
  no purple. Keep it subtly underlined so it reads as interactive.

**Toolbar** (below header, from `feedback-toolbar.tsx` + `toolbar.tsx`), single
`md+` row, left→right:
1. Search input, `md:max-w-sm`: leading magnifier (`Search`, 16px, #525252),
   placeholder **"Search feedback…"** (#525252). Empty in this short. Border
   1px #E7E7EE, radius ~6px, height ~36px.
2. **Type** segmented control (`Tabs`): a `TabsList` pill —
   `h-10 rounded-md bg-muted (#F5F5F5) p-1` — holding three `TabsTrigger`s
   `px-3 py-1.5 text-sm font-medium`:
   - **"All"** — active BEFORE the click: `bg-background (#FCFCFC/#FFF) text-foreground shadow-sm` (a raised white pill). Inactive after.
   - **"Negative"** — inactive before (muted #525252, flat); active AFTER the
     click (white pill + `shadow-sm`, `text-foreground` #000).
   - **"Positive"** — inactive throughout (muted #525252, flat).
3. Agent combobox: outline button, placeholder **"Filter by agent"** (#525252),
   trailing chevron. Unselected.
4. User combobox: outline button, placeholder **"Filter by user"** (#525252),
   trailing chevron. Unselected.
   (No Reset chip visible while type="all"; a quiet **"Reset"** chip may appear
   after the filter engages — optional, keep it subtle if shown.)

**Table** (`md+`, from `feedback-list.tsx`), inside `rounded-md border`
(#E7E7EE). Header row, `text-xs`/`text-sm` #525252, columns:
- checkbox column (`w-10`): an unchecked `Checkbox` (square, ~16px, 1px #E7E7EE
  border, radius ~4px).
- **Type** column (`w-10`): header is icon-only (aria "Type"), no visible label.
- **"Feedback"** — the preview text column (widest).
- **"Agent"** — #525252.
- **"User"** — #525252.
- **"Date"** (`w-32`) — #525252.

Each body row (~52px tall, `border-b` #E7E7EE, cursor pointer):
- checkbox (unchecked).
- **Type icon**: a `size-6` rounded-full chip. Negative =
  **ThumbsDown** (`size-3`) on **`bg-destructive/10`** (~#FDECEC) with
  **`text-destructive` #E54B50**. Positive = **ThumbsUp** on `bg-success/10`
  (~#E7F6EE) with **`text-success` #16A34A**.
- Feedback preview: `text-sm` #000, `line-clamp-2`, truncated at 120 chars
  with "…".
- Agent name (`text-sm` #525252), User name (`text-sm` #525252), relative Date
  (`text-sm` #525252, e.g. "2h ago" / "1d ago").

**Row content** — neutral placeholders only (author + agent already hydrated to
names; no raw ids visible). Six rows BEFORE the click; the two Positive rows
(#2, #5) leave AFTER:

| # | Type | Feedback preview | Agent | User | Date |
|---|---|---|---|---|---|
| 1 | ThumbsDown (red) | "Cited a refund window that doesn't match our policy." | Support agent | user@example.com | 2h ago |
| 2 | ThumbsUp (green) | "Clear, accurate summary of the quarterly report." | Support agent | finance@example.com | 4h ago |
| 3 | ThumbsDown (red) | "Missed the shipping question entirely." | Support agent | user@example.com | 6h ago |
| 4 | ThumbsDown (red) | "Answer contradicted the previous message." | Onboarding agent | ops@example.com | 1d ago |
| 5 | ThumbsUp (green) | "Handed off to a human at the right moment." | Onboarding agent | user@example.com | 1d ago |
| 6 | ThumbsDown (red) | "Password reset steps were out of order." | Support agent | ops@example.com | 2d ago |

AFTER the click, rows 2 and 5 (the ThumbsUp rows) crossfade out; rows
1, 3, 4, 6 remain and a 5th negative row settles into view. Use a fifth
negative placeholder so the filtered list shows **5** ThumbsDown rows (matching
the summary's "5 negative"):

| # | Type | Feedback preview | Agent | User | Date |
|---|---|---|---|---|---|
| 7 | ThumbsDown (red) | "Gave outdated pricing for the Finance plan." | Support agent | finance@example.com | 3d ago |

(Order after filter, top→bottom: rows 1, 3, 4, 6, 7 — all ThumbsDown.)

**Cursor**: a simple arrow pointer, only visible from ~2.90s; reaches the
"Negative" tab, presses at 3.40s, lifts by 4.60s. No cursor before or after.

Hook pill/H1 and payoff caption use the same treatment as the sibling 07-08
shorts (pill **#E2EBFF** bg / **#1E69DC** text; payoff a lower-third caption,
dark #000 text on the canvas, no card).

## Code snippet decision

**Yes — GraphQL.** The console runs the real `GetFeedback` query, and its
`filters` argument is exactly how the Negative tab narrows the list
(`{ score: { eq: 0 } }`) — the same operation a developer would call to pull
negative feedback from the API. Verbatim from `frontend/queries/queries.ts`
(query shell) with the fragment (`FEEDBACK_FIELDS`) inlined for a self-contained
≤12-line snippet:

Anchor line: "The Negative tab is just a filter on one query — pull it from the
API the same way:"

```graphql
query GetFeedback($page: Int!, $limit: Int!, $filters: [FilterFeedback]) {
  feedbackPagination(page: $page, limit: $limit, filters: $filters) {
    pageInfo { itemCount pageCount }
    items { id score description agent user createdAt }
  }
}
# filters: [{ score: { eq: 0 } }]   ← the Negative tab
```

(9 lines. Real operation name, real field names from `FEEDBACK_FIELDS`;
`score: { eq: 0 }` is the exact negative filter `useFeedbackQuery` pushes. The
`sort` arg is elided for length — it defaults, and the filter is the point.)

## Page prose within this feature's section (beyond the video)

- **Name hydration**: rows store raw `agent`/`user` ids; the console batches one
  `GET_AGENTS_BY_IDS` + one `GET_USERS_BY_IDS` per visible page and swaps ids
  for names (agent name; user display = name → "first last" → email → id). If a
  lookup misses, the cell honestly falls back to the raw id rather than blank.
- **The summary stat is global, not page-scoped**: `"{percent}% positive ·
  {negative} negative"` is backed by two `limit:1` count probes over ALL
  feedback, so it does not change when you filter the visible list — clicking
  the negative count is a shortcut that sets the same `negative` type filter.
- **Filtering toolbar**: debounced search (300ms) over the description, the
  Type segmented control (All | Negative | Positive), and async agent/user
  comboboxes (server-filtered, 20 results/page). Any active filter reveals a
  **Reset**; changing any filter resets to page 1.
- **Responsive**: a full data table at `md+` collapses to a card list below
  `md` — each card shows the thumbs chip, a 2-line preview, "agent · user", and
  a relative time; there are no columns on phones (responsive T1).
- **Multi-select bulk delete**: per-row checkboxes plus a page select-all
  (indeterminate when partial) feed a `BulkActionBar` — **"Delete {count}"** —
  and a destructive confirm: **"Delete {count} feedback items?"** / "This
  permanently removes {count} feedback records. The chat sessions themselves
  are not affected. This cannot be undone." Checkbox clicks don't propagate, so
  selecting never opens the detail panel.
- **Empty states**: unfiltered → **"No feedback yet"** ("Thumbs up or down in
  chat land here once an agent has feedback enabled.", action "Review agent
  settings"); filtered-empty → **"Nothing matches these filters"** ("Try
  widening the type, agent, or user, or clear the search.", action "Reset
  filters").
- **RBAC**: the whole page is `guardRoute("feedback")` in `layout.tsx` — readers
  without the feedback area never reach the console.
- **Freshness**: `GetFeedback` runs `cache-and-network` with a 30s poll and
  stale-while-loading (previous page held during refetch), so new feedback
  appears without a manual reload.
