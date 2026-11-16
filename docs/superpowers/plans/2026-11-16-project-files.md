# Project Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every IMP project a shared file folder that all of its chat sessions see — in the agent's sandbox, through the standard document tools, and in the files sidebar.

**Architecture:** Project files are plain S3 objects under an own prefix, served only through new `/projects/:projectId/files…` routes guarded by a project access helper. A project session syncs the folder read-only into `project/` of its sandbox and lists it in the prompt; the only write path into the folder is an explicit promote (route + approval-gated tool). Pure decision logic lives in small modules with unit tests; `routes.ts` and `create-sandbox.ts` only wire them.

**Tech Stack:** Backend: Node/Express, TypeScript, AWS SDK v3 S3, jest (`npm test`, tests beside the code as `*.test.ts`). Frontend: Next.js, React, next-intl, vitest + jsdom (`npx vitest run`).

**Spec:** `docs/superpowers/specs/2026-11-16-project-files-design.md` (incl. "Settled after the builder check").

## Global Constraints

- Key scheme, exactly: `[<s3prefix>/]projects/<projectId>/files/<name>`; flat names via the existing `sanitizeFilename`.
- Access: write implies read; creator, super admin and `rights_mode: "public"` pass; entity name for `RBACResolver` is the singular `"project"`.
- Caps: 200 files per project; promote ≤ 20 keys and ≤ 50 MB total per request; prompt listing 25 entries.
- Name clash on upload-sign or promote without `overwrite: true` → HTTP 409 with the existing file's `lastModified`.
- Origin: S3 metadata `exulu-origin: agent` set only by the agent-side writer; absence means `user`; copies keep metadata.
- The agent never writes the project folder as a side effect: nothing under `project/` is written back; deletion sync applies to `project/` only; session-file behaviour is unchanged.
- Sessions without a project behave exactly as today (payloads, prompt text, sidebar).
- `/s3/download`, `/s3/delete`, `/s3/list` refuse keys under `projects/` for everyone except API keys and super admins; `/s3/sts` policy is narrowed to the caller's own prefix.
- Backend typecheck gate is an equality: the error count and identities before and after must match (`npx tsc --noEmit`). Frontend: exactly the 8 known errors in `lib/demo/*.test.ts`.
- Frontend copy in English via `messages/en.json` (and `de.json` where the neighbouring keys exist); no violet; project section uses existing tokens.
- Work in sibling worktrees (`../backend-project-files` on a branch from `develop`, `../frontend-project-files` from `main`); conventional lowercase commit subjects.

## Review Focus

1. A filename that is `project/../x` or `project//x` passed to the document tools → refused, never resolved outside the project prefix (Task 5).
2. A session whose project was deleted or detached between turns → no listing, no `project/` directory, tools refuse `project/…` with a clear message (Tasks 4, 5).
3. A reader (no write right) calling upload-sign, delete or promote → 403, and the sidebar shows no upload zone or delete (Tasks 2, 3, 8).
4. Promote of a file whose name already exists in the project, from the agent tool → the tool result says the file exists and asks to confirm overwrite, it does not overwrite (Task 6).
5. A project with more than 200 files or a listing with a failed HEAD for one object → upload refused with a message naming the cap; listing still returns, that file's origin falls back to `user` (Tasks 2, 3).

---

## Part A — Backend

### Task 1: Prefix, access check, promote planning (pure modules)

**Files:**
- Create: `src/exulu/project-files.ts`, `src/exulu/project-files.test.ts`
- Create: `src/exulu/project-access.ts`, `src/exulu/project-access.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // project-files.ts
  export const MAX_PROJECT_FILES = 200;
  export const PROJECT_DIR = "project";
  export function projectFilePrefix(projectId: string, s3prefix?: string | null): { projectPrefix: string; fullProjectPrefix: string };
  export function isProjectKey(key: string, s3prefix?: string | null): boolean;          // any key under [prefix/]projects/
  export function parseProjectFilename(filename: string): { scope: "project"; name: string } | { scope: "session"; name: string } | { error: string };
  export type PromotePlan = { accepted: { sourceKey: string; name: string; destKey: string }[]; rejected: { key: string; reason: string }[]; clashes: string[] };
  export function planPromote(args: { keys: string[]; fullSessionPrefix: string; fullProjectPrefix: string; existingNames: string[]; overwrite: boolean }): PromotePlan;
  // project-access.ts
  export type ProjectRight = "read" | "write";
  export function hasProjectAccess(args: { project: { created_by?: number | string | null; rights_mode?: string | null }; rbac: { type: string; users?: { id: string | number; rights: string }[]; roles?: { id: string | number; rights: string }[] }; user: { id: number | string; role?: string | number | null; super_admin?: boolean; type?: string }; want: ProjectRight }): boolean;
  ```

- [ ] **Step 1: Failing tests.** `project-files.test.ts`: prefix with and without `s3prefix` (`"imp"` → `imp/projects/<id>/files/`); `isProjectKey` true for `imp/projects/x/files/a.pdf` and `projects/x/files/a.pdf`, false for `user_1/sessions/…` and `global/…`; `parseProjectFilename("a.pdf")` → session; `("project/a.pdf")` → project/`a.pdf`; `("project/../a")`, `("project//a")`, `("project/")`, `("project/sub/a.pdf")` → `{ error }`; `planPromote`: > 20 keys rejects all; key outside `fullSessionPrefix` rejected; `..` rejected; name in `existingNames` with `overwrite: false` → in `clashes`, not accepted; with `overwrite: true` accepted; accepted count + existing > 200 → all rejected with a reason naming 200. `project-access.test.ts`: creator read+write; super admin; `rights_mode: "public"` read+write; user granted `write` passes `read` and `write`; user granted `read` passes `read`, fails `write`; role grant; outsider fails both; `rbac.type === "public"` (no licence) passes both.
- [ ] **Step 2: Run, expect FAIL** — `npx jest src/exulu/project-files.test.ts src/exulu/project-access.test.ts`
- [ ] **Step 3: Implement.** Reuse `sanitizeFilename` from `session-files.ts`; compare ids as strings (see `sameEntityId` usage elsewhere).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(projects): project file prefix, access rule and promote planning`

### Task 2: Storage helpers and the generic S3 routes

**Files:**
- Modify: `src/uppy/index.ts` (`copyS3Object` ~275, `/s3/sts` policy ~465, `/s3/delete` ~499, `/s3/download` ~561, `/s3/list` ~704, `persistArtifact` callers use `uploadFile` metadata)
- Create: `src/exulu/file-origin.ts`, `src/exulu/file-origin.test.ts`
- Test: `src/uppy/index.test.ts`

**Interfaces:**
- Consumes: `isProjectKey` (Task 1).
- Produces:
  ```ts
  // file-origin.ts
  export type FileOrigin = "agent" | "user";
  export const ORIGIN_METADATA_KEY = "exulu-origin";
  export function originFromMetadata(metadata: Record<string, string> | undefined): FileOrigin;
  export function createOriginResolver(head: (key: string) => Promise<Record<string, string> | undefined>): (file: { key: string; lastModified: string | Date }) => Promise<FileOrigin>; // memoised by key+lastModified, a failing head → "user"
  // uppy/index.ts
  export const getS3ObjectMetadata: (key: string, config: ExuluConfig) => Promise<Record<string, string> | undefined>;
  export function mayUseGenericS3Route(key: string, user: { type?: string; super_admin?: boolean }, s3prefix?: string | null): boolean; // false for project keys unless api or super admin
  ```

- [ ] **Step 1: Failing tests.** `file-origin.test.ts`: `originFromMetadata({ "exulu-origin": "agent" })` → agent; undefined/other → user; resolver calls `head` once for two calls with the same key+lastModified, again when lastModified changes, returns `user` when `head` rejects. `index.test.ts`: `mayUseGenericS3Route` false for a normal user on `projects/x/files/a`, true for api and super admin, true for `user_1/…`; the STS policy builder (extract it as `buildStsPolicy(bucket, userId, s3prefix)`) allows only `…/[prefix/]user_<id>/*`; `copyS3Object` sends `MetadataDirective: "COPY"` (mock the client as the existing tests in this file do).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Before narrowing STS, grep the frontend for `/s3/sts` consumers and keep `global/*` in the policy only if one uploads there; record what you found in the commit body. Apply `mayUseGenericS3Route` at the top of the three routes (403).
- [ ] **Step 4: Run, expect PASS**; full `npm test`; typecheck equality.
- [ ] **Step 5: Commit** — `fix(storage): close generic s3 routes for project keys, narrow the sts policy, keep metadata on copy`

### Task 3: Project file routes

**Files:**
- Modify: `src/exulu/routes.ts` (new block after the session-files routes ~5121; helper beside `loadAuthedSession` ~1773; session listing ~4770 gains `origin`)
- Create: `src/exulu/project-file-routes.test.ts` (route-level tests in the style of the existing route tests; if none mount routes, test the extracted handlers)

**Interfaces:**
- Consumes: Task 1 and 2 exports; `RBACResolver` (`ee/rbac-resolver.ts`), `listS3ObjectsByPrefix`, `getS3SignedUploadUrl`, `deleteS3Object`, `copyS3Object`, `getPdfPreviewBytes`.
- Produces (HTTP):
  - `GET /projects/:projectId/files` → `{ files: { key, name, size, lastModified, contentType, presignedUrl, origin }[] }` (read)
  - `POST /projects/:projectId/files/upload-sign` body `{ filename, contentType, overwrite? }` → `{ uploadUrl, key }` | 409 `{ error: "exists", lastModified }` | 413-style 400 `{ error: "project_full", max: 200 }` (write)
  - `DELETE /projects/:projectId/files?key=` (write) · `GET /projects/:projectId/file/preview-pdf?key=&auth=` (read)
  - `POST /projects/:projectId/files/promote` body `{ sessionId, keys, overwrite? }` → `{ promoted: { key, name }[], rejected, clashes }`; 409 when `clashes` is non-empty and nothing was copied (write on project and `loadAuthedSession(…, "write")` on the session)
  - `GET /sessions/:sessionId/files` items gain `origin`.
  - Internal: `loadAuthedProject(req, res, projectId, want: ProjectRight): Promise<{ user, project } | null>` (401/404/403 written to `res`).

- [ ] **Step 1: Failing tests** with three users (creator, granted reader, outsider): list 200/200/403; upload-sign 200/403/403; clash → 409; 201st file → `project_full`; delete with a key outside the project prefix → 403; promote happy path copies and keeps the source; promote with a foreign session → 403; listing where one HEAD fails still returns with `origin: "user"`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** One shared `listFilesWithOrigin(prefix)` used by both the session and the project GET.
- [ ] **Step 4: Run, expect PASS**; full suite; typecheck equality.
- [ ] **Step 5: Commit** — `feat(projects): project file routes — list, upload, delete, preview, promote`

### Task 4: Sandbox — `project/` in project sessions, origin on agent writes

**Files:**
- Modify: `ee/invoke-skills/create-sandbox.ts` (`createSessionSandbox` signature ~492, `restoreArtifactsFromS3` ~328, `isArtifactPath` ~276, `persistArtifactToS3` ~842, per-turn restore ~525, bash snapshot ~1058)
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:231-248` (pass the project)
- Create: `ee/invoke-skills/project-sync.ts`, `ee/invoke-skills/project-sync.test.ts`

**Interfaces:**
- Consumes: `projectFilePrefix`, `PROJECT_DIR`, `ORIGIN_METADATA_KEY`.
- Produces:
  ```ts
  // project-sync.ts
  export function planProjectSync(remote: { name: string; size: number }[], local: { name: string; size: number }[]): { download: string[]; remove: string[] };
  export async function syncProjectDir(args: { sessionDir: string; projectId: string | null; config: ExuluConfig }): Promise<void>; // null → removes sessionDir/project if present
  // create-sandbox.ts
  createSessionSandbox(sessionId, skills, config, userId, agent, opts?: { projectId?: string | null })
  ```
- [ ] **Step 1: Failing tests.** `planProjectSync`: new and size-changed files in `download`, locally present but remotely gone in `remove`, identical untouched; `syncProjectDir` with `projectId: null` removes an existing `project/` dir (tmp dir fixture, S3 mocked). In `artifact-filter.test.ts` or a new test: `isArtifactPath(<sessionDir>/project/a.pdf)` is false when the session has a project and true when it has none; `persistArtifactToS3` passes metadata `{ "exulu-origin": "agent" }`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Call `syncProjectDir` on cold start and on every cached-hit turn, after the session restore. The caller resolves `projectId` only when the session owner has project read access (`hasProjectAccess`); otherwise passes `null`. Exclude `project/` from the bash mtime snapshot in project sessions.
- [ ] **Step 4: Run, expect PASS**; `npx jest ee/invoke-skills`; full suite.
- [ ] **Step 5: Commit** — `feat(sandbox): project files appear read-only under project/, agent writes carry their origin`

### Task 5: Document tools and the prompt listing

**Files:**
- Modify: `src/templates/tools/session-file-read-tool.ts`, `parse-document-tool.ts`, `view-document-page-tool.ts` (key resolution), their tests
- Modify: `src/exulu/session-file-listing.ts` (+test), `src/exulu/generate-stream.ts:520-536, 956-976`
- Create: `src/templates/tools/resolve-file-key.ts` (+test)

**Interfaces:**
- Consumes: `parseProjectFilename`, `projectFilePrefix`, `sessionFilePrefix`.
- Produces:
  ```ts
  export function resolveFileKey(args: { filename: string; ownerId: string | number; sessionId: string; projectId: string | null; s3prefix?: string | null }): { key: string; scope: "session" | "project" } | { error: string };
  export function describeProjectFiles(files: ListedFile[], projectName: string): string; // 25 newest, "+N more", NEW marker like describeSessionFiles
  ```
- [ ] **Step 1: Failing tests.** `resolveFileKey`: plain name → session key (unchanged from today's construction, assert byte-equal to `sessionFilePrefix(...) + name`); `project/a.pdf` with a project → project key; `project/a.pdf` with `projectId: null` → error "This session has no project files."; traversal forms → error. Listing: block header `Project files (shared with everyone on project <name>)`; 26 files → 25 lines + "+1 more"; no project → empty string. One tool test each: `parse_document({ filename: "project/a.pdf" })` reads the project key.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** All three tools call `resolveFileKey`; tool descriptions gain one sentence: files of the session's project are addressed as `project/<name>` and are read-only. Reword the hard-coded paragraph: session files are private to this session; project files are shared with everyone on the project; a session file gets into the project with `save_to_project` or the sidebar. Without a project the paragraph and listing are byte-identical to today (snapshot test).
- [ ] **Step 4: Run, expect PASS**; full suite; typecheck equality.
- [ ] **Step 5: Commit** — `feat(chat): document tools and the prompt see project files`

### Task 6: `save_to_project` tool

**Files:**
- Create: `src/templates/tools/save-to-project-tool.ts` (+test)
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:333-346` (registration)

**Interfaces:**
- Consumes: `planPromote`, `copyS3Object`, `listS3ObjectsByPrefix`, `hasProjectAccess`.
- Produces: tool `save_to_project({ filename: string, overwrite?: boolean })`, registered only when the session has a project and the **speaker** has write access; `needsApproval: true`; results: `Saved "<name>" to project <projectName>.` / `"<name>" already exists in the project (changed <date>). Call again with overwrite: true only if the user confirms.` / `The project already holds 200 files.` / `No session file named "<name>".`
- [ ] **Step 1: Failing tests** for the four results and for non-registration (no project; reader without write).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** on the pattern of the neighbouring session-file tools.
- [ ] **Step 4: Run, expect PASS**; full suite; typecheck equality; `npm run lint`.
- [ ] **Step 5: Commit** — `feat(chat): save_to_project tool`
- [ ] **Step 6: Docs.** Add a "Project files" section to `mintlify-docs/building/agents/tools-and-skills.mdx` and to the projects page of the docs (routes, the `project/` convention, caps, origin). Commit — `docs: project files`

## Part B — Frontend (`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`)

### Task 7: Client API and scope-agnostic file components

**Files:**
- Modify: `lib/api/session-files.ts` (add `origin` to `SessionFile`); Create: `lib/api/project-files.ts` (+test)
- Modify: `app/(application)/chat/components/session-files/{file-row,upload-zone,upload,panel-content,preview-pane}.tsx|ts` to take a `scope` instead of a bare `sessionId`
- Test: `app/(application)/chat/components/session-files/file-row.test.tsx` (new)

**Interfaces:**
- Produces:
  ```ts
  export type FileScope = { kind: "session"; sessionId: string } | { kind: "project"; projectId: string; name: string; canWrite: boolean };
  export const projectFilesApi: { list(projectId): Promise<{ files: SessionFile[] }>; uploadSign(projectId, { filename, contentType, overwrite? }): Promise<{ uploadUrl: string; key: string } | { exists: true; lastModified: string }>; delete(projectId, key): Promise<void>; promote(projectId, { sessionId, keys, overwrite? }): Promise<{ promoted: { key: string; name: string }[]; clashes: string[] }>; previewPdfUrl(projectId, key): string };
  ```
- [ ] **Step 1: Failing tests**: `FileRow` shows the agent badge (`title` "Created by the agent") for `origin: "agent"` and none for `user`; no delete button when `scope.kind === "project" && !canWrite`; `projectFilesApi.uploadSign` maps 409 to `{ exists: true, lastModified }`.
- [ ] **Step 2–4:** fail, implement, pass; `npx vitest run`; tsc count == 8.
- [ ] **Step 5: Commit** — `feat(files): project files client and scope-aware file components`

### Task 8: Sidebar with two sections

**Files:**
- Modify: `app/(application)/chat/components/session-files/panel-content.tsx`, `app/(application)/chat/hooks.ts` (count ~1152-1220), `chat-header.tsx:183`, `composer-autocomplete/use-composer-autocomplete.ts:193-235`, `messages/en.json` (+`de.json`)
- Test: `app/(application)/chat/components/session-files/panel-content.test.tsx` (new)

**Interfaces:**
- Consumes: Task 7. The session's project id and name come from the session already loaded by the chat page; the write right from a `GET /projects/:id/files` 200 plus a `canWrite` flag — add `canWrite: boolean` to that route's response in the backend branch if Task 3 did not (one line, with a test).
- [ ] **Step 1: Failing tests**: session without project renders exactly one list and the existing privacy note (snapshot of today's markup); with a project: two headed sections "Project · <name>" and "This session", two upload zones for a writer, one for a reader; "Add to project" on a session row calls `promote`; a clash opens a confirm and a second call carries `overwrite: true`; the "@" autocomplete lists project files labelled with the project name and inserts `project/<name>`.
- [ ] **Step 2–4:** fail, implement, pass; full vitest; tsc == 8; eslint on changed files.
- [ ] **Step 5: Commit** — `feat(chat): files sidebar shows project and session files side by side`

### Task 9: Project page tab

**Files:**
- Modify: `app/(application)/projects/components/project-detail-view.tsx:84-111` (tabs `sessions|files|knowledge|settings`), rename usage of `files-tab.tsx` to the Knowledge tab; Create: `app/(application)/projects/components/project-files-tab.tsx` (+test); `messages/en.json` (+`de.json`)
- [ ] **Step 1: Failing tests**: `?tab=files` renders the project files list with an upload zone for a writer; `?tab=knowledge` renders the existing items curation; the tab label of the old tab is "Knowledge".
- [ ] **Step 2–4:** fail, implement, pass; full vitest; tsc == 8.
- [ ] **Step 5: Commit** — `feat(projects): files tab for the shared folder, knowledge tab for pinned items`

### Task 10: End-to-end check

- [ ] **Step 1:** Start backend and frontend from the two worktrees against the local stack (ask before restarting anything already running). Two users, one project: user A uploads in the project page; user B starts a project session, sees the file in the sidebar, asks the agent to summarise `project/<name>`; the agent writes a file, B promotes it; A sees it with the agent badge. A reader cannot upload. Detach the session → the section disappears.
- [ ] **Step 2:** Record what was checked and what could not be in the PR descriptions. No commit.
