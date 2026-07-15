# Feature plan — Interactive question cards + live todo lists

## Sources of truth

- Backend tools: `backend/src/templates/tools/question/question-ask.ts`
  (`question_ask`, "Use this tool to ask a question to the user with multiple
  choice answers", `needsApproval: false`) and
  `backend/src/templates/tools/todo/todo.ts` (`todo_write` / `todo_read`)
- Frontend rendering: `frontend/components/message-renderer.tsx` —
  `QuestionAsk` component (lines 1754–1873), `tool-question_ask` part branch
  (902–950), answered-pill render of `[answer:…]` user text (724–749),
  `tool-todo_write` branch (883–900), latest-todo filtering (440–456)
- Todo list: `frontend/components/ai-elements/todo-list.tsx` (`TodoList`,
  `statusConfig`, progress bar 128–142)
- Dispatch: `frontend/app/(application)/chat/hooks.ts:539–548`
  (`sendQuestionAnswer` — sends `"[answer:" + answerText + "]"`, no files),
  wired in `frontend/app/(application)/chat/components/message-column.tsx:254–258`
- Chat canvas: `message-column.tsx` (`ConversationContent` uses `CHAT_COLUMN`),
  `chat-shell.tsx:29` (`CHAT_COLUMN = "mx-auto w-full max-w-3xl px-4"`),
  `components/ai-elements/message.tsx` (bubble classes)
- Frontend commits: `99e4e6e`/`a2fa2ea` (chat redesign wiring, item 47),
  `900bf7d` (streaming perf pass around MessageItem memoization),
  `c93089d` (todo-list touch-up)
- On-screen copy: card + todo strings are HARDCODED in the components (not in
  `en.json`); the only en.json string in frame is
  `chat.composer.placeholder` → **"Ask me anything..."** (verbatim below)

## What shipped

Two trust surfaces inside the chat transcript:

- **Question cards** (`question_ask`). When the agent needs a decision, the tool
  part renders an interactive card: a header with a ListChecks icon and the
  question, a stack of checkbox options (true multi-select via a `Set`), and a
  full-width purple **"Confirm selection"** button (disabled until at least one
  option is ticked). Confirming dispatches the chosen option texts back into the
  conversation as a structured user message — `[answer:Regional breakdown, Risk
  analysis]` — which the renderer displays as check-marked purple pills inside a
  normal right-aligned user bubble. Once that answer message exists, the
  interactive card renders nothing (message-renderer.tsx:927–929): the pills ARE
  the persistent record, and they survive page refresh. The card also disables
  itself while a response is streaming, so you can't double-answer.
- **Live todo lists** (`todo_write`). The agent's task list renders as a compact
  checklist: green check + strikethrough for completed, blue spinner + medium
  weight for the item in progress, muted circle for pending, plus a thin purple
  progress bar with an `n/m` counter. The renderer keeps only the LATEST
  `todo_write` message (440–456), so the list reads as one live surface that
  updates in place as the agent works.

## Hook

**Agents that ask before they act.**

(H1 with "ask" as the em word in #7033FF; kept from the brief — benefit-led and
6 words, comfortably inside the read floor.)

## Surface area

Pure chat-transcript UI (route `app/(application)/chat/[agent]/[session]`),
backed by two built-in agent tools. Recipe A: reconstruct the actual chat
column. One short on the question card (answer flow); the todo list is ambient
dressing in the same frame and gets its mechanics in page prose.

## Short — `question-cards` (1920×1080, 9.5s)

ONE user action: answering the agent's question — tick two options, click
**"Confirm selection"**. The card is replaced by the answered pills and the todo
list above flips one item to done (ambient continuation, not a user action).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters (fade + 12px rise): pill "Human in the loop" (#E2EBFF bg / #1E69DC text), H1 "Agents that **ask** before they act." (em word #7033FF) | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor (6 words) |
| 1.90–2.40 | Hook exits; chat canvas crossfades in: assistant message with intro line + todo list (3 items, 1/3, bar ~33%) + question card (4 checkbox options, disabled "Confirm selection"); composer card static at bottom | Pivot |
| 2.40–2.90 | Scene sits still, establish (0.5s) | Orientation |
| 2.90–3.50 | Cursor glides to option "Regional breakdown" | Approach |
| 3.50–3.75 | Click → checkbox fills #7033FF with white check (~180ms), row restyles to `border-primary/50 bg-primary/5` | Tick 1 |
| 3.75–4.35 | Cursor moves down to "Risk analysis" | Approach |
| 4.35–4.60 | Click → second tick; "Confirm selection" enables (opacity 0.5 → 1, full #7033FF) | Tick 2, button arms |
| 4.60–5.20 | Cursor glides to the "Confirm selection" button | Approach |
| 5.20–5.45 | Click → button press affordance (~120ms) | THE action lands |
| 5.45–5.75 | Question card collapses (height + fade out, power2.out ~300ms) | Real behavior: answered cards leave the transcript |
| 5.75–6.10 | Right-aligned user bubble (#EDF1F5, rounded-lg) slides in (fade + 12px rise) containing two pills: "✓ Regional breakdown" "✓ Risk analysis" (bg-primary/10, text #7033FF) | The persistent answered state |
| 6.10–6.80 | New state holds completely still (0.7s) | ≥600ms post-action hold |
| 6.80–7.20 | Payoff caption enters (lower third): **"Answers flow straight back — the agent keeps working."** Simultaneously, ambient: todo "Confirm report sections" flips to done (green check + strikethrough), "Draft the executive summary" becomes in-progress (blue, medium weight), bar animates 33%→67%, counter 1/3→2/3 | Payoff entrance + continuation story |
| 7.20–9.50 | Payoff holds still (2.3s); last 600ms fully still = loop resting frame (freeze the in-progress spinner — see deviations) | ≥1.8s sentence floor + clean loop |

Motion: power2.out everywhere, 150–350ms, no bounce, no glow. Cursor: house
cursor affordance identical to the 07-07/07-08 shorts.

### Reconstruction cues (build the real UI, verbatim)

**Framing.** Canvas 1920×1080, bg #FDFDFD + house radial purple wash. The chat
surface renders as a centered card ~1120px wide (border #E7E7EE, radius ~6px,
subtle shadow) — matches the 07-07/07-08 shorts. Inside it, the real chat
column: `mx-auto w-full max-w-3xl px-4` (768px), messages stacked with `gap-6`.
Inter, tracking -0.025em throughout.

**Assistant message** (no bubble — assistant text sits directly on the canvas,
`text-sm text-foreground`; parts stack with `gap-2` inside `MessageContent`,
message block `max-w-[95%]`):

1. Intro text line: `Here's my plan for the quarterly report:`
   (neutral placeholder scenario — no fake brands)
2. **TodoList** (`todo-list.tsx`, wrapper `my-2 space-y-1`, rows
   `flex items-start gap-2 py-0.5`, icons `size-3.5`, content `text-sm`):
   - `Gather revenue figures` — completed: CheckCircle2 green (text-green-500
     ≈ #22C55E), text `text-muted-foreground line-through`
   - `Confirm report sections` — in progress: Loader2 blue (text-blue-500
     ≈ #3B82F6, spinning), text `font-medium`
   - `Draft the executive summary` — pending: Circle `text-muted-foreground`
     (#525252)
   - Progress row: `flex items-center gap-2 pt-1 text-muted-foreground text-xs`
     — track `h-1 flex-1 rounded-full` #EDF1F5 (bg-secondary), fill `bg-primary`
     #7033FF at 33%, counter text **"1/3"**. (All priorities medium so no red
     "(!)" markers appear despite `showPriority` being true.)
3. **Question card** (`my-3 border rounded-lg overflow-hidden bg-card`; border
   #E7E7EE, bg #FCFCFC):
   - Header `p-4 border-b bg-muted/30`: icon chip `p-2 rounded-md bg-primary/10`
     containing ListChecks `h-4 w-4 text-primary` (#7033FF); question
     `font-medium text-sm`: `Which sections should the quarterly report include?`
   - Options `p-3 flex flex-col gap-2`; each is a label
     `flex items-center gap-3 px-3 py-2.5 rounded-md border cursor-pointer`
     (unselected: `border-border`; selected: `border-primary/50 bg-primary/5`)
     with a shadcn Checkbox `h-4 w-4 rounded-sm border border-primary`
     (checked: `bg-primary` fill, white Check) + option text `text-sm`:
     1. `Executive summary`
     2. `Regional breakdown`  ← ticked
     3. `Risk analysis`  ← ticked
     4. `Appendix with raw tables`
   - Footer `px-3 pb-3`: full-width Button size sm (`h-9 rounded-md px-3
     w-full`), bg #7033FF, white text — **"Confirm selection"** (verbatim,
     hardcoded at message-renderer.tsx:1868). Disabled (opacity-50) until a
     selection exists.

**Answered state (after Confirm):** a user message — right-aligned block
(`ml-auto`), bubble `rounded-lg bg-secondary px-4 py-3` (#EDF1F5), containing
`flex flex-wrap gap-1.5 py-1` of pills, each
`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm bg-primary/10
text-primary font-medium` with a CheckIcon `h-3 w-3`:
`✓ Regional breakdown` and `✓ Risk analysis`. (This is the real render of the
dispatched text `[answer:Regional breakdown, Risk analysis]` —
message-renderer.tsx:724–749. Option texts must not contain commas or mid-word
capitals; the renderer splits on `,` and runs `camelCaseToLabel`.)

**Composer (ambient, static, bottom of the card):** form
`relative rounded-lg border bg-card p-2`, row `flex items-end gap-1.5`:
＋ attach ghost icon button, textarea placeholder **"Ask me anything..."**
(`text-sm placeholder:text-muted-foreground`), mic ghost icon button, purple
send button (`size-9`, ArrowUp, bg #7033FF, white glyph). Never interacted with
in this short.

## Code snippet decision

**No snippet.** `question_ask` and `todo_write` are built-in agent tools, not
developer surfaces: the answer round-trip is a plain chat message
(`"[answer:…]"`) over the existing agent run endpoint. Verified: no
question/todo GraphQL operation in `frontend/queries/queries.ts`, no dedicated
REST route in `backend/src/exulu/routes.ts`, no SDK method in
`backend/src/index.ts`. The tool implementations live in
`backend/src/templates/tools/` and are enabled per-agent like any other tool —
page prose, not a snippet.

## Page prose within this feature's section (beyond the video)

- Multi-select is real: options toggle a `Set`; Confirm sends every ticked
  option, joined — and the transcript keeps the answer as check-marked pills in
  a normal user message, so the decision survives refresh and stays part of the
  conversation the agent can see.
- The card protects itself: **"Confirm selection"** stays disabled with nothing
  ticked, and the whole card disables while the agent is streaming — no
  double-answers, no dead clicks.
- The answer is just a message (`[answer:…]` text, dispatched with the session's
  approved/disabled tool state like any send) — model-agnostic, no special
  protocol, works with any agent that has the tool enabled.
- Todo lists update in place: the renderer keeps only the agent's latest
  `todo_write`, so you watch one list change state — spinner on the active item,
  strikethrough as items complete, a purple progress bar counting `n/m`.
  High-priority items get a red "(!)" marker.
- Both tools are built-ins (`question_ask` needs no approval); toggle them
  per-agent exactly like any other tool.

## Recorded deviations from the brief

1. **"Collapses to a compact answered chip" is transient, not the persistent
   state.** `QuestionAsk` does have a collapsed answered view (icon + question
   in muted xs + small pills, message-renderer.tsx:1795–1828), but it only
   renders between local submit and the answer message landing in the
   transcript; once the `[answer:…]` user message exists, the tool part renders
   NOTHING (927–929) and the check-marked pills in the user bubble are the
   persistent record. The short therefore shows card-out → pills-bubble-in,
   which is what a user actually sees settle.
2. Card/todo strings are hardcoded in components; `en.json` only contributes
   the composer placeholder.
3. The real in-progress spinner (`Loader2 animate-spin`) rotates continuously.
   Animate it during the active beats, but FREEZE it for the final 600ms
   resting frame so the loop frame is completely still (house rule wins).
4. The real app also shows a streaming shimmer placeholder ("Thinking...")
   after an answer dispatch. Deliberately omitted: it animates continuously and
   would fight the resting frame; the todo flip carries the "agent keeps
   working" story instead.
