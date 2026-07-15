# Feature plan — Variable-fill dialog for templated prompts

Part of `releases/2026-07-08-prompt-and-skill-libraries/`.

## Sources of truth

- Frontend commit: `6de39dd` (`feat(prompts): redesign per design/pages/prompts.md (2.9)`)
- UI: `frontend/app/(application)/prompts/components/variable-fill-dialog.tsx`
  (the dialog), `frontend/app/(application)/prompts/components/prompt-detail.tsx`
  (trigger + submit handling + usage recording),
  `frontend/app/(application)/prompts/hooks.ts` (`useIncrementPromptUsageLocal`)
- Shared helpers: `frontend/lib/prompts/extract-variables.ts`
  (regex `/\{\{([a-zA-Z0-9_]+)\}\}/g`, unique + alphabetically sorted),
  `format-variable-name.ts` (snake_case → Title Case),
  `fill-prompt-variables.ts` (global `{{key}}` replacement),
  `validate-variable-name.ts`
- Content chips: `frontend/components/primitives/prompt-content.tsx`
  (`{{variable}}` tokens render as `Badge variant="secondary"` chips — the safe
  replacement for the legacy `dangerouslySetInnerHTML` highlight)
- On-screen copy: `frontend/messages/en.json` → `prompts.variables.*`,
  `prompts.usePrompt`, `prompts.copyToClipboard`, `prompts.copiedReady`,
  `prompts.usedCount`, `prompts.favoritesCount`, `prompts.createdBy`,
  `common.cancel` (verbatim below)
- GraphQL: `INCREMENT_PROMPT_USAGE_INDEX` in
  `frontend/app/(application)/prompts/queries.ts:184`
  (`prompt_libraryUpdateOneById`, plain `usage_count` update)

## What shipped

Prompts in the library can contain `{{variable}}` placeholders (letters, numbers,
underscores — **double braces**, not single). Clicking **"Use prompt"** on a
templated prompt no longer copies the raw template; it opens a **variable-fill
dialog**:

- One labeled `Input` per detected variable (`extractVariables` — unique names,
  alphabetically sorted). Labels are Title-Cased from snake_case
  (`report_name` → "Report Name"); placeholders read "Enter report name…".
- The **"Copy to clipboard"** submit stays **disabled until every field has
  non-whitespace input** (`allFilled`, `variable-fill-dialog.tsx:72`).
- On submit, `fillPromptVariables` swaps every `{{key}}` for the typed value, the
  filled text lands on the clipboard, toast **"Prompt copied to clipboard."**
  fires, and **usage is recorded** — `usage_count` increments via
  `prompt_libraryUpdateOneById` and the meta line's "Used N times" ticks up
  (the legacy "Use prompt" never counted; prompts.md M8 fix).
- Prompts without variables skip the dialog: straight copy + toast + count.

In the prompt document behind the dialog, `{{variable}}` tokens render as muted
secondary chips inside the mono content block (`PromptContent`), so the template's
fill-in-the-blank shape is visible before you click.

## Hook

**One prompt library for the whole org.** (Templates carry the blanks; anyone
fills them in seconds — no hunting for the "right version" of a prompt.)

## Surface area

Pure UI feature: detail-view trigger, fill dialog, clipboard + toast, meta-line
tick. The extraction/validation helpers are frontend-lib only and the usage
mutation is a generic field update — no new developer surface. One short on the
"Use prompt" → fill → copy flow; extraction rules and the editor's variable
hints are page prose within this feature's section.

## Short — `prompt-variables` (1920×1080, 10.0s)

One slice, ONE continuous interaction: **using a templated prompt** — click
"Use prompt", one uninterrupted fill sequence (type → Tab → type), click
"Copy to clipboard". The dialog demands every field before it enables submit
(code reality), so both fields are filled in a single continuous keystroke run;
no other UI is touched.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Prompt Library" (#E2EBFF bg / #1E69DC text), H1 "One prompt library for the **whole org**." (em words #7033FF) | Entrance |
| 0.40–1.85 | Hook holds static (1.45s) | ≥1.4s floor for 7 words |
| 1.85–2.30 | Hook crossfades out; prompt document card fades in — name "Quarterly report summary", meta line, content block with `{{report_name}}` / `{{time_period}}` chips, purple "Use prompt" button | Pivot |
| 2.30–2.85 | Cursor glides to **"Use prompt"** | Approach |
| 2.85–3.05 | Click → button press state (bg-primary/90) | The interaction begins |
| 3.05–3.30 | Dialog scales in (0.95→1 + fade, 250ms, power2.out) over a bg-black/80 overlay dimming the card | Real shadcn open motion |
| 3.30–4.50 | Dialog holds static (1.20s): title "Fill in variables", two empty labeled fields, "Copy to clipboard" disabled (opacity-50) | Read beat — ≥1.0s floor for the short title/labels; the description sentence stays on screen 3.3s total (3.30–6.65) |
| 4.50–5.30 | Types **"Quarterly report"** into the "Report Name" field (focus ring on) | Fill sequence, part 1 |
| 5.30–5.45 | Tab — focus ring jumps to "Time Period" | Continuous sequence |
| 5.45–5.95 | Types **"Q2 2026"**; on the last keystroke "Copy to clipboard" enables (opacity 0.5 → 1) | Fill sequence, part 2 — the enable moment is the code's `allFilled` flipping |
| 5.95–6.45 | Cursor glides to **"Copy to clipboard"** | Approach |
| 6.45–6.65 | Click | Completes the interaction |
| 6.65–6.95 | Dialog zooms out (0.95 + fade, 200ms); toast slides in bottom-right: **"Prompt copied to clipboard."**; meta line ticks "Used 12 times" → **"Used 13 times"** | Result — copy + recorded usage |
| 6.95–7.55 | Resulting state holds completely still (600ms): card + toast | ≥600ms post-action hold |
| 7.55–7.95 | Payoff caption enters (lower third): "Type the specifics. The template does the rest." | Entrance |
| 7.95–10.00 | Payoff holds still (2.05s); last 600ms fully still = loop resting frame (toast may remain — it is static) | ≥1.8s full-sentence floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Prompt document** (`prompt-detail.tsx`; the real page is a list-detail split —
for the short, render only the detail as a centered card ~1120px wide on the
#FDFDFD canvas with the house radial purple wash, matching the 07-07/07-08
shorts' framing). Card padding `p-6`, sections `space-y-6`, border #E7E7EE,
radius ~6px, Inter, tracking -0.025em:

- Header row (`flex sm:flex-row sm:items-start sm:justify-between`):
  - Left: h2 **"Quarterly report summary"** (`text-xl font-semibold
    tracking-tight`) + description **"Turns raw notes into an exec-ready
    summary."** (`text-sm text-muted-foreground` #525252)
  - Right (`flex items-center gap-1`): primary Button **"Use prompt"**
    (#7033FF bg, white text, `h-10 px-4`, radius ~6px, `text-sm font-medium`);
    outline Button with pencil icon + **"Edit"** (border #E7E7EE, bg
    background); ghost icon button with an UNFILLED star (`size-4`,
    #525252 — `FavoriteToggle`, not pressed); ghost icon button "⋯"
    (`OverflowMenu` trigger). Do not open the menu.
- Meta line (`flex flex-wrap items-center gap-x-3 text-xs
  text-muted-foreground`, "·" separators):
  **"Created by user@example.com"** · **"2 days ago"** · [Building2 icon
  `size-3`] **"Shared with teams"** · **"Used 12 times"** · **"5 favorites"**
- Content block: `rounded-lg border bg-muted/30 p-4` (bg ≈ #F5F5F5 at 30% over
  card), copy icon button pinned top-right (`ghost size-10`, Copy icon
  `size-4` #525252). Body is JetBrains Mono `text-sm leading-relaxed
  whitespace-pre-wrap` with `{{…}}` tokens as secondary Badge chips
  (#EDF1F5 bg, radius, `font-mono text-xs`, `mx-0.5 align-baseline`):

  > Summarize the [`{{report_name}}`] for [`{{time_period}}`].
  > Highlight revenue, risks, and next steps in under 300 words.

  ([chips] = badge chips; the braces stay INSIDE the chip text, verbatim
  `{{report_name}}` / `{{time_period}}`.)
- Tags row: two secondary badges **"reporting"**, **"operations"** (#EDF1F5).
  Crop the collapsed version-history section below the fold — keep the card
  clean.

**Variable-fill dialog** (`variable-fill-dialog.tsx` + shadcn dialog):

- Overlay: `fixed inset-0 bg-black/80`, fades in with the dialog.
- Content: centered, `max-w-md` (448px), `bg-background` (#FDFDFD), 1px border
  #E7E7EE, `rounded-lg`, `p-6`, `shadow-lg`, `gap-4` vertical grid; X close
  icon top-right (`size-4`, opacity-70). Open motion: fade + zoom-in from 95%,
  ~200–250ms (shadcn `zoom-in-95` — reproduce with power2.out, no bounce).
- Header: DialogTitle **"Fill in variables"** (`text-lg font-semibold
  leading-none tracking-tight`); DialogDescription **"Complete the following
  fields for "Quarterly report summary"."** (`text-sm text-muted-foreground` —
  the prompt name is interpolated, keep the inner double quotes).
- Body (`space-y-4 py-4`), one group per variable (`space-y-2`), alphabetical
  order (report_name before time_period):
  1. Label **"Report Name"** (`text-sm font-medium leading-none`) + Input
     placeholder **"Enter report name…"**
  2. Label **"Time Period"** + Input placeholder **"Enter time period…"**
  - Input: `h-10 w-full rounded-md border px-3 py-2 text-sm` (border #E7E7EE),
    placeholder #525252; focus = 2px ring #7033FF (`focus-visible:ring-2`,
    ring-offset 2px).
- Footer (right-aligned, gap ~8px): outline Button **"Cancel"**, primary Button
  **"Copy to clipboard"** (#7033FF; DISABLED at `opacity-50` until both fields
  have text — flip to full opacity exactly on the last keystroke of "Q2 2026").
- Typed values: field 1 **"Quarterly report"**, field 2 **"Q2 2026"** (neutral
  placeholders — no fake people or brand names).

**Toast** (sonner, default bottom-right, no position override in
`app/(application)/layout.tsx`): light card — `bg-background` #FDFDFD, 1px
border #E7E7EE, `shadow-lg`, radius ~8px — with a success check icon (#16A34A)
and text **"Prompt copied to clipboard."** (`text-sm`, #000). Slides in from
the bottom ~250ms, power2.out.

**Meta-line tick**: when the toast lands, "Used 12 times" swaps to
**"Used 13 times"** (instant text swap or a ≤150ms crossfade — no odometer
gimmick; this is `recordUsage` → refetch in the real app).

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. Cursor + motion
conventions identical to the 07-07 shorts (power2.out, 150–350ms, no bounce,
no glow; #7033FF is the only loud element).

## Code snippet decision

**None.** The dialog, extraction (`lib/prompts/extract-variables.ts`), fill, and
clipboard write are all frontend; the only network call is
`prompt_libraryUpdateOneById` bumping `usage_count` — a generic field update,
not a developer surface for this feature. Pure UI ⇒ no snippet (earn-the-spot
rule).

## Page prose within this feature's section (beyond the video)

- Template syntax: variables are **double-braced** — `{{customer_name}}` —
  letters, numbers, and underscores only (`extractVariables`). Duplicates
  collapse to one field; fields sort alphabetically. The editor hints this live:
  content hint **"Use {syntax} for dynamic content. Variable names can contain
  letters, numbers, and underscores."**, a **"Detected variables:"** chip row
  while typing, and a validation error **"Invalid variable names: {names}. Use
  letters, numbers, and underscores only."** on save
  (`prompts.editor.*` in `en.json`).
- The submit button is held disabled until every field has non-whitespace input
  — no half-filled templates on the clipboard.
- Every "Use prompt" now counts: the copy path increments `usage_count`
  (previously only chat insertion did), so "Used N times" and the "Most used"
  sort finally reflect real usage.
- The same fill flow exists in the chat composer's prompt selector (its
  `PromptVariableForm` is the pattern this dialog mirrors) — pick a templated
  prompt in chat and you get the identical fields inline, inserting the filled
  text into the message box instead of the clipboard.
- Variables render as safe chips in the document view (`PromptContent`) — the
  legacy regex-highlighted `dangerouslySetInnerHTML` path (a stored-XSS surface
  for shared prompts) is gone.
