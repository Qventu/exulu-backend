# Page prose — PROJECTS (non-video sections)

Part of `releases/2026-07-08-projects/`. Every fact below was verified in the
frontend code on 2026-07-09 (paths relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`). All quoted strings
are verbatim from `messages/en.json → projects.*` or the component source.
Format reference: `releases/2026-07-08-admin-and-theming/plan/page-prose.md`
(benefit-led title → 2-3 verified sentences → snippet only where a real
developer surface earns it).

Scope note: the create dialog and the Files tab already have full **video**
plans (`plan/new-project.md`, `plan/project-files.md`) — these prose sections
cover the four surfaces those videos don't: the index list mechanics, the
Sessions tab, the Settings tab, and the two reference-only connections. The
one GraphQL snippet the create dialog earns (`CreateProject`, `rights_mode:
"private"`) is already claimed by `new-project.md` — do NOT repeat it here.

---

## 1. Projects index — "Your workspaces, starred and searchable"

Sources: `app/(application)/projects/page.tsx`, `hooks.ts`
(`useProjectsIndex`, `useFavoriteProjects`, `PROJECTS_PAGE_SIZE = 200`),
`components/primitives/favorite-toggle.tsx`, `messages/en.json → projects.*`.

Prose (2-3 sentences):

The `/projects` index is now a standard collection page — the old permanent
ProjectNav sidebar and `projects/layout.tsx` are gone, and switching happens
here or via ⌘K. Starred projects pin to the top under a **"Favorites"**
heading (then **"All projects"**) and appear exactly once — the group hides
while searching so a project never shows up twice — while the star itself is a
`FavoriteToggle` with `aria-pressed` that pops on tap (a 200ms `zoom-in-50`,
reduced-motion safe) and, because rows are stretched links, calls
`preventDefault`/`stopPropagation` so starring never navigates. The single
Toolbar search ("Search projects…") filters on the server through
`GET_PROJECTS` with a `name contains` filter rather than a client scan, an
empty result reads **"No projects found"** / **"Try a different search
term."**, and past the 200-row window a ghost **"Load more"** button appears
whenever `hasNextPage` is true — the old silent 200/50 ceiling finally has a
visible affordance.

Verified details for the writer:
- Favorites are one shared source of truth (a module-scoped store in
  `hooks.ts`) across the list, the detail-header star, and re-navigations; a
  failed toggle reverts only the toggled project (never clobbers a concurrent
  toggle) and toasts **"Couldn't update favorites. Please try again."**.
- Rows stagger in at 20ms/row, capped at 8 (`Math.min(index, 8) * 20`).
- Empty (no projects): **"No projects yet"** / **"Projects keep related
  conversations and files together."** with a "New project" action.
- Page copy: title **"Projects"**, description **"Workspaces that group your
  conversations and shared context."**.

No snippet — the index's one real developer surface is `CreateProject`, which
`new-project.md` already carries verbatim.

## 2. Sessions tab — "Start, remove, undo — the work, not the paperwork"

Sources: `app/(application)/projects/components/sessions-tab.tsx`,
`components/new-session-dialog.tsx`, `hooks.ts` (`useProjectAgents`,
`useProjectSessions`), `queries.ts` (`CREATE_AGENT_SESSION`,
`UPDATE_AGENT_SESSION_PROJECT`, `REMOVE_AGENT_SESSION_BY_ID`),
`messages/en.json → projects.sessions.* / newSessionDialog.*`.

Prose:

The Sessions tab is the L1 surface of a project — "a place you work" — with
each row resolving its agent's real name client-side (a `GET_PROJECT_AGENTS`
join; while unresolved or if the agent was deleted it renders nothing, never a
raw id) and a title that stretches into chat's existing
`/chat/[agent]/[session]` route. **"New session"** opens an agent picker whose
description preserves the trust disclosure **"Choose an agent for the
conversation. Sessions started in a project can be viewed by project
members."**; picking an agent fires `CREATE_AGENT_SESSION` with `project: <id>`
and `rights_mode: "private"`, then jumps straight into the new chat. Each row's
overflow menu carries two RBAC-gated actions (disabled with **"You don't have
write access to this session"** when the user can't write): **"Remove from
project"** detaches immediately and offers an **"Undo"** toast
(**"Session removed from project."**) that re-attaches the same session, while
**"Delete session…"** runs through the shared `ConfirmDialog`
(**"Delete session?"** / **"\"{title}\" will be permanently deleted. This
cannot be undone."**) and, once confirmed, collapses the row over 300ms
(height + fade, reduced-motion safe) before the list reflows.

Verified details:
- Both actions `await` their mutation BEFORE `refetch` (no stale-list race);
  a single `busyId` disables the row's other action while one is in flight.
- Untitled sessions fall back to **"Untitled session"**; **"Load more"**
  appears past the 50-session window (`SESSIONS_PAGE_SIZE = 50`).
- Empty: **"No sessions yet"** / **"Start the first conversation in this
  project."** with a "New session" action.
- Undo failure toasts **"Couldn't restore the session to the project."**;
  delete failure keeps the dialog open (rejecting `onConfirm`) and toasts
  **"Couldn't delete the session. Please try again."**.

No snippet — the mutations here (`CREATE_AGENT_SESSION`,
`UPDATE_AGENT_SESSION_PROJECT`, `REMOVE_AGENT_SESSION_BY_ID`) are verbatim
copies of existing agent-session operations, not a new developer surface worth
publishing on the page.

## 3. Settings tab — "Details, access, and a delete you configure with your eyes open"

Sources: `app/(application)/projects/components/settings-tab.tsx`,
`components/project-detail-view.tsx` (the cascade `ConfirmDialog`),
`components/visibility-badge.tsx`, `hooks.ts` (`useDeleteProjectCascade`,
`useProjectSessions.totalCount`), `components/primitives/confirm-dialog.tsx`,
`components/rbac`, `queries.ts` (`UPDATE_PROJECT`, `DELETE_PROJECT`),
`messages/en.json → projects.settings.* / danger.* / visibility.*`.

Prose:

The Settings tab consolidates the legacy "Project information", "Access
control" and "Project settings" views into three quiet sections — **Details ·
Access · Danger zone** — with only the danger zone carrying a destructive
border. **Details** edits name, description and the custom instructions every
session inherits (in read mode the header shows a quiet **"Instructions active
· View"** line that deep-links here when instructions are set), and **Access**
drives an `RBACControl` across **private / users / roles** whose save finally
reports success/error via toast (**"Access rights saved."**) — Details and
Access each own their own `UPDATE_PROJECT` hook so the two save spinners no
longer animate each other. Deleting a project is a cascade you configure with
your eyes open: the shared `ConfirmDialog` (**"Delete project?"** /
**"\"{name}\" will be permanently deleted. This cannot be undone. Sessions you
don't delete are kept and detached from the project."**) offers checkboxes
**"Also delete all files"** and **"Also delete all sessions"** whose counts are
live — files from the current pinned list, sessions from
`pageInfo.itemCount`, not just the loaded rows — and an amber warning
recomputes per selection: **"# files and # sessions will be permanently
deleted with the project."**.

Verified details:
- The cascade (`useDeleteProjectCascade`) walks ALL session pages, not the 50
  loaded rows: it re-queries page 1 (`network-only`) in a loop, deleting or
  detaching each batch, so no session is stranded pointing at a deleted
  project id; item deletion tolerates orphaned gids (a failed `DELETE_ITEM` no
  longer aborts the cascade). Success toasts **"Project \"{name}\" has been
  deleted."** and routes back to `/projects`.
- Danger-zone frame copy: **"Danger zone"** / **"Deleting a project is
  permanent. Its files and sessions can optionally be deleted with it."**.
- Name is required on save (**"Project name is required."**); empty
  description/instructions display **"No description provided."** /
  **"No custom instructions set."**.
- The header `VisibilityBadge` reads **"Private"** (Lock) or **"Shared"**
  (Users) and links to Settings → Access; the tooltip names the target, e.g.
  **"Shared with {count} users."**.
- Edit mode is URL-backed (`?edit=1`, `router.replace`d) so the ⋯
  "Edit details" deep-link always applies and a refresh never re-opens edit
  mode; tab switches `push` history so Back steps through tabs.

No snippet — `UPDATE_PROJECT` / `DELETE_PROJECT` are verbatim monolith copies,
and the cascade's value is behavioral (all-pages iteration), not a single
publishable call.

## 4. Connections to already-shipped features (reference only, one clause each)

Sources (for verification): `components/project-detail-view.tsx` (the ⋯ menu's
three download items, lines 294-309), `hooks.ts → useProjectConfigDownloads`,
`releases/2026-07-08-project-search-and-budgets/plan/project-search.md`,
`releases/2026-07-07-tool-configs/`.

Reference clauses (do NOT re-announce — half a sentence each):

- **Project knowledge, through agentic retrieval (part 2).** Files pinned in a
  project's Files tab now route through the same 4-phase agentic retrieval
  pipeline as the rest of the platform — this shipped as **project_search**
  and is announced in `releases/2026-07-08-project-search-and-budgets`
  (framed there as "part 2" of `releases/2026-07-07-agentic-retrieval`). Point
  the reader there; the projects page only owns the pinning UI.
- **Tool-config downloads.** The project detail ⋯ menu also offers
  **"Download Cowork config"**, **"Download Claude Code config"** and
  **"Download continue.dev config"** (per-project LiteLLM endpoint +
  credentials), which shipped in `releases/2026-07-07-tool-configs` — mention
  it in one clause ("alongside yesterday's tool-config downloads"), no
  re-announcement.

No snippet — both are reference links to their own releases.

---

## EXCLUDED (not in scope, already covered elsewhere, or not verifiable)

1. **Create dialog + `CreateProject` GraphQL snippet** — has a full video plan
   (`plan/new-project.md`) that already publishes the `CreateProject`
   mutation with `rights_mode: "private"` verbatim; repeating the snippet or
   the create-flow prose here would duplicate it. The index section above
   covers only the list mechanics (Favorites/star/search/Load-more), not the
   dialog.
2. **Files tab (pinning, 15-item cap, `n/15` counter, orphan cards)** — has
   its own video plan (`plan/project-files.md`); out of this prose doc's scope
   except as the surface the project_search reference points at. The
   `MAX_PROJECT_ITEMS = 15` cap and `UPDATE_PROJECT`-with-`project_items`
   contract are documented there.
3. **project_search / project agentic retrieval mechanics** — shipped and
   documented in `releases/2026-07-08-project-search-and-budgets` (part 2 of
   `2026-07-07-agentic-retrieval`); referenced in one clause, not re-explained.
   Do not claim the pipeline internals from the projects page.
4. **Tool-config download file contents** (Cowork / Claude Code / continue.dev
   JSON+YAML, LiteLLM base URLs, model selection) — the generator lives in
   `useProjectConfigDownloads`, but the feature shipped in
   `releases/2026-07-07-tool-configs`; reference only.
5. **Step budgets / max-tool-steps** — a sibling feature in
   `releases/2026-07-08-project-search-and-budgets`, unrelated to the projects
   page UI; do not mention on this page.
6. **`GET_USER_FAVOURITE_PROJECTS` / favorites store internals as a developer
   surface** — real and verified (`queries.ts`), but it is a read used to
   re-anchor the client store, not an API a consumer would call; described as
   behavior in section 1, not published as a snippet.
