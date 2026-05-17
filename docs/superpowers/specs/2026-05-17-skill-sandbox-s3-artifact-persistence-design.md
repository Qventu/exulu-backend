# S3 artifact persistence for skill sandbox

**Status:** Draft
**Date:** 2026-05-17
**Owner:** dclaessen-exulu

## Goal

When a `ToolLoopAgent` running inside a skill sandbox writes a file via `writeFiles`, persist that file to S3 at `<user_id>/sessions/<session_id>/<relative_path>` (under the existing uppy s3 prefix). When the same session is resumed in a new sandbox (cold cache, process restart, or after sandbox teardown), restore the previously written artifacts back into the session directory so the agent can pick up where it left off. Skill source files are not artifacts and are not persisted.

## Non-goals

- Propagating local deletions (e.g. `rm` via bash) to S3. S3 keys are overwrite-only.
- Binary artifact support beyond what `getS3ObjectContent` already handles (text via `transformToString('utf-8')`). Artifacts in scope are text: markdown, code, JSON, etc. If future skills emit images or PDFs, a buffer-capable S3 reader will be needed; that work is out of scope here.
- Per-file lazy restore. All artifacts for a session are downloaded eagerly on cold start.
- An explicit "save artifact" tool exposed to the agent. Persistence is transparent.

## Architecture

Two extension points in `ee/invoke-skills/create-sandbox.ts`:

1. **Cold-start restore** — when `createSkillSandbox` is invoked AND the session directory does not exist on disk, list S3 under the artifact prefix and download every object into `<sessionDir>/` before returning the handle.
2. **Write-through upload** — wrap `customSandbox.writeFiles` so each successful local write is followed by an `uploadFile` call, scoped to files that qualify as artifacts.

No new sandbox lifecycle hooks are introduced. The agent prompt is unchanged — persistence is invisible to the model.

## Signature change

```ts
createSkillSandbox(
  sessionId: string,
  skills: SkillRef[],
  config: ExuluConfig,
  userId?: number | string,
): Promise<SkillSandboxHandle>
```

Threaded from `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:183` as `user?.id`.

If `userId` is undefined OR `config.fileUploads` is not configured, persistence is **disabled** (no restore, no upload) and a single `console.warn` is emitted at sandbox creation. The sandbox itself remains fully functional locally — only the S3 layer is skipped.

## S3 path convention

Per-file key passed to `uploadFile(buf, relPath, config, opts, userId)` where:

```
relPath = `sessions/${sessionId}/${pathRelativeToSessionDir}`
```

`uploadFile` applies its own prefixing, so the final S3 key becomes:

```
<s3prefix>/user_<userId>/sessions/<sessionId>/<relativePath>
```

This matches the spec's `<user_id>/sessions/<session_id>/...` shape.

## Artifact scope filter

A file qualifies as an artifact iff:

- its absolute path is under `<sessionDir>`, AND
- its absolute path is **not** under `<sessionDir>/skills/`.

Implemented as a single helper:

```ts
function isArtifactPath(absPath: string, sessionDir: string): boolean
```

Anything failing the filter is written locally but not uploaded. Paths outside `<sessionDir>` are blocked by the SRT sandbox anyway, so the filter is defensive for that case.

## Write-through upload behavior

Inside the wrapped `writeFiles`, after each local write succeeds:

1. If persistence is disabled, skip.
2. If the file path fails `isArtifactPath`, skip.
3. Read the just-written content (we already have it in `file.content`) into a buffer.
4. Call `uploadFile(buf, \`sessions/${sessionId}/${rel}\`, config, {}, userId)`. `uploadFile` already retries up to 3 times on signature/auth errors with exponential backoff.
5. If `uploadFile` throws after its internal retries, **log an error and continue** — do not throw. The agent's local write succeeded; failing the tool call would create a worse experience than a missing artifact. Loss is bounded to that single file.

Uploads happen sequentially per `writeFiles` call (the existing loop already iterates files one at a time).

## Restore behavior

On every call to `createSkillSandbox`, decide which of three branches to take based on `sandboxCache.has(sessionId)` and `existsSync(sessionDir)`:

| Cache | Dir on disk | Action |
|-------|-------------|--------|
| hit   | (n/a)       | Existing warm path: reconcile skill versions, return cached handle. No restore. |
| miss  | exists      | Process-restart case. Local files are authoritative (they may contain writes that never reached S3). Rebuild a cache entry with **empty `installedSkills`** so the existing skill-version logic re-downloads all skills, then continue normal sandbox setup. **Skip S3 artifact restore.** |
| miss  | does not exist | True cold start. `mkdir` the session dir, download skills, then restore artifacts from S3 before returning. |

Capture `dirExisted = existsSync(sessionDir)` BEFORE the `mkdir` call.

Cold-start restore steps:

1. Call `listS3ObjectsByPrefix(\`user_${userId}/sessions/${sessionId}/\`, config)`. The helper already prepends `config.fileUploads.s3prefix`.
2. For each returned `key`, compute the path relative to `<sessionDir>` by stripping `<s3prefix>/user_<userId>/sessions/<sessionId>/`.
3. Skip directory-marker keys (empty relative path).
4. `mkdir -p` the parent, then write the file with `node:fs/promises.writeFile`. Direct fs write — restore is a server-side action, not an agent action, so it does not need to go through the SRT wrapper.
5. Content is fetched via `getS3ObjectContent(key, config)` (text only — see Non-goals).

Restore is best-effort: if `listS3ObjectsByPrefix` or any individual `getS3ObjectContent` fails, log and continue. The agent sees a fresh (or partially populated) sandbox, which is strictly better than a failed tool call.

## Error surfaces

- **`userId` missing or `fileUploads` not configured** → warn once at sandbox creation, disable both restore and upload, sandbox still works locally.
- **Restore S3 list/get failure** → log, continue with whatever was successfully downloaded.
- **Upload failure after retries** → log error with sessionId, userId, and S3 key; continue. Agent loop is not interrupted.

## Files touched

- `ee/invoke-skills/create-sandbox.ts`
  - Add optional `userId` parameter.
  - Add `dirExisted` check before `mkdir`.
  - Add cold-start restore block (gated on `!dirExisted && userId && config.fileUploads`).
  - Wrap `customSandbox.writeFiles` so each successful local write is followed by an `uploadFile` call when the path qualifies as an artifact.
  - Add `isArtifactPath` helper.
- `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:183`
  - Pass `user?.id` as the new fourth argument to `createSkillSandbox`.
- No changes to `src/uppy/index.ts`. Reuse `uploadFile`, `listS3ObjectsByPrefix`, `getS3ObjectContent`.

## Test plan

- Cold sandbox + agent writeFile under `<sessionDir>/foo.md` → verify S3 object exists at `<s3prefix>/user_<id>/sessions/<sid>/foo.md`.
- Delete the in-memory cache entry AND remove `<sessionDir>` from `/tmp` → call `createSkillSandbox` again with the same sessionId → verify `foo.md` is restored locally.
- Delete the in-memory cache entry but leave `<sessionDir>` on disk (simulating process restart) → call `createSkillSandbox` → verify skills are re-downloaded but S3 restore is NOT performed (local files preserved, no overwrites).
- Write under `<sessionDir>/skills/foo/bar.md` (e.g. agent modifies a skill file) → verify NOT uploaded to S3.
- Call `createSkillSandbox` with `userId` undefined → verify a single warn is logged, no uploads attempted, sandbox commands still work.
- Inject an S3 upload failure (e.g. revoke credentials mid-session) → verify the `writeFile` tool call still resolves successfully and the agent loop continues.
