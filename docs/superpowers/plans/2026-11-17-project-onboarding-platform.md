# Reading Cache, Long Documents, Agent-Created Projects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents read through `parse_document` are processed once per instance and content, long PDFs are processed with visible progress instead of refused, and an agent can create a project from the current conversation.

**Architecture:** A content-addressed Markdown store in object storage (`derived/`), wrapped around the existing extraction in `parse_document`. The document processor gains a page ceiling for the tool path, shared limiters and a progress callback that the tool forwards as interim generator yields. A new built-in tool `create_project` uses two new server helpers and the existing promote machinery.

**Tech Stack:** TypeScript, Express, AWS S3 SDK, AI SDK 6 tools (async-generator `execute`), jest (backend), Next.js + vitest (frontend).

**Spec:** `docs/superpowers/specs/2026-11-16-project-onboarding-platform-design.md` — read it; it is binding where this plan is silent.

## Global Constraints

- Backend branch from `origin/develop`, frontend branch from `origin/main`, each in its own sibling worktree with symlinked `node_modules`; never edit the primary checkouts.
- Backend gate: `npx tsc --noEmit` reports exactly 8 errors with the same identities as on the base; `npx jest <paths>` for focused runs, one jest process at a time, never parallel fan-out. Known failing suites on base: `src/exulu/compact-session.test.ts`, `src/exulu/resolve-context-window.test.ts`, `src/exulu/skill-env/inventory.test.ts`.
- Frontend gate: `npx vitest run <paths>`, `npx eslint <changed files>`.
- Every behaviour gets a test that fails before the change.
- Schema or one-time data changes go in `src/postgres/init-db.ts` (none are expected here).
- Env vars, exact names and defaults: `EXULU_DOCUMENT_CACHE_DAYS` = `365` (`0` disables the store), `EXULU_DOCUMENT_MAX_PAGES` = `300`, existing `EXULU_ATTACHMENT_MAX_PAGES` = `50` unchanged for inline attachments.
- Store layout, exact: text `[<s3prefix>/]derived/content/<sha256 hex of source bytes>/<fingerprint id>.md`; pointer `[<s3prefix>/]derived/pointers/<sha256 hex of "<bucket>/<full key>">.json` with body `{"etag": string, "sha256": string}`. Metadata on the text object: `exulu-extractor` = readable fingerprint string.
- Interim progress object, exact: `{ status: "reading", filename, phase: "cached" | "text" | "ocr" | "vision" | "storing", pagesDone, pagesTotal }`; at most one per second; never reaches the model.
- The prompt text for sessions without a project stays byte-identical.
- `create_project`: always needs approval; off for every existing agent; a new project is `rights_mode: "private"`, `created_by` = caller.
- Commit trailer: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. A user writes or reads `derived/…` through `/s3/sts`, `/s3/download`, `/s3/object`, `/s3/delete`, `/s3/list` or the multipart routes → refused on every one (Task 1).
2. A refusal, an `officeparser` fallback or a vision-degraded result is requested twice → extracted twice, never stored (Task 2, Task 4).
3. The client disconnects during a 200-page first read → extraction finishes and the text is stored; the in-flight entry is cleared on success and on failure (Task 2).
4. `create_project` copies 30 files and the 17th copy fails → 29 are in the project and gone from the session, one is still in the session and named in the result; no file is in neither place (Task 7).
5. `create_project` is called in a session that already has a project, by a non-owner, or by a guest → the tool is not registered, and a direct call is refused (Task 7).

---

### Task 1: Store keys, fingerprint, expiry setting, route refusal

**Files:**
- Create: `src/exulu/document-cache/keys.ts`, `src/exulu/document-cache/keys.test.ts`
- Modify: `src/exulu/attachment-text.ts` (`validateAttachmentsConfig`), `src/uppy/index.ts:436-442` (`mayUseGenericS3Route`, `buildStsPolicy` test only), their tests

**Interfaces — Produces:**
- `DERIVED_ROOT = "derived"`
- `isDerivedKey(key: string, s3prefix?: string | null): boolean`
- `contentKey(sha256: string, fingerprintId: string, s3prefix?: string | null): string`
- `pointerKey(bucket: string, fullKey: string, s3prefix?: string | null): string`
- `extractorFingerprint(args: { filename: string; exuluConfig: any }): { id: string; label: string }` — `label` examples: `pdftotext@1`, `officeparser@1`, `document-processor/mistral/mistral-ocr/vlm:<model>@1`, `…/vlm:off@1`; `id` = first 16 hex chars of sha256(label)
- `documentCacheDays(env?): number` (default 365, `0` allowed), `documentMaxPages(env?): number` (default 300)

- [ ] Tests: key shapes with and without `s3prefix`; `isDerivedKey` true for `derived/x`, `<prefix>/derived/x`, false for `user_1/derived/x` and `derivedx/y`; fingerprint changes with engine, OCR model, vlm on/off and vlm model, and does not change with `concurrency`; label for a `.docx` without a processor is `officeparser@1`, for a `.pdf` without one `pdftotext@1`; env parsing (unset → default, `"0"` → 0 for cache days, `"0"`/`"abc"`/`"-1"` → boot problem for max pages, `"abc"`/`"-1"` → boot problem for cache days).
- [ ] Tests in `src/uppy`: `mayUseGenericS3Route("derived/content/x.md", …)` is false for a normal user, an API user and a super admin; the STS policy for user 7 contains no resource matching `derived/*`.
- [ ] Run, see them fail. Implement. `mayUseGenericS3Route` returns `!isProjectKey(…) && !isDerivedKey(…)`. Add both env checks to `validateAttachmentsConfig`'s env block so they run even without an attachments config (check where it is called at boot and keep that behaviour for the existing variable).
- [ ] Run focused jest, tsc count 8, commit `feat(documents): derived store keys, extractor fingerprint, cache settings`.

### Task 2: Read-through store and `parse_document` wiring

**Files:**
- Create: `src/exulu/document-cache/store.ts`, `store.test.ts`
- Modify: `src/templates/tools/parse-document-tool.ts`, its test

**Interfaces — Consumes:** Task 1. **Produces:**
```ts
type StoreIo = {
  head(key: string): Promise<{ etag: string | null } | null>;
  getBytes(key: string): Promise<Buffer>;
  getText(key: string): Promise<{ text: string; lastModified: Date } | null>;
  putText(key: string, text: string, metadata: Record<string, string>): Promise<void>;
};
type Extracted = { text: string; totalPages?: number; storable: boolean };
readThroughDocument(args: {
  io: StoreIo; bucket: string; sourceKey: string; s3prefix?: string | null;
  fingerprint: { id: string; label: string }; cacheDays: number; now?: () => Date;
  extract: (bytes: Buffer, onProgress?: ProgressFn) => Promise<Extracted>;
  onProgress?: ProgressFn;
}): Promise<{ text: string; totalPages?: number; fromStore: boolean }>
createStoreIo(exuluConfig): StoreIo   // thin wrapper over src/uppy helpers
```
`totalPages` for a stored text is recovered by counting `--- page N ---` markers (0 markers → undefined).

- [ ] Tests with a fake `StoreIo`: miss → extract once, text + pointer written; second call → no `getBytes`, no extract, `fromStore: true`; pointer with another ETag → bytes fetched and hashed, same content → hit without extract; same bytes under a different `sourceKey` → hit; different fingerprint → miss; entry older than `cacheDays` → extract and overwrite; `cacheDays: 0` → no reads from and no writes to the store; `storable: false` → returned, nothing written, second call extracts again; `extract` throws → nothing written, in-flight entry cleared, next call extracts; two concurrent calls → one extract, both get the text and both receive progress; `putText` rejects → result still returned, `console.warn` once.
- [ ] Implement. In-flight `Map<string, { promise, listeners: Set<ProgressFn> }>` keyed `<sha256>/<fingerprint.id>`; the extraction promise is not tied to the caller's abort signal.
- [ ] Refactor `parse_document`: move today's extraction (lines ~153-223: processor path, `pdftotext` path with garbled/scan refusals, Office path) into one local `extractFull(bytes): Promise<Extracted | { error: string }>` that returns the full marked text. `storable` is false when the processor path fell back to `officeparser` or reported degraded pages (Task 4). Refusals stay `{ error }` and bypass the store. Then: `readThroughDocument` → apply `pages` → line slice exactly as today. `pages` is applied to the full marked text, also on a hit.
- [ ] Tool test: two calls for one file call the extractor once; a refused scan is not stored; output for an uncached file is byte-identical to before this task for the existing fixtures.
- [ ] Update the tool description: results are reused; the first read of a long document can take minutes; drop "Free and fast (no OCR)".
- [ ] Focused jest, tsc 8, commit `feat(documents): parse_document reuses stored text keyed by content`.

### Task 3: Expiry sweep

**Files:** Create `src/exulu/document-cache/sweep.ts`, `sweep.test.ts`; modify the server start-up where other timers are registered (find with `grep -rn "setInterval" src/exulu src/index.ts`).

**Produces:** `sweepExpiredDerived(args: { list(prefix, token?): Promise<{ items: { key: string; lastModified: Date }[]; next?: string }>; remove(keys: string[]): Promise<void>; s3prefix?: string | null; cacheDays: number; now?: () => Date }): Promise<{ deleted: number }>` and `startDerivedSweep(exuluConfig): () => void` (runs once ~1 minute after start, then every 24 h, `unref`'d timer, never overlapping, errors logged and swallowed).

- [ ] Tests: deletes only objects under `derived/` older than the limit, pages through listings sequentially, `cacheDays: 0` deletes everything under `derived/`, a failing `remove` is logged and the sweep continues with the next page.
- [ ] Implement, register only when file uploads are configured, commit `feat(documents): daily sweep removes expired stored text`.

### Task 4: Long documents

**Files:** Modify `src/exulu/attachment-text.ts`, `ee/python/documents/processing/doc_processor.ts`, `src/templates/tools/parse-document-tool.ts`; create `ee/python/documents/processing/limits.ts` (+ test).

**Produces:**
- `ExtractDocumentInput` gains `maxPages?: number` (default `attachmentMaxPages()`), `tolerateVisionFailures?: boolean`, `onProgress?: ProgressFn`; `ExtractedDocument` gains `degradedPages?: number[]`.
- `tooLongNotice` unchanged for attachments; new `tooLongForToolNotice(filename, pageCount, maxPages)`: `[Document too long: "<f>" has N pages, the limit for reading a document is M pages (EXULU_DOCUMENT_MAX_PAGES). The document was NOT read. Tell the user plainly and suggest splitting the file.]`
- `limits.ts`: `ocrLimiter`, `visionLimiter` — process-wide `pLimit(8)` each; `ocrConcurrency(config): number` (default 3, clamp 1..8) read from `documentProcessor.ocr.concurrency`.
- `validateAttachmentsConfig` accepts and validates `ocr.concurrency` (integer 1..8).

- [ ] Tests: `extractDocument` with `maxPages: 300` processes a 120-page PDF (mock processor and `pdfPageCount`), refuses 301 with the tool notice; inline attachments still refuse at 51; limiter never runs more than 8 at once across two concurrent documents; with `tolerateVisionFailures` a page whose VLM call fails three times keeps its OCR text and appears in `degradedPages`; without it the document fails as today.
- [ ] Implement: per-document `pLimit(ocrConcurrency)` wraps a call that itself goes through `ocrLimiter`; same nesting for vision. `parse_document` passes `maxPages: documentMaxPages()`, `tolerateVisionFailures: true`, sets `storable: false` when `degradedPages` is non-empty and appends one line to the returned text: `[Note: figures and tables on page(s) <list> could not be verified; the text for those pages is OCR only.]`
- [ ] Focused jest, tsc 8, commit `feat(documents): read long pdfs through the tool path, shared ocr and vision limits`.

### Task 5: Progress events (backend)

**Files:** Modify `doc_processor.ts`, `attachment-text.ts`, `parse-document-tool.ts`, `src/exulu/tool.ts` (generator yield type), `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:745-770`; create `src/exulu/document-cache/progress.ts` (+ test).

**Produces:** `type ProgressFn = (p: { phase: "text" | "ocr" | "vision" | "storing"; pagesDone: number; pagesTotal: number }) => void`; `throttleProgress(fn, ms = 1000)` (always lets the first and a final `pagesDone === pagesTotal` through); `isInterimToolStatus(value): boolean` (`value?.status === "reading"`).

- [ ] Tests: OCR reports after each chunk with cumulative pages, vision per page; throttle; `parse_document`'s generator yields interim objects then exactly one final result; a cache hit yields only the final result; in the convert wrapper interim values are yielded untouched (no `guardToolOutput`, no audit output) and the final value is guarded as today; the model-facing output of the tool call is the final value only (assert through `toModelOutput` or the AI SDK's preliminary flag — verify in the installed `ai` version's docs/types how yielded non-final values are marked, and add a `toModelOutput` only if they are not excluded by the SDK).
- [ ] Implement: `parse_document.execute` becomes `async function*`; progress from the callback is bridged to the generator with a small queue (promise + array), final result yielded last.
- [ ] Focused jest, tsc 8, commit `feat(documents): parse_document reports reading progress`.

### Task 6: Project id in the prompt

**Files:** `src/exulu/session-file-listing.ts:90-132`, `src/exulu/generate-stream.ts:553,1011`, tests.

- [ ] Tests: with a project the scope sentence and listing header contain `project <name> (id <uuid>)`; without a project the output equals the existing pinned string byte for byte.
- [ ] Implement by passing `{ id, name }` instead of the name; commit `feat(chat): project id in the session prompt`.

### Task 7: `create_project`

**Files:**
- Create: `src/exulu/project-create.ts` (+ test), `src/templates/tools/create-project-tool.ts` (+ test), `src/exulu/turn-project.ts` (+ test)
- Modify: `convert-exulu-tools-to-ai-sdk-tools.ts` (registration near 377-396, turn holder for `resolveFileKey` consumers at 361-400), `src/exulu/generate-stream.ts` (prompt sentence, holder creation), `src/exulu/project-files-promote.ts` only if a move helper belongs there

**Produces:**
```ts
createProjectForUser(db, user, input: { name: string; description?: string }): Promise<{ id: string; name: string }>
attachSessionToProject(db, args: { sessionId: string; projectId: string; user: User }): Promise<void>  // throws unless user may write the session and read the project
planMove(args: { files: { key: string; name: string; size: number }[]; requested?: string[] }): { batches: { key: string; name: string }[][]; skipped: { name: string; reason: string }[] }
type TurnProject = { current: { id: string; name: string; speakerCanWrite: boolean } | null }
CREATE_PROJECT_TOOL_NAME = "create_project"
canRegisterCreateProject(args): boolean
createCreateProjectTool(args): ExuluTool
```
Input schema: `{ name: string (1..120), description?: string (≤ 2000), files?: string[] }`. Default file set: all session files except `isIgnoredArtifactPath` matches, nested paths, and names starting with `tool-output-`.

- [ ] Tests, helpers: created row has `rights_mode: "private"`, `created_by` = user id, a uuid id, and goes through the same validation as `projectsCreateOne` (`prepareItemWrite`); attach refuses a session the user cannot write and a project the user cannot read; `planMove` batches by 20 keys and 50 MB, stops at 200 files, reports clashes of sanitized names and unknown requested names.
- [ ] Tests, tool: not registered when the agent has not enabled it, when the session has a project, when the speaker is not the owner, for guests, without file uploads; `needsApproval` is always true; happy path creates, attaches, copies then deletes each original only after its copy succeeded; a failing copy leaves that file in the session and names it; the result contains name, id, moved count, skipped list, the sentence `Only you can see this project. Invite colleagues on the project page.`, the link `/projects/<id>`, and that the sandbox `project/` folder appears from the next message; after the call the turn holder points at the new project and `parse_document("project/<name>")` resolves in the same turn.
- [ ] Implement. Enable switch: follow how the agent's tool list marks built-in tools as disabled (`disabledTools`); add the inverse for opt-in tools in the smallest way that needs no migration for existing agents (they must stay off). Record the choice in the commit message. The prompt mentions the tool only when `canRegisterCreateProject` is true.
- [ ] Focused jest, tsc 8, commits `feat(projects): server helpers to create a project and attach a session`, `feat(chat): create_project tool`.

### Task 8: Frontend — document reading card

**Files (frontend repo):** create `components/ai-elements/document-reading.tsx` (+ test); modify `components/message-renderer.tsx` near line 1134 and `app/(application)/chat/components/tool-trace.tsx` so `tool-parse_document` parts render it; translation files for the new labels (follow the existing i18n setup, de + en at least).

- [ ] Tests: running with an interim output shows the file name, "Seite 75 von 120" and the phase label; `phase: "ocr"` → "Text wird erkannt", `"vision"` → "Abbildungen und Tabellen werden geprüft", `"storing"` → "Ergebnis wird gespeichert", `"text"` → "Text wird gelesen"; no interim output yet → indeterminate bar; done → one collapsed line with name and page count, plus "bereits gelesen" when no interim progress was ever shown and the call finished; `{ error }` output shows the error text; the component is rendered through the real `MessageRenderer` (mind the memo prop whitelist).
- [ ] Implement with existing UI primitives and theme tokens, no new colours. Commit `feat(chat): progress card for document reading`.

### Task 9: Frontend — react to `create_project`, enable switch

**Files:** `app/(application)/chat/hooks.ts` (session refresh), the agent tool settings where built-in tools are toggled, tests.

- [ ] Tests: when a `tool-create_project` part reaches `output-available`, the session is refetched once and `useChatProjectFiles` receives the new project id (also inside the artifact agent panel); the agent settings show "Projekte anlegen" off by default and persist the choice in the shape Task 7 chose.
- [ ] Implement, vitest + eslint, commit `feat(chat): show the new project right after the agent creates it`.

### Task 10: Docs

- [ ] Add the two env vars, the `ocr.concurrency` option and the `create_project` tool to the Mintlify docs pages that list configuration and built-in tools (`mintlify-docs/`, find with grep for `EXULU_ATTACHMENT_MAX_PAGES` and `save_to_project`). Commit `docs: reading cache, long documents, create_project`.
