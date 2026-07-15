# Page prose — prompt & skill libraries (non-video sections)

Part of `releases/2026-07-08-prompt-and-skill-libraries/`. Every fact below was
verified in code on 2026-07-08; every quoted string is verbatim from
`frontend/messages/en.json` or the component source. Paths are relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend` unless prefixed
`backend/`.

## Sources of truth

- `/prompts` list: `app/(application)/prompts/components/prompts-view.tsx`,
  `app/(application)/prompts/hooks.ts` (`PROMPTS_PAGE_SIZE = 50`,
  `SEARCH_DEBOUNCE_MS = 300`)
- Prompt detail: `app/(application)/prompts/components/prompt-detail.tsx`,
  `app/(application)/prompts/[id]/page.tsx`, `[id]/detail-client.tsx`
- Prompt editor: `app/(application)/prompts/components/prompt-editor-modal.tsx`
  (`MAX_TAGS = 5`), `lib/prompts/build-version-history.ts`
  (`SQUASH_WINDOW_MS = 5 * 60 * 1000`, `HISTORY_CAP = 50`)
- `/skills` list: `app/(application)/skills/components/skills-view.tsx`,
  `app/(application)/skills/hooks.ts` (`SKILLS_PAGE_SIZE = 50`, 300 ms debounce)
- Skill detail: `app/(application)/skills/components/skill-detail-panel.tsx`
  (`PREVIEW_LINES = 15`), `lib/api/skills.ts`
- Create skill: `app/(application)/skills/components/create-skill-dialog.tsx`
- REST export: `backend/src/exulu/routes.ts:3509`
  (`GET /skills/:skillId/download`)
- Copy: `frontend/messages/en.json` → `prompts.*`, `skills.*`

---

## 1. /prompts — the whole library on one screen

**Section title: "Find any prompt in three keystrokes"**

The new `/prompts` page is a split view: a slim, paginated list on the left and
the full prompt document always open on the right. Search is server-side and
debounced at 300 ms, sorting is five-way — "Recently updated", "Recently
created", "Most favorited", "Most used", "Alphabetical" — and a "Filters"
popover stacks a "Favorites only" switch with tag and agent pickers, each
active filter landing as a removable chip above the list. Fifty prompts per
page with a live "{from}–{to} of {total}" footer (e.g. "51–100 of 132"), and
two single-key shortcuts: "/" jumps to search, "N" opens a new prompt.

Verified details for the writer:

- Sort options verbatim (`prompts.sort.*`): "Recently updated",
  "Recently created", "Most favorited", "Most used", "Alphabetical".
- Filters popover: "Favorites only" switch, tag section ("Search tags…",
  heading "Tags", empty state "No tags yet."), agent section
  ("Search agents…", heading "Agents", empty "No agents found."). Trigger
  button label "Filters" with an active-count badge; "Reset" clears all.
- Pagination string verbatim: `"{from}–{to} of {total}"` (en dash). Page size
  is 50 (`PROMPTS_PAGE_SIZE = 50`) — do NOT write "1-25 of 132".
- Shortcuts: "/" focuses the search input; lowercase "n" opens the create
  dialog (write access only). Both ignore typing inside inputs/textareas.
  ⌘K is deliberately left to the global command palette.
- Search placeholder: "Search prompts…". Page header: "Prompts" +
  "Reusable prompt templates with variables — shared with your team and
  surfaced in chat." CTA: "New prompt".
- Empty states: "No prompts yet" / "Create your first reusable prompt — use
  {syntax} for the parts that change." and, when filtered, "No prompts match
  your filters" / "Try a different search, or clear the filters."

## 2. Prompt detail — use it, star it, send the link

**Section title: "Every prompt is one click to use and one link to share"**

The detail pane leads with a "Use prompt" button that copies the content to
the clipboard ("Prompt copied to clipboard.") — and, fixing a long-standing
gap, now actually increments the prompt's `usage_count`, so "Used # times" and
the "Most used" sort finally mean something. A star toggle adds the prompt to
your favorites ("Added to favorites."), and the overflow menu carries
"Copy content", "Copy link", and Delete; "Copy link" puts
`…/prompts/<id>` on the clipboard ("Link copied to clipboard."), because every
prompt now has a full shareable page at `/prompts/[id]` with a
"Back to prompts" link, working Edit, and a post-delete redirect.

Verified details:

- The meta line: "Created by {name}" · relative time · access badge
  ("Private" / "Public" / "Shared with roles" …) · "Used {#} times" ·
  "{#} favorites".
- Usage increment is `INCREMENT_PROMPT_USAGE_INDEX`
  (`prompt_libraryUpdateOneById`, sets `usage_count + 1`) fired from
  `recordUsage()` in `prompt-detail.tsx` after a successful copy — including
  the variable-fill path.
- Favorite toggle resolves the favorite-row id from the user's own favorites
  map before deleting (fixes the legacy double-create that inflated
  `favorite_count`).
- `/prompts/[id]` is a server component fetching `GET_PROMPT_BY_ID`; unknown
  ids render "Prompt not found" / "The prompt you're looking for doesn't
  exist or you don't have permission to view it."

## 3. Prompt editor — one modal for content, variables, and access

**Section title: "Write once, template forever"**

The editor modal is sectioned into "Essentials", "Organize", and
"Sharing & access". A toggle flips the content field between "Plain text" and
"Rich text" (a live-preview markdown editor), while `{{variable}}` tokens are
detected as you type and listed under "Detected variables:" — invalid names
block the save with "Invalid variable names: {names}. Use letters, numbers,
and underscores only." Tags are capped at five ("Up to 5 tags. Use them as
folders (e.g. \"marketing\", \"support\")."), prompts can be assigned to
agents ("Assigned prompts appear as recommendations in chat."), and RBAC
sharing covers private, specific users, roles, teams, or public.

On edit, a change-notes field — "What changed? (optional)" with the hint "A
short note helps teammates understand what changed in this version." — feeds
the version history. History building is pure and predictable: an entry is
appended only when content, name, description, or tags actually changed;
consecutive edits by the same user within 5 minutes are squashed into one
entry; and the timeline is capped at the last 50 versions
(`lib/prompts/build-version-history.ts`).

Verified details:

- Content hint verbatim: "Use {syntax} for dynamic content. Variable names can
  contain letters, numbers, and underscores." plus, in rich-text mode,
  "Markdown formatting is supported."
- Content placeholder: "You are helping {{customer_name}} with their
  {{issue}}…".
- Teams sharing is live (`PROMPTS_RBAC_TEAMS_SUPPORTED = true` in
  `prompts/queries.ts`), including the fix where teams selections previously
  dropped on save.

## 4. /skills — a library, not a maze

**Section title: "Browse skills like files, not like folklore"**

`/skills` gets the same split-view treatment: debounced (300 ms) server-side
search ("Search skills"), a "Filters" popover of tags with removable chips,
and a docked detail panel so the skill you're inspecting stays open while you
scan the list. Pagination shows "{from}–{to} of {total}" at 50 per page, a
count label ("# skills") sits in the toolbar, and "N" opens the create dialog
from anywhere on the page.

Verified details:

- Page header: "Skills" + "Reusable skill packages your agents can load."
  CTA: "New skill".
- Tag filter popover: placeholder "Search tags…", heading "Tags", empty
  "No tags yet."; multiple tags AND together (a skill must carry every
  selected tag).
- Detail is `ListDetail` with `detailMode="panel"`,
  `detailPresentation="docked"` — below the `lg` breakpoint it lifts into a
  sheet. Empty detail: "Select a skill to preview".
- Empty list: "No skills yet" / "Package knowledge and scripts your agents
  can reuse."
- No sort picker is rendered on /skills (the hook has sort state, the UI does
  not expose it) — don't claim one.

## 5. Skill detail panel — read it before you run it

**Section title: "Know what a skill does before an agent loads it"**

Select a skill and the panel shows the actual `SKILL.md`, clamped to the first
15 lines with a "Show {count} more lines" expander — and a warning when it's
absent: "SKILL.md not found" / "Open the editor to create SKILL.md and
document this skill." Below it: inline-editable tags, a compact version
history (current version pinned, last three prior versions, "View all &
compare" deep-linking into the editor), access control, and a stats footer of
"Versions" and "Uses" — with a tooltip that defines the metric: "How many
times this skill has been loaded by an agent." The header overflow menu adds
"Download as .zip" and "Copy skill ID".

The download is a real REST surface, not a UI-only affordance — any
authenticated client can export a skill version as a zip with the folder
structure preserved plus a `version.txt` manifest
(`backend/src/exulu/routes.ts`, `GET /skills/:skillId/download`):

```bash
# Export any skill version as a portable .zip:
curl -H "Authorization: Bearer $JWT" \
  "$EXULU_BACKEND/skills/$SKILL_ID/download?version=3" \
  --output data-analysis-v3.zip
# → folder structure preserved + version.txt
#   (Skill / Skill id / Version / Files / Exported at)
```

Verified details:

- `PREVIEW_LINES = 15` in `skill-detail-panel.tsx`; toggle labels
  "Show {count} more lines" / "Show less".
- Version badge in the header: `v{current_version}`; history rows show
  `v{n}` + optional label + relative time; current row badge: "current".
- Download toasts: "Preparing download…" (menu label while running),
  "Skill download started" / "Couldn't download skill".
- Version omitted from the query string defaults to the skill's
  `current_version` server-side.

## 6. Creating a skill — start blank or bring a bundle

**Section title: "From zero to editable skill in one dialog"**

The "New skill" dialog offers two tabs: "Create blank" and "Create from
upload". Blank creates the record and seeds a templated `SKILL.md` before
dropping you straight into the editor ("Create & open"); upload takes a
drag-and-drop bundle — ".zip (full skill folder) or single .md file" — stages
it to S3 via a presigned URL, and extracts it into version 1. Name,
description, comma-separated tags, and RBAC access are all set in the same
dialog, so a skill is shareable the moment it exists.

Verified details:

- Dialog copy: "New skill" / "Create a skill package. You'll be taken to the
  editor where you can add files and scripts."; dropzone "Drag & drop or
  click to choose"; wrong file type → "Only .zip and .md files are
  supported".
- Blank flow: `CREATE_SKILL` → `skillsApi.init` (`POST /skills/:id/init`).
  Upload flow: `skillsApi.uploadSign` → S3 `PUT` →
  `skillsApi.initFromUpload` (`POST /skills/:id/init-from-upload`); a failed
  extract leaves the empty skill row so the user can retry from the editor.
- IMPORTANT: bundle upload itself (.zip/.md) was announced in the 2026-05-29
  release — reference it as existing ("the .zip/.md upload introduced in
  May"), don't announce it as new. What's new here is the redesigned dialog
  (tabs, dropzone primitive, real RBAC control replacing the mislabeled
  select that silently dropped the RBAC payload).

---

## EXCLUDED — not shipped or not verifiable

- **".skill" file upload, folder upload, agent registry + publish** — spec
  only (backend commit `ad32a6c`, `docs(spec)`); the create dialog accepts
  exactly `.zip` and `.md` ("Only .zip and .md files are supported"). Do not
  mention `.skill` files on the page.
- **"1-25 of 132" pagination example** — wrong on both counts: page size is
  50 for prompts and skills, and the verbatim string is
  "{from}–{to} of {total}" (en dash). Use "1–50 of 132" if an example is
  needed.
- **Full-text prompt search (description/content)** — not shipped;
  `PROMPTS_OR_SEARCH_SUPPORTED = false`, the search filter is
  `name contains` only. Say "search by name", not "search prompt content".
- **Server-side "Favorites only" filter** — the switch exists, but it's a
  client-side intersection applied after the page is fetched (hooks comment:
  backend filter doesn't exist yet). Don't describe it as a server filter or
  imply exact counts under it.
- **Skills sort picker** — `useSkillsIndex` carries sort state, but
  `/skills` renders no sort control. Only prompts get the 5-way sort.
- **Dev console shortcut easter egg** — `console.info` of the "N" + "/"
  shortcuts is development-builds only; not a user-facing feature.
- **"N" shortcut on /prompts for read-only users** — gated by write access
  (`canWrite`); on /skills it is ungated. Phrase shortcut claims per page.
- **Prompt usage from chat insertion** — the chat composer's own
  `useIncrementPromptUsage` path predates this release; the new claim is
  that "Use prompt" in the library now increments too.
