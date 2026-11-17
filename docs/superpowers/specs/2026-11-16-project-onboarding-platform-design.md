# Reading cache, long documents, and projects created by the agent — design

Date: 2026-11-16. Scope: backend (`develop`) and a small frontend part (`main`). This is stage 2a: the platform pieces. Stage 2b (the Metzler & Vater pitch agent moving onto them) gets its own design.

## Intent

Stage 1 gave projects a shared file folder. M&V's pitch work should now run on standard platform functions only: a user uploads tender documents in a chat, the agent asks for the project number, creates a project, puts the files there and starts reading. Three things are missing for that, and all three are useful to every customer:

1. Reading a document costs a parser, OCR and a vision model run every single time, for every user and session. A shared project folder makes that waste visible.
2. Documents over 50 pages are refused when a document processor is configured. Tender documents are routinely longer.
3. An agent cannot create a project, so "turn this conversation into a project" does not exist.

Guiding rule from the product owner: simplify, use the platform's standard building blocks.

## Goals

- The result of reading a document is stored once per instance, as Markdown, keyed by the document's content, and reused by every later read of the same content by anyone who holds a file with it. Entries expire after a configurable time (default 365 days).
- The stored Markdown is not shown in any file list, cannot be edited by users, and is loaded in preference to re-processing whenever it matches the current version of the source.
- When a document processor is configured, documents read through the tools get OCR and the vision pass, for session and project files alike (this is already the behaviour; it must hold for the cached path too).
- Long PDFs are processed, in parallel chunks, instead of refused.
- An agent can, with the user's approval, create a project from the current conversation: create the project, attach the session, move the session's files into the project folder, and tell the user with a link.
- A new project belongs to the person who created it; nobody else sees it until they are invited.
- In a project session the agent knows the project's id, not only its name.

## Non-goals

- No processing on upload and no background job: reading stays on demand. The first read of a long document occupies that tool call while it runs, and shows its progress (section 2a).
- No cache for inline chat attachments (file parts in a message): they are extracted once when sent and stored with the message already.
- No per-page or partial cache: a document is cached whole.
- No UI to view, download, edit or invalidate the stored Markdown.
- No tool to edit, delete or share a project, and none to pin knowledge items to it.
- No cleanup of stored objects when a session or project is deleted (none exists for any object today; separate follow-up).
- No change to who may set `agent_sessions.project` through GraphQL.

## Anti-goals

- A user must never receive document text they could not obtain from the source: the stored Markdown is reachable only through the read tools, which already check access to the source.
- Stale text must never be served: a replaced source has different content and therefore a different entry.
- A failed or refused read (scanned PDF without OCR, garbled text layer) must never be stored as if it were the document's content.
- The agent must not create a project silently, and must not leave the user with files that vanished: if moving fails halfway, every file is still in exactly one of the two places and the result says where.

## Approaches

Decided with the product owner: build these as platform features first, then move M&V onto them (rather than building M&V-specific tools first, or one combined change).

For the cache, three shapes were considered:
1. **Markdown in object storage, keyed by content hash (chosen).** Shared across users, sessions, projects and pods; survives restarts; a changed file is simply a different key.
2. Local disk cache like `pdf-preview-cache.ts`. Simple, but per pod and lost on redeploy; with several backend replicas most reads would still miss.
3. A database table with the text. Queryable, but large blobs in Postgres and a new schema for something that is a file.

For long documents:
1. **Lift the cap for the tool path and rely on the processor's own chunking, with configurable parallelism (chosen).** The Mistral path already splits a PDF into 25-page chunks and merges them before the table and vision passes, so chunk borders are already handled.
2. A background job with progress. Better for 500-page documents, but a queue, a status model and UI — not now.

## Current state (verified 2026-11-16, v5.13.0)

- `parse_document` (`src/templates/tools/parse-document-tool.ts`) fetches the whole object and extracts on every call; nothing is cached. With `attachments.documentProcessor` it calls `extractDocument` (`src/exulu/attachment-text.ts`), which refuses PDFs over `EXULU_ATTACHMENT_MAX_PAGES` (default 50); `pages` filters only after a full run. Without a processor it uses `pdftotext`/`officeparser` (no cap) and refuses scans and garbled layers. Output is line-sliced text with `--- page N ---` markers.
- `documentProcessor` (`ee/python/documents/processing/doc_processor.ts`): Mistral path splits with `split_pdf.py` (25 pages / 25 MB), OCRs chunks under `pLimit(3)`, merges, then a vision pass under `pLimit(vlm.concurrency)` where one page failing three times fails the whole document. No limiter across requests.
- Key resolution for all read tools: `resolveFileKey` (`src/templates/tools/resolve-file-key.ts`). Session files `[prefix/]user_<owner>/sessions/<sid>/<name>`, project files `[prefix/]projects/<pid>/files/<name>`.
- Listings: the session list and sandbox restore take everything under `…/sessions/<sid>/`; the project list, sync, cap and promote take only `projects/<pid>/files/`. A sibling `projects/<pid>/derived/` is invisible to all of them and already refused by the generic `/s3/*` routes (`isProjectKey`).
- `getS3ObjectEtag` gives the source version. `uploadFile` supports object metadata. `pdf-preview-cache.ts` shows in-flight coalescing by ETag.
- Projects: created only through GraphQL `projectsCreateOne` (`rights_mode` default `private`, `created_by` = caller); no server-side helper. `agent_sessions.project` is set by the generic update mutation. Every turn resolves the project through `resolveSessionProject` (owner must have read access).
- `save_to_project` (`src/templates/tools/save-to-project-tool.ts`) is the pattern for a built-in tool with approval and a registration predicate shared with the prompt. `promoteSessionFiles` copies (≤ 20 keys, ≤ 50 MB per batch, 200 files per project).
- The chat reads `session.project` once on mount; the backend re-reads it every turn. Relative links such as `/projects/<id>` render in chat and open in a new tab.
- The project name reaches the prompt in `sessionFilesScopeSentence` and `describeProjectFiles` (`src/exulu/session-file-listing.ts`); the id does not.

## Design

### 1. Stored Markdown for read documents

Decided by the product owner: the store is global per instance and keyed by content, so the same document uploaded by another user, under another name, in another session or project, is not processed again. Entries expire after a configurable time, default 365 days.

**Where.** Two kinds of objects under one top-level prefix `[<s3prefix>/]derived/`:
- the text: `derived/content/<sha256 of the source bytes>/<extractor fingerprint>.md`
- a small pointer per source object, so a read does not have to download the source just to hash it: `derived/pointers/<sha256 of bucket + key>.json` holding `{ etag, sha256 }`

The prefix is outside `user_<id>/` and `projects/`: the browser upload policy (`buildStsPolicy`) cannot write there, and the generic `/s3/*` routes refuse it like project keys (`mayUseGenericS3Route` is widened). Nothing lists, syncs, counts or promotes it, so the Markdown never appears in the sidebar, the project page, the prompt listing or the sandbox, and users cannot edit it.

SHA-256 rather than the storage ETag identifies content: ETags are MD5-based, differ with multipart part sizes, and two different files with the same MD5 can be constructed on purpose, which would let one user plant text for a document another user reads.

**What.** Exactly the text `parse_document` slices today: the full extracted text with `--- page N ---` markers. The extractor fingerprint is computed from configuration alone, without running anything: which path would run (`pdftotext`, `officeparser`, or the document processor), and for the processor its engine, its OCR model name, whether the vision pass is on and with which model, plus a format version constant. It is part of the object name (as a short hash of that string, with the readable string in metadata `exulu-extractor`). Concurrency and retry settings are not part of it. Consequence, intended: turning a processor on, or changing its engine or models, means each document is read once more on its next use.

**Read-through in `parse_document`.**
1. Resolve the key and access-check as today. HEAD the source for its ETag.
2. Read the pointer. If its `etag` matches, the content hash is known; otherwise download the source, hash it, write the pointer.
3. Look for `derived/content/<sha256>/<fingerprint>.md`. If it exists and is not expired: slice and return it.
4. Otherwise extract as today (the source is downloaded if step 2 did not already), store the Markdown, slice and return.

Two reads of the same content at the same moment in one process share one extraction (in-flight map keyed by hash + fingerprint); across pods a duplicate run is acceptable and the later write wins.

**Never stored:** refusals and failures (too long, scanned without OCR, garbled layer, processor error with empty fallback), and degraded results (a processor run that fell back to `officeparser`, or one where a page's vision pass failed, see section 2). Those are returned to the caller but the next read tries again.

**Expiry.** `EXULU_DOCUMENT_CACHE_DAYS`, default `365`, validated at boot like the other limits; `0` turns the store off (nothing read from it, nothing written). An entry older than that, by its last-modified time, is treated as absent and overwritten by the next read. A sweep in the backend process (at start and once a day, one listing at a time, no parallel fan-out) deletes expired text and pointer objects, so text does not outlive the limit even if nobody reads the document again.

**Deleting a file does not delete stored text**, because other files with the same content may use it. Text of a deleted document therefore stays until it expires. Replacing, renaming, promoting or moving a file needs no handling at all: same bytes, same entry; different bytes, different entry.

**Access.** No route serves the store. Only the read tools reach it, and only after resolving and access-checking a source the caller holds; a user gets text only for bytes they can already read. What the store can reveal indirectly is that someone on the instance has read the same document before (a fast first read). The UI therefore says "bereits gelesen", not where the text came from.

**Tool description.** `parse_document` no longer claims to be "free and fast (no OCR)"; it says results are reused and that the first read of a long document can take minutes.

### 2. Long documents

- The 50-page attachment cap (`EXULU_ATTACHMENT_MAX_PAGES`) keeps applying to inline chat attachments only.
- For `parse_document` a separate ceiling applies: `EXULU_DOCUMENT_MAX_PAGES`, default 300. Above it the tool refuses with a notice that names both numbers and suggests splitting the file.
- OCR chunk parallelism becomes configurable (`documentProcessor.ocr.concurrency`, default 3, max 8) and is additionally bounded by one process-wide limiter (default 8 concurrent OCR chunk calls, 8 concurrent vision calls) so one long document cannot starve other users' reads.
- On the tool path, a page whose vision pass fails after its retries keeps its OCR text instead of failing the whole document. The result is returned with a one-line note naming the affected pages, and it is not stored, so a later read retries. Other callers of the processor (knowledge-base processing) keep today's fail-whole behaviour.
- The process-wide limiter is a queue, not a refusal, and applies to every in-process caller of the processor. A caller that already runs at most 3 OCR chunks at a time only notices it when several documents are processed at once.
- An extraction that has started runs to completion and stores its result even when the client disconnects or the turn is aborted; the in-flight entry is removed when it settles. There is no tool-level timeout today and none is added; the per-step timeouts of the processor stay.
- `pages` on a document that is not cached yet still processes the whole document once (so the result can be stored), then returns the requested pages. On a cached document it costs nothing.

### 2a. Progress while a document is read

Requested by the product owner: the user should see clearly what is happening during a long first read.

**Backend.** Tool `execute` functions are already async generators whose yielded values are streamed to the chat as interim results (`convert-exulu-tools-to-ai-sdk-tools.ts`). `parse_document` yields status objects while it works and its normal result last:

`{ status: "reading", filename, phase: "cached" | "text" | "ocr" | "vision" | "storing", pagesDone, pagesTotal }`

- `documentProcessor` gets an optional `onProgress` callback. OCR reports when a chunk finishes (so in steps of up to 25 pages), the vision pass reports per page.
- Updates are throttled to at most one per second, and only the final result reaches the model; interim objects are never offloaded or counted against the output cap.
- A second read that joins a running extraction of the same file receives the same progress.
- A cache hit yields nothing interim; it is immediate.

**Frontend.** A dedicated renderer for `parse_document` calls in the tool trace, replacing the generic JSON card: file name and icon, a progress bar with "Seite X von Y", the current phase in plain words ("Text wird erkannt", "Abbildungen und Tabellen werden geprüft", "Ergebnis wird gespeichert"), and for long documents the hint that the result is kept so the next read is immediate. When done it collapses to one line: file name, page count, and "bereits gelesen" when stored Markdown was used. Errors and refusals show their text. Labels go through the existing translations.

### 3. Creating a project from a conversation

**Server helpers** (new module, no GraphQL dependency): `createProjectForUser(db, user, { name, description? })` mirroring `projectsCreateOne` (`rights_mode: "private"`, `created_by` = user), and `attachSessionToProject(db, { sessionId, projectId, user })`, which verifies that the user may write the session and read the project before setting the column (the GraphQL path's missing check is not copied).

**Tool `create_project`.** Input `{ name, description?, files: string[] }`. `files` is required and lists exactly the session files to move (bare names; an empty list creates the project without moving anything; unlisted files stay in the session), so the approval card always shows what will move. Always requires approval; "allow for this chat" does not apply. It:
1. creates the project and attaches the current session to it, in one database transaction (a lost race or a refused attach leaves no project behind);
3. moves the files: copy into the project folder in batches (respecting 20 keys / 50 MB per batch and the 200-file cap), then delete the session originals that were copied. An original that a stored message of this conversation refers to through a file part (for example attachments of a session created from an e-mail) is copied but kept, so replaying the history keeps working; if the history cannot be read, every original is kept. Stored Markdown needs no handling; the moved files have the same content. A file that fails to copy stays in the session and is named in the result;
4. returns: the project's name and id, how many files moved, which did not and why, the sentence "Only you can see this project. Invite colleagues on the project page.", and the link `/projects/<id>`.

**Registration.** Offered only when: the agent has the tool enabled (opt-in per agent, off for every existing agent: an entry `{ id: "create_project", type: "function", config: [] }` in `agent.tools`, added through the generic tools picker like `skill_author`), the turn is not a routine run, the session exists and has no project, the speaker is the session's owner and not a guest, and file uploads are configured. The prompt mentions the tool only when it is registered (one shared predicate, as for `save_to_project`).

**Same-turn continuity.** After the tool ran, the document tools of the same turn resolve `project/<name>` against the new project (one mutable holder per turn, shared by the tool factories and set by `create_project`; the system prompt of that turn is not rebuilt, the tool result is what tells the model), so the agent can go on reading immediately. The sandbox's `project/` directory and the prompt listing follow on the next turn; the tool result says so.

**Frontend.** When a `create_project` result arrives, the chat re-reads its session so the "Project" section, the header chip and the "@" list appear without a reload. The same works in the agent panel beside an artifact.

### 4. Project id in the prompt

In a project session the scope sentence and the listing header read `project <name> (id <uuid>)`. The text for sessions without a project stays byte-identical.

## Edge cases

| Case | Behaviour |
|---|---|
| Source replaced while a read is running | The text is stored under the hash of the bytes that were read; the next read sees a new ETag, re-hashes, and finds or creates the entry for the new content |
| Same document uploaded by another user, another name | Same hash, immediate result |
| Entry older than `EXULU_DOCUMENT_CACHE_DAYS` | Treated as absent, re-read, overwritten; the sweep deletes it if nobody reads it |
| Two users read the same uncached 200-page file at once on different pods | Both extract; the later store wins; both get correct text |
| Pointer missing, unreadable or with another ETag | Source is downloaded and hashed again |
| Storing the Markdown fails | The read still returns its result; a warning is logged |
| `create_project` name already used by another project | Allowed (names are not unique); the id in the result disambiguates |
| Session already has a project | Tool not offered |
| Speaker is not the session owner (shared session) | Tool not offered |
| More than 200 files, or a file name that already exists in the batch | Excess and clashing files stay in the session and are named |
| Move interrupted after copy, before delete | File exists in both places; the result says so; nothing is lost |
| A document processor is not configured | Cache still works with the `pdftotext`/`officeparser` result; scans are refused and not cached |

## Calls made (not decided by the product owner)

- SHA-256 as the content key, a per-object pointer to avoid re-hashing, and a daily sweep that enforces the expiry.
- The UI wording "bereits gelesen".
- The extractor fingerprint is part of the key; changing the processor's engine or models re-reads every document once.
- Degraded results are returned but not stored.
- The process-wide limiter applies to all processor callers and queues.
- Ceiling of 300 pages for tool reads; process-wide limits of 8.
- `create_project` moves files rather than copying them; it is opt-in per agent; it is not offered in shared sessions to non-owners or in routine runs; `files` is required; originals referenced by the history are kept.
- The final `parse_document` result carries `fromStore: true` when stored text was used, so the UI badge does not have to be inferred.
- No cache for inline attachments.

## Left to the builder

- How the tool is enabled per agent, following the existing configurable built-in tools.
- The exact fingerprint strings and the in-flight map's shape.
- How the frontend detects the tool result and refreshes the session.

## Testing

- Unit: content and pointer keys; cache hit/miss/expired/fingerprint mismatch; pointer with a stale ETag; refusals and degraded results not stored; in-flight coalescing; expiry sweep; `EXULU_DOCUMENT_CACHE_DAYS` validation and `0`; move planning (batches, cap, clash, partial failure); registration predicate; prompt text with and without a project (byte-identical without).
- Integration: `parse_document` twice on the same file → one extraction; the same bytes under another name in another session → no extraction; after replacing the file → a second extraction; a 120-page PDF with a mocked processor is processed, not refused; `create_project` end to end with mocked storage, then `parse_document("project/<name>")` in the same turn.
- Unit: progress events (order, throttling, never part of the model output); frontend renderer states (running, cached, done, error).
- Manual: a real long PDF with the processor configured, watching the progress display; two users reading the same project file; creating a project from a chat and from the artifact agent panel.

## Follow-ups (not part of this)

- Deleting stored objects when a session or project is deleted.
- A background job with progress for very long documents.
- GraphQL attach of a session to a project does not check project read access.
- Tool-output offload files are written under the speaker, not the session owner.
- Stage 2b: the M&V pitch agent on projects.
