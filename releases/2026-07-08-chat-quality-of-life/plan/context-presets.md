# Feature plan — Context presets: edit, delete & active-preset state

## Sources of truth

- Spec: `frontend/docs/superpowers/specs/2026-07-07-context-preset-management-design.md` (commit `74322c7`)
- Code (commits `2436749`, `7c8ed66`, `02fae8e`, `1a721ca`, `e7eef26`, `28e17fa`, `104ef6c`, all 07-07):
  - `frontend/components/items-selection-modal.tsx` (preset rows: lines 497–620 — per-row
    pencil/trash, two-step inline confirm strip)
  - `frontend/app/(application)/chat/components/pinned-context-row.tsx` (active-preset chip,
    "modified" flag, Update preset button)
  - `frontend/app/(application)/chat/components/composer.tsx` (active-preset state,
    apply-replaces-pinned-set, mutation wiring)
  - `frontend/app/(application)/chat/components/save-preset-modal.tsx` (edit mode via `existingPreset`)
  - `frontend/lib/presets/check-preset-access.ts` (write-access gate: admin / creator / RBAC write)
- On-screen copy: `frontend/messages/en.json` → `chat.presets.*` (verbatim below)
- GraphQL (pre-existing, now actually wired): `frontend/queries/queries.ts:2871`
  `UpdateContextPreset` → `context_presetsUpdateOneById`; `:2899` `DeleteContextPreset`
  → `context_presetsRemoveOneById`

## What shipped

Context presets got a full lifecycle. In the "Browse contexts and items, or load
a saved preset" modal, each preset row now shows pencil (edit metadata/sharing
via the existing SavePresetModal) and trash icons — write access only. Delete
uses the house two-step **inline** confirm (never modal-on-modal): the trash
swaps in a strip on the row — "This cannot be undone." + Cancel + destructive
"Confirm delete". Applying a preset now **replaces** the pinned set instead of
merging, and keeps the preset's identity: a purple Bookmark chip with the preset
name leads the pinned-context row. Drift detection compares the pinned set to
the preset's items — when they diverge the chip shows an italic *modified* tag
and (with write access) an "Update preset" button appears that saves the current
pinned set back to the preset. × on the chip deselects (clears all pinned
items). Association is ephemeral (this chat only).

## Hook

**Apply a preset, tweak it live, save it back — without leaving the chat.**

## Surface area

UI feature (chat composer footer + shared items-selection modal). Recipe A:
reconstruct the actual screen.

## Reconstruction cues (verbatim from the shipped code)

- **Pinned-context row** (under the textarea, inside the composer card):
  `flex flex-wrap items-center gap-1.5 pt-2`, aria-label "Pinned knowledge for this chat".
  - **Active-preset chip:**
    `inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary`
    — Bookmark icon `size-3.5`, preset name (truncate at 10rem), then when dirty
    an italic `font-normal text-primary/70` word **`modified`**, then an × button
    (`size-3` X, `rounded-full p-0.5 hover:bg-primary/20`). Aria:
    `Active preset: {name}` / `Deselect preset "{name}"`.
  - **Item badges** (existing `SessionItemBadge`, amber — amber stays reserved
    for knowledge chips): `inline-flex items-center gap-1 text-xs bg-amber-50
    text-amber-900 rounded-full px-2.5 py-1`, Database icon `w-3 h-3`,
    capitalized label, small ×.
  - **Update preset button** (only when dirty + write access): outline,
    `h-7 rounded-full text-xs`, Check icon `size-3.5` — label **`Update preset`**;
    pending state: Loader2 spinner + **`Updating...`**.
  - **Save button** (always): ghost, same shape, Plus icon — **`Save context preset`**.
- **Toasts** (sonner, bottom-right): success **`Preset updated`** /
  `"{name}" has been updated successfully.`; delete: **`Preset deleted`** /
  `"{name}" has been deleted.`
- **Modal preset row:** container `relative w-full rounded-lg border`
  (+ `hover:border-primary/50 hover:bg-accent/50`, selected `border-primary bg-accent`);
  content `p-3`: name `font-medium text-sm`, description
  `text-xs text-muted-foreground line-clamp-2`, meta line with Database icon
  `{n} contexts • {n} items`, secondary tag badges. Top-right actions
  (`absolute right-2 top-2`): ghost icon buttons `size-7`, Pencil `size-3.5`
  (`hover:text-foreground`) and Trash2 `size-3.5` (`hover:text-destructive`).
  Aria: `Edit preset "{name}"` / `Delete preset "{name}"`.
- **Inline confirm strip** (replaces the action icons, appended to the row):
  `flex items-center gap-2 border-t px-3 py-2` — left text
  `text-xs text-destructive` **`This cannot be undone.`**, ghost `h-7 text-xs`
  **`Cancel`**, destructive `h-7 text-xs` **`Confirm delete`** (destructive red
  #E54B50; Loader2 while pending).
- Edit modal (SavePresetModal in edit mode): title **`Edit context preset`**,
  description **`Update your context preset configuration.`**
- Modal search placeholder: `Search presets...`; preview pane header `Preview`.

## Short B — `context-preset-update` (1920×1080, 9.5s)

One slice: the dirty active-preset chip → one click on "Update preset" → synced.
(Delete and edit are covered in prose; the apply click is a separate slice we
don't ship — the chip state tells the apply story implicitly.)

| t (s) | What's on screen | Why |
|---|---|---|
| 0.0–0.4 | Hook enters: **"Context presets, upgraded"** | Entrance |
| 0.4–1.6 | Hook holds still (1.2s) | ≥1.0s floor (3 words) |
| 1.6–2.0 | Hook exits; composer card crossfades in (lower half): textarea "Ask me anything...", pinned row below it — purple chip `🔖 Support Docs modified ×`, three amber badges ("Support KB", "Onboarding guide", "Pricing FAQ"), outline "✓ Update preset", ghost "+ Save context preset" | Pivot |
| 2.0–2.7 | UI sits still | Establish (0.7s) |
| 2.7–3.1 | Ambient caption enters above the card: **"The pinned set drifted from the preset"** | Label the state |
| 3.1–4.6 | Caption holds still (1.5s) | ≥1.4s floor (7 words) |
| 4.6–5.0 | Caption exits; cursor glides to "Update preset" | Approach |
| 5.0–5.3 | Click → button swaps to spinner + **"Updating..."** | The action |
| 5.3–5.9 | Resolves: *modified* disappears from the chip; toast slides in bottom-right: **"Preset updated"** / *"Support Docs" has been updated successfully.* | Reactive change |
| 5.9–6.6 | Resolved state holds completely still (0.7s) | Breath after action |
| 6.6–7.0 | Payoff enters (upper area): **"Tweak the pinned set, save it back — one click."** | Entrance |
| 7.0–8.9 | Payoff holds still (1.9s) | ≥1.8s floor (full sentence) |
| 8.9–9.5 | Resting frame — fully still (0.6s) | Clean loop |

Motion: power2.out, no bounce. The chip's *modified* word fades out (200ms), it
does not slide — the chip width change is subtle and eased.

## Prose for the page section (beyond the video)

- Per-row **edit** (pencil → "Edit context preset": name, description, tags,
  sharing/RBAC) and **delete** with the two-step inline confirm — deletes never
  stack a second dialog on top of the modal.
- Apply now replaces the pinned set instead of piling on, and applying a second
  preset swaps cleanly.
- All affordances are permission-gated: admin, creator, or RBAC write.

## Code snippet decision

**No snippet.** Frontend-only feature — the spec's first line: "All required
GraphQL mutations already exist in the backend." `UpdateContextPreset` /
`DeleteContextPreset` (`queries/queries.ts:2871/2899`) pre-existed this release,
so there is no *new* developer-facing surface; showing them would advertise old
API as new. UI affordances get no code per the earn-the-spot rule.
