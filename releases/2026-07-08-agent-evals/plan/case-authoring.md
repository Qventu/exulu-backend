# Feature plan — Conversation-based test case authoring

Part of `releases/2026-07-08-agent-evals/`.

## Sources of truth

- Frontend code:
  `frontend/app/(application)/evals/cases/components/test-case-modal.tsx`
  (the whole modal; conversation logic in `handleAddMessage`), commit `e609e98`
  ("feat(evals): list pages + detail Tabs restructure + full i18n (5.1 part 1/2)")
- Shared primitives the modal composes (all verified for this plan):
  `frontend/components/message-renderer.tsx` (transcript; placeholder handling,
  per-message actions), `frontend/components/ai-elements/message.tsx`
  (`Message` / `MessageContent` bubble classes),
  `frontend/components/ai-elements/conversation.tsx` (StickToBottom transcript),
  `frontend/components/primitives/file-picker.tsx` (`FilePicker` a.k.a.
  `UppyDashboard` trigger + `FileItem` staged-file card, `getPresignedUrl`)
- On-screen copy: `frontend/messages/en.json` → `evals.cases.modal.*`,
  `evals.common.cancel`, `common.selectFiles` (verbatim below)
- GraphQL: `CREATE_TEST_CASE` / `UPDATE_TEST_CASE` in
  `frontend/queries/queries.ts:2153` / `:2163`
  (`test_casesCreateOne` / `test_casesUpdateOneById`, input type `test_caseInput`)

## What shipped

Test cases are authored as real conversations, not one-line prompts:

- **Test-case modal, two tabs.** *Basic info* — name (required), description,
  required expected output. *Conversation* — script a multi-turn conversation:
  type a user message and press **Enter** to add it (Shift+Enter = new line),
  or click **Add message**.
- **Auto-inserted assistant placeholders.** Every added user turn gets a ghost
  assistant turn appended after it: "💬 Placeholder, generated agent response
  will be added here when the test case is run…". Removing a user message also
  removes its placeholder (`message-renderer.tsx:399`).
- **Real chat rendering.** The transcript is the product's actual
  `MessageRenderer` inside the `Conversation` scroller — user bubbles on the
  right, per-message edit/remove actions, placeholder turns styled with
  `bg-secondary/50 … border-l-2 border-primary/30` and their action row
  suppressed.
- **File attachments.** Up to 10 files per message via the Uppy file picker
  (S3 presigned URLs; `.png .jpg .jpeg .gif .webp .pdf .docx .xlsx .xls .csv
  .pptx .ppt .mp3 .wav .m4a .mp4 .mpeg`). Staged files render as `FileItem`
  cards under the composer with an amber compatibility warning.
- **Persistence.** `CREATE_TEST_CASE` / `UPDATE_TEST_CASE` GraphQL mutations;
  the `inputs` field stores the scripted `UIMessage[]` conversation verbatim.

## Hook

**Test cases that talk like your users.**

(H1 with "talk" as the em word in #7033FF; pill above: "Agent Evals".)

## Surface area

UI feature (dialog with tabs + real chat transcript) backed by a real developer
surface (plain GraphQL mutations on `test_cases` — conversations can be scripted
programmatically). One short on the Conversation tab's add-a-turn moment; the
Basic tab, file limits, and edit/remove affordances are page prose.

## Short — `case-authoring` (1920×1080, 9.5s)

One slice, ONE user action: typing a user turn into the composer and pressing
**Enter** → it appears as a chat bubble with a ghosted assistant placeholder
auto-inserted after it. A PDF is already staged from earlier setup; posting the
message clears the composer (including the staged card) — that is real behavior,
the file travels with the message.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Agent Evals" (#E2EBFF bg / #1E69DC text), H1 "Test cases that **talk** like your users." (em word #7033FF) | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor (7 words) |
| 1.90–2.40 | Hook crossfades out; "Create test case" dialog fades in at **state A** (see below): Conversation tab active, composer in view, caret blinking in the textarea, PDF card staged | Pivot |
| 2.40–2.90 | Everything still (0.5s), caret blinks | Orient the viewer |
| 2.90–4.60 | Typing into the textarea: "Summarize the attached report in three bullets." (~1.7s, natural cadence, caret visible) | The one action — keystroke sequence |
| 4.60–5.10 | Enter: small "↵ Enter" keycap chip pulses by the textarea (in 4.60, out by 5.10); the message posts — user bubble + ghost placeholder append to the transcript, textarea clears, staged PDF card + amber warning collapse away, view settles to **state B** (single 350–450ms power2.out settle) | Action lands |
| 5.10–7.00 | State B holds completely still (1.9s) — the new ghost placeholder sentence is the focal read | ≥1.8s full-sentence floor + ≥600ms post-action hold |
| 7.00–7.40 | Payoff caption enters in the lower canvas band: "Ghost turns become real replies on every run." | Entrance |
| 7.40–9.50 | Payoff holds still (2.1s); last 600ms fully static = loop resting frame | ≥1.8s floor (8 words) + clean loop |

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. Inter,
tracking -0.025em. Motion: power2.out, 150–350ms (settle beat may run 450ms),
no bounce, no glow. #7033FF is the only loud element.

**Dialog shell** (`test-case-modal.tsx`; real `DialogContent` is
`md:max-w-4xl md:max-h-[90dvh] md:rounded-lg md:p-6`): render the dialog
896px wide, height clamped to ~960px, at **0.92 scale**, horizontally centered,
top edge at y≈40 — this leaves a ~150px lower band free for the payoff caption
(no mid-scene reframing). Border 1px #E7E7EE, radius ~8px (rounded-lg), subtle
shadow, bg #FCFCFC.

- Dialog title: **"Create test case"** (text-lg font-semibold)
- Dialog description: **"Create a new test case with conversation inputs and
  expected outputs."** (text-sm, #525252)
- Tabs (full-width `grid grid-cols-2`, h-10, bg #F5F5F5, p-1, rounded-md):
  **"Basic info"** with Info icon (inactive, muted) · **"Conversation"** with
  MessageSquare icon (active: white bg, shadow-sm, text-foreground). Icons
  h-4 w-4, gap-2.
- Footer (bottom, right-aligned, gap-2): outline button **"Cancel"**, primary
  button **"Create test case"** (#7033FF, white text, shadow-sm). Render the
  primary button enabled (Basic info was filled during "earlier setup").

**Conversation tab content** — one Card ("Conversation flow") inside a
scrollable area. Everything between tabs and footer scrolls; header/tabs/footer
do not.

- Card header: CardTitle text-sm with MessageSquare h-4 w-4:
  **"Conversation flow"** + secondary Badge with the message count.
  CardDescription: **"Add user messages in order. The agent will respond
  between each message automatically."**
- Transcript container: `max-h-[350px] overflow-y-auto border rounded-lg
  bg-muted/30` (border #E7E7EE), inner padding px-6 py-4, messages spaced
  space-y-4, sticks to bottom.
- **User bubble** (from `message.tsx`): right-aligned (`ml-auto`,
  max-w-[95%]), content `rounded-lg bg-secondary px-4 py-3 text-sm` — bg
  #EDF1F5, black text. Inside the bubble, below the text (mt-2): the action
  row — two small ghost icon buttons, pencil (Edit) and trash (Remove), 12px
  icons, muted. Always visible on user messages (real behavior: hover-reveal
  only applies to assistant rows).
- **Ghost placeholder turn**: left-aligned block, `bg-secondary/50 rounded-lg
  px-4 py-4 border-l-2 border-primary/30` (2px left border = #7033FF at 30%),
  text-sm, verbatim text: **"💬 Placeholder, generated agent response will be
  added here when the test case is run…"** No action row (suppressed for
  placeholders — real behavior).
- **Composer** (below the transcript, inside the card):
  - Label (text-sm font-semibold): **"Add user message"**
  - Textarea, 2 rows, border #E7E7EE, placeholder: **"Type the user's
    message…"**
  - Button row: left — outline button **"Select files"** with a FilePlus icon
    after the text (h-4 w-4); right (ml-auto) — outline button with Plus icon
    then **"Add message"**. Both enabled.
  - Staged file grid (`grid grid-cols-3 gap-2`), one card in column 1:
    `FileItem` at **opacity-50** (it renders disabled here — real), `rounded-lg
    border p-2`; inside: aspect-square preview area (bg #F5F5F5 at 50%,
    rounded-md) with a red File icon (24px, #E54B50) and centered text-xs
    muted filename **"quarterly-report.pdf"**; below the preview a truncated
    text-xs **"quarterly-report.pdf"**. No hover action buttons visible.
  - Amber warning row: `p-3 rounded-lg`, bg amber-500/10 (#F59E0B @10%),
    border amber-500/20, AlertCircle icon 16px #D97706, text-xs #78350F:
    **"Ensure the selected agent supports the file types you've attached
    (images, documents, audio, etc.)."**
  - Helper line (text-xs, #525252): **"Press Enter to add, Shift+Enter for
    new line. You can attach files to messages."**

**State A (t=1.90–4.60)** — mid-authoring, scrolled to the composer (real:
the card overflows the dialog's scroll area when a file is staged):

- Visible top-to-bottom in the scroll viewport: the tail of the transcript —
  turn-1 user bubble **"What changed in Q2 travel spend?"** (top edge may clip
  at the viewport — fine) and its full ghost placeholder — then the complete
  composer: label, textarea (caret blinking, empty), button row, staged
  quarterly-report.pdf card, amber warning, helper line.
- The "Conversation flow" card header is scrolled out of view in state A.

**The action (t=2.90–5.10)**:

- Text types into the textarea: **"Summarize the attached report in three
  bullets."**
- Enter affordance: a small neutral keycap chip "↵ Enter" fades in beside the
  textarea's bottom-right corner at 4.60, presses once, gone by 5.10.
- On post (all one settle, 350–450ms power2.out): new user bubble (with its
  edit/trash row) + new ghost placeholder fade/slide into the transcript
  (the real container uses `animate-in fade-in duration-500` — mimic);
  textarea clears back to its placeholder; staged PDF card and amber warning
  collapse away (the file now travels inside the just-posted message);
  scroll settles.

**State B (t=5.10 onward)** — with the staged card gone the whole card fits
the viewport: "Conversation flow" header now visible with secondary Badge
**"4"** (real: the count includes placeholder turns — 2 user + 2 ghost),
transcript showing turn-1 bubble + ghost, new bubble "Summarize the attached
report in three bullets." + new ghost placeholder (transcript pinned to
bottom, ~350px tall), then the cleared composer and helper line. Footer
buttons unchanged. Hold completely still.

**Payoff caption (t=7.00)**: single line in the lower canvas band (below the
dialog), Inter, dark text on the canvas (no card): **"Ghost turns become real
replies on every run."** Optionally "real replies" in #7033FF. Enters with a
12px rise + fade, 300ms.

## Code snippet decision

**Yes — GraphQL.** Test cases are plain GraphQL records; the modal's own
mutation can script conversations programmatically (`inputs` is the
`UIMessage[]` transcript). Actual operation from
`frontend/queries/queries.ts:2153` (item selection trimmed from the full
`TEST_CASE_FIELDS` list — all shown fields are real):

Anchor line: "Test cases are plain records — script the conversation via GraphQL:"

```graphql
mutation CreateTestCase($data: test_caseInput!) {
  test_casesCreateOne(input: $data) {
    item {
      id
      name
      inputs
      expected_output
    }
  }
}
```

(10 lines; `$data.inputs` carries the scripted user turns + placeholders,
`expected_output` is the required grading target.)

## Page prose within this feature's section (beyond the video)

- **Basic info tab**: "Name *" (placeholder "e.g., Customer Support — Refund
  Request"), "Description" ("Describe what this test case evaluates…"), and
  required "Expected output *" with help text "This can be an exact expected
  response or a description of what the output should contain." Validation is
  explicit: "Name, at least one input message, and expected output are
  required."
- **Files**: up to 10 per message through the shared file picker ("Select
  files" → upload or pick from the gallery; S3 presigned URLs via
  `getPresignedUrl`). Accepted: images, PDF, Office docs, CSV, audio, video.
  The amber note reminds you the agent under test must support the attached
  media types.
- **Transcript is the real chat renderer**: per-message edit (user turns) and
  remove actions; removing a user message also removes its auto-inserted
  placeholder. Placeholder turns are display-only scaffolding — at run time
  the agent's generated responses take their place.
- **Editing**: the same modal opens pre-filled for existing cases
  ("Edit test case" / "Update test case") and saves through
  `UPDATE_TEST_CASE` (`test_casesUpdateOneById`); eval-set scoping shows
  "Create test case for {setName}" when opened from a set.

## Deviations from the brief (reality wins)

1. The brief asked for the PDF card to stay static through the short. In
   reality the staged `FileItem` card lives in the composer and **clears when
   Enter posts the message** (`handleAddMessage` resets `currentFiles`);
   non-image attachments render **no card inside the transcript bubble** —
   the file travels in the message data. The short shows the card static
   through hook + typing, then collapsing as part of the post settle.
2. The staged card renders at 50% opacity (the modal passes `disabled={true}`
   to `FileItem`) — keep it, do not "fix" it.
3. The "Conversation flow" count badge includes placeholder turns (shows "4"
   after the second user turn) — real behavior, keep verbatim.
4. The ghost placeholder is not literally transparent: its "ghosted" look is
   `bg-secondary/50` + `border-l-2 border-primary/30` + the 💬 sentence, with
   the action row suppressed.
