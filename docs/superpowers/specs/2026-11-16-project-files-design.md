# Project files — design

Date: 2026-11-16. Scope: backend (`develop`) and frontend (`main`). First of two projects; the second (the Metzler & Vater pitch agent moving onto it) gets its own design.

## Intent

Session files are private to one session. Teams that work on one matter across many sessions and several people (a pitch, a tender, a case) have nowhere to put the documents once so that every session on that matter sees them. Today such customers build their own storage and tools beside the platform; M&V did, and it confuses their users.

A project gets a shared file folder. Every chat session that belongs to the project sees those files — in the agent's working directory, through the standard document tools, and in the files sidebar — without copying them into the session. Access follows the project's existing RBAC.

Guiding rule from the product owner: simplify, and use the platform's standard building blocks (agent, projects, skills, default tools) instead of per-customer constructions.

## Goals

- A file folder per project, readable by project readers and writable by project writers.
- In a project session the agent can list, read, parse and view project files with the existing tools, and sees them in its sandbox.
- The files sidebar shows two clearly separated areas in a project session: project files and session files, each with its own upload zone.
- A session file can be promoted into the project folder — by a click in the sidebar or by asking the agent.
- Files the agent produced are marked as such, in both areas.
- The project page gets a place to manage the folder outside a chat.
- Sessions without a project behave exactly as today.

## Non-goals

- No change to who can open a project's sessions. Sessions stay private to their owner unless shared the existing way. (The dialog copy claiming members can view project sessions is wrong today and stays a follow-up.)
- No processing on upload: no OCR, chunking or embedding of project files. Reading is on demand through the existing tools. Project files are not a knowledge base; `project_items` stays what it is.
- No folders inside the project folder, no versioning, no rename, no per-file permissions.
- No uploader identity ("who uploaded this"). Origin is only agent vs. user.
- No fix of the session-RBAC quirks found during recon (see Follow-ups), beyond not repeating them.
- Public/guest chats get nothing.

## Anti-goals

- A project file must never be readable by someone without read access to the project — including through the generic `/s3/download` route, which today serves any key that has no `user_` segment.
- The agent must not write into the shared folder as a side effect of running a command. Shared state changes only through an explicit promote.
- A session must never show another project's files, and a session detached from its project must stop seeing them on the next turn.
- No silent overwrite of a colleague's file.

## Approaches

1. **Project folder as a platform feature (chosen).** Own storage prefix, own routes and access helper, visible in project sessions. Removes the need for customer-side storage and tools; useful to every customer. Cost: real work in both repos.
2. **Documents as knowledge-base items pinned to the project.** Uses only what exists (`project_items`). But a chat upload does not land there, so users would need the data UI or a special tool — the confusing part stays.
3. **Only move the upload into the chat, keep customer storage.** Smallest change, keeps every custom construction and does not solve sharing.

The product owner picked 1: it is the only one that actually reduces custom building.

Within 1, two sub-decisions (my calls, see "Calls made"):
- Origin marking via S3 object metadata set by the agent-side writer, not a new database table.
- The agent sees the project folder read-only; writing into it is the promote action only.

## Current state (verified 2026-11-16)

- Session files are pure S3, no table: `[<s3prefix>/]user_<ownerId>/sessions/<sessionId>/<name>` (`src/exulu/session-files.ts:20`, duplicate in `routes.ts:4695`). Routes at `routes.ts:4770-5121` (list, upload-sign, sync-to-sandbox, delete, preview-pdf, adopt), auth via `loadAuthedSession` (`routes.ts:1773`).
- Sandbox: `/tmp/exulu-sessions/<sid>` (`ee/invoke-skills/create-sandbox.ts:535`); `restoreArtifactsFromS3` syncs the session prefix in on cold start and every turn (`:328-387, 525-531`); everything the agent writes outside `skills/` is uploaded to the session prefix (`isArtifactPath`, `persistArtifactToS3`, bash snapshot diff, `:276-286, 842-886, 1058-1142`). Deletions are never propagated to the local directory.
- Tools `read_session_file`, `parse_document`, `view_document_page` build keys from the session prefix and reject `/` in filenames (`src/templates/tools/*`). `parse_document` yields page markers for PDF always, for Office files only when `attachments.documentProcessor` is configured.
- The per-turn prompt lists session files (max 25) and states they are "NOT visible in other sessions, projects, or knowledge bases" (`generate-stream.ts:520-536, 956-976`).
- Projects: `projectsSchema` (`core-schema.ts:207`), `RBAC: true`, entity name in the `rbac` table is the singular `project`. `agent_sessions.project` (uuid) is set by the project page's "New session" dialog; the session's project already reaches `convertExuluToolsToAiSdkTools` (`:195`) but not the sandbox. There is no "can this user read/write this project" helper.
- `checkRecordAccess` requires an exact rights match: a user granted `write` fails a `read` check (`src/utils/check-record-access.ts:63/85/107`).
- `/s3/download` allows any authenticated user for keys without a `user_` segment (`src/uppy/index.ts:620-627`); `/s3/delete` has no such rule.
- Frontend: sidebar `app/(application)/chat/components/session-files/*` (flat list, one upload zone, polling every 5 s), client `lib/api/session-files.ts`; project page tabs `sessions|files|settings` where "files" is the `project_items` curation (`projects/components/files-tab.tsx`).

## Design

### Storage

- Key: `[<s3prefix>/]projects/<projectId>/files/<name>`. Flat; names sanitized with the existing `sanitizeFilename`.
- One helper `projectFilePrefix(projectId, config)` next to `sessionFilePrefix`; no second copy in the routes.
- `/s3/download`, `/s3/delete` and `/s3/list` refuse any key under `projects/` for everyone except API keys and super admins. Project files are only served through the project routes, which return presigned URLs.

### Access

- New helper `loadAuthedProject(req, res, projectId, "read" | "write")`, modelled on `loadAuthedSession`: authenticate, load the project, `RBACResolver(db, "project", id, rights_mode)`, then check access where **write implies read**. Creator, super admin and `rights_mode: "public"` behave as everywhere else.
- Without the RBAC licence `RBACResolver` reports `public`; project files are then open to every authenticated user, consistent with the rest of the platform in that edition.

### Routes (`/projects/:projectId/files…`)

- `GET` (read): same payload as the session listing plus `origin`.
- `POST upload-sign` (write): body `{ filename, contentType, overwrite? }`. If the name exists and `overwrite` is not true → 409 with the existing file's `lastModified`. The 50 MB per-file cap is enforced by the client only, exactly as for session files today; promote enforces its caps on the server.
- `DELETE ?key=` (write), `GET preview-pdf` (read): as for sessions, with the project prefix check.
- `POST promote` (write on the project **and** write on the session): body `{ sessionId, keys[], overwrite? }`; copies session files into the project folder, preserving metadata; same caps as adopt (20 keys, 50 MB total), same 409 rule. The source stays in the session.
- Caps: a project folder holds at most 200 files; upload-sign and promote refuse beyond that.

### Origin

- The agent-side writer (`persistArtifactToS3`) sets S3 object metadata `exulu-origin: agent`. User uploads set nothing; absence means `user`. Copies (adopt, promote) preserve metadata.
- Listings return `origin: "agent" | "user"` for session and project files. Reading metadata costs one HEAD per object; cache it in memory keyed by key + lastModified so the sidebar's 5-second poll stays cheap.

### In a project session: the agent

- The session's project is resolved each turn. If the session owner has read access to the project, the project folder is available; otherwise it is as if the session had no project.
- Sandbox: project files appear under `project/` in the working directory, synced in on cold start and on every turn like session files, **including deletions**. The agent may not change the shared folder through that path: whatever it writes under `project/` is not uploaded and is replaced on the next sync. The tool descriptions and the prompt say so.
- Tools: `read_session_file`, `parse_document`, `view_document_page` accept `project/<name>` as filename and then read from the project prefix; plain names keep meaning the session.
- New standard tool `save_to_project({ filename, overwrite? })`, registered only in project sessions where the speaker has write access to the project: promotes one session file. It requires approval like other write tools.
- Prompt: a second listing block "Project files (shared with everyone on project <name>)" with the same 25-entry cap and NEW marker; the paragraph that says session files are not visible to projects is reworded to explain the two scopes and how a file gets from one to the other.

### In a project session: the sidebar

- Two sections. "Project · <name>" on top with a tinted header and a team icon, "This session" below. Each has its own upload zone; the whole-conversation drop target keeps uploading to the session.
- Project section is read-only (no upload zone, no delete) for users without write access.
- Session rows get an action "Add to project" for users with write access; on a name clash a confirm asks before overwriting.
- Files with `origin: "agent"` carry a small agent icon and the tooltip "Created by the agent", in both sections.
- The privacy note becomes per-section: session files are private to this session; project files are visible to everyone with access to the project.
- Header chip and "@" autocomplete include project files, the latter labelled with the section.
- Sessions without a project show the panel exactly as today.

### Project page

- New tab "Files" managing the folder with the same row, upload and preview components (made scope-agnostic: session or project). The existing `project_items` tab is renamed "Knowledge" (`?tab=knowledge`).

## Edge cases

| Case | Behaviour |
|---|---|
| Session detached from its project | Next turn: no project listing, `project/` removed from the sandbox, tools refuse `project/…` |
| Speaker in a shared session lacks project read | Project availability follows the **session owner** for sandbox content (one sandbox per session) but the **speaker** for `save_to_project`; listing routes always check the caller |
| Two users upload the same name | Second gets 409 and a confirm; nothing is overwritten silently |
| File deleted from the project while a session is open | Disappears from the sidebar on the next poll and from the sandbox on the next turn |
| Project deleted | The routes answer 404 from then on, so the files are unreachable. Removing the objects is a follow-up sweep; the generic delete mutation is not touched here |
| Agent without sandbox | Tools still read project files (they read S3 directly) |
| More than 25 project files | Prompt lists 25 newest and says how many more exist |

## Calls made (not decided by the product owner)

- S3 metadata for origin instead of a table; no uploader identity.
- Read-only `project/` for the agent, promote as the only write path, approval on `save_to_project`.
- 200-file cap per project; flat names.
- Tab rename on the project page.
- Closing `/s3/download` for `projects/` keys rather than relying on unguessable keys.

## Left to the builder

- How `project/` is materialised in the sandbox (per-session copy excluded from write-back, or a shared read-only directory) as long as the behaviour above holds, including sandbox policy and path resolution.
- Component split in the frontend, exact tint and icons within the existing design system (no violet).
- Cache shape for origin metadata.

## Settled after the builder check (2026-11-16)

1. **Generic S3 routes.** `/s3/sign`, `/s3/params` and `/s3/multipart*` mint their own keys (`user_<id>/…` or `global/…`), so they cannot address `projects/`. `/s3/object` requires an API or internal key. `/s3/download`, `/s3/delete`, `/s3/list` get the `projects/` refusal described above. **`/s3/sts` is the exception and a pre-existing hole:** it hands any authenticated user credentials with `s3:PutObject` on the whole bucket (`src/uppy/index.ts:465-477`), which already lets a user overwrite other users' session files. This work narrows that policy to the caller's own `user_<id>/*` prefix (and `global/*` if the frontend needs it — verify the only consumer first). Without it the write side of project RBAC is decorative.
2. **Promote and the session check.** Promote and `save_to_project` use `loadAuthedSession(…, "write")` as it is. The session's creator always passes, which covers the real case; the RBAC quirks only affect shared sessions and stay a follow-up.
3. **Metadata on copy.** `copyS3Object` must keep metadata (`MetadataDirective: "COPY"`, the S3 default); a test pins that `exulu-origin` survives adopt and promote. Browser PUTs carry no metadata by design — absence means `user`.
4. **`project/` in the sandbox.** The top-level name `project` is reserved in project sessions: nothing under it is written back, and whatever the agent puts there is replaced on the next sync. Deletion sync applies to `project/` only; session-file sync is unchanged. In sessions without a project the name has no special meaning.
5. **Access helper first.** The first task proves `RBACResolver(db, "project", …)` plus the write-implies-read check against creator, granted reader, granted writer, outsider, `public` and no-licence, before any route builds on it.

## Testing

- Unit: prefix helper; access helper (read/write/creator/public/no licence; write implies read); promote planning (caps, clash, traversal); `/s3/*` refusal for `projects/` keys; origin mapping; tool filename routing.
- Integration: project routes with two users (reader, writer, outsider); a project session turn shows both listings; detach removes access.
- Frontend: sidebar sections by session.project and rights; promote flow with clash; origin badge; project page tab.
- Manual: two browsers, two users, one project; upload in one, read by the agent in the other's session.

## Follow-ups (not part of this)

- Project members' access to project sessions (`check-record-access.ts:118` todo; misleading dialog copy).
- `loadAuthedSession` passes the plural entity name to `RBACResolver`; exact-match rights rule for sessions.
- Project `custom_instructions` never reach the system prompt (only retrieval).
- Tool-output offload writes under the speaker, not the session owner.
- M&V stage 2: one project per pitch, pitch record pinned to the project, removal of the custom upload, document context and tool.
