# Feature plan — Skill versioning with per-file diffs

Part of `releases/2026-07-08-prompt-and-skill-libraries/`.

## Sources of truth

- Frontend commits: `2ff7d18` (`feat(skills): redesign library and mini-IDE per
  design/pages/skills.md (2.10)`), `061c6ec` (adversarial-review fixes),
  `68399b8` (original `feat: add skills management system with version control`)
- UI: `frontend/app/(application)/skills/[skillId]/components/skill-diff-modal.tsx`
  (the Compare-versions dialog — star of the short),
  `components/version-history-panel.tsx` (History sheet, Compare button gated
  `current_version >= 2`),
  `components/editor-top-bar.tsx` (History + purple "Save version" buttons),
  `components/skill-editor-view.tsx` (save-version InputDialog wiring)
- API client: `frontend/lib/api/skills.ts` — `skillsApi.saveVersion` (`POST
  /skills/:skillId/version`), `skillsApi.diff` (`GET /skills/:skillId/diff`),
  `skillsApi.download` (.zip of a versioned bundle, folder structure +
  `version.txt`)
- Backend routes: `backend/src/exulu/routes.ts:3749` (`POST
  /skills/:skillId/version` → S3 snapshot copy + history append, returns
  `{ newVersion, fileCount }`), `routes.ts:3855` (`GET /skills/:skillId/diff`
  → per-file `added`/`removed`/`modified` + unified diff strings; **unchanged
  files are filtered out of the response**, `routes.ts:3943`)
- On-screen copy: `frontend/messages/en.json` → `skills.editor.diff.*`,
  `skills.editor.history.*`, `skills.editor.topbar.*`,
  `skills.editor.input.saveVersion*` (verbatim below)
- Diff rendering: `react-diff-viewer-continued`, `DiffMethod.WORDS`, split view
  for `modified` files on ≥md, custom light-theme variables (verbatim hex below)

## What shipped

Skills are versioned file bundles with real change management:

- **Save version** — the editor top bar's one purple button (GitBranch icon).
  Opens a label dialog ("Label (optional)", placeholder "e.g. Tightened safety
  prompt"), then `POST /skills/:skillId/version` copies every file of the
  current version into the next S3 slot (`skills/<id>/v<N+1>/`) and appends
  `{ version, created_at, label }` to the skill's `history`. Toast: "New
  version saved".
- **Version history sheet** — newest-first list, current version pinned on top
  (purple-tinted card, "CURRENT" badge), labels + relative timestamps, and a
  **Compare** button (enabled from v2).
- **Compare versions modal** (`SkillDiffModal`) — From/To version selects
  (labels rendered as "v3 — Tightened safety prompt", "v4 (current)"), a
  per-file list with added/removed/modified status icons, and a
  react-diff-viewer pane: unified view with a colored badge for added/removed
  files, **split red/green view with word-level highlights for modified files**.
- **Download .zip** — any version's full bundle, folder structure preserved,
  plus a `version.txt`.

## Hook

**Skills, under version control.**

(Improved from "Change management for AI capabilities." — shorter, concrete,
and the payoff caption carries the benefit: "Know exactly what changed, file
by file.")

## Surface area

UI feature (editor top bar → History sheet → Compare modal) + a real developer
surface (the versioning REST routes the UI itself calls). One short on the diff
modal's per-file click; Save-version flow, History sheet and .zip download are
page prose within this feature's section.

## Short — `skill-versions` (1920×1080, 9.6s)

One slice, ONE user action: clicking the **modified** file `reference.md` in
the Compare-versions file list → its split red/green diff reveals in the pane.
The modal is already open when the demo starts (post-hook), with the removed
file selected — exactly the state the component's auto-select produces (it
picks the first changed file in list order; see staging note below).

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Skill Library" (#E2EBFF bg / #1E69DC text) + H1 "Skills, under **version control**." (em words #7033FF) — no sub-line | Entrance |
| 0.40–1.85 | Hook holds static (1.45s) | ≥1.4s floor for 4-word phrase |
| 1.85–2.30 | Hook crossfades out; "Compare versions" dialog card fades in, fully populated: From **v3 — Tightened safety prompt** → To **v4 (current)**, "3 changed", 3-file list with `archive/legacy_prompt.md` active, red removed-file pane | Pivot |
| 2.30–3.40 | Modal holds (1.1s) while the cursor glides from the pane toward the `reference.md` row | Let the viewer parse the surface; approach |
| 3.40–3.65 | Click on **reference.md** → row goes active (bg rgba(112,51,255,0.10), text #7033FF); the previous active row clears to plain | The ONE action |
| 3.65–4.00 | Pane swaps (250ms fade, power2.out): removed view out, **split diff in** — column titles "v3" \| "v4", red left / green right rows, word-level highlights | Result reveal |
| 4.00–6.50 | Diff holds completely still (2.5s) | ≥600ms post-action hold + scan time |
| 6.50–6.90 | Payoff caption enters (lower third): "Know exactly what changed, file by file." | Entrance |
| 6.90–9.60 | Payoff holds still (2.7s); last 600ms fully still = loop resting frame | ≥1.8s sentence floor + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Framing.** The real `DialogContent` is `md:max-w-6xl` (1152px),
`md:max-h-[90dvh] md:rounded-lg`, `flex flex-col gap-0 p-0`. For the short,
render the dialog as the centered card (~1120–1152px wide) directly on the
#FDFDFD canvas with the house radial purple wash — **no dark modal overlay**
(matches the 07-07/07-08 shorts' framing). Border 1px #E7E7EE, radius ~8px,
subtle shadow (0px 2px 3px rgba(0,0,0,0.16)). Keep the shadcn X close button
top-right (size-4, #525252) for authenticity. Inter, tracking -0.025em;
diff/file content in JetBrains Mono.

**Header** (`border-b px-6 py-4`):

- Title row: GitCompare icon (lucide, size-5, #525252) + **"Compare versions"**
  (`text-lg font-semibold`)
- Description: **"View file-level differences between two skill versions."**
  (`text-sm`, #525252)

**Version selector bar** (`border-b bg-muted/30 px-6 py-3`, flex row,
`items-center gap-3`; bg reads as a faint #F5F5F5 tint over the card):

- Label **"From"** rendered UPPERCASE (`text-xs font-semibold uppercase
  tracking-wide`, #525252) + Select trigger (`h-8 text-xs`, border #E7E7EE,
  chevron) showing **"v3 — Tightened safety prompt"** (the
  `versionLabelTagged` format "v{version} — {label}")
- ArrowRight icon (size-4, #525252) between the two selects
- Label **"To"** (same style) + Select showing **"v4 (current)"**
  (`versionLabelCurrent` format "v{version} (current)")
- Right-aligned (`ml-auto`), `text-xs` #525252: **"3 changed"** (ICU plural
  "# changed"). Do NOT render an "unchanged" counter — the backend filters
  unchanged files out of the response, so `unchangedCount` is always 0.

**Body** — two panes (`flex`, min-height ~560px so the card fills nicely):

*Left file list* (`w-56` = 224px, `border-r` #E7E7EE):

- Header **"Files"** rendered UPPERCASE (`border-b px-3 py-2 text-xs
  font-semibold uppercase tracking-wide`, #525252)
- File rows (`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs`,
  status icon `size-3`, path truncates). Exact rows, in this order (backend
  order = from-version paths lexicographic, then added paths appended):
  1. `archive/legacy_prompt.md` — FileMinus icon **#E54B50** (removed).
     ACTIVE at open: `bg-primary/10 text-primary` → bg rgba(112,51,255,0.10),
     text #7033FF
  2. `reference.md` — FileEdit icon **#D97706** (modified). ← click target;
     becomes the active row after the click
  3. `scripts/extract_tables.py` — FilePlus icon **#16A34A** (added)
- No "unchanged" rows (server-filtered). `SKILL.md` is intentionally absent —
  it didn't change between v3 and v4, so the diff endpoint doesn't return it.

*Right pane, state 1 — removed file* (`p-4`):

- Badge (outline, `border-destructive/30 text-destructive`, radius ~6px):
  **"File removed in v4"** (the `fileRemoved` format "File removed in
  v{version}" with toVersion)
- Below: unified diff, ALL lines removed-red. Line rows: bg **#FBD0D0**, text
  **#8D0C0C**, gutter (line numbers 1–5) bg **#F9B9B9**; JetBrains Mono
  ~13px. Content (5 lines):

  ```
  # Legacy prompt

  Summarize the quarter in one paragraph.
  Do not include tables or charts.
  Skip regional breakdowns.
  ```

*Right pane, state 2 — modified file, split view* (`p-4`, revealed by the
click):

- Two-column react-diff-viewer. Column title row: **"v3"** (left) and
  **"v4"** (right), JetBrains Mono `text-xs`, on gutter-grey #F5F5F5 header
  cells.
- Row treatment: unchanged lines plain on #FDFDFD, gutters #F5F5F5; changed
  lines — left: bg **#FBD0D0**, text #8D0C0C, gutter #F9B9B9, word-removed
  spans **#F58A8A**; right: bg **#D2F9E0**, text #0C5A29, gutter #BCF6D1,
  word-added spans **#8FF0B3**. (These are the component's custom light-theme
  variables converted to hex.)
- Content — left (v3, 7 lines):

  ```
  # Report structure

  Use the sections below for every quarterly report.

  - Summary: three sentences, plain language.
  - Revenue tables use the raw CSV column names.
  - Close with open risks.
  ```

  Right (v4, 8 lines):

  ```
  # Report structure

  Use the sections below for every quarterly report.

  - Summary: three sentences, plain language.
  - Revenue tables use normalized column names.
  - Add one chart per region (scripts/extract_tables.py).
  - Close with open risks.
  ```

  Line 6 = modified pair (word-level: "the raw CSV" red on the left,
  "normalized" green on the right); right line 7 ("- Add one chart per
  region…") = added, its left counterpart is an empty grey placeholder row.

**Hook / payoff typography.** Same system as the sibling shorts: pill
`#E2EBFF`/`#1E69DC` (radius full, text-xs semibold), H1 Inter ~64px semibold
#000 with the em words in #7033FF; payoff caption lower-third, Inter ~32px
medium, #000 on a soft white card or bare canvas. Cursor + motion conventions
identical to the 07-07 shorts (power2.out, 150–350ms, no bounce, no glow;
cursor click = quick 0.9 scale dip).

**Staging note (fidelity).** The component auto-selects the first CHANGED file
in list order when the modal opens (`skill-diff-modal.tsx:172-174`). With the
file set above that is `archive/legacy_prompt.md` (removed) — so the opening
state is exactly what the real app shows, and the single click on
`reference.md` is a genuine, state-changing action.

## Code snippet decision

**Yes — REST.** Versioning is a real developer surface: skills are file
bundles people script against (upload bundles, download .zip), and both
endpoints below are what the UI itself calls (`lib/api/skills.ts`). Real
routes + real payload keys from `backend/src/exulu/routes.ts:3749`/`3855`:

Anchor line: "Snapshots and diffs are plain REST — script them:"

```http
POST /skills/:skillId/version
{ "label": "Tightened safety prompt" }
# → { "newVersion": 4, "fileCount": 12 }

GET /skills/:skillId/diff?fromVersion=3&toVersion=4
# → { "fromVersion": 3, "toVersion": 4,
#     "files": [ { "path": "reference.md",
#                  "status": "modified", "diff": "..." } ] }
```

(9 lines; `status` is `"added" | "removed" | "modified"` — unchanged files are
filtered server-side; `diff` is a unified-diff string for text files ≤500KB.)

## Page prose within this feature's section (beyond the video)

- **Save version flow**: top bar's one purple button — GitBranch icon +
  **"Save version"** — opens a dialog titled **"Save version"**: "Snapshot the
  current state into a new version slot. You keep editing the next version."
  Field **"Label (optional)"**, placeholder **"e.g. Tightened safety prompt"**,
  helper **"Snapshots v{current}; you keep editing as v{next}."**, confirm
  **"Save version"**. Success toast: **"New version saved"**. Hidden entirely
  for read-only viewers.
- **Version history sheet**: header **"Version history"** + **"Compare"**
  button (GitCompare icon, disabled until v2). Rows newest-first; the current
  version is pinned on top with a purple-tinted card, `v4` mono badge and a
  "Current" tag; older rows show their label (tag icon) and a relative
  timestamp (clock icon, e.g. "3 days ago"). Empty state: **"No previous
  versions yet"** / **"Save a version to snapshot the current state."**
- **Download .zip**: any version's bundle downloads with folder structure
  preserved plus a `version.txt` (`GET /skills/:skillId/download?version=N`) —
  take a skill into Claude Code or any other tool.
- Mobile behavior worth one line: below `md` the compare modal becomes a
  full-screen takeover, the file list becomes a horizontal chip strip, and
  diffs render unified instead of split.
