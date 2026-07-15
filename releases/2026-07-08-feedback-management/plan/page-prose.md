# Page prose — FEEDBACK MANAGEMENT (non-video sections)

Part of `releases/2026-07-08-feedback-management/`. Every fact below was
verified in the frontend code on 2026-07-08 (paths relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`). All quoted strings
are verbatim from `messages/en.json → feedbackReview.*` (and `common.*`) or
the component source. Format reference:
`releases/2026-07-08-admin-and-theming/plan/page-prose.md` (benefit-led
title → 2–3 verified sentences → snippet only where a real developer surface
earns it).

The video-section feature plans in this same folder
(`feedback-triage.md`, `feedback-detail-replay.md`) carry the demo visuals;
these prose sections are the assembled page copy and must not duplicate their
step-by-step detail.

One snippet on the whole page: the `feedbackRemoveOneById` delete mutation
(section 3) — the console's only genuine write op. The console is otherwise a
pure admin UI over read queries.

Files: `app/(application)/feedback/**`
(`page.tsx`, `layout.tsx`, `components/use-feedback-query.ts`,
`components/feedback-summary-stat.tsx`, `components/feedback-toolbar.tsx`,
`components/feedback-list.tsx`, `components/feedback-detail-panel.tsx`),
`queries/queries.ts`, `components/shell/nav-config.ts`, `lib/route-guard.tsx`,
`components/primitives/toolbar.tsx`.

---

## 1. Summary stat header — "The health of every answer, in one line"

Sources: `components/feedback-summary-stat.tsx`,
`components/use-feedback-query.ts` (summary probes, lines 122–152),
`page.tsx` (PageHeader `meta` slot), `messages/en.json → feedbackReview.*`.

Prose:

The `/feedback` console leads with a quiet one-line verdict in the page
header — **"{percent}% positive · {negative} negative"** — that reads the
whole corpus, not just the page you're on. The two counts come from a pair of
count-only `GET_FEEDBACK` probes (`limit: 1`, reading `pageInfo.itemCount`
for `score: 1` and `score: 0`) that poll every 30 seconds, so the split stays
current as new thumbs land, and the header simply renders nothing until there
is at least one rating to summarise. The negative number is itself a
link-button: clicking it drops you straight into the negatives
(`onSelectType("negative")`), because a review console should make the thing
you actually need to fix one click away.

Verified details for the writer:
- The line is a single ICU string `"{percent}% positive · {negative} negative"`
  (`feedbackReview.summaryStat`); the component splits it so only the
  `{negative}` count becomes the inline link-button.
- `percent = round(positive / (positive + negative) * 100)`; the stat hides
  while loading or when `total === 0` (`feedback-summary-stat.tsx:28`).
- Both probes and the main list run `pollInterval: 30000` with
  `fetchPolicy: "cache-and-network"` (`use-feedback-query.ts:99–141`) — the
  page is live without a manual refresh.

No snippet — this is presentational admin UI over read-only counts.

## 2. Filtering toolbar — "Slice thousands of ratings to the one that matters"

Sources: `components/feedback-toolbar.tsx`, `components/use-feedback-query.ts`
(filter assembly, lines 78–97), `components/primitives/toolbar.tsx`
(300 ms debounce, lines 91–94), `queries/queries.ts`
(`GET_AGENTS`, `GET_USERS`), `messages/en.json → feedbackReview.toolbar.*`.

Prose:

The toolbar is built on the shared `Toolbar` primitive and combines four
filters that all compose into one server-side `filters[]` query. A search box
(**"Search feedback…"**) debounces at 300 ms and edits a `description.contains`
filter; a segmented Type control (**All · Negative · Positive**) maps to
`score: { eq: 0 | 1 }`; and two async `EntityCombobox` pickers
(**"Filter by agent"**, **"Filter by user"**) hit `GET_AGENTS` / `GET_USERS`
with a server-side `name.contains` search — each showing **"No agents match"**
/ **"No users match"** on a miss. Because the URL stores raw ids, each
combobox also carries a `resolveLabel` callback that rehydrates the chosen
id back into a human name (users falling back to email, then id), so a
deep-linked or reloaded filter never shows a bare id. Every change resets to
page 1, an active-filter count surfaces on the primitive, and a **"Reset"**
control clears all four at once.

Verified details:
- Debounce is the `Toolbar` default of 300 ms (`toolbar.tsx:91–94`); the
  feedback toolbar passes no override.
- User id is passed verbatim into `{ user: { eq: userId } }` — no
  `parseFloat`/number-coerce (`use-feedback-query.ts:93–94`, comment "U12").
- `activeFilterCount` counts search + non-`all` type + agentId + userId;
  `onResetFilters` calls `query.resetFilters()` only when the count is > 0.
- Combobox fetches use `fetchPolicy: "cache-first"`, `page: 1, limit: 20`;
  `resolveAgentLabel` / `resolveUserLabel` query by `{ id: { eq } }`,
  `limit: 1`.

No snippet — Apollo lives in the hook/toolbar, but the ops here
(`GET_AGENTS`, `GET_USERS`) are generic list queries, not a feedback-specific
developer surface.

## 3. The feedback list — "Names, not ids — and delete fifty at once" (SNIPPET)

Sources: `components/feedback-list.tsx`
(name hydration lines 111–160, responsive table vs card lines 244–390,
bulk delete lines 207–222 + 417–500), `queries/queries.ts`
(`DELETE_FEEDBACK` line 551, `GET_AGENTS_BY_IDS` line 772,
`GET_USERS_BY_IDS` line 1591),
`messages/en.json → feedbackReview.confirmDelete.* / selectionBar.* / toasts.*`.

Prose:

The list solves the "raw id" problem the backend still hands it: for each
visible page it batches one `GET_AGENTS_BY_IDS` (`agentByIds`) and one
`GET_USERS_BY_IDS` (`userByIds`) call and maps every author and agent id to a
real name — users composed from name, then firstname/lastname, then email,
then id (`userLabel`, `feedback-list.tsx:85–88`) — with the raw id kept only
as an honest last-resort fallback. The layout is responsive by breakpoint:
a full data table at `md+` (**Type · Feedback · Agent · User · Date** with a
select column) collapses below `md` into a tap-friendly card list, each card a
≥44 px hit target with a thumbs icon, two-line preview, and relative time.
Reviewers can multi-select across the page and clear ratings in bulk: the
selection bar's **"Delete {count}"** opens a confirm dialog —
**"Delete {count} feedback items?"** / **"This permanently removes {count}
feedback records. The chat sessions themselves are not affected. This cannot
be undone."** — before firing one `DELETE_FEEDBACK` per row and toasting
**"Deleted {count} feedback items"**.

Snippet — EARNED (the console's only write op; the delete every bulk and
single action funnels through, `queries.ts:551–557`):

```graphql
mutation DeleteFeedback($id: ID!) {
  feedbackRemoveOneById(id: $id) {
    id
  }
}
```

Verified details:
- Bulk delete `Promise.all`s one `deleteFeedback({ variables: { id } })` per
  selected row (`feedback-list.tsx:207–222`); both bulk and single-item paths
  `refetchQueries: [GET_FEEDBACK, "GetFeedback"]`.
- Checkbox clicks `stopPropagation()` so toggling selection never opens the
  detail panel; selection is pruned to the visible page so the count never
  includes stale rows (`visibleSelected`, lines 164–172).
- Hydration queries are `skip`-guarded when there are no ids; the code frames
  this as fixing an honest-degradation state (comment "BE-4 … cells fell back
  to raw ids", lines 108–110).
- Single-item delete lives in the detail panel's overflow menu with its own
  confirm ("Delete this feedback?" / …) and toast ("Feedback deleted").
- Failure path on either shows "Failed to delete feedback".

## 4. RBAC-gated console — "An admin surface that fails closed"

Sources: `layout.tsx`, `page.tsx` (RBAC doc comment lines 5–12),
`components/shell/nav-config.ts` (feedback entry lines 205–216),
`lib/route-guard.tsx`.

Prose:

`/feedback` is an admin review console, and the gate is enforced on the
server, not hidden in the client: a server `layout.tsx` wraps the client page
in `guardRoute("feedback")`, so an account without the right is served the
shared `<AccessDenied/>` primitive server-side rather than a flash of guarded
content. The requirement is declared once in `nav-config.ts` and reused by
both the sidebar and the guard, honouring the "nav-hidden must imply
route-guarded" rule — today that requirement is **`super_admin`**, with a
`TODO` in the config to flip to a dedicated `feedback` role key when the
backend role-model ships. Denial is transparent by design: `AccessDenied`
names the missing right instead of silently bouncing anyone.

Verified details:
- `layout.tsx` returns `(await guardRoute("feedback")) ?? children` — the
  page-level guard, no client guard in `page.tsx`.
- Nav entry `id: "feedback"`, `route: "/feedback"`, `requires: "super_admin"`
  (`nav-config.ts:215`), with the comment "TODO(backend role-model): flip to
  a `feedback` role key when it ships".
- The guard redirects unauthenticated hits to `/login`, and renders
  `<AccessDenied requiredRight={…} backHref="/chat" />` on a failed predicate
  (`route-guard.tsx:140–147`).

No snippet — the gate is a route guard, not a callable developer surface.

## 5. Complements the in-chat feedback loop — reference only

Sources (prior releases, not re-verified here):
`releases/2026-07-08-chat-quality-of-life/` (in-chat trajectory feedback),
`releases/2026-07-08-chat-trust-and-control/` (source-deactivation,
`feedback-source-curation`).

Prose (one clause, no re-announcement):

This console is the review end of a loop that already starts in chat: the
👍/👎 trajectory feedback shipped in **chat-quality-of-life** and the
thumbs-down that deactivates the offending source (**chat-trust-and-control**,
`feedback-source-curation`) are where ratings are created — `/feedback` is
simply where an admin triages what those interactions produced.

No snippet — reference only.

---

## EXCLUDED (not shipped, out of scope, or belongs to another release)

1. **`CREATE_FEEDBACK` / `feedbackCreateOne` GraphQL snippet** — this mutation
   is the chat footer's **"Send feedback"** dialog
   (`app/(application)/chat/components/feedback-dialog.tsx:38,124`;
   `app/(application)/chat/queries.ts:396`), NOT the `/feedback` review
   console. The console never creates feedback. Do not present it as part of
   this page. The console's only write is `feedbackRemoveOneById` (section 3).
2. **A `/feedback` REST route** — none. The console is pure GraphQL over
   Apollo (`GET_FEEDBACK` / `feedbackPagination`, name-hydration `byIds`
   queries, `DELETE_FEEDBACK`). No REST endpoint to cite.
3. **"Live count" summary framing** — the header is a percent-positive /
   negative-count split (`"{percent}% positive · {negative} negative"`), not a
   single total-feedback counter. Describe it as the positive/negative split,
   made current by a 30 s poll; do not claim a standalone "total feedback"
   headline number.
4. **Detail panel conversation replay / Open-in-Chat / meta strip** — covered
   by the video-section plan `feedback-detail-replay.md`; keep the prose page
   to the list/toolbar/summary/RBAC surfaces above and let that section carry
   the replay.
5. **Server-side `feedback` role enforcement** — not shipped. The gate
   resolves to `super_admin` today; the config comment marks a future
   `feedback` role key. Do not imply role-level (non-super-admin) access
   exists yet.
6. **Backend-denormalised `agentName` / `userName` on feedback rows** — not
   shipped; the list compensates with client-side `byIds` hydration
   (comment "BE-4"). Frame hydration as the current mechanism, not a backend
   feature.
7. **Trajectory-feedback and source-deactivation mechanics** — announced in
   `chat-quality-of-life` and `chat-trust-and-control` respectively; reference
   in one clause (section 5), never re-announce or re-explain.
