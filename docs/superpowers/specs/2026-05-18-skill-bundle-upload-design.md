# Skill bundle upload

**Status:** Draft
**Date:** 2026-05-18
**Owner:** dclaessen-exulu

## Goal

Let users upload a full skill bundle as a `.zip` (or a single `SKILL.md`) from the Skills page in the frontend, instead of only creating an empty skill and adding files one by one via the per-file editor. The upload is extracted server-side and stored at `skills/<skillId>/v1/...` in S3 — the same prefix the per-file flow already uses — so the new bundle is indistinguishable from one assembled manually.

## Non-goals

- Updating an existing skill via upload (creating a new version from a zip). This will be a follow-up; the current spec is create-only.
- Parsing SKILL.md frontmatter to auto-fill name/description/tags. User types these manually, matching today's create flow.
- Re-uploads of partially-failed bundles. If extraction fails mid-flight, the skill row stays in a "no files yet" state and the user re-uploads from the editor page or deletes the row.
- A scheduled cleanup of orphaned staging keys. Out of scope; staging keys live indefinitely in S3 if a user closes the tab mid-upload.

## Architecture

Four moving parts:

1. **Frontend modal (extended)** — the existing New Skill modal at `frontend/app/(application)/skills/page.tsx` gets a mode toggle: **Create blank** (current behavior) | **Create from upload**.
2. **Frontend Uppy reuse** — `useUppy` + `uppy-dashboard` (already used for per-file uploads in the skill editor) drive a single-file `.zip`/`.md` dropzone inside the modal.
3. **Two new REST endpoints** on the backend:
   - `POST /skills/:skillId/upload-sign` — returns a presigned PUT URL for a per-user staging key in S3.
   - `POST /skills/:skillId/init-from-upload` — fetches the staging object, validates + extracts it, uploads each entry to the skill prefix, updates the DB row.
4. **`backend/src/skills/bundle-extractor.ts`** (new) — pure async function that takes the zip/md bytes and writes them to S3. Kept separate from the route handler so the extraction logic is testable in isolation.

## Frontend flow

After the user picks a file and clicks Create in upload mode:

1. `skillsCreateOne` GraphQL mutation runs as today → returns `skillId`.
2. `skillsApi.uploadSign(skillId, extension, contentType)` → `{ uploadUrl, stagingKey }`.
3. Uppy uploads the file directly to S3 via that presigned PUT URL. Configured with `maxNumberOfFiles: 1` and `allowedFileTypes: ['.zip', '.md']`.
4. On Uppy success, `skillsApi.initFromUpload(skillId, stagingKey, isZip)` → `{ filesCount }`.
5. On 200: close the modal, redirect to `/skills/<skillId>` (the existing post-create destination).
6. On any error after `skillsCreateOne`: surface the error in the modal. The empty skill row stays in place. We do NOT auto-rollback via a GraphQL delete — that creates more failure surface (delete fails too) than it solves.

The mode toggle defaults to "Create blank" so the existing fast path is unchanged.

## Backend route: `POST /skills/:skillId/upload-sign`

Request:

```ts
{ extension: '.zip' | '.md', contentType: string }
```

Response:

```ts
{ uploadUrl: string, stagingKey: string }
```

Behavior:

- Verify the authenticated user owns or has access to `skillId` (mirror checks already in `/skills/:skillId/sign`).
- Generate `stagingKey = user_<userId>/skills/_staging/<uuid><extension>` and a presigned PUT for it (1 hour expiry).
- Return both. The frontend uses `uploadUrl` for the PUT and passes `stagingKey` back in the init call.

## Backend route: `POST /skills/:skillId/init-from-upload`

Request:

```ts
{ stagingKey: string, isZip: boolean }
```

Response:

```ts
{ filesCount: number }
```

Behavior:

1. Verify the user owns `skillId` AND that `stagingKey` starts with `user_<userId>/skills/_staging/` (so users can't trigger extraction of another user's staging key).
2. Fetch the staging object from S3 with `GetObjectCommand`.
3. Delegate to `extractBundleToS3({ bytes, skillId, isZip, config })` from `bundle-extractor.ts`.
4. Update the skill DB row: `s3folder = "skills/<skillId>"`, `current_version = 1`, `history = [{ version: 1, files: N, createdAt }]` — mirroring what the current `/init` route does.
5. Delete the staging key with `DeleteObjectCommand` (best-effort — log on failure, don't fail the request).
6. Return `{ filesCount }`.

## Module: `backend/src/skills/bundle-extractor.ts`

Single exported function:

```ts
async function extractBundleToS3(opts: {
  bytes: Buffer,
  skillId: string,
  isZip: boolean,
  config: ExuluConfig,
}): Promise<{ filesCount: number }>
```

Behavior:

- **Single-`.md` case** (`isZip: false`): upload `bytes` to `skills/<skillId>/v1/SKILL.md`. Return `{ filesCount: 1 }`.
- **Zip case** (`isZip: true`):
  1. Parse with `jszip` (already in `node_modules`, currently unused).
  2. Walk all entries. For each entry path:
     - Reject the whole upload if the path contains `..` or starts with `/`. Throw a 400-style error with the offending path.
     - Skip directory entries (jszip exposes a `dir` flag).
  3. Detect a single top-level wrapper folder: if every entry shares the same first path segment, strip that segment from each entry's relative path. Anthropic skill zips typically have this shape (`docx/SKILL.md`, `docx/scripts/...`).
  4. Verify that, after stripping, an entry named `SKILL.md` exists at the root. Reject the upload if not.
  5. Enforce caps: total uncompressed size ≤ **50 MB**, total entry count ≤ **500**. Reject with explicit numbers in the error message if exceeded. Both caps are computed by summing entry uncompressed sizes as the walk proceeds — bail at the first cap violation rather than after fully walking the archive.
  6. Upload each entry to `skills/<skillId>/v1/<relPath>` via `PutObjectCommand`. Sequential uploads — skill bundles are small enough that parallelism isn't worth the added failure handling complexity.
  7. If any S3 upload fails partway through, throw. The caller (route handler) doesn't attempt rollback; the partially-extracted skill remains in S3 and the DB row stays without `current_version`/`s3folder` set, so the editor page shows it as "needs files".

The function is the single place where path safety and caps are enforced — the route handler is just a transport layer.

## Validation rules (consolidated)

- Path safety: any entry path containing `..` or starting with `/` → reject the whole upload.
- Required file: `SKILL.md` at the (post-strip) root → reject if missing.
- Size cap: 50 MB total uncompressed.
- Count cap: 500 entries (excluding directory markers).

## Frontend API helpers (`frontend/util/api.ts`)

Two new methods on `skillsApi`:

```ts
uploadSign(skillId: string, extension: '.zip' | '.md', contentType: string)
  : Promise<{ uploadUrl: string, stagingKey: string }>

initFromUpload(skillId: string, stagingKey: string, isZip: boolean)
  : Promise<{ filesCount: number }>
```

## Frontend modal changes

In `frontend/app/(application)/skills/page.tsx`:

- Add a `mode: 'blank' | 'upload'` state inside the modal.
- Two pill buttons at the top: "Create blank" (default) | "Create from upload".
- In `upload` mode: render an Uppy `Dashboard` component below the existing name/description/tags fields, configured for one file, `.zip` or `.md`. The Create button stays disabled until a file is selected AND name is filled.
- In `blank` mode: unchanged.
- The Create handler branches on mode: blank path is today's flow; upload path runs `skillsCreateOne` → `uploadSign` → Uppy upload → `initFromUpload`.

We extend `useUppy` only if its current signature can't take a one-shot upload URL — to be confirmed during implementation. If extension is needed, it should remain backwards-compatible with the existing per-file editor uses.

## Error surfaces

- **Zip parse failure / corrupt archive**: 400 with a clear message ("Could not parse zip file: <reason>").
- **Missing SKILL.md**: 400 with `"Bundle must contain a SKILL.md file at the root."`
- **Path traversal**: 400 with `"Bundle contains an unsafe path: <path>"`
- **Size cap exceeded**: 400 with actual size and the 50 MB limit.
- **Count cap exceeded**: 400 with actual count and the 500 limit.
- **S3 GET/PUT failure mid-extract**: 500. Skill row stays without `current_version`/`s3folder`; editor page shows "needs files".

## Files touched

- `backend/src/exulu/routes.ts` — add `upload-sign` and `init-from-upload` handlers near the existing `/init` handler.
- `backend/src/skills/bundle-extractor.ts` — new file containing `extractBundleToS3`.
- `frontend/util/api.ts` — two new methods on `skillsApi`.
- `frontend/app/(application)/skills/page.tsx` — mode toggle in the New Skill modal, dropzone UI block for upload mode.
- `frontend/hooks/use-uppy.tsx` — small extension if needed to support a one-shot fixed upload URL; review during implementation.

## Test plan

- Upload a valid zip with `SKILL.md` at root → skill row created, files at `skills/<id>/v1/...`, redirect to editor.
- Upload a valid zip wrapped in a top-level folder (e.g. `docx/SKILL.md`) → wrapper stripped, same result.
- Upload a `.md` file → skill row created, single file at `skills/<id>/v1/SKILL.md`.
- Upload a zip without SKILL.md → 400, skill row exists but `current_version` unset (editor shows "needs files").
- Upload a zip with `../etc/passwd` entry → 400, no S3 writes happen.
- Upload a 60 MB zip → 400 with size-cap message.
- Upload a zip with 600 entries → 400 with count-cap message.
- Upload, then disconnect mid-upload → staging key remains in S3 (acceptable; cleanup is out of scope).
- Concurrent uploads of two different skills in two browser tabs → no cross-talk (per-user staging keys).
