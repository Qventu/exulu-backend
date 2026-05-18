# Session files side panel

**Status:** Draft
**Date:** 2026-05-18
**Owner:** dclaessen-exulu

## Goal

Let users see, preview, upload, and delete the files belonging to the current chat session — the same `<s3prefix>/user_<userId>/sessions/<sessionId>/` prefix the agent's `writeFile` and bash artifact-mirroring already write to. The panel lives in a toggleable right sidebar on the chat page. Uploaded files become available to the agent next turn so users can drop a document and immediately ask the agent to work with it.

## Non-goals

- Sharing session files across sessions, projects, or knowledge bases. The panel explicitly tells the user files are scoped to this session only.
- Multi-user collaboration on a single session's files (no real-time presence; one user owns a session today).
- Inline editing of file contents from the panel. Editing happens by replacing the file via upload, or by asking the agent.
- A cleanup job for the PDF preview cache. The cache lives on `/tmp`; the OS reaps it. A dedicated cleanup process can be added later if disk usage becomes an issue.

## Architecture

Four pieces:

1. **Backend REST routes** under `/sessions/:sessionId/*` that list, sign uploads for, delete, and PDF-preview session files. The session prefix in S3 is the source of truth; no new DB table.
2. **`pdf-preview-cache.ts` module** that fronts LibreOffice (`soffice --headless --convert-to pdf`) with an ETag-keyed on-disk cache + in-flight coalescing, so the same `.docx` doesn't trigger two parallel renders.
3. **Frontend `SessionFilesPanel` component** rendering inside the chat page. List view, upload zone, and a preview-pane router that picks a renderer (text/code/markdown/image/PDF) based on content type.
4. **Sandbox sync helper** that pulls a freshly-uploaded key into the live session sandbox dir so the agent's `readFile`/`bash` see user uploads on the next turn without waiting for a process restart.

## UX

- **Trigger:** new button in the chat header (folder icon + file-count badge when ≥1). Click toggles the panel.
- **State persistence:** open/closed state stored in `localStorage` under `chat.sessionFilesPanel.open`. Default-open on first visit to a session that has files; default-closed for empty sessions.
- **Layout:** the outermost chat container changes from `flex flex-col` to `flex flex-row`, with the existing column as the first child and the panel conditionally rendered as the second. Panel width is `340px`.
- **Top-of-panel notice (always visible):** *"Files in this session aren't shared with other sessions, projects, or knowledge bases."* Plain text, no dismiss button — it's a persistent scope reminder.
- **List view:** files sorted by `lastModified` descending. Each row: type icon, name (truncated), size, relative time, hover-revealed actions (Preview / Download / Delete).
- **Preview view:** clicking Preview replaces the list with the preview pane. A "← Files" button restores the list. The preview pane itself routes by content type — see section "Preview rendering" below.
- **Upload zone:** always pinned to the bottom of the list view. Drag-drop or click-to-browse, multi-file. Per-file size cap 50 MB (matches the skill bundle cap).
- **Live updates while panel is open:** poll the list endpoint every 5 seconds when the panel is visible. Out-of-sight = no polling. A future improvement could hook into the agent's stream events but polling avoids new infra.

## Backend routes

All routes auth-check that the calling user owns the session by verifying the resolved S3 key string-starts-with `<s3prefix>/user_<authenticatedUserId>/sessions/<sessionId>/`. There is no session DB row to look up (sessions are inferred from S3 + the chat conversation table); the user-prefix gate is what enforces isolation. The helper is exported once from `routes.ts` so all five new routes share the same check.

### `GET /sessions/:sessionId/files`

Lists `<s3prefix>/user_<userId>/sessions/<sessionId>/`. Returns:

```ts
{
  files: Array<{
    key: string;            // full S3 key incl. bucket-internal prefix
    name: string;           // basename
    size: number;
    lastModified: string;   // ISO timestamp
    contentType: string;    // inferred from extension when S3 doesn't have it
    presignedUrl: string;   // 1-hour signed GET
  }>;
}
```

Excludes directory-marker keys. Inlining the presigned URL avoids a second round trip per file when the user clicks Preview/Download.

### `POST /sessions/:sessionId/files/upload-sign`

Body: `{ filename: string, contentType: string }`. Sanitizes the filename (strip leading slashes, reject `..`). Returns `{ uploadUrl, key }` for a one-shot Uppy/presigned PUT to `<s3prefix>/user_<userId>/sessions/<sessionId>/<safeFilename>`.

After Uppy reports success, the frontend calls `POST /sessions/:sessionId/files/sync-to-sandbox` (below) so the agent sees the file without a sandbox restart.

### `POST /sessions/:sessionId/files/sync-to-sandbox`

Body: `{ key: string }`. Verifies the key is under the user's session prefix, then downloads it into the live session sandbox directory at the relative path (mirroring the cold-start restore behaviour). No-op if the sandbox isn't currently materialized (the cold-start restore will pick the file up next time).

This route exists specifically so a user can upload a file mid-conversation and have the agent's next turn read it via `readFile` without restarting anything.

### `DELETE /sessions/:sessionId/files/:key`

Deletes the S3 object. Auth check on prefix. Returns `{ deleted: true }`. Does not remove the corresponding file from the live sandbox dir — agents that already cached the contents in conversation history retain access; future readFile calls will fail with a "no such file" surface, which is fine.

### `GET /sessions/:sessionId/file/:key/preview-pdf`

For binary office formats (`.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp`). Responds with `Content-Type: application/pdf` streaming the rendered PDF.

Implementation:
1. Resolve the source S3 ETag via `HeadObject`.
2. Call `pdfPreviewCache.get(sourceKey, etag)` — returns either a cached buffer or kicks off a fresh render.
3. Stream the buffer back.

The frontend never needs to know about the cache; it just hits this endpoint and gets a PDF.

## `pdf-preview-cache.ts` module

Lives at `backend/src/sessions/pdf-preview-cache.ts`. Single exported function:

```ts
async function getPdfPreviewBytes(opts: {
  sourceKey: string;
  etag: string;
  config: ExuluConfig;
}): Promise<Buffer>
```

Behavior:

- Cache file path: `/tmp/exulu-pdf-cache/<sanitizedEtag>.pdf`. S3 returns ETags wrapped in double-quotes; we strip the quotes and additionally `[^a-zA-Z0-9_-]` → `_` so weird ETag formats (e.g. multipart-upload ETags with hyphens) stay filename-safe.
- Hit path: `existsSync` → read file → return.
- Miss path:
  1. Fetch the source object from S3 into a temp file at `/tmp/exulu-pdf-cache/_in/<etag>.<ext>`.
  2. Spawn `soffice --headless --convert-to pdf <input> --outdir /tmp/exulu-pdf-cache/_out`.
  3. Move the resulting PDF to `/tmp/exulu-pdf-cache/<etag>.pdf`.
  4. Clean up the input temp file.
  5. Return the bytes.
- **In-flight coalescing**: a `Map<etag, Promise<Buffer>>` so two simultaneous requests for the same ETag share one LibreOffice invocation.
- Errors from `soffice` surface as a thrown `PreviewRenderError`; the route maps that to 500 with a clear message.

## Frontend API helpers

`frontend/util/api.ts` adds `sessionFilesApi`:

```ts
sessionFilesApi = {
  list(sessionId: string): Promise<{ files: SessionFile[] }>,
  uploadSign(sessionId: string, filename: string, contentType: string):
    Promise<{ uploadUrl: string; key: string }>,
  syncToSandbox(sessionId: string, key: string): Promise<void>,
  delete(sessionId: string, key: string): Promise<{ deleted: true }>,
  previewPdfUrl(sessionId: string, key: string): string, // auth'd URL the frontend embeds in <iframe>
}
```

`previewPdfUrl` returns a URL with the auth token in a query string (matching how `/s3/download` provides URLs the browser can embed without the JS bearer header).

## Frontend components

New, focused files under `frontend/components/session-files/`:

- `session-files-panel.tsx` — top-level. Owns the list-vs-preview view state, polling, panel header (title + scope notice + close button).
- `file-row.tsx` — one entry in the list. Name, icon, metadata, hover actions.
- `upload-zone.tsx` — drag-drop dropzone, runs the upload via Uppy with the per-file presigned URL, calls `sync-to-sandbox` on success.
- `preview-pane.tsx` — routes by content type: TextPreview / CodePreview / SecureImageRenderComponent / PdfPreview / Metadata-only fallback.
- `pdf-preview.tsx` — `<iframe src={previewPdfUrl}>`.

The chat page imports just `<SessionFilesPanel />` and wires the toggle state in its header.

## Preview rendering by content type

Inferred from the file extension (and the response's `Content-Type` as fallback):

| Extension(s) | Renderer | Notes |
|---|---|---|
| `.md`, `.txt` | `TextPreview` | Existing component; markdown rendered. |
| `.py`, `.js`, `.ts`, `.tsx`, `.json`, `.yaml`, `.yml`, `.sh`, `.html`, `.css`, `.xml`, `.toml` | `CodePreview` | Syntax highlight by extension. |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg` | `SecureImageRenderComponent` | Presigned URL → `<img>`. |
| `.pdf` | `pdf-preview.tsx` direct | Iframe with the presigned download URL. |
| `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp` | `pdf-preview.tsx` with `previewPdfUrl` | LibreOffice → PDF route. |
| anything else | metadata + Download button | No preview attempt. |

Inline content fetch for text/code is capped at 200 KB (matches the skills editor) — larger files get a "too big to preview inline" message + Download.

## Agent visibility of user uploads

User-uploaded files land at exactly the same S3 prefix as agent artifacts (`<s3prefix>/user_<userId>/sessions/<sessionId>/...`), so the existing `restoreArtifactsFromS3` cold-start logic already covers process-restart scenarios. The `sync-to-sandbox` route covers the warm-sandbox case mid-conversation.

The skills section of the system prompt (in `provider.ts`) gets one extra sentence:

> *"Files the user has uploaded to this session are visible in the working directory by their original filename — read them with the readFile tool or list them with `ls`."*

This appears whether skills are present or not — it's session-level info, not skill-specific. Implementation note: factor this into a separate `if (sessionID)` block in `provider.ts` rather than nesting under the `if (currentSkills?.length)` block.

## Live updates

- Polling: when the panel is open, call `sessionFilesApi.list(sessionId)` every 5 seconds.
- The polling interval is plain `setInterval`, cleared on panel close / unmount.
- This is the cheap-and-correct approach. A future iteration could hook into the chat stream's tool-result events (`artifacts` field on the `bash` and `writeFile` tool outputs) to push updates without polling, but that's incremental.

## Error surfaces

- **`/sessions/:sid/files` fails** → panel shows an error state with a Retry button; existing list (if any) stays visible.
- **Upload fails** → toast with the error; the file row doesn't appear, no orphan in S3 (presigned PUT either succeeded or didn't).
- **`/preview-pdf` fails** → preview pane shows "Could not render preview" + Download button. The cache miss path's `soffice` failure is logged server-side with the source key + ETag.
- **`sync-to-sandbox` fails** → log on the server, surface a warning toast: "File uploaded but the agent may not see it until the next session restart." Upload itself is still considered successful.

## Files touched

- `backend/src/exulu/routes.ts` — 5 new routes (list, upload-sign, sync-to-sandbox, delete, preview-pdf) + a small auth helper for the session-prefix check.
- `backend/src/sessions/pdf-preview-cache.ts` — new module.
- `backend/src/exulu/provider.ts` — one paragraph added to the system prompt's session-context section.
- `backend/ee/invoke-skills/create-sandbox.ts` — small exported helper to download a single S3 key into the live session dir; reused by the sync-to-sandbox route.
- `frontend/util/api.ts` — `sessionFilesApi` block.
- `frontend/app/(application)/chat/[agent]/[session]/chat.tsx` — layout change to flex-row, toggle button in header, `<SessionFilesPanel />` mount, panel-open state with localStorage persistence.
- `frontend/components/session-files/session-files-panel.tsx` — new top-level panel.
- `frontend/components/session-files/file-row.tsx`, `upload-zone.tsx`, `preview-pane.tsx`, `pdf-preview.tsx` — new focused pieces.

## Test plan

- Fresh session, no files: open panel → empty state visible, scope notice shown, upload zone present.
- Drop a `.md` file: row appears, click Preview → markdown rendered inline.
- Drop a `.docx`: row appears, click Preview → spinner → iframe shows the LibreOffice-rendered PDF. Click Preview again on the same file → instant (cache hit; mtime on the cache file unchanged within seconds).
- Have the agent run the docx skill to produce `Contract_Review_Result.docx`: within 5s the file appears in the panel (poll). Click Preview → PDF renders.
- Upload a `.pdf` directly → iframe renders the file (no LibreOffice step).
- Delete a file → row disappears; refresh the page → still gone; agent's next `ls` doesn't show it.
- Upload a file, then immediately ask the agent to read it. The agent's `readFile` against the filename succeeds because `sync-to-sandbox` placed it in the live sandbox dir.
- Open the panel in two browser tabs for the same session: both poll, both reflect uploads done from either side within 5s.
- Concurrent `.docx` previews from two tabs of the same file → only one `soffice` process spawns (in-flight coalescing).
- Try uploading a 60 MB file → frontend rejects with a clear error before hitting Uppy.
- Try `GET /sessions/<sid-of-other-user>/files` from a different user's account → 403.

## Out-of-scope follow-ups noted

- Pre-built thumbnails for images / first page of PDFs (could be added to the list view for nicer browsing).
- Folder hierarchy support in the panel (the agent could create subdirs; for v1 we show a flat list).
- A scheduled cleanup of `/tmp/exulu-pdf-cache/` (the OS reaps `/tmp` eventually; we don't pre-empt).
- Stream-event-driven panel updates instead of 5s polling.
- Bulk operations (multi-select delete, multi-file download as zip).
