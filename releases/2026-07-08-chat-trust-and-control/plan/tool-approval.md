# Feature plan — Tool-call approval flow (Allow once / Allow for this chat / Deny)

## Sources of truth

- Code (frontend, route-local chat rebuild):
  - `frontend/app/(application)/chat/components/tool-call-approval.tsx` — the
    approval card (request state) and the resolved status row; button
    hierarchy Allow once = primary, Allow for this chat = outline, Deny =
    outline + `text-destructive`; `getInputSummary` heuristic (preferred keys
    `path, file_path, filename, command, query, url, question, prompt, text`).
  - `frontend/app/(application)/chat/components/message-column.tsx` — renders
    `ToolCallApproval` for parts in state `approval-requested` /
    `approval-responded`; everything sits in `CHAT_COLUMN`.
  - `frontend/app/(application)/chat/components/chat-shell.tsx:29` —
    `CHAT_COLUMN = "mx-auto w-full max-w-3xl px-4"` (768px column).
  - `frontend/app/(application)/chat/hooks.ts` — `approveToolForChat` /
    `revokePreApprovedTool` / `preApprovedTools`; persistence key
    `pre-approved-tool-calls-${sessionId}` (localStorage, JSON string[] of raw
    part types like `"tool-Email"`).
  - `frontend/app/(application)/chat/components/capability-sheet.tsx:138-193` —
    "Approved for this chat" section with per-row **Revoke**.
- Backend: `backend/src/exulu/tool.ts:115` — `ExuluTool.needsApproval` defaults
  to **true**; `backend/src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:443`
  — pre-approved ids (`"tool-" + name` from the request body's `approvedTools`,
  parsed in `backend/src/exulu/routes.ts:798`) flip `needsApproval` to false for
  the run. Sandbox `readFile`/`writeFile`/`bash` are exposed with
  `needsApproval: false` (same file, :374-393) — approval is for custom /
  integration tools.
- On-screen copy: `frontend/messages/en.json` → `chat.approval.*` and
  `chat.capabilities.*` (verbatim below).
- Real approval-gated tool for the demo: `backend/src/templates/tools/email.ts`
  (`id: "email"`, `name: "Email"`, no `needsApproval` set → defaults true;
  input schema `recipient, subject, html, text` — `getInputSummary` picks the
  `text` field for the mono preview).

## What shipped

When an agent wants to run a sensitive tool, the stream pauses and an approval
card renders in-column, inside the assistant turn: a muted `ShieldAlert` icon,
the title **"Run {tool}?"**, one explaining sentence, and a monospace preview of
the actual tool input — no dead chevron rows, everything readable up front.
Three actions with corrected hierarchy: **Allow once** (primary purple),
**Allow for this chat** (outline; approves this call AND persists a per-session
pre-approval), **Deny** (outline, destructive red text). Once answered, the card
collapses to a quiet status row with semantic styling — green
**"Approved: {tool}"** or red **"Denied: {tool}"** — and the agent continues
streaming. Pre-approvals are visible and revocable in the capability sheet
("Approved for this chat" → **Revoke**), fixing the old invisible, irrevocable
pre-approvals.

## Hook

**Nothing runs without your say-so.**

## Surface area

UI feature (chat conversation column, in-turn card) + a real SDK surface:
`ExuluTool.needsApproval` is a public constructor field on `@exulu/backend`'s
exported `ExuluTool` class — approval-by-default is a backend contract, not a
frontend nicety. One short on the Allow-once click; pre-approval persistence and
capability-sheet revocation are page prose within this feature's section.

## Short — `tool-approval` (1920×1080, 9.5s)

One slice, ONE user action: clicking **"Allow once"** on the shield-marked
approval card → card resolves to the green "Approved: Email" row and the agent
resumes streaming. (The streaming resume is reactive, not a second action.)

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters (fade + 12px rise): pill "Chat — trust & control" (#E2EBFF bg / #1E69DC text), H1 **"Nothing runs without your say-so."** ("say-so" in #7033FF) | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor (5 words) |
| 1.90–2.35 | Hook crossfades out; chat panel fades in: user bubble "Email the quarterly report summary to the team", assistant line "I'll draft and send that now.", then the approval card — shield icon, **"Run Email?"**, description sentence, mono input preview, three buttons. Stream is visibly paused (no caret motion) | Pivot; the card IS the moment |
| 2.35–4.25 | Scene holds completely still (1.9s) — viewer reads the card | ≥1.8s floor (card description is a full sentence) |
| 4.25–4.95 | Cursor glides in from lower right toward **"Allow once"** | Approach (cursor affordance) |
| 4.95–5.15 | Hover: button darkens to `bg-primary/90`; click at ~5.05 (subtle 0.98 scale press, no bounce) | The one action |
| 5.15–5.45 | Card crossfades (250ms) into the resolved row: green-tinted `border-success/30 bg-success/5`, CheckCircle2, **"Approved: Email"** | Resolution, semantic success styling |
| 5.45–6.05 | Resolved state holds still (600ms) | ≥600ms post-action hold before layout change |
| 6.05–7.10 | Agent resumes streaming below the row: "Sent — the quarterly report summary is on its way to user@example.com." types in (~30ms/char, natural jitter) | Payoff in-product: approval unblocks the stream |
| 7.10–7.50 | Payoff caption enters (lower third): **"One click — and the agent keeps moving."** | Entrance; streamed sentence is now static |
| 7.50–9.50 | Payoff holds still (2.0s); last 600ms completely still = loop resting frame | ≥1.4s floor (7 words) and ≥1.8s payoff hold |

### Reconstruction cues (build the real UI, verbatim)

**Framing (house default + chat-canvas conventions):** 1920×1080, bg #FDFDFD
with the house radial purple wash. The chat surface renders as a centered panel
card ~1120px wide (~620px tall, bg #FCFCFC, 1px border #E7E7EE, radius ~6px,
subtle shadow), and INSIDE it the conversation sits in the real chat column:
`mx-auto w-full max-w-3xl px-4` (768px), messages stacked with `gap-6`
(`ConversationContent`). Inter, tracking -0.025em; mono is JetBrains Mono.

**User bubble** (`ai-elements/message.tsx`): right-aligned (`ml-auto`), `w-fit
max-w-[95%]`, `rounded-lg bg-secondary px-4 py-3` (#EDF1F5), `text-sm`
foreground text. Copy: `Email the quarterly report summary to the team`.

**Assistant turn**: no bubble — plain `text-sm` foreground text, left-aligned.
Line 1: `I'll draft and send that now.` The approval card follows with `mt-3`.

**Approval card — request state** (`tool-call-approval.tsx`, verbatim):

- Shell: shadcn Card = `rounded-lg border bg-card shadow-sm` + `mt-3
  border-border bg-card` → radius ~8px, border #E7E7EE, bg #FCFCFC. Card width
  = full message width inside the column.
- Header (`p-6 pb-3`): row `flex items-start gap-2` —
  - `ShieldAlert` icon, `size-4` (16px), **`text-muted-foreground`** (#525252,
    muted grey — NOT purple, NOT amber), `mt-0.5`.
  - Title (`text-base font-medium`, 16px): **"Run Email?"** (i18n
    `chat.approval.title` = `"Run {tool}?"`; tool name = part type
    `tool-Email` with `tool-` stripped, `_`→space — renders as `Email`).
  - Below it (`text-sm text-muted-foreground`, `space-y-1` under the title):
    **"The agent wants to run this tool. Review the request and choose how to
    proceed."** (`chat.approval.description`).
- Content (`p-6 pt-0 space-y-3`):
  - Input preview: `line-clamp-3 break-all rounded-md border border-border
    bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground` — JetBrains
    Mono 12px on a faint #F5F5F5-at-40% chip. Text (the email tool's `text`
    field — that is what `getInputSummary` really picks): `Hi team, here is the
    quarterly report summary — highlights, risks, and next steps inside.`
  - Button row `flex gap-2 sm:flex-row`, three buttons each `sm:h-9 sm:flex-1`
    (equal thirds), `rounded-md text-sm font-medium`:
    1. **"Allow once"** — primary: bg #7033FF, white text (the only loud
       element in frame). Hover `bg-primary/90`.
    2. **"Allow for this chat"** — outline: 1px border #E7E7EE, bg
       `background` (#FDFDFD), foreground text.
    3. **"Deny"** — outline + `text-destructive` (#E54B50 label, same outline
       shell).

**Resolved success row** (replaces the whole card on click, verbatim):
`mt-3 flex items-center gap-2 rounded-lg border px-3 py-2` with
`border-success/30 bg-success/5` (success = #16A34A → border ~rgba(22,163,74,.3),
bg ~rgba(22,163,74,.05)); `CheckCircle2` `size-4 text-success`; label `text-sm
font-medium text-success`: **"Approved: Email"** (`chat.approval.approved` =
`"Approved: {tool}"`). Deny would render `border-destructive/30
bg-destructive/5`, `XCircle`, **"Denied: Email"** — do NOT show it in this
short; it's prose material.

**Resumed stream**: below the resolved row, `mt-3`, plain assistant `text-sm`
text types in: `Sent — the quarterly report summary is on its way to
user@example.com.`

**Cursor & motion:** default arrow cursor sprite as in the 07-07/07-08 shorts;
power2.out, 150–350ms transitions, no bounce, no glow. Card→row swap is a
250ms crossfade in place (height animates smoothly, no layout jump elsewhere).

## Code snippet decision

**Yes — SDK.** Approval is a backend contract: `ExuluTool` is exported from
`@exulu/backend` (`backend/src/index.ts:21`) and its `needsApproval` constructor
field defaults to `true` (`backend/src/exulu/tool.ts:115`) — every custom tool
asks first unless the developer opts out. Real class, real fields, real tool
names (the demo's `email` tool is this exact shape):

Anchor line: "Approval is the default for every custom tool — opt out per tool
in the SDK:"

```ts
import { ExuluTool } from "@exulu/backend";

new ExuluTool({
  id: "email",
  name: "Email",
  description: "Send an email via SMTP.",
  type: "function",
  config: [],
  needsApproval: true, // default — chat asks before running
  execute: async ({ recipient, subject, text }) => ({ result: "sent" }),
});
```

(12 lines. `needsApproval: false` skips the card; pre-approvals arrive as
`approvedTools` ids — `"tool-" + name` — in the chat request body,
`backend/src/exulu/routes.ts:798`.)

## Page prose within this feature's section (beyond the video)

- **Allow for this chat**: approves the pending call and persists the tool id
  (raw part type, e.g. `tool-Email`) under
  `pre-approved-tool-calls-{sessionId}` in localStorage — scoped to this one
  conversation, sent with every subsequent request as `approvedTools`, so the
  card never re-appears for that tool in this session.
- **Revocable, visibly**: the capability sheet grows an **"Approved for this
  chat"** section — "Tools allowed to run without asking again in this
  conversation." — listing each pre-approved tool with a green status dot and a
  per-row **"Revoke"** button (`chat.capabilities.*`, verbatim). No more
  invisible, irrevocable pre-approvals.
- **Deny is honest**: denying collapses the card to a red-tinted
  **"Denied: Email"** row (semantic destructive tokens) and the agent is told
  the call was refused — it answers with what it can do instead.
- **Backend default**: `needsApproval` defaults to true for every custom
  `ExuluTool`; the built-in sandbox `readFile`/`writeFile`/`bash` run
  approval-free (they operate inside the session sandbox), so the cards appear
  exactly where the stakes are: email, integrations, external actions.

## Recorded deviations from the brief

- The brief's canonical example (`tool-bash`) is not approval-gated in shipped
  code: sandbox `bash`/`readFile`/`writeFile` are exposed with
  `needsApproval: false`. The short uses the real `Email` tool (default
  `needsApproval: true`) instead — same card, honest gating.
- The shield icon is muted grey (`text-muted-foreground`), not a warning color
  — keep it quiet; the only loud element is the purple "Allow once" button.
- The input preview for the email tool shows the message `text` body (the
  `getInputSummary` preferred-key order), not the recipient — reproduce that,
  don't invent a "To:" line.
