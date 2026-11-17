# Project Sessions From Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An artifact can open the agent panel inside a project, an app tool can save a file into its session folder, and app code can create a project and add files through an exported API.

**Architecture:** Three additive pieces. The panel-open message gains an optional `project` field; the frame probes access before it acks and the panel starts a fresh session whenever the mounted session's project differs from the request's. The tool context gains `saveSessionFile`, a thin wrapper over one pure write function. `@exulu/backend` exports `ExuluProjects`, a thin wrapper over the existing `createProjectForUser` and the project file rules.

**Tech Stack:** Backend TypeScript, jest, knex, AWS S3 client. Frontend Next.js, React, Apollo, vitest.

**Spec:** `docs/superpowers/specs/2026-11-17-project-sessions-from-artifacts-design.md` (backend repo)

## Global Constraints

- Prerequisite: backend PR #116 is merged to `develop` and frontend PR #21 is merged to `main`. Both branches start from there.
- Backend work happens in the worktree `../backend-project-sessions`, branch `feature/project-sessions-from-artifacts` from `develop`. Frontend work in `../frontend-project-sessions`, same branch name, from `main`. `node_modules` is symlinked from the primary checkout. Never edit the primary checkouts.
- `CHANNEL_V` stays `2` on both sides. `project` on the request and on the ack are optional fields.
- An artifact never learns anything about a project the viewer cannot open. `denied` is the single answer for "no access", "no such project", "probe failed" and "probe timed out".
- No session row is ever created with a project the probe did not confirm.
- A request without `project` never lands in a session that has a project.
- `saveSessionFile` writes to the session folder only. It never writes to a project.
- The frontend `ai` pin is not touched.
- Run one test process at a time. Backend: `npx jest <path>`. Frontend: `npx vitest run <path>`.
- Backend typecheck gate is an equality: `npm run type-check` reports exactly 8 errors with the same identities as on `develop`. Fewer is a failure too.
- Frontend lint: `npm run lint` reports no new errors. One error in `app/(application)/data` exists on `main` already.
- Commit subjects are at most 100 characters. Commits end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- No push, no PR, no merge without Daniel's word.

## Rulings made while planning

- **Name clash in `saveSessionFile`:** a file of the same name is overwritten. This is what a user upload does (`POST /sessions/:id/files/upload-sign` signs a PUT for the sanitised name). The returned name differs from the input only through sanitising.
- **Docs:** `mintlify-docs` has no artifact panel protocol page. The protocol reference is `src/skills/bundled/imp-artifact-apps/references/identity-handshake.md`, and that is what gets updated. No new mintlify page for the protocol.
- **Template API (Daniel, 2026-11-17: one function, not two):** `openPanel` returns `Promise<{ accepted: boolean; project?: "attached" | "denied" }>` instead of `Promise<boolean>`. Published artifacts carry their own copy of the template and are not affected. An artifact that copies the new template must read `.accepted`: a bare `if (await openPanel(...))` would always be true. The reference says so in bold, and the type is named `OpenPanelResult` so the change shows up in a typecheck wherever the result is typed.
- **`ExuluProjects.create` throws on invalid input, `addFile` returns `{ error }`.** A script creates one project and adds many files; a bad file must not abort the loop.

## Review Focus

1. The probe resolves after the artifact navigated away. Expected: no ack on the retired port, no panel opened. Task 5.
2. Two open requests in quick succession, the first with a slow probe. Expected: only the later request opens the panel; both get their own ack. Task 5.
3. The mounted session points at a project the viewer lost access to, and the artifact asks for that same project. Expected: ack `denied`, a fresh session without project, the old conversation untouched. Task 6.
4. `saveSessionFile` gets a name with a path separator, `..`, or only whitespace. Expected: separators become `_`, the other two return `{ error }`, nothing is written. Task 1.
5. `ExuluProjects.addFile` with `ifExists: "skip"` on a project that already holds 200 files, for a name that exists. Expected: `{ name, skipped: true }`, not the "project is full" error. Task 2.

---

## File Structure

Backend:

- Create `src/exulu/session-file-write.ts`: the pure write rules and the builder for the tool-context function.
- Create `src/exulu/session-file-write.test.ts`.
- Modify `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`: pass `saveSessionFile` into `execute`.
- Create `src/exulu/projects-public.ts`: `ExuluProjects`.
- Create `src/exulu/projects-public.test.ts`.
- Modify `src/index.ts`: export `ExuluProjects`.
- Modify `src/skills/bundled/imp-artifact-apps/templates/imp-channel.ts`, its test, and `references/identity-handshake.md`.
- Modify `mintlify-docs/developers/tutorials/custom-tools.mdx` and `mintlify-docs/developers/core/exulu-tool/configuration.mdx`. Create the page folder `mintlify-docs/developers/core/exulu-projects/` with the same file layout as `mintlify-docs/developers/core/exulu-queues/`, and add it to the navigation in `mintlify-docs/docs.json` next to `exulu-queues`.

Frontend:

- Modify `lib/artifacts/agent-panel-protocol.ts` and its test.
- Modify `app/(application)/chat/hooks.ts` and `app/(application)/chat/components/session-screen.tsx`: a `project` for lazily created sessions.
- Modify `app/artifacts/[artifact_name]/artifact-frame.tsx` and its test: probe before ack.
- Create `app/(application)/artifacts/open/[name]/session-reuse.ts` and its test.
- Modify `app/(application)/artifacts/open/[name]/viewer-client.tsx`, `agent-panel.tsx` and their tests.

---

## Backend

### Task 1: `saveSessionFile` in the tool context

**Files:**
- Create: `src/exulu/session-file-write.ts`
- Test: `src/exulu/session-file-write.test.ts`
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (the `upload` block and the first argument of `cur.tool.execute`, around lines 648 to 756)
- Modify: `mintlify-docs/developers/tutorials/custom-tools.mdx`, `mintlify-docs/developers/core/exulu-tool/configuration.mdx`

**Interfaces:**
- Consumes: `sanitizeFilename`, `sessionFilePrefix` from `src/exulu/session-files.ts`; `MAX_ADOPT_UPLOAD_BYTES` from `src/exulu/session-file-adopt.ts`; `treatAsGuest` from `src/exulu/public-surface.ts`; `uploadFile` from `src/uppy/index.ts`.
- Produces:

```ts
export type SessionFileInput = { name: string; data: Uint8Array | Buffer };
export type SessionFileResult = { name: string } | { error: string };
export type SaveSessionFile = (file: SessionFileInput) => Promise<SessionFileResult>;

export const SAVE_INVALID_NAME = "Invalid filename (no path separators, no '..').";
export const SAVE_EMPTY = "The file is empty.";
export const SAVE_TOO_LARGE = "It is larger than 50 MB.";
export const SAVE_FAILED = "Saving the file failed.";

/** `put` receives the key WITHOUT the general s3 prefix. */
export function writeSessionFile(args: {
  ownerId: number | string;
  sessionId: string;
  file: SessionFileInput;
  put: (key: string, data: Uint8Array | Buffer, contentType: string) => Promise<void>;
}): Promise<SessionFileResult>;

export function buildSaveSessionFile(args: {
  sessionID?: string;
  ownerId?: number | string;
  user?: { id?: unknown };
  req?: { headers?: Record<string, unknown> };
  exuluConfig?: ExuluConfig;
  inRoutineRun: boolean;
}): SaveSessionFile | undefined;
```

- [ ] **Step 1: Write the failing tests** in `src/exulu/session-file-write.test.ts`, with a recording `put`:

  - `writes under user_<owner>/sessions/<session>/<name>`: owner `7`, session `s1`, name `a.pdf` puts key `user_7/sessions/s1/a.pdf` and returns `{ name: "a.pdf" }`.
  - `replaces path separators`: name `a/b\\c.pdf` puts `…/a_b_c.pdf` and returns that name.
  - `refuses '..' and blank names`: `../x.pdf` and `"   "` return `{ error: SAVE_INVALID_NAME }`, `put` not called.
  - `refuses empty data`: zero bytes returns `{ error: SAVE_EMPTY }`.
  - `refuses more than 50 MB`: `MAX_ADOPT_UPLOAD_BYTES + 1` bytes returns `{ error: SAVE_TOO_LARGE }`; exactly `MAX_ADOPT_UPLOAD_BYTES` is written.
  - `reports a failed put`: `put` rejects, result is `{ error: SAVE_FAILED }`, nothing is thrown.
  - `content type follows the extension`: `a.pdf` puts `application/pdf`, `a.unknownext` puts `application/octet-stream`.
  - `buildSaveSessionFile is undefined` for each of: no `sessionID`; `exuluConfig.fileUploads` missing any of `s3endpoint`, `s3key`, `s3secret`, `s3Bucket`; no `user.id`; a request with header `x-public-surface: 1`; `inRoutineRun: true`.
  - `buildSaveSessionFile returns a function` when all of those hold, and uses `ownerId` for the prefix, falling back to `user.id` when `ownerId` is undefined.

- [ ] **Step 2: Run** `npx jest src/exulu/session-file-write.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `writeSessionFile` and `buildSaveSessionFile`.** The key is `sessionFilePrefix(ownerId, sessionId, undefined) + safeName`. The real `put` in `buildSaveSessionFile` calls `uploadFile(data, key, exuluConfig, { contentType }, undefined, undefined, true)`; `global: true` skips the user prefix and `uploadFile` adds the general prefix itself. Content type comes from the extension through the mime helper the `upload` block already uses, with `application/octet-stream` as fallback.

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Pass it into `execute`.** In `convert-exulu-tools-to-ai-sdk-tools.ts`, next to `upload` in the first argument: `saveSessionFile: buildSaveSessionFile({ sessionID, ownerId: sessionOwnerId, user, req, exuluConfig, inRoutineRun: inRoutineRun ?? Boolean(routineHandleFactory) })`. Add one test to `convert-exulu-tools-to-ai-sdk-tools.test.ts` in that file's existing style: a custom tool's `execute` receives a function as `saveSessionFile` in a session with uploads configured, and `undefined` without a `sessionID`.

- [ ] **Step 6: Run** `npx jest src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.test.ts`, then `npm run type-check`. Expected: PASS, and exactly the 8 known errors.

- [ ] **Step 7: Docs.** In both mintlify pages, where `upload`, `sessionID` and `routine` are described, add `saveSessionFile`: what it writes, that the returned `name` is what `parse_document` and `read_session_file` take, the four cases in which it is `undefined`, that a same-named file is replaced, the 50 MB cap, and that moving a file into a project stays with `create_project` and `save_to_project`.

- [ ] **Step 8: Commit** `feat(tools): saveSessionFile writes a tool's file into the session folder`.

### Task 2: `ExuluProjects`

**Files:**
- Create: `src/exulu/projects-public.ts`
- Test: `src/exulu/projects-public.test.ts`
- Modify: `src/index.ts`
- Create: `mintlify-docs/developers/core/exulu-projects/` (layout of `exulu-queues/`); modify `mintlify-docs/docs.json`

**Interfaces:**
- Consumes: `createProjectForUser` from `src/exulu/project-create.ts`; `MAX_PROJECT_FILES`, `projectFilePrefix` from `src/exulu/project-files.ts`; `SKIP_PROJECT_FULL`, `SKIP_TOO_LARGE` from `project-create.ts`; `createPromoteS3` from `src/exulu/project-files-s3.ts`; `uploadFile`; `postgresClient`; `exuluApp` from `src/exulu/app/singleton.ts`; `sanitizeFilename`; the content-type lookup from Task 1 (export it from `session-file-write.ts`).
- Produces:

```ts
export const FILE_EXISTS = "A file with this name is already in the project.";
export const PROJECT_NOT_FOUND = "Project not found.";
export const OWNER_NOT_FOUND = "No user with this id.";
export const UPLOADS_NOT_CONFIGURED = "File uploads are not configured.";

export type AddFileResult = { name: string; skipped?: true } | { error: string };

/** Testable cores, deps injected. */
export function createProjectCore(db: any, input: { name: string; description?: string; ownerId: number | string }): Promise<{ id: string }>;
export function addProjectFileCore(args: {
  db: any;
  projectId: string;
  name: string;
  data: Uint8Array | Buffer;
  ifExists?: "error" | "skip";
  s3prefix?: string | null;
  listProjectNames: (projectPrefix: string) => Promise<string[]>;
  put: (key: string, data: Uint8Array | Buffer, contentType: string) => Promise<void>;
}): Promise<AddFileResult>;

export const ExuluProjects: {
  create(input: { name: string; description?: string; ownerId: number | string }): Promise<{ id: string }>;
  addFile(input: { projectId: string; name: string; data: Uint8Array | Buffer; ifExists?: "error" | "skip" }): Promise<AddFileResult>;
};
```

- [ ] **Step 1: Write the failing tests** with a fake `db` in the style of `src/templates/tools/create-project-tool.test.ts`:

  - `create inserts a private project owned by ownerId`: the inserted row has `created_by: ownerId`, `rights_mode: "private"`; the result is `{ id }` only.
  - `create throws OWNER_NOT_FOUND` when the `users` table has no row with that id, and inserts nothing.
  - `create throws on a blank name` (the error of `createProjectForUser`).
  - `addFile puts projects/<id>/files/<name>` and returns `{ name }`.
  - `addFile sanitises the name`: `a/b.pdf` is stored and returned as `a_b.pdf`.
  - `addFile returns PROJECT_NOT_FOUND` for an unknown project id, `put` not called.
  - `addFile returns SAVE_INVALID_NAME` for `../x`.
  - `addFile returns SKIP_TOO_LARGE` above 50 MB.
  - `existing name, default`: `{ error: FILE_EXISTS }`, `put` not called.
  - `existing name, skip`: `{ name, skipped: true }`, `put` not called.
  - `existing name, skip, project at 200 files`: still `{ name, skipped: true }`.
  - `new name, project at 200 files`: `{ error: SKIP_PROJECT_FULL }`.
  - `a failed put` returns `{ error: SAVE_FAILED }`.

- [ ] **Step 2: Run** `npx jest src/exulu/projects-public.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Order of checks in `addProjectFileCore`: project row, name, size, existing name (then `ifExists`), file cap, put. `ExuluProjects.create` gets `db` from `postgresClient()`. `ExuluProjects.addFile` reads the config from `exuluApp.get()`, returns `{ error: UPLOADS_NOT_CONFIGURED }` without `fileUploads`, lists names through `createPromoteS3(config).listProjectNames`, and puts through `uploadFile(..., true)` with the key `projects/<id>/files/<name>` (no general prefix, as in Task 1).

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Export.** `export { ExuluProjects } from "./exulu/projects-public";` in `src/index.ts`. Run `npm run type-check`: exactly the 8 known errors.

- [ ] **Step 6: Docs.** The `exulu-projects` pages: both functions with their inputs and results, the rules (private project, creator gets write, 200 files, 50 MB, `ifExists`), one example of a rerunnable loop with `ifExists: "skip"`, and a clear note that this is for trusted server code such as scripts and migrations, has no user context, and must not be called from a tool on behalf of a user. Add the page to `docs.json`.

- [ ] **Step 7: Commit** `feat(projects): export ExuluProjects.create and addFile for server-side code`.

### Task 3: Artifact template and protocol reference

**Files:**
- Modify: `src/skills/bundled/imp-artifact-apps/templates/imp-channel.ts`
- Test: `src/skills/bundled/imp-artifact-apps/templates/imp-channel.test.ts`
- Modify: `src/skills/bundled/imp-artifact-apps/references/identity-handshake.md`, and `SKILL.md` and `templates/app.html` where `openPanel` is used or described

**Interfaces:**
- Produces, on `ImpChannel`:

```ts
export type OpenPanelResult = { accepted: boolean; project?: "attached" | "denied" };
openPanel(
  slot: string,
  opts?: { prompt?: string; items?: string[]; files?: string[]; project?: string },
): Promise<OpenPanelResult>;
```

- [ ] **Step 1: Write the failing tests** in the existing test file's style:

  - `openPanel posts project on the request` with `v: 2`.
  - `resolves { accepted: true, project: "attached" }` on an ack carrying that.
  - `resolves { accepted: true, project: "denied" }` likewise.
  - `an ack without project resolves { accepted: true }` (an old host).
  - `an ack with an unknown project value drops the field`.
  - `resolves { accepted: false } on timeout`.
  - `a rejected ack resolves { accepted: false }` and carries no `project`.
  - `a request without project resolves { accepted: true }` on a plain accepted ack.

- [ ] **Step 2: Run** `npx jest src/skills/bundled/imp-artifact-apps/templates/imp-channel.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** One function. Update every existing test in the file that expects `true` or `false` from `openPanel` to expect the object. `CHANNEL_V` is not changed.

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Reference.** In `identity-handshake.md`, add `project` to the `exulu:panel:open` and `exulu:panel:open:ack` rows and a short section: what `attached` and `denied` mean, that `denied` covers every reason and the artifact gets no detail, that the panel still opens on `denied` without a project, that an old host answers without the field, that the ack can now take as long as the access check, and what an artifact should show on `denied` (a hint that the viewer needs access to the project). Rewrite the `openPanel` paragraphs of the reference (the ones saying it resolves `true` or `false`) for the object result, with the warning that the result must be read through `.accepted`. Check `templates/app.html` and `SKILL.md` for uses of the old boolean and update them.

- [ ] **Step 6: Commit** `feat(artifacts): template can open the agent panel in a project`.

---

## Frontend

### Task 4: Protocol fields

**Files:**
- Modify: `lib/artifacts/agent-panel-protocol.ts`
- Test: `lib/artifacts/agent-panel-protocol.test.ts`

**Interfaces:**
- Produces:

```ts
export interface OpenPanelRequest { /* existing fields */ project?: string }
export type PanelProjectStatus = "attached" | "denied";
export interface OpenPanelAck { /* existing fields */ project?: PanelProjectStatus }
export function openPanelAck(slot: string, accepted: boolean, reason?: string, project?: PanelProjectStatus): OpenPanelAck;
```

- [ ] **Step 1: Write the failing tests:**

  - `keeps a uuid project`: `123e4567-e89b-42d3-a456-426614174000` survives parsing.
  - `drops a project that is not a strict uuid, keeps the request`: for `"abc"`, `""`, `42`, `null`, `{}`, a uuid with surrounding spaces, and a uuid followed by `/../x`, the parsed request is non-null and has no `project` key.
  - `the result never aliases the input`: an extra unknown key on the input is absent from the result.
  - `openPanelAck carries project only when given`: without the fourth argument the ack has no `project` key.
  - `CHANNEL_V is 2`.

- [ ] **Step 2: Run** `npx vitest run lib/artifacts/agent-panel-protocol.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** The uuid check is one anchored regular expression, case-insensitive, over the whole string. Update the file's header comment: the channel now also carries a project id from the artifact, which is untrusted and only ever used as the argument of an access-checked lookup.

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Commit** `feat(artifacts): panel-open request and ack carry an optional project`.

### Task 5: Probe before the ack

**Files:**
- Modify: `app/artifacts/[artifact_name]/artifact-frame.tsx`
- Test: `app/artifacts/[artifact_name]/artifact-frame.test.tsx`

**Interfaces:**
- Consumes: Task 4.
- Produces, on the frame's `panel` prop: `probeProject?: (projectId: string) => Promise<boolean>`, and `export const PROJECT_PROBE_TIMEOUT_MS = 8000;` (below the artifact's 10 second ack wait).
- Contract for `onOpenRequest`: the request it receives carries `project` only when the probe confirmed access.

- [ ] **Step 1: Write the failing tests** in the existing file's style, with a controllable `probeProject`:

  - `no project: ack is immediate and has no project field`, `onOpenRequest` called once. (Existing behaviour, pinned.)
  - `probe true`: no ack before the probe resolves; then ack `accepted: true, project: "attached"`; `onOpenRequest` receives the request with `project`.
  - `probe false`: ack `accepted: true, project: "denied"`; `onOpenRequest` receives the request without a `project` key and with its prompt intact.
  - `probe rejects`: same as `probe false`.
  - `probe never resolves`: after `PROJECT_PROBE_TIMEOUT_MS` (fake timers) same as `probe false`.
  - `host without probeProject`: same as `probe false`.
  - `unknown slot with a project`: ack `accepted: false, reason: "unknown-slot"`, the probe is never called.
  - `port retired while probing` (the frame navigated): no ack is posted, `onOpenRequest` is not called.
  - `a second request overtakes a slow first`: request A with a pending probe, then request B without project. B is acked and opened. When A's probe resolves, A is acked with its status but `onOpenRequest` is not called for A.

- [ ] **Step 2: Run** the frame's test file. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** `answerOpenRequest` stays synchronous for a request without `project`. With `project` it checks panel and slot first, then awaits the probe raced against the timeout, then re-checks `portRef.current === port` and `cancelled` exactly as the refresh branch does, then acks, then hands over. A request counter in a ref decides whether a late request may still open the panel. The request passed on is rebuilt without `project` on `denied`; never spread the original.

- [ ] **Step 4: Run** the test file. Expected: PASS.

- [ ] **Step 5: Commit** `feat(artifacts): check project access before acking a panel-open request`.

### Task 6: Sessions that carry the project, and the reuse rule

**Files:**
- Modify: `app/(application)/chat/hooks.ts` (`UseChatSessionArgs`, `createSession`)
- Modify: `app/(application)/chat/components/session-screen.tsx` (`SessionScreenProps`, pass-through)
- Create: `app/(application)/artifacts/open/[name]/session-reuse.ts`
- Test: `app/(application)/artifacts/open/[name]/session-reuse.test.ts`
- Modify: `app/(application)/artifacts/open/[name]/agent-panel.tsx`, `viewer-client.tsx`, `page.tsx`
- Test: `agent-panel.test.tsx`, `viewer-client.test.tsx`, and the chat hook's existing test for `createSession` (find it with `grep -rl "agent_sessionsCreateOne\|createAgentSession" app/\(application\)/chat --include='*.test.*'`)
- Modify: the artifacts feature's queries file (the one exporting `GET_SHARED_ARTIFACTS`)

**Interfaces:**
- Consumes: Tasks 4 and 5.
- Produces:

```ts
// hooks.ts, UseChatSessionArgs, and session-screen.tsx, SessionScreenProps
/** Project for a session this screen creates lazily. Ignored when initialSession is set. */
project?: string | null;

// session-reuse.ts
/** True when the request must start a new session: the projects differ, where none equals none. */
export function needsFreshSession(current: string | null | undefined, requested: string | null | undefined): boolean;

// artifacts queries
export const PROBE_PROJECT_ACCESS = gql`query ProbeProjectAccess($id: ID!) { projectById(id: $id) { id } }`;
```

- [ ] **Step 1: Write the failing tests.**

  `session-reuse.test.ts`: `needsFreshSession` is `false` for (`null`, `null`), (`undefined`, `null`), (`"a"`, `"a"`); `true` for (`"a"`, `null`), (`null`, `"a"`), (`"a"`, `"b"`).

  Chat hook test: with `project: "p1"` and no initial session, the create mutation's variables contain `project: "p1"` and `rights_mode: "private"`, and the controller's `session.project` is `"p1"` afterwards. Without `project`, the variables contain no `project`.

  `agent-panel.test.tsx`:
  - `request with a project, no session yet`: the session screen is mounted with `project` set to it and the prompt is seeded.
  - `request with project p1 while the mounted session has project p1`: no remount, the prompt lands in the same controller.
  - `request with project p1 while the mounted session has no project`: the session screen remounts with `initialSession: null`, `project: "p1"`, and the prompt is seeded into the new controller, exactly once.
  - `request without project while the mounted session has project p1`: remount with no session and no project.
  - `request without project, session without project`: no remount.
  - `on a remount the URL loses ?session=` and keeps `?agent=`.
  - `New chat after a project request` starts without a project.
  - `a dropped file after a project request` creates the session with that project (the lazy create goes through the same `createSession`).

  `viewer-client.test.tsx`: `probeProject` resolves `true` when the query returns an id, `false` for `null`, and `false` when the query rejects.

- [ ] **Step 2: Run** the four test files one after another. Expected: the new tests FAIL.

- [ ] **Step 3: Implement the hook part.** `createSession` adds `project` to the mutation variables when set and sets `newSession.project` on the row it stores, so `useChatProjectFiles` sees it at once. Read `project` through a ref, like `sessionPathRef`.

- [ ] **Step 4: Implement the panel part.** `MountedAgentPanel` holds `fresh: { nonce: number; project: string | null } | null`. In the effect that applies `openRequest`, before marking the nonce applied: the current project is `controller.session.project ?? null` when the controller has a real session (an id other than `"new"`), otherwise `fresh?.project ?? null`. If `needsFreshSession(current, request.project)`, set `fresh` to a new nonce with the request's project, remove `session` from the URL with `history.replaceState`, and return without applying; add `fresh` to the effect's dependencies so it runs again against the new controller. While `fresh` is set, `SessionScreen` and `HistoryRail` get no initial session and no initial messages, `SessionScreen` gets `project={fresh.project}`, and its key includes `fresh.nonce`. `startNewChat` clears `fresh`.

- [ ] **Step 5: Implement the viewer part.** `viewer-client.tsx` passes `probeProject` in the frame's `panel` prop: an Apollo `client.query` of `PROBE_PROJECT_ACCESS` with `fetchPolicy: "network-only"`, resolving `Boolean(data?.projectById?.id)`, `false` on any error. In `page.tsx`, make sure the query that loads `?session=` selects `project`.

- [ ] **Step 6: Run** the four test files one after another, then `npm run lint` and `npx tsc --noEmit`. Expected: PASS, no new lint or type errors.

- [ ] **Step 7: Commit** `feat(artifacts): panel sessions start in the requested project`.

### Task 7: Manual check on the local stack

Needs Daniel's go for starting servers.

- [ ] A test artifact with one agent slot and two buttons: one calls `openPanel` with a project the viewer owns, one with a random uuid.
- [ ] Own project: the ack says `attached`, the header chip shows the project, the agent lists `project/<name>` files, the session appears in the project's sessions tab.
- [ ] Random uuid: the ack says `denied`, the panel opens with the prompt, no chip, and `select count(*) from agent_sessions where project = '<that uuid>'` returns 0.
- [ ] Project button, then a button without project: a new session starts, the project conversation is still in the history rail.
- [ ] An artifact built from the old template still opens the panel.
- [ ] A custom tool calling `saveSessionFile` writes a file that `parse_document` reads by the returned name.

## Release

Backend PR to `develop`, frontend PR to `main`, backend first. The frontend works against an older backend: nothing in the frontend calls a new backend route.
