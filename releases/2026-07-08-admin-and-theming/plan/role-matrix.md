# Feature plan — Role editor with the 7-area permission matrix

Part of `releases/2026-07-08-admin-and-theming/`.

## Sources of truth

- Frontend commits: `882db25` (role-detail-panel + local PermissionMatrix — the
  redesign that replaced the legacy ~1400px stacked-cards RoleForm dialog),
  `65d2a9e` (SaveBar primitive)
- UI: `frontend/app/(application)/users/components/role-detail-panel.tsx`
  (panel: name field with reserved-role lock, PermissionMatrix, blast-radius
  info line, meta block, danger zone, sticky SaveBar),
  `frontend/app/(application)/users/components/permission-matrix.tsx`
  (7 rows × None/Read/Write ToggleGroup; ~320px vs the legacy ~1400px),
  `frontend/components/primitives/save-bar.tsx` (renders null unless dirty;
  slide-up 200ms), `frontend/components/primitives/form-section.tsx`,
  `frontend/components/ui/toggle-group.tsx` + `toggle.tsx` (segment styling)
- Panel chrome: `frontend/components/primitives/list-detail.tsx` — the role
  panel opens as a right-side Sheet, `sm:max-w-md` (448px), with a bordered
  header (role name, close ×)
- On-screen copy: `frontend/messages/en.json` → `access.roles.*` (verbatim
  below) and `common.save` / `common.discard`
- GraphQL: `UPDATE_USER_ROLE_BY_ID` in
  `frontend/app/(application)/users/queries.ts` (`rolesUpdateOneById`, seven
  permission `String` variables)

## What shipped

The role editor is now a single narrow panel with a real permission matrix:

- **PermissionMatrix** — seven rows, one per permission area on `UserRole`
  (`agents`, `workflows`, `variables`, `users`, `api`, `evals`,
  `budget_management`). Each row: lucide icon + label + info tooltip with the
  area's description, and a 3-state **None / Read / Write** segmented control
  (Radix ToggleGroup). All seven areas fit in ~320px of vertical space — the
  whole model on one screen, no nested cards, no scrolling between areas.
- **Sticky SaveBar** — appears only when the draft is dirty (the primitive
  renders `null` otherwise). Slides up from the panel bottom with summary
  **"You have unsaved changes."**, outline **Discard**, primary purple **Save**.
- **Reserved-role lock** — `admin` / `default` get a "System" badge, a disabled
  name field with hint "System roles cannot be renamed.", and a disabled delete
  button ("System roles cannot be deleted.").
- **Blast-radius info line** — shield icon + "Members of this role see
  navigation changes immediately." directly under the matrix.

## Hook

**Least-privilege roles in seconds.**

## Surface area

UI feature (role panel + matrix) backed by a real GraphQL surface
(`rolesUpdateOneById` with the seven permission fields). One short on the
matrix interaction; reserved-role locking and the info tooltips are page prose
within this feature's section.

## Short — `role-matrix` (1920×1080, 9.7s)

One slice, ONE user action: clicking **Write** on the **Budgets** row's
segmented control → the sticky Save bar slides up from the panel bottom.

### Demo arc (timed beats)

| t (s) | On screen | Why |
|---|---|---|
| 0.00–0.40 | Hook enters: pill "Access control" (#E2EBFF bg / #1E69DC text), H1 "Least-privilege roles in **seconds**." (em word #7033FF) — no sub-line | Entrance |
| 0.40–1.85 | Hook holds static (1.45s) | ≥1.4s floor for 4-word phrase |
| 1.85–2.30 | Hook crossfades out, role panel card fades in centered: header "Finance", name field, full 7-row matrix (Budgets row = Read), info line. No save bar yet | Pivot — the whole permission model visible at once |
| 2.30–3.00 | Cursor glides to the Budgets row's "Write" segment (bottom row of the matrix) | Approach |
| 3.00–3.25 | Click → "Write" chip flips on (bg #E2EBFF, text #1E69DC, 150ms color transition), "Read" chip returns to transparent | The one action |
| 3.25–3.45 | SaveBar slides up from the card's bottom edge (slide-in-from-bottom ~8px + fade, 200ms ease-in-out): "You have unsaved changes." + Discard (outline) + Save (#7033FF) | Immediate dirty-state feedback — real product behavior |
| 3.45–4.15 | Hold the new state still (700ms) — Write on, save bar resting | ≥600ms breath after the action lands |
| 4.15–4.55 | Soft highlight sweep (#E2EBFF wash) enters over the info line "Members of this role see navigation changes immediately." | Real product copy carries the message |
| 4.55–6.55 | Highlight holds, everything else still (2.0s) | ≥1.8s full-sentence read floor |
| 6.55–6.85 | Highlight fades out | Clear stage |
| 6.85–7.45 | Breath (600ms), card fully still | Breath before payoff |
| 7.45–7.85 | Payoff caption enters (lower third): "Seven areas, three levels, one save." | Entrance |
| 7.85–9.70 | Payoff holds still (1.85s); last 600ms fully still = loop resting frame | ≥1.4s floor (6 words) + clean loop |

### Reconstruction cues (build the real UI, verbatim)

**Framing (deviation from the ~1120px default, on purpose):** the real surface
is a right-side Sheet only 448px wide (`sm:max-w-md`) — stretching it to
1120px would falsify the layout. Build the panel at true sizes inside a
448px-wide card, then apply a uniform `scale(1.25)` to the whole card
(≈560px×~910px on screen), centered on the 1920×1080 #FDFDFD canvas with the
house radial purple wash. Card: bg #FCFCFC, 1px border #E7E7EE, radius 8px,
subtle shadow (0px 2px 3px rgba(0,0,0,0.16)), `overflow: hidden` — the SaveBar
must be clipped by the card as it slides up.

**Card header** (from `list-detail.tsx` Sheet chrome): `border-b` #E7E7EE,
`px-4 py-3`, title **"Finance"** (`text-base font-semibold`, truncate), ghost
close **×** icon button at the far right (size-4 X in a size-8 hit area,
muted).

**Panel body** (`role-detail-panel.tsx`; `p-4`, sections stacked `gap-6`):

1. Title row: **"Finance"** (`text-lg font-semibold`). No "System" badge —
   Finance is not a reserved role.
2. Name block: Label **"Role name"** (`text-sm font-medium`) + Input
   (`h-10`, full width, 1px #E7E7EE border, radius ~6px) with value
   **"Finance"**. (Placeholder when empty would be
   "e.g. Admin, Developer, Viewer" — not shown here.) No reserved hint.
3. FormSection: h2 **"Permissions"** (`text-lg font-medium`) + description
   **"Configure access levels for each area."** (`text-sm` muted #525252),
   then content with `gap-4`.
4. **PermissionMatrix** — column `flex flex-col gap-2`; each row:
   `flex items-center justify-between gap-3 rounded-md border bg-card px-3
   py-2` (border #E7E7EE, radius ~6px, row ≈48px tall). Left cluster: lucide
   icon `size-4` muted #525252, label `text-sm font-medium`, then an Info
   icon (`size-3.5`, muted) as tooltip trigger. Right: ToggleGroup —
   three items with `gap-1`, each `h-8 px-3 text-xs font-medium rounded-md`;
   OFF = transparent bg / foreground text (hover bg #F5F5F5); ON =
   bg #E2EBFF, text #1E69DC. Segment labels verbatim: **None** / **Read** /
   **Write**. The seven rows, in real order, with icon + verbatim label +
   the initial selected segment for this short:
   1. **Agents** (Bot icon) — Read
   2. **Routines** (Workflow icon) — None  ← en.json labels the `workflows`
      area "Routines"; do NOT render "Workflows"
   3. **Variables** (Variable icon) — None
   4. **Users** (Users icon) — None
   5. **API** (CodeSquare icon) — None
   6. **Evals** (Brain icon) — None
   7. **Budgets** (Wallet icon) — **Read → clicked to Write** (star of the
      short)
5. Info line directly under the matrix: `rounded-md border` #E7E7EE-muted,
   `bg-muted/30` (≈#F5F5F5 at 30%), `px-3 py-2 text-xs` muted, inline Shield
   icon (`size-3.5`) then verbatim: **"Members of this role see navigation
   changes immediately."**
6. Meta ("Details") block and danger zone exist below in the real panel but
   are below the fold here — do not render them.

**SaveBar** (`save-bar.tsx`; absent until the click, then animates in):
pinned to the card's bottom edge, `border-t` #E7E7EE, bg
rgba(253,253,253,0.95) + backdrop-blur, `px-4 py-3`, single row: left
summary **"You have unsaved changes."** (`text-sm` muted), right two buttons
`gap-2`: **"Discard"** (outline: transparent bg, 1px #E7E7EE border) and
**"Save"** (solid #7033FF, white text), both `h-10 px-4 text-sm font-medium`,
radius ~6px. Entrance: translateY(8px)→0 + fade, 200ms ease-in-out (this is
the real `slide-in-from-bottom-2` behavior).

**Tooltips:** do not open any tooltip in the short — the Info icons are
static affordances only (opening one would be a second interaction).

Canvas 1920×1080. Inter everywhere, tracking -0.025em. #7033FF appears only
on the Save button and the H1 em word. Cursor + motion conventions identical
to the 07-07/07-08 shorts (power2.out, 150–350ms, no bounce, no glow).

## Code snippet decision

**Yes — GraphQL.** The seven permission areas are real fields on the roles
mutation — the editor's own save path. Excerpt of the actual operation
(trimmed to the field the short touches), from
`frontend/app/(application)/users/queries.ts`:

Anchor line: "Permissions are plain role fields — grant them via GraphQL:"

```graphql
mutation UpdateUserRole($id: ID!, $budget_management: String) {
  rolesUpdateOneById(
    id: $id
    input: { budget_management: $budget_management }
  ) {
    item {
      id
      name
      budget_management
    }
  }
}
```

(12 lines, real operation and field names; values are `"read"`, `"write"`, or
`null` for None. The full operation also takes `$agents $workflows $variables
$users $api $evals` — same `String` shape.)

## Page prose within this feature's section (beyond the video)

- The matrix replaced the legacy roles dialog: ~1400px of stacked permission
  cards collapsed into ~320px — the entire access model of a role fits one
  viewport, inside a 448px side panel.
- Each row's info tooltip carries the area's scope, verbatim from
  `access.roles.permissionAreaDescriptions`: Agents "AI agents and their
  configurations.", Routines "Routines and their runs.", Variables
  "Environment variables and secrets.", Users "User management and roles.",
  API "API access and management.", Evals "Evaluation sets, test cases, and
  eval runs.", Budgets "Spend budgets for users, roles, teams, projects, and
  agents."
- Reserved roles (`admin`, `default`) are protected: "System" badge, locked
  name field ("System roles cannot be renamed."), disabled delete ("System
  roles cannot be deleted.").
- Changes propagate instantly — "Members of this role see navigation changes
  immediately." — and deleting a role keeps member accounts but revokes its
  grants (confirm dialog: "The role \"{name}\" will be deleted permanently.
  Members of this role keep their accounts but lose its grants. This cannot
  be undone.").
- Legacy permission strings still render correctly: the matrix normalizes any
  stored value by keyword (write/create/update/delete → Write; read/view →
  Read), so old roles show up faithfully in the new control.
