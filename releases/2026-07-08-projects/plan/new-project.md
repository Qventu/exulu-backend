# Feature plan — Projects index + create dialog (`new-project`)

Part of `releases/2026-07-08-projects/`.

## Sources of truth

- UI: `frontend/app/(application)/projects/page.tsx` (the /projects index —
  PageHeader with one "New project", server-side name search Toolbar, pinned
  Favorites group, ListDetail rows, "Load more" past 200),
  `.../projects/components/create-project-dialog.tsx` (the create dialog: Name +
  Description visible, "Advanced" collapsible hiding Custom instructions, the
  Lock "Private" reassurance line, footer Cancel / Create; on success it
  `router.push(\`/projects/\${newProject.id}\`)`),
  `.../projects/hooks.ts` (`useProjectsIndex` server search + Load-more window;
  `useFavoriteProjects`),
  `.../projects/components/project-detail-view.tsx` (the payoff destination —
  the project workspace header: breadcrumb, avatar, name, "Private"
  VisibilityBadge, "New session"),
  `.../projects/components/visibility-badge.tsx` (the Lock "Private" pill),
  `frontend/components/primitives/page-header.tsx` (h1 `text-2xl font-semibold
  tracking-tight`, breadcrumb parent crumb + current page, action slot).
- On-screen copy: `frontend/messages/en.json` → `projects.*` and
  `projects.create.*` (verbatim below); `common.cancel` = "Cancel".
- GraphQL: `CREATE_PROJECT` in `frontend/app/(application)/projects/queries.ts`
  (the local, colocated copy — the index does NOT import from
  `queries/queries.ts`).
- Tokens: `releases/2026-07-08-projects/hyperframes-design.md` +
  `frontend/app/globals.css` (primary #7033FF, accent #E2EBFF / #1E69DC,
  muted-foreground #525252, border #E7E7EE, muted #F5F5F5, card #FCFCFC).

## What shipped

The /projects index is now a standard collection page (the old permanent
ProjectNav sidebar and `projects/layout.tsx` are gone; switching happens here
or via ⌘K):

- **PageHeader** — h1 "Projects", one-line description "Workspaces that group
  your conversations and shared context.", and exactly ONE primary action: a
  purple **"New project"** button (Plus icon + label). This fixes the old
  cryptic icon-plus.
- **Toolbar** with a single server-side name-search input (placeholder "Search
  projects…"); typing filters via `GET_PROJECTS` with a `name contains`
  filter (`useProjectsIndex`).
- **Pinned Favorites group** at the top (heading "Favorites"), shown once, then
  an "All projects" heading; the Favorites group hides while searching.
- **Project rows**: avatar + name (`text-sm font-medium`, truncate) + a
  right-aligned "Updated <relative time>" datum + a star **FavoriteToggle**.
  Rows stagger in (20ms/row, capped at 8).
- **"Load more"** ghost button appears when the list exceeds the 200-row window
  (`PROJECTS_PAGE_SIZE = 200`) and `hasNextPage`.
- **Create dialog** (title "Create new project", description "A project groups
  chat sessions and shared files in one place."): **Name** and **Description**
  fields visible; **Custom instructions** tucked inside a collapsed
  **"Advanced"** section (ChevronRight that rotates 90°); a Lock-icon trust line
  **"Private — only you can see this project until you share it."**; footer
  **Cancel** (outline) + **Create project** (purple). Submit fires
  `CREATE_PROJECT` with `rights_mode: "private"`, toasts "Project created.",
  closes, and navigates into the new project workspace.

## Hook

**Named, private workspaces for your team's AI.**
(em-word "private" in brand purple #7033FF.)

## Surface area

UI feature (index + create dialog) + one real developer surface: the
`CreateProject` GraphQL mutation the dialog fires. One short on the ONE create
action. The Favorites pin, server search, Load-more, and the Advanced /
custom-instructions section are page prose within this feature's section.

## Short — `new-project` (1920×1080, 9.0s)

One slice, ONE user action: with the dialog already open and the Name filled,
the cursor clicks **"Create project"**; the dialog confirms and the view
transitions into the new project's workspace header. One create action.

Framing: centered card on the #FDFDFD canvas with the house soft radial purple
wash. The create dialog is rendered as the centered card (~560px wide — the
real dialog is `sm:max-w-[500px]`, scaled to ~1.35× product type for 1080p
legibility). The payoff swaps that card for the project workspace header
(~1120px wide). Inter throughout, tracking -0.025em. Purple #7033FF appears
only in the hook em-word, the "Create project" / "New session" buttons, and the
cursor's click ring — everything else is neutral product chrome.

### Demo arc (timed beats)

Placeholder project being created: **Name = "Quarterly report"** (already typed
into the Name field at open). Description left empty. Advanced stays collapsed.

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.25 | Empty canvas + radial wash (nothing animates yet) | Never start motion at t=0 |
| 0.25–0.55 | Hook enters (lower third, dark text on canvas): pill "Projects" (#E2EBFF bg / #1E69DC text), H1 "Named, **private** workspaces for your team's AI." (em-word "private" #7033FF) | Entrance (150–250ms, power2.out) |
| 0.55–2.35 | Hook holds static (1.8s) | ≥1.8s floor (8+ words / full sentence) |
| 2.35–2.70 | Hook crossfades out; create-dialog card fades + scales in from 0.98 (power2.out, ~250ms). Dialog reads: title "Create new project", description line, Name field filled "Quarterly report", empty Description field, collapsed "▸ Advanced" trigger, Lock line "Private — only you can see this project until you share it.", footer "Cancel" (outline) + "Create project" (purple) | Pivot; dialog is fully legible before any action |
| 2.70–4.10 | Dialog holds static (1.4s) so the "Private — only you…" line and filled Name can be read | ≥1.8s floor deferred to the still hold below; this window lets the eye reach the trust line and CTA |
| 4.10–4.55 | Cursor glides in from lower-right toward the purple "Create project" button (power2.out) | Cursor affordance for the click |
| 4.55–4.75 | Click: button depresses ~1px + a soft #7033FF ring pulses once (no glow); button label swaps "Create project" → spinner (Loader2) + "Creating..." | The ONE action lands |
| 4.75–5.35 | Dialog card fades + scales down to 0.98 and out (~300ms); a small "Project created." toast slides in bottom-right | Confirm + dismiss |
| 5.35–5.85 | Workspace header fades in (power2.out): breadcrumb "Projects / Quarterly report", avatar + H1 "Quarterly report", a "Private" pill (Lock icon, bordered), and the purple "New session" button | The view has transitioned into the new project workspace |
| 5.85–6.65 | Header + toast hold completely still (≥600ms post-action) | Post-action settle |
| 6.65–7.05 | Payoff caption enters (lower third): "Private by default — shipped into its own workspace." | Entrance |
| 7.05–9.00 | Payoff holds still (~1.95s); toast has faded by ~7.4s; last 600ms fully frozen = loop resting frame | ≥1.8s full-sentence floor + clean loop |

All transitions 150–350ms, power2.out, no bounce, no glow. The cursor is the
only moving element between 4.10 and 4.55; from 5.85 onward nothing moves except
the one-time payoff-caption entrance, and from 8.40 the frame is fully static.

### Reconstruction cues (build the real UI, verbatim)

Canvas 1920×1080, bg #FDFDFD + house radial purple wash (same framing as the
sibling 07-08 shorts). Inter everywhere, tracking -0.025em. Radius ~6px, borders
1px #E7E7EE, subtle shadow `0px 2px 3px rgba(0,0,0,0.16)`.

**Hook** (lower-third, no card): pill "Projects" (#E2EBFF bg / #1E69DC text,
rounded, `text-xs font-medium`) above H1 "Named, private workspaces for your
team's AI." — em-word "private" in #7033FF, the rest #000.

**Create-dialog card** (from `create-project-dialog.tsx`; the real dialog is
`DialogContent sm:max-w-[500px]`, `space-y-4` form). Card bg #FCFCFC, radius
~6px, 1px #E7E7EE, shadow. Top-to-bottom:
- **DialogTitle**: "Create new project" — `text-lg font-semibold`.
- **DialogDescription**: "A project groups chat sessions and shared files in one
  place." — `text-sm` #525252.
- **Name** block: Label "Name"; Input filled with **"Quarterly report"**
  (`text-sm`, 1px #E7E7EE, radius ~6px). (Placeholder when empty is "Enter
  project name" — but here it is filled.)
- **Description** block: Label "Description"; empty Textarea (3 rows) with
  placeholder "Describe what this project is about..." in #525252.
- **Advanced** collapsible trigger: a ghost button, `text-muted-foreground`
  #525252, `text-sm`, with a right-pointing ChevronRight (size-4) before the
  word **"Advanced"**. Stays COLLAPSED in this short (chevron at 0°). Do not
  reveal Custom instructions.
- **Private trust line**: a Lock icon (size-3, #525252) + text
  **"Private — only you can see this project until you share it."** —
  `text-xs` #525252, single row, icon shrink-0.
- **DialogFooter** (`gap-2`, right-aligned): **"Cancel"** — outline button
  (1px #E7E7EE, transparent bg, #000 label); then **"Create project"** —
  primary purple button (#7033FF bg, #FFFFFF label). On click the primary
  button shows Loader2 spinner + **"Creating..."**.

**Cursor**: a neutral system arrow cursor, ~28px, drawn top-left origin. Click
ring = a single #7033FF stroke ring that expands ~1.15× and fades over ~200ms
(no fill, no glow).

**Toast** (bottom-right, sonner-style): small card, bg #FCFCFC, 1px #E7E7EE,
radius ~6px, `text-sm` #000 text **"Project created."**, subtle success accent
(a thin #16A34A left edge is acceptable but optional — keep it quiet).

**Workspace header** (payoff, from `project-detail-view.tsx` + `page-header.tsx`
+ `visibility-badge.tsx`), rendered ~1120px wide:
- **Breadcrumb** row: `Projects` (link-styled, #525252) + a chevron separator +
  `Quarterly report` (current page, #000). `text-sm`.
- **Leading avatar**: a `size-10` ProjectAvatar (rounded square, initial "Q" on
  a neutral tint — no violet).
- **H1**: "Quarterly report" — `text-2xl font-semibold tracking-tight`, #000.
- **Description**: none (project was created without one) — omit the line.
- **Action cluster** (right side): a **"Private"** pill — bordered
  (`rounded-full border border-border`, `px-2.5`, `text-xs font-medium`
  #525252) with a Lock icon (size-3) + label "Private"; a ghost star
  (FavoriteToggle, unpressed); a `⋯` overflow button (MoreVertical); then the
  purple **"New session"** button (#7033FF bg, #FFFFFF label, Plus icon +
  "New session"). The overflow menu stays CLOSED.

Verbatim strings used (all from `projects.*`): "Projects", "New project"
(index, not shown in this short's frames — the dialog is already open),
"Create new project", "A project groups chat sessions and shared files in one
place.", "Name", "Enter project name", "Description", "Describe what this
project is about...", "Advanced", "Private — only you can see this project until
you share it.", "Cancel" (from `common.cancel`), "Create project", "Creating...",
"Project created.", "Private" (visibility badge), "New session".

**Deviations from the brief (followed reality):**
1. The reassurance line is **"Private — only you can see this project until you
   share it."** — the brief's shorthand "Private — only you" is not the real
   string. Rendered in full (an 8+-word sentence → gets the ≥1.8s read budget
   across the 2.35–4.10 window).
2. The submit button reads **"Create project"**, not "Create" (`create.submit`).
   The click still lands on this one button — the one-action rule holds.
3. The dialog TITLE is **"Create new project"** (`create.title`), distinct from
   the button label.
4. The payoff is not a generic "workspace header" — it is the real project
   detail header: a breadcrumb "Projects / <name>", avatar + name, a **"Private"**
   VisibilityBadge (Lock pill), and a purple **"New session"** action. This is
   what confirms the "named, private, shipped-into-its-own-workspace" promise.

## Code snippet decision

**Yes — GraphQL.** Clicking "Create project" fires exactly one real developer
surface: the `CreateProject` mutation. It is the operation a script or CI would
call to provision a workspace, and it carries the load-bearing detail the video
asserts — `rights_mode: "private"`. Verbatim from
`frontend/app/(application)/projects/queries.ts` (the local colocated copy):

Anchor line: "Create dialog fires one mutation — private by default:"

```graphql
mutation CreateProject($input: projectInput!) {
  projectsCreateOne(input: $input) {
    item {
      id
      name
      rights_mode
    }
  }
}
```

(Real operation and root; `PROJECT_FIELDS` is trimmed to the three fields the
video reads — the source selection is longer but every field shown here is real.
The submitted `$input` sets `name`, optional `description` /
`custom_instructions`, and `rights_mode: "private"`.)

## Page prose within this feature's section (beyond the video)

- **One primary action.** The index PageHeader carries exactly one purple
  button, **"New project"** — replacing the old cryptic icon-plus.
- **Server-side search.** The Toolbar search ("Search projects…") filters on the
  server via `name contains`, not a client filter — it scales past the visible
  window. Empty result → "No projects found" / "Try a different search term.".
- **Favorites, pinned once.** Starred projects surface in a **"Favorites"**
  group at the top (then **"All projects"**); the group hides while searching so
  a project never appears twice. Stars are one shared source of truth across the
  list, the detail-header star, and re-navigations.
- **Load more past 200.** The list loads 200 rows, then shows a **"Load more"**
  step — the old silent 200/50 ceilings now have a visible affordance.
- **Advanced, collapsed by default.** Custom instructions live behind the
  **"Advanced"** disclosure in the create dialog, keeping first-run to ~3
  decisions (name, description, create). The hint under the field: "Added to
  every conversation in this project.".
- **Private by default.** New projects are created with `rights_mode: "private"`
  and the trust line states it at the moment of creation:
  **"Private — only you can see this project until you share it."**. The new
  workspace opens with a **"Private"** visibility badge; sharing is a later,
  explicit step in Settings → Access.
- **Straight into the work.** On success the dialog toasts "Project created."
  and navigates to `/projects/<id>` — the Sessions tab of the new workspace,
  ready for its first "New session". No intermediate confirmation screen.
- **Deep-link create.** Arriving at `/projects?new=1` (e.g. from the ⌘K palette)
  opens the create dialog automatically, consistent with every other
  collection's create entry.
