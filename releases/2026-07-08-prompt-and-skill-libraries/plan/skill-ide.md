# Feature plan — Skill editor mini-IDE

Part of `releases/2026-07-08-prompt-and-skill-libraries/`.

## Sources of truth

- Frontend code (all under `frontend/app/(application)/skills/[skillId]/components/`):
  `skill-editor-view.tsx` (full-bleed shell, dialog host, dirty-switch guard),
  `skill-editor.tsx` (editor pane: path header, Unsaved badge, Save, Cmd/Ctrl+S
  window binding, `.md` → MarkdownEditor / other → mono textarea),
  `editor-top-bar.tsx` (h-12 bar: sidebar toggle · back · Sparkles + name + vN ·
  Refresh · History · Save version · ⋯),
  `file-sidebar.tsx` (w-60 rail: FILES header + New file/folder, tree, footer
  file count + vN badge), `file-tree.tsx` (recursive tree, monochrome icons,
  selection = `bg-primary/10 text-primary`)
- Markdown primitive: `frontend/components/primitives/markdown-editor.tsx`
  (@uiw/react-md-editor; the skill editor passes `preview="edit"` when writable —
  source-editing pane with toolbar, NOT a split live preview)
- On-screen copy: `frontend/messages/en.json` → `skills.editor.*` (verbatim below)
- REST surface: `backend/src/exulu/routes.ts` → `POST /skills/:skillId/sign`
  (~line 3583; body `{ filePath, contentType }`, returns `{ key, url, method:
  "PUT" }`) — the exact call `handleSave` makes on Cmd+S, followed by a
  presigned PUT (`frontend/lib/api/skills.ts` → `skillsApi.sign` +
  `skillsApi.uploadContent`)
- Toast: sonner `Toaster` mounted in `app/(application)/layout.tsx` with no
  `position` prop → default bottom-right; success toast copy
  `skills.editor.toasts.fileSaved` = **"File saved"**

## What shipped

`/skills/[skillId]` is now a full-bleed mini-IDE, not a form page:

- **Collapsible file sidebar** (inline `w-60` rail, left Sheet on mobile) with a
  real file tree: create file/folder (header buttons, right-click, per-row kebab),
  rename, delete — folder deletes warn about cascading contents.
- **Editor pane**: `.md` files open in a markdown editor
  (@uiw/react-md-editor, edit mode); every other file opens in a plain mono
  textarea. Header shows the mono file path, an **"Unsaved"** badge while dirty,
  and a **Save** button (disabled until dirty). **Cmd/Ctrl+S saves** — a real
  window-level binding that no-ops when the file is clean or read-only.
- **Version snapshots**: "Save version" (top bar, purple) snapshots the current
  state; History sheet + diff modal compare versions.
- **Guard rails**: switching files with unsaved edits raises "Discard unsaved
  changes?"; navigating away is intercepted by the shared unsaved-changes guard;
  without write access the whole surface degrades to read-only with a
  **"Read-only"** badge in the file header.

## Hook

**Build agent skills like a code project — files, versions and Cmd+S, right in
the browser.**

(H1 in the short trims this to "Build agent skills like a **code project**.")

## Surface area

UI feature (the IDE surface) sitting on a real REST surface: the same presigned
`sign → PUT` flow the Save button uses is a scriptable API. One short on the
edit → Cmd+S save moment; file ops, versions, diff and read-only mode are page
prose within this feature's section.

## Short — `skill-ide` (1920×1080, 9.5s)

One slice, ONE user action: **saving an edit with Cmd+S** (a short typed edit
dirties SKILL.md and surfaces the "Unsaved" badge; the ⌘S chord is the action;
the badge clearing + "File saved" toast is the result).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Skill Library" (#E2EBFF/#1E69DC), H1 "Build agent skills like a **code project**." (em words #7033FF) — no sub-line | Entrance |
| 0.40–1.95 | Hook holds static (1.55s) | ≥1.4s floor for 7 words |
| 1.95–2.40 | Hook crossfades out; skill-editor card fades in: top bar + file sidebar + SKILL.md open in the editor, no "Unsaved" badge, Save button disabled (50% opacity) | Pivot |
| 2.40–3.00 | Card holds still; text caret blinks at the end of the last "Steps" line in SKILL.md | Orient (600ms) |
| 3.00–4.20 | Typing: a new list line **"4. Cite sources."** types in (~14 cps). At the FIRST keystroke the **"Unsaved"** badge fades/scales in next to the `SKILL.md` path (150ms) and the Save button enables (full #7033FF) | Dirty state appears live, exactly as in product |
| 4.20–4.80 | Hold the dirty state still (600ms) — badge visible, Save enabled | Breath before the action |
| 4.80–5.35 | Keycap chip "⌘ S" enters bottom-center (two keycaps, white, 1px #E7E7EE, radius 6, subtle shadow); at ~5.15 both keys press (scale 0.94 + #EDF1F5 fill, 120ms down/up) | The one action — keystroke affordance (analog of the cursor for clicks) |
| 5.35–5.75 | Save lands: "Unsaved" badge fades out (150ms), Save button returns to disabled 50%, toast slides in bottom-right: green check + **"File saved"** (white card, 1px #E7E7EE, shadow) | Result of the action |
| 5.75–6.60 | Result holds completely still (850ms); keycap chip fades out at 6.30 | ≥600ms post-action hold |
| 6.60–7.00 | Payoff caption enters (lower third): "Files, versions, Cmd+S — in the browser." | Entrance |
| 7.00–9.50 | Payoff holds still (2.5s); toast may stay (sonner default 4s); last 600ms completely still = loop resting frame | ≥1.4s floor for 7 words + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Framing**: the real route is a full-bleed work surface (`PageShell
variant="full-bleed"`). For the short, render it as a centered app card
~1120×640px (border 1px #E7E7EE, radius 8px, subtle shadow) on the #FDFDFD
canvas with the house radial purple wash — matching the 07-07/07-08 shorts.
Inter, tracking -0.025em; file path and file contents in JetBrains Mono.

**Top bar** (`editor-top-bar.tsx` — h-12 (48px), border-b #E7E7EE, px-12,
items gap-8, bg #FDFDFD), left → right:

- Ghost icon button 32px: PanelLeftClose icon 16px (#525252) · vertical
  separator (1px #E7E7EE, h-20px) · ghost ArrowLeft 16px · separator
- Identity: Sparkles icon 16px **#7033FF** + skill name **"Quarterly report"**
  (14px, font-semibold, near-black) + secondary badge **"v2"** (bg #EDF1F5,
  JetBrains Mono 12px, radius 6px, px ~10px)
- Spacer, then right cluster: ghost RefreshCw icon 14px · outline button
  **"History"** (h-32px, 1px #E7E7EE, History icon 14px, 13px text) · primary
  button **"Save version"** (bg #7033FF, white, GitBranch icon 14px) · ghost
  MoreHorizontal icon (⋯)

**File sidebar** (`file-sidebar.tsx` + `file-tree.tsx` — w-60 = 240px,
border-r #E7E7EE, full card height below the top bar):

- Header (border-b, faint gray tint ~#F9F9F9, px-12 py-8): left label
  **"Files"** rendered UPPERCASE via CSS (`text-xs font-semibold uppercase
  tracking-wider`, #525252) — on screen it reads **FILES**; right: two 28px
  ghost icon buttons, FilePlus + FolderPlus icons 14px #525252
- Tree (12px text, rows ~28px tall, icons 14px):
  1. **SKILL.md** — SELECTED: row bg rgba(112,51,255,0.10) ≈ #F1EBFF, File icon
     + text #7033FF, font-semibold, radius 4px, text indent 22px
  2. **scripts** — collapsed folder: ChevronRight + Folder icons #525252,
     name font-medium (default foreground), indent 8px
  3. **references** — collapsed folder, same styling
  4. **checklist.md** — unselected file: File icon #525252, plain text,
     indent 22px
- Footer (border-t, px-12 py-8): left **"5 files"** (12px #525252); right
  outline badge **"v2"** (1px #E7E7EE, JetBrains Mono 12px)

**Editor pane** (fills the remaining ~880px):

- File header (`skill-editor.tsx` — border-b #E7E7EE, bg ~#F9F9F9 (muted/30),
  px-16 py-8, ~38px tall): left **"SKILL.md"** in JetBrains Mono 12px #525252
  (no leading slash — `displayPath` strips it). The **"Unsaved"** badge sits
  right of the path (shadcn outline badge: 1px #E7E7EE border, 12px
  font-semibold, dark text, radius 6px, px-10) — ONLY while dirty. Right:
  **"Save"** button (primary sm, h-32px, bg #7033FF, white, floppy Save icon
  14px) — disabled (50% opacity) until dirty, back to disabled after save.
- Body: @uiw/react-md-editor in edit-only mode — a slim ~32px toolbar strip
  (bottom border #E7E7EE) of small monochrome glyph icons (bold, italic,
  strikethrough, link, quote, code, list — a simplified row of ~10 gray 14px
  glyphs is faithful), then the markdown source area: white bg, mono 13px,
  dark text, padding 16px, line-height ~1.7.

**SKILL.md contents** (neutral placeholder, no fake brands):

```
---
name: quarterly-report
description: Assemble the quarterly report from workspace data.
---

# Quarterly report

## Steps
1. Pull the latest figures from the data explorer.
2. Draft the summary section.
3. Attach charts to the final document.
```

The typed edit appends line **"4. Cite sources."** under Steps.

**Toast**: bottom-right of the canvas (sonner default position; Toaster has no
`position` prop). White card, 1px #E7E7EE border, stronger shadow, green
(#16A34A) check icon + **"File saved"** (14px).

Motion: power2.out, 150–350ms, no bounce, no glow. #7033FF is the only loud
element (Save/Save version buttons, selected tree row, Sparkles, H1 em words).

## Code snippet decision

**Yes — REST.** Cmd+S is not a black box: the editor saves through a public,
scriptable REST flow — `POST /skills/:skillId/sign` returns a presigned PUT URL
for an exact path inside the current version (`routes.ts` ~3583; the same call
`skillsApi.sign` makes). Developers can push skill files from CI or a repo sync
without the browser.

Anchor line: "Cmd+S is a plain REST flow — script the same save from anywhere:"

```http
POST /skills/{skillId}/sign
{ "filePath": "SKILL.md", "contentType": "text/markdown" }

# → { "key": "skills/{skillId}/v2/SKILL.md",
#     "url": "<presigned PUT URL>", "method": "PUT" }

PUT <presigned PUT URL>
Content-Type: text/markdown

<new SKILL.md content>
```

(10 lines; real route, real body/response field names — `filePath`,
`contentType`, `key`, `url`, `method` — straight from the route handler.
The `v2` in the key comes from the skill's `current_version`.)

## Page prose within this feature's section (beyond the video)

- **Full file management**: create file ("New file" — "Use .md for Markdown
  files.", placeholder "e.g. guide.md"), create folder, rename, delete — from
  the sidebar header buttons, right-click context menus, or per-row kebabs.
  Folder deletes warn: **"The folder and all its contents will be removed from
  the current version. This cannot be undone."**
- **Dirty-switch guard**: clicking another file with unsaved edits raises
  **"Discard unsaved changes?"** — "Your unsaved edits to this file will be lost
  when you switch." with a "Discard and switch" confirm; leaving the route is
  intercepted by the shared unsaved-changes guard.
- **Versions**: "Save version" snapshots the current state ("Snapshot the
  current state into a new version slot. You keep editing the next version."),
  with an optional label; the History sheet lists versions and "Compare" opens
  a file-level diff modal ("Compare versions").
- **Read-only degradation**: without write access the path header shows a
  **"Read-only"** badge, `.md` files render as preview, Save and all file ops
  disappear — you can still browse every file.
- `.md` opens in a markdown editor; every other extension (scripts, JSON,
  configs) opens in a plain monospace textarea — skills are code, and the
  editor treats them that way.
