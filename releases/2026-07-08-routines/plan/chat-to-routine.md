# Feature plan — Save a chat as a reusable routine (chat → routine)

## Sources of truth

- Chat entry point: `frontend/app/(application)/chat/components/chat-header.tsx`
  — ⋯ menu item (lines 210–220), enable gate `canSaveRoutine` (≥1 user + ≥1
  assistant message, lines 181–187), `SaveWorkflowModal` mount (line 443, passes
  `messages`, `agentId`, `sessionTitle`), ⌘./Ctrl+. opens the menu (lines 191–200)
- Dialog: `frontend/app/(application)/workflows/components/routine-editor-dialog.tsx`
  — CREATE-only `RoutineEditorDialog`; `SaveWorkflowModal` is an alias export
  (line 555). `frontend/components/save-workflow-modal.tsx` is a 2-line barrel
  re-export kept for chat's import path.
- Shared primitives: `frontend/components/primitives/overflow-menu.tsx`
  (⋯ trigger = ghost `size-8` button with `MoreHorizontal size-4`; item recipe),
  `frontend/components/ui/dialog.tsx` (overlay `bg-black/80`, content
  `zoom-in-95` + fade, `sm:rounded-lg`), `frontend/components/ui/dropdown-menu.tsx`
  (`min-w-[8rem] rounded-md border bg-popover p-1 shadow-md`)
- On-screen copy: `frontend/messages/en.json` → `chat.header.*`,
  `routines.editor.*`, `common.cancel`, `chat.composer.placeholder` (verbatim below)
- GraphQL: `CREATE_WORKFLOW_TEMPLATE` in
  `frontend/app/(application)/workflows/queries.ts:112`
  (`workflow_templatesCreateOne`; required vars `$name`, `$rights_mode`,
  `$agent`, `$steps_json`)

## What shipped

Any chat can become a routine. The chat header's ⋯ menu carries **"Save as
Routine"** (ListChecks icon), enabled once the session has at least one user and
one assistant message (before that it renders disabled with the muted sub-line
**"Available after the agent's first reply"**). Selecting it opens the
`RoutineEditorDialog` pre-seeded from the conversation: the **Routine name**
field is pre-filled with the session title, a Description field, collapsed
**Sharing & permissions** (RBAC: private / public / users / roles / teams), and
a **Steps** tab holding the captured conversation — user messages kept verbatim
and editable, every assistant turn replaced by a placeholder that the agent
regenerates fresh on each run. Saving fires `CREATE_WORKFLOW_TEMPLATE`
(`workflow_templatesCreateOne`) with the agent always attached. This is the only
creation path for routines — the /workflows page edits them but never creates.

## Hook

**From conversation to automation in two clicks.**

## Surface area

Chat surface (session header ⋯ menu) opening the routines dialog. Recipe A:
reconstruct the actual chat screen, then the real dialog over it. One short, ONE
user action: the ⋯ → "Save as Routine" menu selection (one gesture chain, like
the exemplar's click-plus-type). The dialog opening pre-seeded is the reactive
result, not an action.

## Short — `chat-to-routine` (1920×1080, 9.8s)

One slice: open the ⋯ menu and pick "Save as Routine" → the dialog rises,
already filled in from the conversation.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters (fade + 12px rise): pill "Routines" (#E2EBFF bg / #1E69DC text) above H1 **"From conversation to automation in two clicks."** ("two clicks" in #7033FF) | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor (7 words) |
| 1.90–2.30 | Hook exits; chat app card crossfades in: header (Analyst / "Quarterly report"), 2-message conversation, composer at bottom | Pivot |
| 2.30–2.75 | Chat sits completely still (0.45s) | Establish |
| 2.75–3.30 | Cursor glides to the ⋯ button in the header's right cluster | Approach |
| 3.30–3.55 | Click → dropdown opens below-right (fade + zoom-in-95, ≤200ms): Share / **Save as Routine** / Model… (GPT-5) / Usage / — / Delete conversation | First half of the action |
| 3.55–4.15 | Cursor slides down one row; "Save as Routine" row highlights (#E2EBFF bg, #1E69DC text) | Aim |
| 4.15–4.40 | Click → menu closes, dialog scales in (zoom-in-95 + fade, ~250ms) over the dimmed chat card | The action lands |
| 4.40–5.10 | Dialog holds completely still (0.7s): title "Save as routine", Setup \| Steps tabs, **Routine name already filled: "Quarterly report"** (mirrors the header title), Description field, "Sharing & permissions — Private — only you", footer Cancel / Save routine | ≥600ms post-action hold; the pre-seed is visible |
| 5.10–5.45 | Soft highlight sweep (#E2EBFF wash) enters over the dialog description line: "Convert this conversation into a reusable routine. Use {variable_name} syntax to create variables." | Real product copy carries the message |
| 5.45–7.30 | Highlight holds, everything else still (1.85s) | ≥1.8s full-sentence read floor |
| 7.30–7.55 | Highlight fades out | Clear stage |
| 7.55–7.95 | Payoff caption enters (lower third, over the dimmed area below the dialog): **"Your conversation, captured as steps — ready to rerun."** | Entrance |
| 7.95–9.80 | Payoff holds still (1.85s); last 600ms fully still = loop resting frame | ≥1.8s floor (8 words) + clean loop |

## Reconstruction cues (build the real UI, verbatim)

**Stage:** 1920×1080 canvas, bg #FDFDFD + house radial purple wash. The chat
screen renders as a centered app card ~1120px wide (border 1px #E7E7EE, radius
~6px, subtle shadow) — same framing as the 07-07/07-08 shorts. Inter,
tracking -0.025em. Cursor + motion conventions identical to the 07-07 shorts
(power2.out, 150–350ms, no bounce, no glow).

**Chat header** (`chat-header.tsx`; `h-12 border-b bg-background px-4`, items
`gap-2`, all inside the app card's top edge):

- Left→right: ghost icon button with `History` icon (`size-4`, muted) · agent
  visual `size-6` (in product an animated Lottie orb — render a static
  purple-tinted gradient disc) · agent name **"Analyst"** (`text-sm
  font-medium`) · muted `/` separator · session title **"Quarterly report"**
  (`text-sm`) · usage chip: `rounded-full border #E7E7EE px-2.5 py-0.5 text-xs`
  muted, text **"3% · 1.2K"**.
- Right cluster: the ⋯ trigger — ghost icon button `size-8`, `MoreHorizontal`
  icon `size-4`. (Files chip and mobile + button omitted: no files, desktop.)

**Conversation** (column max-w ~768px centered in the card, generous vertical
padding — the "Quiet Column"):

- User message, right-aligned bubble: `rounded-lg bg-secondary px-4 py-3
  text-sm` (bg #EDF1F5) — **"Draft the quarterly report from this week's sales
  numbers."**
- Assistant reply, left-aligned plain text (no bubble), `text-sm`: **"Done —
  here's a first draft. Revenue is up 12% QoQ, churn flat at 2.1%. Want me to
  expand any section?"** (≥1 user + ≥1 assistant = the menu item is enabled.)

**Composer** (bottom of the column, from the shipped composer card):
`<form class="relative rounded-lg border bg-card p-2">`, row `flex items-end
gap-1.5`: ＋ ghost icon button · textarea placeholder **"Ask me anything..."**
(`text-sm placeholder:text-muted-foreground`) · mic ghost icon button · send
button `size-9`, bg #7033FF, white `ArrowUp` glyph.

**⋯ dropdown** (`overflow-menu.tsx` + shadcn dropdown; `align="end"` under the
trigger): `min-w-[8rem] rounded-md border bg-popover p-1 shadow-md` (make it
~220px so labels fit). Items `flex items-center gap-2 rounded-sm px-2 py-1.5
text-sm`, leading icon `mr-2 size-4 shrink-0` muted. Exact order and strings:

1. **"Share"** — `Share2` icon
2. **"Save as Routine"** — `ListChecks` icon (enabled; no sub-line). Hover/active
   state: `bg-accent` #E2EBFF, text #1E69DC
3. **"Model… (GPT-5)"** — `Cpu` icon
4. **"Usage"** — `Gauge` icon
5. separator (`h-px bg-border`)
6. **"Delete conversation"** — `Trash2` icon, text #E54B50

**Dialog** (`routine-editor-dialog.tsx`, real shadcn Dialog): overlay dims the
app card only — real overlay is `bg-black/80`; use black at ~60% scoped inside
the app frame so the canvas/wash stays visible (presentational easing, noted as
a deviation). DialogContent centered on the card: `sm:max-w-4xl` (896px),
`sm:rounded-lg sm:p-6`, bg #FCFCFC, border #E7E7EE, shadow-lg; enters with
fade + `zoom-in-95`.

- Header (`pb-2`): title **"Save as routine"** (`text-lg`, note the lowercase
  "routine" — the ⋯ menu says "Save as Routine" with capital R; both are
  verbatim, do NOT normalize) + description `text-sm` muted #525252:
  **"Convert this conversation into a reusable routine. Use {variable_name}
  syntax to create variables."** (literal curly braces).
- Tabs: full-width 2-column TabsList (`grid w-full grid-cols-2`, bg #F5F5F5
  rounded-md p-1, `mb-6`): **"Setup"** active (white bg + subtle shadow),
  **"Steps"** inactive muted.
- Setup tab content (`space-y-6`):
  - Label **"Routine name"** (`text-sm font-medium`); Input below (`mt-2`,
    h-9, border #E7E7EE) **pre-filled with "Quarterly report"** — identical to
    the header's session title; this is the visible pre-seed. No error line
    (name non-empty).
  - Label **"Description"**; Textarea `rows=3 mt-2` with muted placeholder
    **"Describe what this routine does and when to use it…"**
  - Divider (`border-t pt-6`), then a row: left — h3 `text-sm font-medium`
    **"Sharing & permissions"** with `text-xs` muted line **"Private — only
    you"**; right — outline `sm` button **"Show advanced"** with `ChevronDown`
    icon (`ml-1 size-4`).
- Footer (`border-t`, right-aligned, gap-2): outline button **"Cancel"**,
  primary button **"Save routine"** (bg #7033FF, white text, enabled).

**Captions:** hook + payoff set in Inter, tracking -0.025em, on-canvas (outside
the app card). #7033FF reserved for "two clicks" in the hook and the send/Save
buttons — nothing else loud.

## Code snippet decision

**Yes — GraphQL.** Saving fires a real public GraphQL mutation —
`workflow_templatesCreateOne` — and it is the same call a developer scripts to
create routines programmatically (steps are plain JSON messages). Excerpt of the
actual operation from `frontend/app/(application)/workflows/queries.ts:112`,
trimmed to the required variables (optional `$description`/`$RBAC` dropped):

Anchor line: "The dialog is plain GraphQL underneath — script the same creation path:"

```graphql
mutation CreateWorkflowTemplate(
  $name: String!
  $rights_mode: String!
  $agent: String!
  $steps_json: JSON!
) {
  workflow_templatesCreateOne(
    input: { name: $name, rights_mode: $rights_mode, agent: $agent, steps_json: $steps_json }
  ) {
    item { id name variables }
  }
}
```

(12 lines, real operation and field names; `variables` in the selection is real
too — the backend extracts `{variable_name}` tokens from the steps.)

## Page prose within this feature's section (beyond the video)

- **The gate, honestly:** before the agent's first reply, the menu entry is
  disabled with the muted sub-line **"Available after the agent's first reply"**
  (disabled menu items get no pointer events, so the "why" is inline, not a
  tooltip). ⌘./Ctrl+. opens the ⋯ menu from the keyboard.
- **The Steps tab** (not shown in the short — the dialog opens on Setup): the
  captured conversation renders in a bordered, muted preview under
  **"Conversation steps"** with the tip **"Use {variable_name} syntax to create
  reusable variables (e.g. {company_name})."** User messages stay verbatim and
  are editable/removable; every assistant turn becomes a placeholder —
  *"Placeholder — the agent's generated response will appear here when the
  routine runs."* — so runs regenerate answers fresh instead of replaying stale
  ones. Add more steps inline (**"Add user message"**, Enter to add,
  Shift+Enter for a new line) and attach files (images, documents, audio —
  with a warning to make sure the agent supports those types).
- **Sharing is first-class at creation:** RBAC modes private / public / users /
  roles / teams behind **"Show advanced"**; collapsed summaries like
  "Private — only you" and "Shared with 3 users" tell the truth about the
  current draft. The agent is always attached on save ("Routines must have an
  agent attached" guards the payload); success toasts `"{name}" created` and
  the routines list refetches.
- **Only creation path:** the /workflows subpage edits existing routines inline
  (Basics / Access / Steps) but never creates — chat is where routines are born.

## Deviations from the brief

- The brief's demo moment said the dialog opens "with the conversation already
  loaded as steps" **visible**. In code the dialog always opens on the **Setup**
  tab (`useState("setup")`); the captured steps sit one tab away and showing
  them would need a second click (= second action). The short therefore proves
  pre-seeding via the pre-filled **Routine name = session title** plus the
  Setup | Steps tabs and the description copy; the Steps tab is covered in page
  prose.
- Overlay dim softened from the real `bg-black/80` to ~60%, scoped inside the
  app card, so the brand canvas stays readable on video. Purely presentational.
