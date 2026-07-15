# Page prose — ADMIN & THEMING (non-video sections)

Part of `releases/2026-07-08-admin-and-theming/`. Every fact below was
verified in the frontend code on 2026-07-08 (paths relative to
`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`). All quoted strings
are verbatim from `messages/en.json` or the component source. Format
reference: `releases/2026-07-08-platform-roundup/index.html` (kicker → h2 →
one-liner → 2–3 paragraphs, snippet only where earned).

One snippet on the whole page: the /token cURL (section 4). The
`usersCreateOne` GraphQL for API keys was already published in
platform-roundup's `api-key-scoping` section — do not repeat it.

---

## 1. Theme CSS import/export — "Paste a stylesheet, ship a brand"

Sources: `app/(application)/configuration/components/import-css-dialog.tsx`,
`components/theme-studio.tsx`, `components/theme-editor.tsx`,
`theme-defaults.ts`, `messages/en.json → configuration.*`.

Prose (2–3 sentences):

The Theme studio's overflow menu now round-trips whole themes as CSS. Paste
any stylesheet with `:root` and `.dark` blocks into **"Import theme CSS"** and
the dialog parses it live, before you commit: a running count reads
**"{lightCount} light · {darkCount} dark variables detected"**, unreadable
declarations are listed under a non-blocking warning ("N lines couldn't be
read and will be skipped:"), and a missing-block paste gets the honest hint
**"No :root or .dark block found — paste a complete CSS theme."** Variables
the manifest doesn't know don't get dropped — they land in a trailing,
fully editable **"Custom"** group, and the editor flips to "Modified only" so
you see exactly what arrived. Going the other way, **"Export CSS"** puts the
published theme on the clipboard ("CSS copied to clipboard"), and **"Show raw
configuration"** reveals the stored overrides as copyable JSON ("Stored
configuration (JSON)") next to the generated stylesheet ("Generated CSS
(published theme)") — deliberately the *live* theme, never the unpublished
draft.

Verified details for the writer:
- Import merges into the draft; nothing changes for users until publish. The
  dialog description says so verbatim: "Paste a full CSS theme with :root and
  .dark blocks. Detected variables merge into your draft — nothing changes
  for users until you publish."
- Import button label: "Import"; success toast: "Theme imported" / "N
  variables merged into your draft — review, then publish."
- Menu labels (verbatim): "Import CSS…", "Export CSS", "Show raw
  configuration" / "Hide raw configuration", "Reset to defaults…".
- Raw-view copy buttons: "Copy JSON", "Copy CSS".
- Parser is synchronous (no artificial delay), first `:root`/`.dark` block
  only.

No snippet — the video section (theme-studio.md) carries this feature's
visuals.

## 2. Variables vault — "Secrets that stay in the vault"

Sources: `app/(application)/variables/create/page.tsx`,
`components/variable-detail-panel.tsx`, `components/columns.tsx`,
`components/variable-list.tsx`, `edit/[variable_id]/page.tsx`,
`queries/queries.ts` (GET_VARIABLES_LIST ~line 1258, GET_VARIABLE_VALUE
~line 1345), `components/primitives/secret-field.tsx`,
`messages/en.json → variables.*`.

Prose:

The rebuilt `/variables` vault treats every value as sensitive by default.
New variables are created as **"Secret — encrypted at rest"** unless you
explicitly pick "Plain text — stored as-is", and the list page never receives
values at all — `GET_VARIABLES_LIST` selects only name, type, and timestamps,
while a reveal in the detail panel fetches the value on demand through
`GET_VARIABLE_VALUE` under `fetchPolicy: "no-cache"`, so the secret never
lands in the client cache. Revealed values re-mask themselves after 30
seconds ("Value revealed for 30 seconds."), copying works without revealing,
and edits that can break things downstream — renaming, or downgrading a
Secret to plain text — go through a change-impact confirmation first:
**"Renaming \"{oldName}\" to \"{newName}\" will break any agent or model that
references the old name."** and **"Switching from Secret to Plain stores the
value without encryption — consumers that decrypt it may break."**

Verified details:
- Create form: Type is a RadioGroup, `encrypted: true` is the default
  (create/page.tsx:54). Secret option description: "Encrypted at rest.
  Recommended for API keys, tokens, and passwords."
- Plain values still go through the same on-demand fetch, with the warning
  "Stored without encryption. Use only for non-sensitive values."
- SecretField: `remaskAfterMs={30_000}`, `canCopyWithoutReveal` (detail
  panel, variable-detail-panel.tsx:217-223).
- Edit-page ConfirmDialog title: "Save changes?"; rename bullet adds
  "Renaming may break # referencing resources." + a "View usage" link when
  usage data exists.
- Page description (verbatim): "Secrets and environment variables your
  models, agents, and integrations depend on."

DO NOT claim usage tracking works. The backend `used_by` field has not
shipped (queries.ts comment: "Backend Backlog BE-1");
`variable-list.tsx:24` hardcodes `usageAvailable = false`, so the list's
"Used by" column renders **"Usage unavailable"** and the detail panel
degrades to **"Usage tracking is not yet available from the backend."** If
mentioned at all, frame it as honest degradation (the UI never fakes "0
resources"), not as a feature.

No snippet.

## 3. API keys — "Credentials with a paper trail"

Sources: `app/(application)/keys/components/keys-view.tsx`,
`components/key-create-dialog.tsx`, `components/key-detail-panel.tsx`,
`hooks.ts`, `queries.ts`, `messages/en.json → keys.*`.

Prose:

The `/keys` page is now a live audit surface: the table polls every 30
seconds (`pollInterval: 30_000`, hooks.ts:37,142), so "Last used" is current
— and a credential that has never authenticated wears a **"Never"** badge,
which the code itself calls an audit signal. Creating a key is a two-step
wizard in one dialog: step one names the key and picks a scope from two
option cards — **"Admin"** ("Full access. Currently acts as a super admin,
regardless of the selected role.") with a role selector, or **"Agents"**
("Read-only access to the agents on the allowlist.") which replaces the role
field with an agent-allowlist builder — and step two reveals the key exactly
once, with Esc, outside-click, and the close button all disabled until you
press Done: **"This key is shown only once — copy it now and store it
securely. You won't be able to view it again."** Click any row and the detail
panel opens with the log-matchable mask (`sk_…/production` — "The suffix
after “sk_…/” identifies this key in logs."), role reassignment behind its
own confirmation ("Change role?"), and revocation in a Danger zone:
"Requests using this key stop working immediately."

Verified details:
- Plaintext is CSPRNG-generated client-side (`sk_<13>_<13>` base36,
  hooks.ts:165) and bcrypt-hashed before the mutation; the plaintext is
  returned exactly once from `createKey`.
- The list query (GET_API_KEYS) deliberately never selects `apikey` or the
  synthetic `email` (which embeds the credential hash) — safe to state as
  "the hash never travels to the browser list".
- Optional team/project attribution selectors exist on create + detail
  ("Requests made with this key are attributed to the chosen team and/or
  project for cost tracking.") — fine to mention in passing.
- Empty state: "No API keys yet" / "Create one to call the IMP API from your
  services."
- Cross-link at the page foot: "Looking for your personal token?" →
  "Personal token".

Honesty constraint: admin-scope keys currently ignore the selected role. The
UI says it verbatim — "Admin keys currently act as a super admin — the
selected role does not restrict them yet." Do not claim role-restricted
admin keys. The agents-scope backend enforcement was already announced in
platform-roundup (`api-key-scoping`) — reference it ("the scoped keys
announced yesterday now have a proper cockpit"), don't re-announce, and do
NOT reuse the `usersCreateOne` GraphQL snippet.

## 4. Personal token /token — "Your bearer token, five seconds flat" (SNIPPET)

Sources: `app/(application)/token/components/token-view.tsx`, `token/hooks.ts`,
`messages/en.json → token.*`.

Prose:

The `/token` page is a single card built for one job: grab a working bearer
token fast, without ever burning it onto the screen. The token sits in a
masked SecretField — copy works without revealing — and an expiry chip
decodes the JWT's `exp` claim into an honest status: quiet green while more
than an hour remains ("Expires in {hours} h"), orange under an hour
("Expires in {minutes} min"), red once dead ("Expired — sign in again"). A
collapsed **"Usage example (cURL)"** disclosure carries a copyable request
with your deployment's backend URL pre-filled — and the token stays a
placeholder in the snippet, because the page never renders the secret in
plain text.

Snippet — EARNED (this is the literal on-page developer surface,
token-view.tsx:69-77, backend URL injected from config):

```bash
curl -X POST $EXULU_BACKEND/graphql \
  -H "Authorization: Bearer $EXULU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ agentsPagination(page: 1, limit: 10) { items { id name } } }"}'
```

Verified details:
- Page copy: title "Personal token", description "Your bearer token for the
  IMP API.", security note "This token acts as you. Keep it private.", sent
  as `Authorization: Bearer <token>`.
- The chip is static by design (source comment: "a visibly ticking countdown
  is anxiety, not transparency").
- No-token and unauthenticated states are EmptyStates with a "Sign in again"
  action.

## 5. Analytics lens — "Analytics that live in the URL"

Sources: `app/(application)/analytics/lens.ts`,
`components/breakdown-chart-card.tsx` (CSV export ~lines 253-310),
`components/range-picker.tsx`, `components/donut-view.tsx`,
`messages/en.json → analytics.*`.

Prose:

Every view of `/analytics` is now a URL. The lens — date range, measure,
dimension, chart view — serializes into query params, so the exact slice
you're looking at is shareable and refresh-safe: preset ranges **24h / 7d /
14d / 30d** plus a **Custom** calendar range (capped at 30 days, "Maximum
range: {days} days"), a **"View by"** dimension picker across **Agents ·
Users · Projects · Teams · Roles · Routines**, and a Breakdown card that
flips between a ranked **"List"** and a **"Share"** donut. **"Export CSV"**
downloads the current breakdown as an entity-by-day pivot — top-10 entities
as rows, one zero-filled column per day in the window plus a Total, names
hydrated from IDs, and a UTF-8 BOM prefix "so Excel opens UTF-8 cleanly"
(that comment is in the source).

Verified details:
- `RANGE_PRESETS = ["24h", "7d", "14d", "30d", "custom"]`, default 14d;
  `DIMENSIONS = ["agents", "users", "projects", "teams", "roles",
  "routines"]`; `BREAKDOWN_VIEWS = ["list", "share"]` (lens.ts:26-43).
- Deep-link degradation is honest and toasted: an over-30-day custom range
  resets with "The deep-linked range exceeded 30 days and was reset to the
  last 14 days."; legacy `?type=` params remap or drop with a visible toast.
- CSV filename: `analytics-{dimension}-{measure}-{start}-{end}.csv`; spend
  cells keep 6 decimals.
- Legacy alias honored: `?measure=count` → requests.

Already announced — reference, don't re-announce: the KPI strip and the
"+ $x.xx unattributed" spend hint shipped in platform-roundup
(`unattributed-spend-hint` section explicitly covers "the analytics KPI
strip"). One clause like "the KPI strip announced this morning now sits on
top of a fully URL-driven lens" is the ceiling.

No snippet (a shareable URL example in prose is enough; don't fabricate one).

## 6. GraphQL explorer — "The whole API, signed in as you"

Sources: `app/(application)/explorer/page.tsx`, `explorer/graphiql.tsx`.

Prose:

`/explorer` embeds a full GraphiQL workbench against your deployment's
`/graphql` endpoint — schema docs, autocomplete, query history, the works.
Your session token is injected automatically (`Authorization: Bearer …` from
the live session, graphiql.tsx:59-63), so every query you run executes with
your real permissions: what you can read here is exactly what your
integrations can read with the same credentials, making it the honest
sandbox for API work before you mint a key.

Verified details:
- Server-side route guard (`guardRoute("explorer")`) — in practice this
  gate resolves to super-admins today (page.tsx comment: "Until the backend
  populates `api` in serverSideAuthCheck's role object this collapses to
  super_admin in practice"). Say "admin surface" rather than promising
  role-based access.
- No custom chrome worth quoting — the page is the stock GraphiQL UI.

No snippet.

## 7. n8n embed — "Automation, embedded (honestly)"

Sources: `app/(application)/n8n/page.tsx`, `n8n/n8n-client.tsx`,
`messages/en.json → n8n.*`.

Prose:

The **Automation** page embeds the full n8n editor in an iframe sized to the
remaining viewport — clipboard access allowed, a skeleton overlay until the
canvas loads, and a ghost **"Open in new tab"** escape hatch — whenever
`N8N_URL` is configured on the server. Below desktop widths the page refuses
to ship a cramped 390-px canvas and says so instead: **"The n8n editor needs
a larger screen"**, with "Open the editor in a new tab on desktop to build
and debug automations." and the same open-in-new-tab action as the way out.

Verified details:
- Page copy: title "Automation", description "Build and run automations in
  the embedded n8n editor."
- Unconfigured state: the route guard denies access when `N8N_URL` is unset;
  the defensive client empty state reads "Automation is not configured" /
  "Set N8N_URL on the server to enable the embedded editor."
- Route gate: super-admin or workflows read permission AND n8n enabled
  (page.tsx doc comment).

No snippet.

## 8. Projects workspace — "A place you work, not a record you administer"

Sources: `app/(application)/projects/components/project-detail-view.tsx`,
`components/files-tab.tsx`, `hooks.ts` (MAX_PROJECT_ITEMS = 15, line 45;
totalCount from pageInfo.itemCount, line 264), `messages/en.json →
projects.*`.

Prose:

Project detail pages are organized into three URL-backed tabs — **Sessions ·
Files · Settings** — so every section is linkable, refresh-safe, and
back-button-steppable. The Files tab pins shared knowledge for every session
in the project, with a live counter on the tab itself (**"{count} / {max}
files"** badge, e.g. `7/15`) and a hard, atomic 15-item cap: overshooting an
add tells you exactly what happened ("Only # slots left — nothing was
added.") and at the limit the button disables with "This project has reached
the limit of 15 files. Remove one to add another." Deleting a project is a
cascade you configure with your eyes open — checkboxes for **"Also delete
all files"** and **"Also delete all sessions"** carry live counts (sessions
from `pageInfo.itemCount`, not just loaded rows), and the amber warning
recomputes per selection: "# files and # sessions will be permanently
deleted with the project."

Verified details:
- Dialog copy: "Delete project?" / "\"{name}\" will be permanently deleted.
  This cannot be undone. Sessions you don't delete are kept and detached
  from the project."
- Tab switches push history entries; sub-state (`?edit=1`) replaces.
- Files empty state: "No files yet" / "Pin knowledge items to share them
  with every session in this project."
- Orphaned pins are surfaced honestly: "Item no longer exists" / "It was
  deleted from its knowledge context. Remove it to free a slot."
- Header keeps the quiet trust line "Instructions active · View" when custom
  instructions are set.

Already announced — reference only: the ⋯ menu's tool-config downloads
("Download Cowork config" / "Download Claude Code config" / "Download
continue.dev config") shipped in `releases/2026-07-07-tool-configs`. At most
a half-sentence ("alongside yesterday's tool-config downloads"), no
re-announcement.

No snippet.

---

## EXCLUDED (not shipped or not verifiable — do not claim)

1. **Variables usage tracking (`used_by`)** — backend field not shipped
   (Backend Backlog BE-1). `variable-list.tsx:24` hardcodes
   `usageAvailable = false`; the UI renders "Usage unavailable" / "Usage
   tracking is not yet available from the backend." today. Only the honest
   degradation may be described.
2. **Role-restricted admin API keys** — the selected role does not restrict
   admin-scope keys; the UI states "Admin keys currently act as a super
   admin — the selected role does not restrict them yet." Never imply
   role enforcement for admin keys.
3. **CREATE_API_KEY GraphQL snippet** — dropped. The `usersCreateOne`
   mutation with `scope_mode`/`agent_ids` was already published verbatim in
   platform-roundup's `api-key-scoping` section; repeating it would
   re-announce. The /token cURL is the page's one snippet instead.
4. **Analytics KPI strip + unattributed-spend hint** — already announced in
   platform-roundup (`unattributed-spend-hint`); reference in one clause at
   most.
5. **Projects tool-config downloads** — announced 2026-07-07
   (`releases/2026-07-07-tool-configs`); reference only.
6. **API-key agent-scoping backend enforcement** — announced in
   platform-roundup (`api-key-scoping`); the /keys section sells the UI on
   top of it, not the enforcement itself.
7. **Role-based /explorer access (`api:write` gate)** — the guard collapses
   to super_admin in practice until the backend populates `api` in
   `serverSideAuthCheck` (explorer/page.tsx comment); do not promise
   role-level gating.
8. **Theme import of nested/multi-block CSS** — the parser reads only the
   first `:root` and `.dark` blocks, no nested braces (documented deliberate
   limit); do not claim "any CSS file".
