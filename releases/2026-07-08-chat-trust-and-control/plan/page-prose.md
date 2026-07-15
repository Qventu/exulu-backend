# Page prose — Chat trust & control (non-video sections)

Every fact below was verified in the frontend code on 2026-07-08. All quoted UI
strings are verbatim from `messages/en.json` (namespace `chat.*` / `common.*`)
or from hardcoded JSX. Paths are relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`.

Snippet verdict: **no code snippets on this page.** All five features are pure
product UI. The mutations behind them (`UPDATE_AGENT_SESSION_RBAC`,
`CREATE_FEEDBACK`, `UPDATE_ITEM`) are internal GraphQL operations, not public
developer surfaces — nothing here earns a snippet block.

---

## Section 1 — Decide what the agent may use, per conversation

Kicker suggestion: `Chat experience` · id suggestion: `skills-and-tools`

Verified in `app/(application)/chat/components/capability-sheet.tsx` and
`app/(application)/chat/components/attach-menu.tsx`; strings in
`messages/en.json` under `chat.capabilities` / `chat.attach`.

Prose (2–3 sentences):

> The **"Skills & tools"** sheet — opened from the ＋ menu in the composer —
> lists every skill and tool the agent carries, each with its own switch, plus
> per-section **"Enable all"** / **"Disable all"**. Anything you approved
> mid-conversation shows up under **"Approved for this chat"** — *"Tools
> allowed to run without asking again in this conversation."* — with a
> per-row **"Revoke"** button, so a one-time *"Allow for this chat"* is never
> an invisible, permanent grant. When capabilities are switched off, a quiet
> **"N off"** badge sits on the ＋ trigger itself, so a non-default setup is
> visible before you send the next message.

Verified details for the writer:
- Sheet title: `"Skills & tools"`; sections `"Skills"` and `"Tools"`, one
  Switch per item wired to `controller.toggleTool` / `controller.disabledTools`.
- Section header action toggles between `"Enable all"` and `"Disable all"`
  (`controller.enableAll(ids)` / `disableAll(ids)`; label flips when every
  item in the section is off).
- `"Approved for this chat"` section header + description `"Tools allowed to
  run without asking again in this conversation."`; each row has a green
  StatusDot and an outline `"Revoke"` button
  (`controller.revokePreApprovedTool`). Rows only render when pre-approvals
  exist. Pre-approvals are created by the tool-approval card's
  `"Allow for this chat"` button and stored per-session
  (localStorage key `pre-approved-tool-calls-{sessionId}`, `hooks.ts:657-691`).
- Badge string: `"{count} off"` (e.g. "2 off"), rendered on the ＋ trigger
  (aria-label `"Add to conversation"`) and again on the `"Skills & tools"`
  menu entry (`attach-menu.tsx:132-139, 176-183`). The count only counts ids
  belonging to this agent's capabilities, so a stale id can never inflate it.
- Desktop: popover anchored in the composer card; mobile: bottom sheet,
  max-h 85dvh.

---

## Section 2 — Share a conversation without giving away the pen

Kicker suggestion: none (grouped under Chat experience) · id: `session-sharing-rbac`

Verified in `app/(application)/chat/components/share-popover.tsx`,
`components/rbac.tsx`,
`app/(application)/chat/components/composer.tsx:432-448`,
`lib/check-chat-session-write-access.ts`; strings under `chat.share` and
`chat.composer`.

Prose (2–3 sentences):

> **"Share conversation"** hands out the link — *"Anyone with access can open
> this conversation at the link below."* — and an **"Access"** collapsible
> holds the actual rights editor: private, shared with specific users, or
> shared with roles, each recipient set to **Read** or **Write**, saved with
> **"Save access rights"**. Recipients without write access get the full
> transcript but not the pen: the composer is replaced by a muted lock bar —
> *"Read-only — shared by {email}. Ask them for write access."* — naming the
> owner instead of leaving a dead input.

Verified details for the writer:
- Dialog title `"Share conversation"`, description `"Anyone with access can
  open this conversation at the link below."`; `"Conversation link"` read-only
  input + copy button labeled `"Copy conversation link"`; `"Created by
  {email}"` line when the creator is known.
- `"Access"` collapsible → `RBACControl` with
  `allowedModes={["private", "users", "roles"]}` and
  `subjectLabel="conversation"` (private option reads `"Only you can see this
  conversation"`). Users are found via `"Search users by email..."`; every
  selected user/role has a Read/Write select (`rbac.tsx:331-332`).
- Save: `"Save access rights"` → `UPDATE_AGENT_SESSION_RBAC`; toasts
  `"Access rights saved"` / `"Failed to save access rights"`.
- Read-only enforcement: `checkChatSessionWriteAccess` grants write to the
  creator (private), listed users/roles with `rights === 'write'`, and super
  admins. Without write access `composer.tsx` renders a muted bar with a Lock
  icon: `"Read-only — shared by {email}. Ask them for write access."`,
  fallback `"Read-only — you don't have write access to this conversation."`.
- IMPORTANT: do NOT claim "teams" sharing for conversations (see Exclusions).

---

## Section 3 — Find any conversation, delete fifty at once

Kicker suggestion: none · id: `conversation-search`

Verified in `app/(application)/chat/[agent]/search/page.tsx`,
`app/(application)/chat/hooks.ts:951-954` (server filter engages at
`search.length >= 3`), `components/primitives/toolbar.tsx` (300 ms default
debounce); strings under `chat.search`.

Prose (2–3 sentences):

> Every agent now has a **"Search conversations"** page at
> `/chat/[agent]/search`: type three characters or more into *"Search by
> title…"* and a debounced server-side title search narrows the list, each row
> a title plus relative timestamp, with **"Show more (N of M)"** paging in 50
> at a time. Flip on **"Select"** and checkboxes appear on the rows you're
> allowed to touch — select-all included — ending in one destructive
> **"Delete N chats"** action behind a confirm that spells out the stakes:
> *"This permanently deletes the N selected conversations for everyone with
> access. This can't be undone."*

Verified details for the writer:
- Page title `"Search conversations"`, breadcrumb back to `/chat/[agent]/new`
  labeled with the agent's name.
- Search placeholder `"Search by title…"`; 300 ms debounce (Toolbar default);
  server title-contains filter only engages at ≥ 3 characters, with helper
  text `"Type at least 3 characters to search."` below the toolbar.
- Selection: `"Select"` button toggles select mode (becomes `"Cancel"`);
  `"Select all"` checkbox spans writable rows only; count label via
  `common.selectedCount`; delete CTA `"Delete {count} chats"` (singular
  `"Delete 1 chat"`).
- Confirm dialog: title `"Delete {count} conversations?"`, description `"This
  permanently deletes the {count} selected conversations for everyone with
  access. This can't be undone."` (singular: "the selected conversation");
  success toast `"Deleted N chats."`, partial-failure toast
  `"Deleted {deleted}, {failed} failed."`.
- Pagination: `"Show more ({shown} of {total})"`, page size 50. Empty states:
  `"No matching conversations"` / `"Nothing matches "{query}". Try a different
  title."` when searching; `"No conversations yet"` otherwise.

---

## Section 4 — See how the answer was built

Kicker suggestion: none · id: `reasoning-timeline`

Verified in `components/message-renderer.tsx` — `ReasoningVisualisation`
(lines 1460-1577) and `ToolCallChip` (lines 1389-1458). All strings here are
hardcoded JSX, not i18n.

Prose (2–3 sentences):

> While an agent works, its reasoning renders as a numbered timeline — each
> step a small numbered bubble with the agent's thinking and chips for every
> tool it called; click a chip and it unfolds into the actual **Input** and
> **Output** of that call. Long runs stay readable: streaming shows only the
> latest five steps (older ones wait behind *"N more reasoning steps - show
> all"*), and once the answer lands the whole trail collapses to a single
> quiet line — *"N reasoning steps - show details"* — expandable whenever you
> want to audit the run.

Verified details for the writer:
- Steps are numbered (index + 1 in a `bg-primary/10` circle), step text in
  muted small type, tool calls rendered as `ToolCallChip`s beneath the step.
- `ToolCallChip`: tool icon + prettified name + monospace input preview;
  expandable only when input/output exist; expanded panel shows `Input` and
  `Output` labels over pretty-printed JSON `<pre>` blocks (max-h-48, scroll).
- Streaming: latest 5 steps animate in; overflow line is
  `"{N} more reasoning steps - show all"` (singular "step").
- Finished: collapses (when more than 1 step) to
  `"{N} reasoning steps - show details"`; expanded state offers `"Show less"`.
- QUOTE EXACTLY: the collapse labels use a plain hyphen (`- show details`),
  not an em dash. Do not "fix" the punctuation when quoting.
- The timeline mounts for agentic context search and for generic tool parts
  (`message-renderer.tsx:983, 1056`).

---

## Section 5 — Thumbs-down that fixes the source, not just the answer

Kicker suggestion: none · id: `feedback-source-curation`

Verified in `app/(application)/chat/components/feedback-dialog.tsx` and the
gate in `app/(application)/chat/components/message-column.tsx:165-168`;
strings under `chat.feedbackDialog`.

Prose (2–3 sentences):

> A thumbs-down now opens **"What could be improved?"** — and beneath the
> free-text field, **"Sources referenced in this response"** lists every
> knowledge item the answer actually cited. Knowledge curators get a
> per-source **"Deactivate"** button with the consequences stated up front —
> *"Deactivating archives the item globally — it will no longer appear in any
> user's chat or search results."* — and a two-step inline confirm
> (*"Archives "{item}" globally for every user."* → **"Confirm deactivate"**)
> so one bad source can be pulled for the whole team from inside the feedback
> dialog, no modal-on-modal, no hunting through the knowledge base.

Verified details for the writer:
- Negative path: title `"What could be improved?"`, description `"Help us
  understand what went wrong so we can improve."`; positive path exists too
  (`"What did you like?"`). Textarea placeholder `"Enter your feedback
  here..."`; submit `"Submit feedback"` (disabled until text is entered);
  success toast `"Feedback submitted"` / `"Thank you for your feedback!"`.
- Sources section renders only on score 0 with cited items; extraction dedupes
  by context + item id from the answer's citation blobs
  (`extractReferencedItems`). Each row: item name + its context (underscores
  prettified).
- Curator gate: `can(user, { area: "agents", level: "write" })` computed at
  the mount (`message-column.tsx:166`); non-curators see the source list
  without Deactivate buttons.
- Two-step confirm: `"Deactivate"` (destructive-tinted outline) swaps in an
  inline strip inside the same dialog — warning `"Archives "{item}" globally
  for every user."` with `"Confirm deactivate"` / `"Cancel"`. Confirming runs
  `UPDATE_ITEM(context)` with `{ archived: true }`; row state flips to
  `"Deactivated"`; toast `"Source deactivated"` / `"{item} has been archived
  globally."`.
- Background detail (optional, verified): submitting also closes the loop on
  the answer's trajectory via a best-effort `postTrajectoryFeedback` POST that
  never blocks the GraphQL feedback.

---

## Excluded (not shipped / not verifiable)

1. **"Teams" sharing mode for conversations.** The scope brief said
   "private/users/roles/teams", but `share-popover.tsx:171` passes
   `allowedModes={["private", "users", "roles"]}` — the teams option (which
   `components/rbac.tsx` supports for other surfaces) is filtered out of the
   conversation share dialog. Do not mention teams (or public) for session
   sharing.
2. **Any code snippet.** Proposed none: `UPDATE_AGENT_SESSION_RBAC`,
   `CREATE_FEEDBACK`, and `UPDATE_ITEM` are internal frontend GraphQL
   operations, and pre-approvals live in localStorage — there is no public
   REST/API surface for a developer snippet in any of the five features.
3. **"Approved for this chat" surviving across devices/sessions.** Pre-approvals
   are stored in browser localStorage per session id — do not claim they sync
   or persist server-side.
4. **i18n for the reasoning timeline.** Its strings ("N reasoning steps - show
   details", "Show less", "Input", "Output") are hardcoded English, unlike the
   rest of the page — safe to quote, but don't claim localization.
