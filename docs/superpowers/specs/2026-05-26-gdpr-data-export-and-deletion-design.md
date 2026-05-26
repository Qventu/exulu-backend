# GDPR data export and account deletion — Design

**Date:** 2026-05-26
**Scope:** Two HTTP routes on the Exulu backend that satisfy DSGVO/GDPR Art. 15 (Recht auf Auskunft) and Art. 17 (Recht auf Löschung), gated to super-admin operators.

## Goals

- Operator-driven endpoints (super-admin only) to fulfil data-subject access and erasure requests for any user in the system.
- Export returns a single ZIP containing the user's account information and all personal data we hold for them in Postgres.
- Deletion hard-erases the user's database footprint and S3 binaries in one operation.

## Non-goals

- Self-service flows for end users (no `/me/...` variants). All access is via super-admin.
- Pseudonymization, soft-delete, or recovery windows. Deletion is intentionally final.
- Background job orchestration. Both routes execute synchronously per request.
- A separate audit log of GDPR operations. Existing server logs are sufficient for the immediate need.

## Routes

Both routes are registered in `src/exulu/routes.ts` (root-mounted, matching the existing convention — the codebase does not use an `/api/` prefix).

| Method | Path | Response |
|---|---|---|
| `GET` | `/users/:id/data-export` | `200` with `Content-Type: application/zip` and `Content-Disposition: attachment; filename="user-<id>-export-<isoDate>.zip"`. Errors: `400` (bad id), `401` (no auth), `403` (not super-admin), `404` (no such user), `500` (build failure). |
| `DELETE` | `/users/:id` | `204 No Content` on success. Errors: `400` (bad id), `401` (no auth), `403` (not super-admin, or attempted self-delete), `404` (no such user), `500` (DB transaction failed). |

## Authentication & authorization

Both handlers share an identical preamble, factored into a file-local helper `resolveTargetUser(req, res)` that returns the target `User` row or `null` (after having written the response).

1. `await requestValidators.authenticate(req)` — on failure return `authResult.code ?? 401` with `{ detail: authResult.message }`.
2. Require `authResult.user.super_admin === true`; otherwise `403 { detail: "Super admin access required." }`.
3. Parse `req.params.id` as an integer; on `NaN` return `400 { detail: "Invalid user id." }`.
4. Look up the row in `users`; if missing, return `404 { detail: "User not found." }`.

For `DELETE` only, an additional check after step 4:

5. If `targetUser.id === authResult.user.id`, return `403 { detail: "Super admins cannot delete their own account." }`.

## Data export contents

ZIP built in memory with `JSZip` (already a dependency — same pattern as `src/skills/bundle-extractor.ts`). All DB reads share one `postgresClient()` connection. JSON pretty-printed with 2-space indent.

| File | Source | Notes |
|---|---|---|
| `user_data.json` | `users` row for `:id`, with `role` hydrated to the full role object | **Strip** `password`, `apikey`, `temporary_token`, `anthropic_token` before serializing. |
| `sessions.json` | `agent_sessions` where `user = :id` | Each session augmented with `messages: AgentMessage[]` from `agent_messages` where `session = <session_id>`, ordered by `createdAt` ascending. |
| `feedback.json` | `feedback` rows where `user = :id` | Plain dump. |
| `prompt_favorites.json` | `prompt_favorites` rows where `user_id = :id` | Plain dump. |
| `tracking.json` | `tracking` rows where `user = :id` | Plain dump. |
| `README.txt` | Generated | One-paragraph explanation of the export format, the export timestamp, and a reference to Art. 15 DSGVO. |

The S3 prefix `user_<id>/` (session files, skill staging) is **not** included in the export — the export is the database personal-data set. Operators can pull S3 separately if a subject specifically requests their uploads.

## Deletion cascade

All Postgres deletions run inside one `db.transaction(...)`. S3 cleanup happens after the transaction commits.

Tables touched and order:

1. `agent_messages` where `user = :id`
2. `agent_sessions` where `user = :id`
3. `feedback` where `user = :id`
4. `prompt_favorites` where `user_id = :id`
5. `tracking` where `user = :id`
6. `rbac` where `user_id = :id`
7. `users` where `id = :id`

After the transaction commits:

8. `listS3ObjectsByPrefix("user_<id>/", config)` and delete each key via `deleteS3Object`. Errors here are logged with `console.error` but do not fail the request — the database personal-data footprint is already gone, and stale S3 keys carry only an integer user id, no identifiers.

### Failure modes

- Any DB delete throws → transaction rolls back, route returns `500 { detail: "Failed to delete user." }`. The user row is intact and the operation can be retried.
- S3 list/delete throws after commit → log; route still returns `204`. A future cleanup sweep (out of scope) can reconcile orphaned prefixes.

## Components and dependencies

- **New code:** ~150 LOC added to `src/exulu/routes.ts`, in its own section block between Session Files and the `app.use(express.static(...))` call. Two route handlers plus the `resolveTargetUser` helper.
- **No new modules.** No new dependencies (uses `JSZip`, `postgresClient`, `listS3ObjectsByPrefix`, `deleteS3Object`, `requestValidators` — all already in scope).
- **No schema changes.** Uses existing tables only.

## Testing

- Manual: as a super-admin, hit `GET /users/:id/data-export` for a user with sessions, verify the ZIP opens and contains the six expected files with non-empty content where applicable.
- Manual: as a super-admin, `DELETE /users/:id` and verify (a) the user disappears from `users`, (b) `agent_sessions`/`agent_messages` for them are gone, (c) S3 prefix is empty.
- Manual negative cases: non-super-admin gets 403; bad id gets 400; missing user gets 404; self-delete gets 403.

Automated tests are not in scope for this spec — the codebase does not have route-level integration tests for the existing user-data endpoints, so adding them here would be a new pattern. Can be added in a follow-up if desired.

## Open questions

None at design time. All ambiguities resolved during brainstorming:

- Delete semantics → hard delete + cascade.
- Export scope → DB personal-data set (user + sessions + messages + feedback + prompt_favorites + tracking), excluding S3 binaries.
- Self-delete → blocked.
- Route prefix → root-mounted (`/users/:id/...`), matching codebase convention.
