# Feature plan — Prompt version history (visual diff + restore)

Part of `releases/2026-07-08-prompt-and-skill-libraries/` (Prompt Library section).

## Sources of truth

- Frontend code (all verified 2026-07-08, relative to `frontend/`):
  - `app/(application)/prompts/components/version-history-panel.tsx` — the
    collapsed "Version history" block at the bottom of the prompt detail
    (newest-first sort, "Show 3" preview, per-row Compare/Restore actions)
  - `app/(application)/prompts/components/version-diff-modal.tsx` — the diff
    dialog (`react-diff-viewer-continued`, `DiffMethod.WORDS`, `splitView` at
    md+, pickable compare versions, metadata-change summary)
  - `app/(application)/prompts/components/version-restore-modal.tsx` — restore
    dialog (amber warning, change preview, optional restore note; write-gated)
  - `app/(application)/prompts/components/prompt-detail.tsx:363` — panel
    placement (last section of the detail pane, after content + tags)
  - `lib/prompts/build-version-history.ts` — squash window 5 min
    (`SQUASH_WINDOW_MS`), cap 50 (`HISTORY_CAP`), `buildRestoreHistory`
- On-screen copy: `frontend/messages/en.json` → `prompts.history.*`,
  `prompts.diff.*`, `prompts.restore.*` (verbatim below)
- GraphQL: `UPDATE_PROMPT_INDEX` in `frontend/app/(application)/prompts/queries.ts`
  (`prompt_libraryUpdateOneById`, `$history: JSON`) — history rides an existing
  JSON column, no new API surface

## What shipped

Every prompt now carries a visible edit history:

- **History panel** — the prompt detail ends in a **"Version history"** section:
  a current-version badge (`vN` = max history version + 1), a version count, and
  version rows newest-first. Each row shows a mono `vN` badge, a **"Latest"**
  badge on the newest entry, the edit's change message as the title line
  (fallback **"Untitled change"**), the author, and a relative timestamp. More
  than 3 versions collapses behind **"Show all ({count} more)"**.
- **Visual diff** — each row's **"Compare"** action (Eye icon) opens the
  **"Compare versions"** modal: two version pickers ("Compare from" →
  "Compare to", the live state labeled **"Current"**), a metadata-change
  summary (name/description/tags), and a side-by-side red/green content diff
  with word-level highlights (unified inline below `md`). Opened from a row, it
  compares the current content against that version.
- **Restore** — each row's **"Restore"** action (write access only) opens a
  confirmation modal that snapshots the current state into history first
  ("Current version will be preserved"), shows exactly what will change, takes
  an optional restoration note (default "Restored from vN"), then rolls
  name/description/content/tags back.
- **History hygiene** — consecutive edits by the same user within 5 minutes
  squash into one entry; history is capped at the last 50 versions.

## Hook

**Every prompt keeps its history — see exactly what changed, roll back
anytime.**

## Surface area

Pure UI feature over the existing `history` JSON field on `prompt_library` —
no new API, no new backend behavior. One short on the Compare → diff-modal
moment; restore flow and squash/cap mechanics are page prose within this
feature's section.

## Short — `prompt-versions` (1920×1080, 8.0s)

One slice, ONE user action: click **"Compare"** on a version row → the
side-by-side diff modal opens with red/green line changes.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Prompt Library" (#E2EBFF bg / #1E69DC text), H1 "Every prompt, with a **history**." (em word #7033FF) — no sub-line | Entrance |
| 0.40–1.90 | Hook holds static (1.5s) | ≥1.4s floor for a 5-word phrase |
| 1.90–2.35 | Hook crossfades out; prompt-detail card fades in, scrolled to the "Version history" section (header + 3 version rows, see cues) | Pivot |
| 2.35–2.80 | Card fully still — rows readable (no caption, just UI settle) | Orientation beat |
| 2.80–3.50 | Cursor glides to the "Compare" button on the top row (v3 · Latest) | Approach (cursor affordance) |
| 3.50–3.75 | Click: row hover wash (bg-muted/30 #F5F5F5 @30%), button hover state (#E2EBFF bg, #1E69DC text), press | The one action |
| 3.75–4.10 | Backdrop dims (black @ 80%, 200ms fade); "Compare versions" modal scales in 0.98→1.0 + fade (250–300ms, power2.out) with the split diff already rendered | Result |
| 4.10–4.90 | Modal holds completely still (800ms) | ≥600ms post-action hold |
| 4.90–5.30 | Payoff caption enters as a lower third on the dimmed backdrop below the modal, white #FFFFFF: "See exactly what changed — and roll back anytime." | Entrance |
| 5.30–8.00 | Payoff holds still (2.7s); last 600ms completely still = loop resting frame | ≥1.8s full-sentence floor + clean loop |

## Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash. Inter, tracking
-0.025em; JetBrains Mono for the version badges and diff content. Borders 1px
#E7E7EE, radius ~6px (badges/buttons) / 8px (`rounded-lg` dialog). Motion:
power2.out, 150–350ms, no bounce, no glow. Cursor + framing conventions
identical to the 07-07/07-08 shorts.

### State A — prompt detail card with the Version history section

Render the prompt detail as a centered card ~1120px wide on the canvas
(`p-6` padding, `space-y-6` between blocks). Show a cropped top-of-section for
authenticity, then the history panel as the star. Real detail structure
(`prompt-detail.tsx`):

- Cropped above the fold (partially visible at the card top, cut by the card
  edge): the content block — `rounded-lg border bg-muted/30 p-4` with 2–3 mono
  lines of the prompt text (see sample content below) — and a tags row with
  `secondary` badges **"finance"** **"reporting"** (bg #EDF1F5). This anchors
  the panel as "bottom of a prompt page" without needing the full header.
- **Version history section** (`version-history-panel.tsx`): `border-t`
  #E7E7EE, `pt-6`, `space-y-3`:
  - Header row: History icon (lucide `History`, 16px, #525252) +
    **"Version history"** (`text-sm font-semibold`, #525252) + outline badge
    **"v4"** (mono `text-xs`, 1px #E7E7EE border, text #000) + muted
    **"3 versions"** (`text-xs`, #525252). No "Show all" button — it only
    renders with >3 versions.
  - Version rows (`space-y-2`), each `rounded-md border border-border p-3`,
    two-column: left = title line + meta, right = actions:
    1. Badge **"v3"** (mono, outline) + secondary badge **"Latest"** (bg
       #EDF1F5, `text-xs`) + `text-sm font-medium` **"Added output format
       rules"** — meta line (`text-xs`, #525252): **"user@example.com"** · **"2
       hours ago"**
    2. Badge **"v2"** + **"Tightened tone guidelines"** — **"user@example.com"**
       · **"yesterday"**
    3. Badge **"v1"** + **"Untitled change"** — **"user@example.com"** · **"3
       days ago"**
    - Row actions (right, `gap-1`): ghost button `h-8 text-xs` with Eye icon
      (12px) + **"Compare"**; ghost button with RotateCcw icon + **"Restore"**.
      Ghost hover = bg #E2EBFF, text #1E69DC (real `hover:bg-accent
      hover:text-accent-foreground`).

### State B — the diff modal (opens on click)

Real dialog (`version-diff-modal.tsx` + shadcn dialog): overlay `bg-black/80`
over the whole canvas; content `max-w-5xl` (1024px), centered, bg #FCFCFC, 1px
#E7E7EE border, `rounded-lg`, p-6, `flex flex-col` with `gap-4`, subtle shadow.
Top-to-bottom:

- Title row: GitCompare icon (20px, **#7033FF** — it's `text-primary`) +
  **"Compare versions"** (`text-lg font-semibold`). Description below:
  **"View the differences between prompt versions."** (`text-sm`, #525252).
  Standard dialog X close button top-right.
- Selector row (`border-b` #E7E7EE, `pb-4`, two equal columns with an
  ArrowRight icon, 16px #525252, between them):
  - Left: label **"Compare from"** (`text-xs font-semibold`, #525252) + select
    trigger `h-9` showing mono **"v4"** + secondary badge **"Current"**
  - Right: label **"Compare to"** + select trigger showing mono **"v3"**
- No "Metadata changes" block (only content differs in this scenario — the
  block renders only when name/description/tags changed).
- Content diff: `rounded-md border` container filling the modal body;
  `react-diff-viewer-continued` split view, NO style overrides in code, so use
  the library's default light palette: column titles **"v4"** (left) and
  **"v3"** (right) in a #FAFBFC title bar; line gutters with line numbers;
  removed lines (left) bg #FFEEF0, removed words #FDB8C0; added lines (right)
  bg #E6FFED, added words #ACF2BD; unchanged lines plain white; mono type
  (JetBrains Mono). Word-level highlights are real (`DiffMethod.WORDS`).
- Footer row (`text-xs`, #525252, justify-between): left **"v4 — 2 minutes
  ago"**, right **"v3 — 2 hours ago"**.

Sample diff content (design for one changed word pair, one changed phrase, one
removed line — red AND green both visible):

Left (v4, current):
```
You are a financial analyst.
Summarize the quarterly report in five bullet points.
Highlight revenue, margin, and cash flow.
Flag any risks in a separate section.
```
Right (v3):
```
You are a financial analyst.
Summarize the quarterly report in three bullet points.
Highlight revenue and margin.
```
Line 1 unchanged; line 2 changed ("five" red-word left / "three" green-word
right); line 3 changed; line 4 exists only on the left (full red line, empty
gray spacer on the right). Keep the diff to these 4 lines so it reads at a
glance.

### Faithfulness notes for the builder

- Diff direction is real product behavior: opening Compare from a version row
  passes `compareVersion: null`, so the LEFT side is the current content
  (titled `v4`) and the RIGHT side is the clicked version (`v3`). Do not flip
  it.
- Real quirk, do not reproduce: with no left selection the left Select's
  internal value is `"current"`, which matches no item, so the real trigger
  renders empty until touched. Render it as **"v4  Current"** instead — that
  is what the diff header (`leftTitle`) genuinely says and what the select
  shows after any interaction.
- "Latest" sits on v3 because the badge marks the newest *history snapshot*;
  the live editable state is v4 (max + 1) — shown in the section-header badge.

## Code snippet decision

**None — pure UI.** Version history is stored on the existing `history: JSON`
field of `prompt_library` and is built client-side
(`lib/prompts/build-version-history.ts`); the mutation involved
(`prompt_libraryUpdateOneById` with `$history: JSON`) is a pre-existing generic
update, not a new developer surface. An opaque JSON blob does not earn the
spot.

## Page prose within this feature's section (beyond the video)

- **Restore flow** (shown as a still or prose, not in the short): the
  **"Restore version {version}"** modal warns **"Current version will be
  preserved"** — **"Your current prompt is saved in version history before
  restoring. No history is deleted."** It previews exactly what will be rolled
  back ("The following will be restored:"), takes a **"Restoration note
  (optional)"** (default **"Restored from v{version}"**, hint "This appears in
  the version history to help track changes."), and confirms with **"Restore
  version"**. Success toast: **"Version restored"** — **"Restored to
  v{version}. A new version has been created."** Restore is write-gated: the
  button doesn't render without write access.
- **Change messages**: the prompt editor asks **"What changed? (optional)"**
  when saving; that note becomes the version row's title line in the history.
- **History hygiene**: consecutive edits by the same author within 5 minutes
  squash into a single version (no timeline spam while iterating); history
  keeps the most recent 50 versions.
- **Compare anywhere**: inside the diff modal both sides are pickable — any
  version against any other, including the live **"Current"** state; when
  name, description or tags differ, a **"Metadata changes"** summary lists
  them above the content diff; identical content shows **"No content changes
  between these versions."**
