# Feature plan — Project workspace: pinned knowledge (Files tab)

Part of `releases/2026-07-08-projects/`.

## Sources of truth

- UI:
  `frontend/app/(application)/projects/components/project-detail-view.tsx`
  (URL-backed Sessions/Files/Settings tabs, the `2/15` tab badge, the
  atomic-against-15 `handleAddItems` that persists via `UPDATE_PROJECT`),
  `.../components/files-tab.tsx` (the `n / 15 files` counter mini-toolbar,
  the "Add files" trigger, the responsive card grid, the controlled
  `ItemsSelectionModal` wiring),
  `.../components/project-item-card.tsx` (one pinned item card: name link,
  description, context · relative-time · chunks footer; the 200 ms
  `fade-in zoom-in-95` entrance; the distinct "Entire context" and orphan
  cards),
  `frontend/components/items-selection-modal.tsx` (the shared browse/preset
  modal — folder tree, items list with the purple checkbox select state,
  right-hand "Selected Items" rail, and the `Add (N) Item(s)` confirm)
- On-screen copy: `frontend/messages/en.json` → `projects.files.*`,
  `projects.tabs.*`, `projects.detail.newSession`, `projects.title`
  (verbatim below). The modal's own strings are **hard-coded literals in
  `items-selection-modal.tsx`**, not i18n keys — copy them verbatim from
  that file (there are no `en.json` keys for them).
- GraphQL: `UPDATE_PROJECT` (`projectsUpdateOneById`) in
  `frontend/app/(application)/projects/queries.ts` (line 98) — the mutation
  the confirm ultimately fires, with `project_items` in its selection set.
- Cap constant: `MAX_PROJECT_ITEMS = 15` in
  `frontend/app/(application)/projects/hooks.ts:45`.
- Tokens: `releases/2026-07-08-projects/hyperframes-design.md`
  (primary #7033FF, border #E7E7EE, muted-foreground #525252, accent
  #E2EBFF / accent-foreground #1E69DC, radius ~6px, Inter tracking
  -0.025em).

## What shipped

The project detail page is a workspace, not a form. Under the header
(breadcrumb "Projects /", avatar + name, description, purple **"New
session"**) sit three URL-backed tabs: **Sessions**, **Files**, **Settings**
(`?tab=`, refresh-safe and back-button-steppable). The **Files** tab is the
curation surface for a project's pinned knowledge:

- **Live counter** `"{count} / {max} files"` (e.g. **"2 / 15 files"**) in a
  mini-toolbar, next to an **"Add files"** outline button. The **Files** tab
  trigger also carries a small secondary badge `count/max` (**"2/15"**).
- **Atomic 15-item cap** on every add path. If a batch would push past 15,
  nothing is applied and the user is told how many slots remain
  (`files.limitToast`); at the limit the button disables with an
  always-reachable explanation (`files.limitTooltip`).
- **Card grid** (1 → 2 → 3 cols): each `ProjectItemCard` shows the item name
  (links to `/data/{context}/items/{id}`), description, and a footer of
  `context · relative-time · N chunks`. Cards fade/scale in (200 ms) so a new
  card is visibly attributable to the just-closed modal.
- **Two special card shapes**: full-context entries render a distinct
  **Database**-icon card with an **"Entire context"** outline badge; orphaned
  gids (item deleted elsewhere) render a muted dashed **"Item no longer
  exists"** card that stays removable.
- **The shared `ItemsSelectionModal`** does the picking: a Browse tab (folder
  tree → items list with a purple checkbox select state → right-hand
  "Selected Items" rail) and a Presets tab. Confirming items writes the gids
  into `project_items` via `projectsUpdateOneById`; picking a whole context
  or applying a preset are the other two add paths.

## Hook

**Pin the knowledge. Every session inherits it.**

(Benefit-led evolution of the brief's "A project is a place you work." — it
names the exact payoff the Files tab delivers: files pinned here are shared
with every session in the project, verbatim from
`projects.files.emptyDescription`.)

## Surface area

UI feature (the Files tab curation loop) + one real developer surface: the
`UPDATE_PROJECT` (`projectsUpdateOneById`) mutation that persists the pinned
`project_items` gid list — the same write the modal's confirm fires. ONE
short on a single confirm. The 15-cap toast, the orphan / "Entire context"
card variants, presets, and the tab's URL-backing are page prose within this
feature's section.

## Short — `project-files` (1920×1080, 9.0s)

One slice, ONE user action: with the `ItemsSelectionModal` already open on the
Browse tab and one item already selected (purple checkbox), the cursor clicks
the **"Add (1) Item"** confirm. The modal closes, a new card fades into the
Files grid, and the counter ticks **"2 / 15 files" → "3 / 15 files"** (and the
tab badge **2/15 → 3/15**).

### Demo arc (timed beats)

Demo project = "Finance". Files tab opens with **2** cards already pinned
("Quarterly report", "Onboarding checklist"); a **third**, "Support agent",
is confirmed live. All type at ~1.4× product scale for 1080p legibility.

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.20 | Empty canvas (bg #FDFDFD + radial purple wash), nothing animates | No animation starts at t=0 |
| 0.20–0.50 | Hook enters (lower-third on canvas, no card): pill "Projects" (#E2EBFF bg / #1E69DC text), H1 "Pin the knowledge. **Every session inherits it.**" (em phrase #7033FF) | Entrance |
| 0.50–2.30 | Hook holds static (1.8s) | ≥1.8s floor (full sentence) |
| 2.30–2.65 | Hook crossfades out; Files-tab card fades in — tabs row (Sessions / **Files 2/15** / Settings, Files active), counter **"2 / 15 files"** + **"Add files"** button, grid of 2 cards ("Quarterly report", "Onboarding checklist") | Pivot; the surface reads instantly |
| 2.65–3.25 | The `ItemsSelectionModal` is already open over the card, Browse tab, folder "Finance" selected; item **"Support agent"** row is already selected (purple checkbox + purple border); confirm reads **"Add (1) Item"** | Set the one action up; nothing has moved yet |
| 3.25–3.75 | Cursor glides to the **"Add (1) Item"** button; button shows hover state | Cursor affordance for the click |
| 3.75–3.95 | Cursor press (button depresses ~1px, 120 ms); THE click | The one action |
| 3.95–4.35 | Modal crossfades out (200 ms); Files card fully back in front | Result begins |
| 4.35–4.75 | New **"Support agent"** card fades + scales in (200 ms, zoom-in-95) as the third grid cell; simultaneously counter **"2 / 15 files" → "3 / 15 files"** and tab badge **2/15 → 3/15** | The payoff: card lands, counter ticks |
| 4.75–5.75 | Grid holds completely still (1.0s) | ≥600ms post-action hold |
| 5.75–6.15 | Payoff caption enters (lower third): "Pinned once — shared with every session." | Entrance |
| 6.15–9.00 | Payoff holds still (2.85s); last ~600ms fully frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

Motion: all transitions power2.out, 150–200 ms, no bounce, no glow. The card
entrance is the real `fade-in zoom-in-95 duration-200`. The cursor is the only
thing moving between 2.65 and 3.75; after 4.75 the frame is static except the
payoff caption entrance.

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash (same framing as the
sibling 07-08 shorts). The Files surface lives in a centered card ~1120px wide
(radius ~6px, border 1px #E7E7EE, bg #FCFCFC, subtle shadow
`0 2px 3px rgba(0,0,0,0.16)`). Inter everywhere, tracking -0.025em. Purple
#7033FF appears only in the hook em phrase, the modal's selected-item accents,
and the "New session" button — everything else is neutral/bordered.

**Header strip (top of the card, quiet — it frames the tabs):**
- Breadcrumb **"Projects"** then " / ", text-xs #525252 (`projects.title`).
- Project avatar (rounded square, single-letter "F" monogram on a muted fill)
  + name **"Finance"** (text-lg font-semibold #000).
- Right side: a purple **"New session"** button (`bg #7033FF`, white text,
  `+` icon; `projects.detail.newSession`). It is decor here — never clicked.

**Tabs row** (from `project-detail-view.tsx`): a segmented `TabsList` with
three triggers — **"Sessions"**, **"Files"**, **"Settings"**
(`projects.tabs.*`). **Files** is the active trigger (subtle raised/filled
segment). The Files trigger carries a secondary Badge to its right reading
**"2/15"** (text-xs, muted secondary style) — it ticks to **"3/15"** on the
action. Underneath, the Files tab body (the `mt-6` content) fades in.

**Files-tab body** (from `files-tab.tsx`):
1. Mini-toolbar: a `flex justify-between` row. Left: **"2 / 15 files"**
   text-sm #525252 (`projects.files.counter`, so it reads `"2 / 15 files"`,
   NOT a bare `2 / 15`). Right: an outline **"Add files"** button with a
   leading `+` icon (`projects.files.addFiles`).
2. Card grid, 3 columns (`lg:grid-cols-3`), gap-4. Two `ProjectItemCard`s
   pre-pinned, a third fades in on the action.

**Each `ProjectItemCard`** (from `project-item-card.tsx`): a bordered Card
(radius ~6px, border #E7E7EE, bg #FCFCFC) with `p-4` content, `flex
items-start gap-3`:
- Left/main column: name as a link, text-sm font-medium, `line-clamp-2`
  (hover → #7033FF underline; render it in default #000 here). Below it a
  `line-clamp-2` description in text-xs #525252. Then a top-bordered footer
  (`border-t #E7E7EE pt-2`, text-xs #525252) reading
  `{Context} · {relative time} · {N} chunks` with `·` separators.
- Right: a ghost icon **X** remove button (size-8 on desktop), muted, always
  visible (aria "Remove from project", `projects.files.removeItem`). Present
  but not interacted with.

Card content (neutral placeholders):
| # | Name | Description | Footer |
|---|---|---|---|
| 1 | "Quarterly report" | "Q2 revenue, churn and pipeline summary." | Finance · 2 days ago · 12 chunks |
| 2 | "Onboarding checklist" | "Steps for a new hire's first week." | Finance · 5 days ago · 8 chunks |
| 3 (fades in) | "Support agent" | "Answers product questions from docs." | Finance · just now · 5 chunks |

(Footer "chunks" uses `projects.files.chunks` → e.g. **"12 chunks"**,
**"5 chunks"**; context name is capitalized via `prettyContext`, so **"Finance"**.)

**The `ItemsSelectionModal`** (from `items-selection-modal.tsx`) — open over
the card, Browse tab. A large bounded dialog (`sm:max-w-6xl`, radius ~6px,
border #E7E7EE, bg #FCFCFC, stronger popover shadow). All strings below are
HARD-CODED in the component (no i18n) — copy verbatim:
- Header: title **"Add Context & Items"** (text-lg font-semibold), description
  **"Browse contexts and items, or load a saved preset"** (text-sm #525252).
- Tabs under the header: **"Browse"** (active) / **"Presets"**.
- Left rail (`basis-64`, `border-r`, `bg-muted/10`): a **"FOLDERS"** label
  (text-xs font-semibold #525252, uppercase) then folder buttons, each a
  Folder icon + name. Show **"Finance"** as the selected folder (open-folder
  icon, `bg #E2EBFF` accent, accent-foreground #1E69DC, font-medium); one or
  two neutral siblings above/below (e.g. "Support", "HR") in plain #000.
- Middle panel: a breadcrumb strip (Folder icon › **"Finance"** in
  font-medium #000, plus a right-aligned **"New Item"** outline button with a
  file-plus icon and a **"Select all"** outline button with a layers icon —
  both decor). Below, a search field placeholder **"Search items in this
  context..."**, then the items list. Each item row is a bordered button with
  a 16px checkbox square on the left, a File icon, the item name (text-sm
  font-medium), a description line, and an "Updated …" line.
  - Rows (neutral): **"Support agent"** — SELECTED (checkbox filled #7033FF
    with a white check, row `bg-primary/10` #7033FF@10%, border #7033FF, name
    text in #7033FF); **"Weekly report"** and **"Budget template"** —
    unselected (empty checkbox with #525252@30% border, neutral row).
- Right rail (`basis-80`, `border-l`, `bg-muted/5`): header **"Selected
  Items"** (text-sm font-semibold) + a secondary Badge **"1"**. Below, one
  entry card: File icon + **"Support agent"** (text-sm font-medium) with a
  Folder-icon **"Finance"** sub-line (text-xs #525252).
- Footer (`border-t`): a **"Cancel"** outline button on the left, and on the
  right the confirm — a primary #7033FF button with a leading Check icon
  reading **"Add (1) Item"** (singular; the label is
  `Add {count && (count)} Item{s}` — with 1 selected it is exactly
  **"Add (1) Item"**). THIS is the button clicked.

Hook pill/H1 and payoff caption use the sibling 07-08 short treatment: pill
#E2EBFF bg / #1E69DC text; the em phrase and payoff em words in #7033FF;
payoff rendered as a lower-third caption (dark #000 text on the canvas, no
card).

## Code snippet decision

**Yes — GraphQL.** Confirming items in the modal doesn't just update local
state — it persists the pinned `project_items` gid list through the real
`UPDATE_PROJECT` mutation (`projectsUpdateOneById`). That is the exact write a
developer would call to pin knowledge to a project from the API, and
`project_items` is a first-class field in its selection set. Verbatim
structure from `frontend/app/(application)/projects/queries.ts` (the
`${PROJECT_FIELDS}` selection expanded to the fields the card actually reads):

Anchor line: "Every confirm writes the pinned gid list — `project_items` — to
the project:"

```graphql
mutation UpdateProject($id: ID!, $input: projectInput!) {
  projectsUpdateOneById(id: $id, input: $input) {
    item {
      id
      name
      project_items
    }
  }
}
```

Companion note (not code): the client sends
`input: { project_items: ["finance/<item-id>", ...] }` — the same
`{context}/{id}` gids the cards render (a bare `{context}` gid = an "Entire
context" pin). 6 lines, real operation and field names.

## Page prose within this feature's section (beyond the video)

- Three add paths, one cap: pick individual items (Browse), pick a whole
  **"Entire context"** (Select all), or apply a saved **preset** — each is
  atomic against **15**. Over-cap batches apply nothing and say how many slots
  remain: **"Only # slot(s) left — nothing was added."** /
  **"No slots left — remove a file first. Nothing was added."**
  (`projects.files.limitToast`). At the cap the "Add files" button disables
  with **"This project has reached the limit of 15 files. Remove one to add
  another."** (`projects.files.limitTooltip`).
- Every pinned file is shared: the empty state says it plainly — **"Pin
  knowledge items to share them with every session in this project."**
  (`projects.files.emptyDescription`, empty title **"No files yet"**).
- Two honest edge-case cards: a full-context pin shows a Database-icon card
  with an **"Entire context"** badge (`projects.files.entireContext`); a
  deleted item shows a muted dashed **"Item no longer exists"** /
  **"It was deleted from its knowledge context. Remove it to free a slot."**
  card that stays removable (`projects.files.orphanTitle` /
  `orphanDescription`) — orphans are never silently dropped.
- Add confirmation is quiet and truthful: **"# file(s) added to the
  project."**, or **"Already in this project — nothing new was added."** when
  the selection was all duplicates (`projects.files.addedToast`).
- The tab is a real URL: `?tab=files` is linkable, refresh-safe, and
  back-button-steppable (tab switches push history; the Settings `?edit=1`
  sub-state replaces). The Files trigger shows a live `count/max` badge
  (e.g. **"3/15"**) once at least one file is pinned.
