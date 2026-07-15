# Feature plan — Feedback detail panel with conversation replay

Part of `releases/2026-07-08-feedback-management/`.

## Sources of truth

- UI: `frontend/app/(application)/feedback/components/feedback-list.tsx`
  (the `md+` data table: Checkbox · Type · Feedback · Agent · User · Date; row
  click → `handleSelect(item)` opens the detail), and
  `frontend/app/(application)/feedback/components/feedback-detail-panel.tsx`
  (the detail body: header type indicator + `RelativeTime` + overflow menu,
  meta grid, **Open in Chat** button, feedback text, and the read-only
  conversation rendered by `MessageRenderer`).
- Detail presentation: `frontend/components/primitives/list-detail.tsx` —
  feedback passes `detailMode="panel"` **`detailPresentation="sheet"`**, so at
  every width the detail opens as a **right-side overlay Sheet** (from
  `components/ui/sheet.tsx`: `side="right"`, `slide-in-from-right`,
  `data-[state=open]:duration-500`, width `w-3/4 sm:max-w-md`, `border-l`,
  dimmed `bg-black/80` overlay). No `detailTitle` is passed, so the Sheet
  header reads the default **"Details"** (`common.details`).
- Conversation replay: `frontend/components/message-renderer.tsx` +
  `frontend/components/ai-elements/message.tsx`. User messages render as a
  right-aligned bubble (`ml-auto`, `bg-secondary` #EDF1F5, `rounded-lg`,
  `px-4 py-3`); assistant messages render as **left-aligned plain body text**
  (no bubble, `text-foreground`). The panel mounts it read-only:
  `showTokens={false}`, `status="idle"`, `writeAccess={false}`,
  `config={{ marginTopFirstMessage: "mt-0" }}`.
- On-screen copy: `frontend/messages/en.json` → `feedbackReview.*` (columns,
  detailPanel, typeNegative/typePositive) + `common.details` (verbatim below).
- GraphQL: `GET_AGENT_MESSAGES` in `frontend/queries/queries.ts` (~line 494) —
  the operation that fetches the session transcript the replay renders.
- Tokens: `releases/2026-07-08-feedback-management/hyperframes-design.md`
  (secondary #EDF1F5, success #16A34A, destructive #E54B50, muted #F5F5F5,
  muted-foreground #525252, border #E7E7EE, primary #7033FF).

## What shipped

Clicking any feedback row opens a detail Sheet that reconstructs the whole
interaction behind the rating:

- **Header** — a round type chip (thumbs-up on `bg-success/10 text-success`
  for positive; thumbs-down on `bg-destructive/10 text-destructive` for
  negative), the label **"Positive feedback" / "Negative feedback"**, a
  `·` separator, and a `RelativeTime` (e.g. **"2d ago"**), with an overflow
  menu (`MoreHorizontal`, aria "Actions") whose only item is **"Delete
  feedback"** (destructive, opens the shared ConfirmDialog).
- **Meta grid** — a two-column `dl`: **User** (name/email + copy-id button),
  **Agent** (agent name + copy-id), **Session** (session title in mono +
  copy-id).
- **Open in Chat** — an outline button linking to
  `/chat/{agent}/{session}` with a trailing `ExternalLink` icon — one click
  jumps straight to the live source session.
- **Feedback** — the author's comment in a `bg-muted/50` rounded block.
- **Conversation** — the full session transcript rendered by the *real* chat
  `MessageRenderer` (same component the live chat uses), read-only. Messages
  come from `GET_AGENT_MESSAGES` filtered to `session eq feedback.session`,
  each row's `content` JSON-parsed into a `UIMessage`.

## Hook

**See the whole conversation behind the rating.**

## Surface area

UI feature (row click → detail Sheet with the live replay) + one real
developer surface: the `GET_AGENT_MESSAGES` GraphQL query that hydrates the
transcript. One short on the single action (row click → Sheet slides in). The
overflow "Delete feedback" action, copy-id buttons, and the empty-conversation
state are page prose within this feature's section.

## Short — `feedback-detail-replay` (1920×1080, 9.0s)

One slice, ONE action: the cursor clicks a feedback row in the list; the
detail Sheet slides in from the right with the replayed conversation, the
comment, and **Open in Chat**, then settles.

### Demo arc (timed beats)

The list card and the Sheet both live on the same #FDFDFD canvas. When the
Sheet opens it slides in over the list (which dims slightly behind the
`bg-black/80` overlay at low opacity — keep it readable, ~15% scrim so the
promo stays light). The em-word in the hook is brand purple #7033FF; nothing
else on screen is purple.

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.30 | Hook enters (lower-third caption on the canvas, list card faint behind): pill "Feedback" (#E2EBFF bg / #1E69DC text), H1 "See the whole **conversation** behind the rating." (em word #7033FF) | Entrance (not at t=0) |
| 0.30–2.10 | Hook holds static (1.8s) | ≥1.8s full-sentence floor (8+ words) |
| 2.10–2.45 | Hook fades out; the feedback list card is now fully lit and centered. Cursor is parked over the first row | Pivot to the surface |
| 2.45–2.95 | Cursor glides to the target row (row 2, the negative one); the row hover-tints (`bg-muted/40`) under it | Click affordance, motion toward target |
| 2.95–3.15 | Cursor press on row 2 (subtle 0.95 scale dip on the cursor); row sets `data-state="selected"` | The ONE action lands |
| 3.15–3.75 | Sheet slides in from the right (`slide-in-from-right`, ~500ms, power2.out) over a light scrim; header "Details" + a thin border-l visible; body still settling | Real Sheet entrance (duration-500) |
| 3.75–4.35 | Sheet fully in place. Header shows the red thumbs-down chip + **"Negative feedback" · 2d ago**; meta grid (User / Agent / Session) and **Open in Chat** button visible | Resulting state assembles |
| 4.35–5.20 | Body scroll settles on the **Conversation** replay: one right-aligned user bubble ("Can you summarize the Q3 finance report?") + one left-aligned assistant reply (plain text, 2 short lines); the **Feedback** comment block sits above it | The payoff: the replay is the real chat UI |
| 5.20–5.90 | Everything holds completely still (700ms) | ≥600ms post-action settle |
| 5.90–6.30 | Payoff caption enters (lower third): "The full replay, comment, and one-click jump to the session." | Entrance |
| 6.30–9.00 | Payoff holds still (2.7s); last ~600ms fully frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

Motion: the Sheet is the only large move (power2.out, ~500ms, no bounce, no
glow). The row hover-tint and cursor press are 150–200ms. After 5.20 the frame
is static except nothing — no spinners exist in this surface once loaded.

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash (same framing as the
sibling 07-08 shorts). Inter everywhere, tracking -0.025em, radius ~6px,
borders 1px #E7E7EE. Purple #7033FF appears only in the hook em word and
pill-adjacent accents; the product surface uses semantic colors only.

**The list card** (from `feedback-list.tsx`, `md+` table, inside a centered
card ~1120px wide, radius ~6px, border 1px #E7E7EE, bg #FCFCFC, subtle
shadow). Table header row (`text-muted-foreground` #525252, text-sm): a
checkbox cell (`w-10`), an unlabeled type cell (`w-10`), then **"Feedback"**,
**"Agent"**, **"User"**, **"Date"** (`w-32`). Two body rows, each 44px+ tall,
`border-b` #E7E7EE, `cursor-pointer`:

| Row | Type chip | Feedback (line-clamp-2, ≤120 chars +"…") | Agent | User | Date |
|---|---|---|---|---|---|
| 1 | green ThumbsUp on `bg-success/10` | "Nailed the tone and gave exactly the figures I needed." | Support agent | user@example.com | 5d ago |
| 2 (target) | red ThumbsDown on `bg-destructive/10` | "Missed the shipping-cost line and summarized the wrong quarter." | Support agent | user@example.com | 2d ago |

Type chip = `size-6` rounded-full; ThumbsUp/ThumbsDown `size-3`. Positive
chip `bg-success/10 text-success` (#16A34A); negative `bg-destructive/10
text-destructive` (#E54B50). On row 2 hover, tint the whole row `bg-muted/40`;
on click set the selected data-state (subtle `bg-muted/40`, `border-primary/50`
is card-list only — for the table keep the muted selected tint).

**The Sheet** (right overlay, `slide-in-from-right`, `w-3/4 sm:max-w-md` → in
1080p render it ~460–520px wide, full height, `border-l` #E7E7EE, `bg-#FCFCFC`,
shadow-lg, over a light dimmed scrim on the list). Structure top→bottom:

1. **Sheet header** (`border-b`, px-4 py-3): title **"Details"** (text-base,
   truncate) + a ghost close `×` at top-right (X icon, size-4).
2. **Panel header** (`border-b border-border px-4 py-3`, flex between):
   - Left: `size-7` rounded-full red chip with `ThumbsDown size-3.5`
     (`bg-destructive/10 text-destructive`), then **"Negative feedback"**
     (text-sm font-medium), a muted `·`, then **"2d ago"** (text-sm
     `text-muted-foreground`). (No status badge — omit; `feedback.status` is
     empty in the demo.)
   - Right: overflow button — `size-8` ghost, `MoreHorizontal size-4`, aria
     "Actions". Menu stays CLOSED in this short.
3. **Body** (`flex flex-col gap-6 p-4`):
   - **Meta grid** (`dl`, text-sm, two columns `[auto,1fr]`, gap-3):
     - **"User"** (muted label) → `user@example.com` + a `size-7` ghost copy
       button (Copy icon, aria "Copy user id").
     - **"Agent"** (muted) → `Support agent` + copy button (aria "Copy agent
       id").
     - **"Session"** (muted) → session title in **`font-mono text-xs`**:
       `Quarterly report review` + copy button (aria "Copy session id").
   - **Open in Chat** button: outline, size-sm, label **"Open in Chat"** with a
     trailing `ExternalLink size-3.5` (`ml-2`). Links to `/chat/{agent}/{session}`.
   - **Feedback** section: `h3` **"Feedback"** (text-sm font-semibold), then a
     `whitespace-pre-wrap rounded-md bg-muted/50 p-4 text-sm` block containing
     the comment: "Missed the shipping-cost line and summarized the wrong
     quarter."
   - **Conversation** section: `h3` **"Conversation"** (text-sm font-semibold),
     then a `rounded-md border p-4` (#E7E7EE) region holding the
     `MessageRenderer` replay.

**Conversation replay content** (from `message.tsx` bubble rules — build the
real chat UI):
- Message 1 — **user**, right-aligned bubble: container `ml-auto`, `max-w-[95%]`;
  bubble `bg-secondary` (#EDF1F5), `rounded-lg`, `px-4 py-3`, text-sm
  `text-foreground`. Text: **"Can you summarize the Q3 finance report?"**
- Message 2 — **assistant**, left-aligned, **no bubble**, plain `text-foreground`
  text-sm (markdown body). Two short lines:
  **"Q3 revenue was up 8% quarter over quarter, led by the Finance
  segment."** then **"Net margin held at 21%."** (Keep it to ~2 lines so the
  whole replay fits the Sheet without scrolling in-frame.)
- Do NOT render message action rows (`showActions` is effectively off for this
  read-only mount context — the panel passes no `onRegenerate` and
  `agent.feedback` is not relevant here; keep bubbles clean, no copy/retry
  icons under the assistant message).

**Hook + payoff type**: pill #E2EBFF bg / #1E69DC text; H1 dark
(`#000`), em word #7033FF. Payoff is a lower-third caption (dark text on the
canvas, no card), same treatment as sibling 07-08 shorts.

Neutral placeholders only: user `user@example.com`, agent "Support agent",
session title "Quarterly report review", topic "Q3 finance report" / "Finance".
No real names or brands.

## Code snippet decision

**Yes — GraphQL.** The replay is the feature, and it is powered by one real
operation: `GET_AGENT_MESSAGES`, filtered to the feedback's session, which the
panel JSON-parses into chat messages. This is the developer surface — the way
to pull a session transcript from the API. Verbatim from
`frontend/queries/queries.ts`:

Anchor line: "The replay is one query — pull the session transcript, render it
in the real chat UI:"

```graphql
query GetAgentSessionMessages(
  $page: Int!
  $limit: Int!
  $filters: [FilterAgent_message]
) {
  agent_messagesPagination(page: $page, limit: $limit, filters: $filters) {
    items {
      id
      session
      content
      createdAt
    }
  }
}
```

(11 lines, real operation and field names; the panel calls it with
`filters: [{ session: { eq: feedback.session } }]`, `page: 1`, `limit: 1000`,
then `JSON.parse`es each item's `content` into a UIMessage for
`MessageRenderer`. The default `sort` `createdAt ASC` is omitted for length —
it is the query's default argument.)

## Page prose within this feature's section (beyond the video)

- **The real chat renderer, read-only.** The conversation isn't a screenshot
  or a re-implementation — it is the same `MessageRenderer` the live chat uses,
  mounted with `writeAccess={false}`, `showTokens={false}`, `status="idle"`.
  Tool calls, reasoning blocks, citations, and todo lists all render exactly as
  they did in the session; you just can't edit or regenerate.
- **Metadata at a glance.** User (name or email), agent name, and session
  title each sit next to a copy-id button (**"Copy user id" / "Copy agent id"
  / "Copy session id"**) so an ID is one click away for support tickets or
  debugging. Names are hydrated in the list from `GET_AGENTS_BY_IDS` /
  `GET_USERS_BY_IDS`, falling back to the raw id when a lookup misses.
- **One-click jump to the source.** **"Open in Chat"** links to
  `/chat/{agent}/{session}` — from a rating straight into the live session to
  continue or correct the thread.
- **Empty state.** If a session has no stored messages the Conversation section
  shows **"No messages found for this session."** (`detailPanel.conversationEmpty`)
  instead of an empty box; while loading it shows the shared `Loading` spinner.
- **Delete from the panel.** The overflow menu's only item, **"Delete
  feedback"** (destructive), opens the shared ConfirmDialog — **"Delete this
  feedback?"** / "This permanently removes the feedback record. The chat
  session itself is not affected. This cannot be undone." — and on success
  toasts **"Feedback deleted"** and closes the panel. The chat session is never
  touched.
- **Presentation.** The detail is a right-side overlay Sheet at every width
  (`detailPresentation="sheet"`), full-height, `sm:max-w-md`; below `md` it
  becomes a bottom sheet (`max-h-[85dvh]`). Selection is URL-synced to
  `?selected=<id>`, so a detail view is deep-linkable and back/forward closes
  it.
