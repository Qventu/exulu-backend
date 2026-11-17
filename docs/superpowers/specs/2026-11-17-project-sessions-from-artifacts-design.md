# Project sessions from artifacts, and files written by app tools

Date: 2026-11-17
Status: draft, awaiting approval
Builds on: `2026-11-16-project-onboarding-platform-design.md` (reading store, `create_project`), PRs backend #116 and frontend #21.

## Intent

Customer apps keep their documents in IMP projects and let their agent read them with the standard tools (`parse_document`, `view_document_page`, `read_session_file`). Three gaps stop that today. They were found while moving the M&V pitch agent onto projects (spec in the mevakipi repo, `docs/superpowers/specs/2026-11-17-pitch-auf-projekten-design.md`), but none of them is M&V-specific.

1. An artifact opens the agent panel without a project, so the session cannot see project files.
2. An app tool cannot put a file where the standard tools see it. The `upload` helper in the tool context writes to `<user id>/<generated key>`, outside the session folder.
3. Server-side app code (a migration script) cannot create a project or add a file to it without writing to platform tables directly. `createProjectForUser` exists but is not exported.

## Goals

- An artifact can ask for the panel session to start inside a given project.
- An app tool can save a file into the current session's folder.
- App code can create a project for a user and add files to it through an exported API.

## Non-goals

- No change to who may access a project. All three pieces go through the existing access rules.
- No sharing UI, no automatic sharing.
- No project file listing for artifacts.

## Anti-goals

- An artifact must never learn anything about a project the viewer cannot access, not even its name.
- An artifact must never be able to attach a session to a project the viewer cannot access.

## Approaches

**A. The panel-open request carries a project id (chosen).** The host checks access and starts the session in the project. Standard tools then work unchanged.

**B. An app tool reads project files by its own lookup.** No platform change, but every app rebuilds file access and its own permission check. This is the custom machinery the M&V work is removing.

**C. Artifact buttons deep-link into the platform's project chat.** Nearly free, but the agent no longer sits beside the artifact, which is the point of the panel.

Daniel chose A on 2026-11-17.

## Design

### 1. `exulu:panel:open` with a project (frontend, plus a backend check if none exists)

- `OpenPanelRequest` gains an optional `project: string`. `parseOpenPanelRequest` accepts it only as a strict uuid and drops anything else. `CHANNEL_V` goes from 2 to 3. A v2 request without `project` keeps working unchanged.
- When `project` is present, the host creates the panel session inside that project, the same way the project page starts a chat in a project today. The planner must find that path and reuse it.
- The access decision is made by the backend, with the rule `resolveSessionProject` already applies (project owner or RBAC grant). The frontend never decides.
- `exulu:panel:open:ack` gains `project?: "attached" | "denied"`. `denied` covers both "no access" and "no such project", so the artifact cannot tell them apart.
- On `denied` the panel still opens, with the prompt placed and a session without a project. The artifact decides what to tell the user.
- A panel that already shows a session in another project, or in none, starts a new session for a request with a different `project`. The planner decides how that fits the existing reuse rules in `apply-open-request.ts`.
- Docs: the artifact panel protocol page in `mintlify-docs`.

### 2. `saveSessionFile` in the tool context (backend)

- The options object passed to an app tool's `execute` gains `saveSessionFile?: (file: { name: string; data: Uint8Array | Buffer; }) => Promise<{ name: string } | { error: string }>`.
- It writes into the folder of the session the tool runs in, with the same rules as a user upload: name sanitising, name clash handling, size cap, session ownership. It returns the final file name, which is the name the standard tools take.
- It is undefined when the turn has no session, when file uploads are not configured, for guests, and in routine runs. A tool must handle its absence.
- It writes to the session only. Moving a file into the project stays with `create_project` and `save_to_project`, so approval stays where it is.
- Docs: the custom tools page.

### 3. Exported project API (backend)

- `@exulu/backend` exports `ExuluProjects` with two functions:
  - `create({ name, description?, ownerId })` returns `{ id }`. It wraps `createProjectForUser`: private project, creator gets write.
  - `addFile({ projectId, name, data })` returns `{ name } | { error }`. Same name, size and 200-file rules as `promoteSessionFiles`. No user context: this is for trusted server code.
- Both are documented as server-side APIs for scripts and migrations, not for tools acting on behalf of a user.

## Left to the builder

- How the project page starts a session in a project, and whether a backend check on session creation already exists or has to be added.
- Whether `saveSessionFile` and `ExuluProjects.addFile` share one write helper with the upload routes.
- Test layout. Each piece needs tests for the refusal cases named above.

## Release

Two PRs after #116 and #21 are merged: backend to `develop`, frontend to `main`. The frontend's `ai` pin is not touched.
