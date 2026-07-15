# Feature plan — Eval run configuration wizard

Part of `releases/2026-07-08-agent-evals/`.

## Sources of truth

- UI: `frontend/app/(application)/evals/[id]/runs/components/create-eval-run-modal.tsx`
  (the whole dialog; header comment documents the three-section Phase 5.1 redesign)
- Entry points: `frontend/app/(application)/evals/[id]/runs/eval-runs.tsx` (create),
  `.../components/eval-runs-table.tsx` — `handleEditRun` (edit) and `handleCopyRun`
  (copy = same modal, `{ ...run, id: "", name: `${run.name} (Copy)` }`)
- On-screen copy: `frontend/messages/en.json` → `evals.runs.runConfig.*`
  (verbatim below)
- GraphQL: `CREATE_EVAL_RUN` (`eval_runsCreateOne`) and `UPDATE_EVAL_RUN`
  (`eval_runsUpdateOneById`) in `frontend/queries/queries.ts` (~L2292 / ~L2404)
- Built-in eval function: `backend/src/templates/evals/index.ts` —
  `LLM as Judge` (`llm_as_judge`), description "Evaluate the output of the LLM as
  a judge.", one config entry `name: "prompt"` with the long judge-prompt
  description (verbatim below)

## What shipped

One tall dialog (`max-w-4xl`, `h-[90vh]`, internal ScrollArea) configures an eval
run in three sections:

1. **Essentials** — run name, agent dropdown, test-case multi-select with a
   per-case "`N` msgs" badge, a live "`x` of `y`" counter, and a Select all /
   Deselect all toggle.
2. **Eval functions** — multi-select with the same counter + select-all pattern.
   Checking a function that declares config entries reveals an inline
   **Configuration** block inside its row: one labelled textarea per config entry
   (for the built-in LLM-as-Judge, the judge `prompt`), with the entry's
   description as both placeholder and helper text.
3. **Advanced** — a Collapsible, closed by default, summarized inline on its
   trigger: **"Advanced — Average · pass ≥ 70 · 300s"** (scoring method
   Average/Median/Sum, pass threshold 0–100, timeout in seconds).

The footer submit stays disabled until name + agent + ≥1 test case + ≥1 eval
function are set. The same modal powers create ("New run config"), edit
("Edit run config") and copy-run (copy pre-fills the create form with
"`name` (Copy)"). Mutations: `CREATE_EVAL_RUN` / `UPDATE_EVAL_RUN`.

## Hook

**Test your agents like you test your code.**

## Surface area

Pure UI wizard on top of generated CRUD mutations — but the run config itself is
a real API object developers can create programmatically, so the GraphQL mutation
earns a snippet. One short on the eval-function check → config reveal; the
create/edit/copy reuse and the Advanced fields are page prose.

## Short — `eval-run-wizard` (1920×1080, 9.0s)

One slice, ONE user action: clicking the **LLM as Judge** checkbox in the Eval
functions list. The check reveals the per-function Configuration block (judge
`prompt` textarea) inside the row, ticks the counter 0 → 1, and enables the
footer submit — all consequences of the single click. The collapsed Advanced
summary row stays visible below throughout.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Agent Evals" (#E2EBFF bg, #1E69DC text), H1 "Test your agents **like you test your code**." (em phrase #7033FF) | Entrance |
| 0.40–2.30 | Hook holds static (1.9s) | ≥1.8s floor for 8-word sentence |
| 2.30–2.75 | Hook crossfades out; run-config dialog fades in, scrolled to the Eval functions section (state A below): all three function rows unchecked, counter "0 of 3", Advanced summary row visible below, footer button disabled | Pivot |
| 2.75–3.35 | Cursor glides to the "LLM as Judge" checkbox | Approach |
| 3.35–3.60 | Click → checkbox fills #7033FF with white check | The one action |
| 3.60–3.95 | Configuration block expands inside the row (~300ms height reveal, power2.out): "Configuration" heading, "prompt" label, empty textarea showing the judge-prompt placeholder, helper text below. Simultaneously: counter ticks "0 of 3" → "1 of 3"; Separator + Advanced row slide down to make room; footer "Create run config" transitions disabled (50% opacity) → enabled full #7033FF | Consequences of the single click, real reflow |
| 3.95–5.90 | Hold the new state completely still (1.95s) — viewer scans the judge-prompt textarea and the Advanced summary row below | ≥600ms post-action hold, generous read time |
| 5.90–6.30 | Payoff caption enters (lower third, on-canvas below the dialog is too tight — overlay bottom-center over the canvas margin): "Check a function, tune its judge prompt inline." | Entrance |
| 6.30–9.00 | Payoff holds still (2.7s); last 600ms completely still = loop resting frame | ≥1.8s floor for 8-word caption + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Canvas:** 1920×1080, bg #FDFDFD + house radial purple wash (identical to the
07-07/07-08 shorts). Inter everywhere, tracking -0.025em. No dark modal overlay —
render the dialog as a centered card, house framing.

**Dialog card** (`DialogContent` is `flex h-[90vh] max-w-4xl flex-col`): 896px
wide (max-w-4xl — NOT the default 1120px; this dialog has a real fixed width),
~940px tall, centered. bg #FCFCFC, 1px border #E7E7EE, radius ~6px, subtle shadow
(0 2px 3px rgba(0,0,0,0.16)). Padding 24px. Shadcn close "X" (16px, 70% opacity)
top-right.

- **Header** (pinned above the scroll area): title **"New run config"**
  (text-lg, font-semibold).
- **Scrollable body**, scrolled so the following is visible top-to-bottom
  (state A). Content sits in `space-y-6`:
  1. **Tail of the Essentials test-case list** (cropped at the top edge of the
     scroll viewport): the bottom one-and-a-half rows of a bordered card
     (1px #E7E7EE, radius ~8px `rounded-lg`, bg #FCFCFC, 12px padding). Each row:
     checked checkbox (16px, #7033FF fill, white check, radius 4px) + name
     text-sm font-medium + secondary badge (bg #EDF1F5, 10px text, radius full)
     + description text-xs #525252. Placeholder rows (neutral, no brands):
     - "Quarterly report summary" — badge **"4 msgs"** — "Summarise an uploaded quarterly report."
     - "Refund policy question" — badge **"2 msgs"** — "Answer a policy question from the knowledge base."
  2. **Separator** (1px #E7E7EE, full width).
  3. **Eval functions header row** (flex, space-between): left — label
     **"Eval functions *"** (text-sm font-semibold) with counter below
     **"0 of 3"** (text-xs #525252); right — outline button **"Select all"**
     (size sm, h-9 px-3, 1px #E7E7EE border, radius ~6px, text-sm).
  4. **Eval functions card** (1px #E7E7EE, radius ~8px, bg #FCFCFC, 12px
     padding, rows `space-y-2`). Each row: 12px padding, radius ~6px,
     transparent border (hover state not needed), unchecked checkbox (16px,
     1px #7033FF border per shadcn `border-primary`, empty) + text block:
     - Row 1 (the star): **"LLM as Judge"** (text-sm font-medium) —
       **"Evaluate the output of the LLM as a judge."** (text-xs #525252)
     - Row 2: "Exact match" — "Compare the reply against the expected output."
     - Row 3: "Response length" — "Score how concise the reply is."
     (Rows 2–3 are neutral placeholders for user-registered eval functions;
     only LLM as Judge ships built-in.)
  5. **Separator**.
  6. **Advanced collapsed trigger**: full-width row, 12px padding, 1px #E7E7EE
     border, radius ~6px; left text (text-sm font-medium):
     **"Advanced — Average · pass ≥ 70 · 300s"** (em dash, middle dots, real
     "≥" glyph — assembled from `advanced` = "Advanced — {summary}" and
     `advancedSummary` = "{method} · pass ≥ {threshold} · {timeout}s" with
     method "Average", threshold 70, timeout 300); right: chevron-down icon
     16px #525252.
- **Footer** (pinned): Separator, 16px vertical margin, then full-width button
  **"Create run config"** (h-11, bg #7033FF, white text, radius ~6px).
  State A: disabled — 50% opacity. After the check: full opacity.

**State B — the reveal** (inside the "LLM as Judge" row, below its description;
`mt-3 border-t pt-3`, inner spacing 12px; top border 1px #E7E7EE):

- Heading **"Configuration"** (text-xs font-medium, #525252)
- Label **"prompt"** (text-xs font-medium, near-black) — yes, lowercase field
  name; this IS the judge-instructions field
- Textarea: min-height 80px, full row width, 1px #E7E7EE border, radius ~6px,
  bg #FCFCFC, text-xs; EMPTY, showing the placeholder (verbatim, wraps ~3–4
  lines, placeholder gray ~#9CA3AF):
  **"The prompt to send to the LLM as a judge, make sure to instruct the LLM to
  output a numerical score between 0 and 100. Add {actual_output} to the prompt
  to replace with the last message content, and {expected_output} to replace
  with the expected output."**
- Helper text below the textarea: the SAME string again, text-xs #525252,
  relaxed leading. The duplication (placeholder + helper) is real product
  behavior — keep both.

The expansion pushes rows 2–3, the separator and the Advanced row downward
(~210px); the pinned footer does not move. Everything must still fit above the
footer after expansion — pre-compose state A with the content ending well short
of the viewport bottom (the test-case tail crop at the top is the slack
variable). Note: in the real app the block appears instantly (conditional
render); the short animates it as a 300ms power2.out height+fade reveal per
house motion rules. Cursor: standard house cursor with click affordance
(scale-down tick on press). No bounce, no glow; #7033FF is the only loud element.

**Verbatim string inventory** (`evals.runs.runConfig.*` unless noted):
"New run config" (createTitle) · "Eval functions *" (evalFunctionsLabel) ·
"Select all" (selectAll) · "Advanced — Average · pass ≥ 70 · 300s"
(advanced + advancedSummary + scoringMethod.average) · "Create run config"
(submit.create) · "Configuration" (hardcoded in the modal) · "prompt" +
its long description (backend `src/templates/evals/index.ts` config entry) ·
"N msgs" badges (hardcoded template `{count} msgs`) · "0 of 3" / "1 of 3"
(hardcoded template `{selected} of {total}`) · "LLM as Judge" /
"Evaluate the output of the LLM as a judge." (backend eval template).

## Code snippet decision

**Yes — GraphQL.** The run config is a plain `eval_runs` object; the wizard's own
mutation is generated CRUD that developers can call directly. Actual operation
from `frontend/queries/queries.ts` (`CREATE_EVAL_RUN`), item selection trimmed to
the fields the wizard sets:

Anchor line: "A run config is just data — script it via GraphQL:"

```graphql
mutation CreateEvalRun($data: eval_runInput!) {
  eval_runsCreateOne(input: $data) {
    item {
      id
      name
      agent_id
      eval_functions
      scoring_method
      pass_threshold
    }
  }
}
```

(12 lines, real operation and field names; `test_case_ids` and
`timeout_in_seconds` also live on `eval_runInput`.)

## Page prose within this feature's section (beyond the video)

- **One modal, three jobs.** Create ("New run config"), edit ("Edit run config" /
  "Update run config" submit), and copy — the table's Copy action re-opens the
  same modal in create mode pre-filled as "`name` (Copy)" with a cleared id
  (`handleCopyRun`, `eval-runs-table.tsx`).
- **Essentials.** Name, agent dropdown, and a test-case multi-select where every
  case shows a "`N` msgs" badge (its scripted conversation length), with a live
  "`x` of `y`" counter and one-click Select all / Deselect all.
- **Per-function config.** Eval functions declare their own config entries;
  checking a function reveals its entries inline as labelled textareas. The
  built-in LLM-as-Judge exposes `prompt` — judge instructions with
  `{actual_output}` / `{expected_output}` template slots, scored 0–100.
- **Advanced stays out of the way.** Scoring method (Average / Median / Sum),
  pass threshold (0–100) and timeout (seconds) live in a collapsed section whose
  trigger summarizes them at a glance: "Advanced — Average · pass ≥ 70 · 300s".
  Sensible defaults (average / 70 / 300s) mean most runs never open it.
- **Guardrails.** Submit is disabled until name, agent, at least one test case
  and at least one eval function are set; per-field toasts back this up
  ("Select at least one eval function.").
