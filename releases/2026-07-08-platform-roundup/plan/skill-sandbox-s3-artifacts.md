# Feature plan — Skill sandbox artifacts persist to S3 (PROSE + snippet)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-05-17-skill-sandbox-s3-artifact-persistence-design.md`
- Code: `ee/invoke-skills/create-sandbox.ts` (write-through upload, cold-start
  restore, presigned URLs — writeFile result shape verified at ~line 814:
  `{ success: true, path, url?, key? }`),
  `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`
- Commits: `602b8f7` (S3 persistence + streamed skill-agent steps), `a7f9a60`
  (presigned S3 URL returned from writeFile), `6ff5a71` (sandbox file tools for
  the outer agent + system dependency check)

## What shipped

Files an agent writes in its skill sandbox are no longer disposable:

- **Write-through persistence.** Every artifact write is mirrored to S3 at
  `<s3prefix>/user_<userId>/sessions/<sessionId>/<relativePath>`. Skill source
  files are excluded — only artifacts persist.
- **Cold-start restore.** Resume a session after a sandbox teardown or process
  restart and previously written artifacts are downloaded back into the session
  directory before the agent runs — it picks up exactly where it left off.
- **Presigned URLs.** `writeFile` returns a presigned S3 URL alongside the
  local path, so a generated report is immediately shareable/downloadable.
- **Fail-soft everywhere.** Missing S3 config or a failed upload never fails
  the tool call — the local write already succeeded; persistence is best-effort
  and invisible to the model.

## Hook

**"Sandboxes are disposable. The files your agents make aren't anymore."**

## Surface area

Backend/agent-runtime feature, prose-only. Audience: teams running skill/file
agents in production.

## Page prose plan (2–3 paragraphs)

1. The pain: sandboxes are ephemeral by design — a restart between turns used
   to eat every generated report, script, and dataset.
2. The mechanism: transparent write-through to S3 + eager restore on cold
   start; local files win on process restarts (no overwrites of un-synced work).
3. The bonus: presigned URL on every write — the artifact is a link the moment
   it exists.

## Code snippet — EARNED (payload-style, JSON)

The `writeFile` tool result, shape verbatim from `create-sandbox.ts` (values
illustrative):

```json
{
  "success": true,
  "path": "sessions/3f2a.../quarterly-report.md",
  "url": "https://s3.eu-central-1.amazonaws.com/…/user_42/sessions/3f2a…/quarterly-report.md?X-Amz-Signature=…",
  "key": "uploads/user_42/sessions/3f2a.../quarterly-report.md"
}
```

Label on page: "writeFile now answers with a shareable URL".
