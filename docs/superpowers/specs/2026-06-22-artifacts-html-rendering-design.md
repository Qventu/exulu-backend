# Shareable Artifact Links

**Date:** 2026-06-22 (revised 2026-06-24)
**Status:** Design

## Goal

Let a user turn an S3 artifact (created/displayed in the chat) into a
**shareable link**. From the artifact UI the user picks a unique name, an expiry
date, and an access mode (`public`, `password`, or `regular` Exulu auth). This
creates a row in a new `shared_artifacts` table. Visiting
`<FRONTEND>/artifacts/<name>` then resolves that row, enforces the chosen access
mode, and serves the file: **HTML renders inline in the browser**; everything
else (Word, Excel, PDF, …) **downloads**.

## Background

- S3 access helpers live in `src/uppy/index.ts`. `getS3ObjectBytes(key, config)`
  reads an object as a `Buffer` from the configured default bucket
  (`config.fileUploads.s3Bucket`); `key` is the object key relative to the
  bucket (no bucket name in it).
- Authentication is centralized in
  `authentication({ apikey, authtoken, internalkey, db })` (`src/auth/auth.ts`).
  An `internalkey` matching `process.env.INTERNAL_SECRET` returns a synthetic
  admin-scoped `api` user. The generic request validator
  (`src/validators/requests.ts`) does **not** pass `internalkey` — the Uppy S3
  routes read the `internal-key` header themselves. New routes must do the same.
- RBAC read enforcement lives in the backend:
  `checkRecordAccess(record, "read", user)`
  (`src/utils/check-record-access.ts`) and `applyAccessControl` /
  `authorizedRead` (`src/exulu/read-api.ts`,
  `src/graphql/utilities/access-control.ts`). It evaluates `rights_mode`
  (`public` / `private` / `users` / `roles` / `teams`), `created_by`, and the
  `rbac` table.
- Tables are defined in `src/postgres/core-schema.ts` (Knex). `RBAC: true`
  auto-adds `rights_mode` (default `"private"`) and `created_by`. Tables are
  created idempotently from the schema list in `src/postgres/init-exulu-db.ts`.
- Frontend is Next.js 16 (app router, server components by default), next-auth
  4 with a custom backend JWT exposed at `session.user.jwt`. The
  `app/(application)/layout.tsx` root layout **force-redirects** any
  unauthenticated visitor to `/login`. Server-side backend calls authenticate
  with `Authorization: Bearer ${session.user.jwt}` and `process.env.BACKEND`.

## Architecture decision

**Frontend authenticates; backend trusts via the internal key — with RBAC as a
backend-enforced hybrid.** RBAC enforcement cannot move to the frontend (it
depends on the user's roles/teams and the `rbac` table), so:

- `public` / `password` modes: the **frontend** is the gate. The viewer has no
  Exulu identity, so the frontend fetches the bytes from the backend using the
  shared `INTERNAL_SECRET` (`internal-key` header).
- `regular` mode: the viewer must have a logged-in session. The frontend forwards
  the **viewer's** bearer token to the backend, which runs the existing
  `checkRecordAccess` against the `shared_artifacts` row.

## Data model — `shared_artifacts`

New `ExuluTableDefinition` in `src/postgres/core-schema.ts`, `RBAC: true`,
registered in the `init-exulu-db.ts` schema list (idempotent create).

| field | type | notes |
|---|---|---|
| `name` | `text` (index, unique) | URL slug. Prefilled with the sanitized S3 key; user-editable. URL-safe. |
| `s3key` | `text` | Bare object key (bucket prefix stripped — see normalization). |
| `auth_mode` | `text` | `"public"` \| `"password"` \| `"regular"`. Default `"regular"`. |
| `password_hash` | `text`, nullable | bcrypt hash; set only when `auth_mode = "password"`. |
| `expires_at` | `date`, nullable | Access rejected with `410` once `now > expires_at`. `null` = no expiry. |
| `content_type` | `text`, nullable | Captured at creation when known; otherwise derived from the key's extension. |

`RBAC: true` additionally provides `rights_mode` and `created_by`, plus the usual
`createdAt`/`updatedAt`/`id`. For `auth_mode = "regular"`, the standard RBAC
fields (`rights_mode` + `rbac` table entries for users/roles/teams) scope who may
view. For `public`/`password`, `rights_mode` is not consulted.

The download filename is derived from `basename(s3key)`.

### Key normalization

The `s3key` may arrive bare or bucket-prefixed (as `/s3/list` returns it).
Normalize on **create**:

```
if first path segment === config.fileUploads.s3Bucket:
    s3key = remaining segments joined by "/"
else:
    s3key = the given key
```

Store the normalized bare key.

## Backend endpoints (`src/exulu/routes.ts`)

### `POST /shared-artifacts` — create a link

- Authed as the real user (bearer / API key via the normal validator).
- Body: `{ s3key, name, auth_mode, password?, expires_at, rights_mode?, rbac? }`.
- Normalizes `s3key`; sanitizes `name` to a URL-safe slug; sets `created_by` from
  the caller; bcrypt-hashes `password` when `auth_mode = "password"`; writes
  `rbac` entries when `auth_mode = "regular"` and `rights_mode` is `users`/
  `roles`/`teams`.
- Unique-name collision → `409` with `{ detail }` so the UI can prompt for a new
  name.
- Validation: `auth_mode = "password"` requires a non-empty `password`;
  `expires_at`, if present, must be in the future.
- Returns `{ name }`.

### `GET /shared-artifacts/:name/meta` — resolve gate

- **internal-key** auth (reads the `internal-key` header directly).
- Looks up the row by `name`. Missing → `404`. Expired → `410`.
- Returns `{ auth_mode, expires_at, filename, content_type }`. **Never** returns
  `password_hash` or bytes. Lets the frontend choose the gate.

### `GET /shared-artifacts/:name/content` — serve bytes

Looks up the row by `name`; `404` if missing; re-checks `expires_at` → `410`.
Auth depends on the row's `auth_mode`:

- `public` → requires a valid `internal-key`.
- `password` → requires a valid `internal-key` **and** an `x-share-password`
  header; bcrypt-compares to `password_hash`; mismatch → `401`.
- `regular` → requires the **viewer's** bearer token (no internal key); runs
  `checkRecordAccess(row, "read", user)`; denied → `401`/`403`.

On success: `const bytes = await getS3ObjectBytes(row.s3key, config)`, then set
headers and stream:

- HTML (`.html`/`.htm`): `Content-Type: text/html; charset=utf-8`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
- Everything else: the resolved `Content-Type`, plus
  `Content-Disposition: attachment; filename="<basename>"`.

Missing S3 object (`NoSuchKey`/`NotFound`) → `404`; other errors → `500`.

## Frontend route — `app/artifacts/[artifact_name]/`

**Top-level**, NOT under `(application)` (that group's layout force-redirects
unauthenticated visitors, which would break `public`/`password` links). Server
component (`export const dynamic = "force-dynamic"`).

Flow:

1. Fetch `<BACKEND>/shared-artifacts/<name>/meta` server-side with `internal-key`.
   `404` → not-found page; `410` → "link expired" page.
2. Branch on `auth_mode`:
   - `public` → proceed.
   - `password` → render a client password form. On submit it re-requests content
     with the password (the password is sent to the route handler / server
     action, never embedded in the page).
   - `regular` → `serverSideAuthCheck()`; if no session,
     `redirect("/login?destination=/artifacts/<name>")`; otherwise carry the
     viewer's `session.user.jwt`.
3. Fetch `<BACKEND>/shared-artifacts/<name>/content` with the appropriate
   credential (internal-key, internal-key + `x-share-password`, or the viewer's
   bearer token).
4. Dispatch by type:
   - **`.html`/`.htm` → render inline.** Serve the HTML so the browser displays
     it (e.g. via a sandboxed iframe fed the bytes), reusing the existing
     extension check.
   - **Everything else → download.** Stream the bytes to the client with the
     derived filename so the browser saves the file.

New server-only env var: `INTERNAL_SECRET` in the frontend (must equal the
backend's), sent as the `internal-key` header on server-side fetches.

### Security notes

- Inline HTML runs JavaScript in the **frontend origin**. Render it in a
  sandboxed iframe so artifact scripts can't reach the next-auth session/cookies.
  `X-Content-Type-Options: nosniff` is set on the backend response.
- `INTERNAL_SECRET` is server-only on the frontend; it is never exposed to the
  browser and never sent for `regular` mode (which uses the viewer's token).
- A `public` link is a bearer capability: anyone with the URL can view until it
  expires. That is the explicit intent of `public` mode.

## Share UI — `ShareArtifactDialog`

One shared dialog component:

- **Name** — text input, prefilled with the sanitized S3 key, editable.
- **Expiry** — presets (1 day / 7 days / 30 days / custom date); maps to
  `expires_at`.
- **Access mode** — `public` / `password` / `regular`.
- **Password** — shown only when mode is `password`.
- **RBAC scoping** — shown only when mode is `regular`, reusing the existing
  rights/RBAC controls.

On submit it calls `POST /shared-artifacts`; on success it copies
`<FRONTEND>/artifacts/<name>` to the clipboard and toasts. A `409` surfaces a
"name taken" message.

Wired into **three** artifact entry points:

- `FileItem` action row in `primitives/file-picker.tsx` (used by
  `components/message-renderer.tsx`).
- `file-row.tsx` action row in
  `app/(application)/chat/components/session-files`.
- **Inline S3 links in message text** — see below.

### Inline S3-URL detection in chat messages

Agents sometimes return a bare S3 URL in the message body (an artifact they
created and uploaded). When the renderer encounters such a URL it shows a subtle
share affordance (a small icon / CTA next to the link) that opens the same
`ShareArtifactDialog`, prefilled with the artifact's key.

- **Recognizing an S3 URL.** A URL is an S3 artifact link when its base matches
  the configured S3 endpoint, `COMPANION_S3_ENDPOINT`. Because
  `message-renderer.tsx` is a client component, this base must reach the client:
  expose it (e.g. as `s3_endpoint`) through the existing `app/api/config`
  payload, sourced server-side from `COMPANION_S3_ENDPOINT`. The renderer matches
  both markdown-link hrefs and autolinked bare URLs whose href starts with that
  base.
- **Extracting the key.** Take the URL path after the endpoint base, strip a
  leading bucket segment if present (same normalization as
  [Key normalization](#key-normalization)), and URL-decode it. That bare key
  seeds the dialog's prefilled name and the `s3key` sent to
  `POST /shared-artifacts`. (The backend re-normalizes defensively.)
- **Affordance.** Render the icon/CTA adjacent to the detected link, styled
  subtly (ghost icon button, visible on hover/focus). It does not alter the link
  itself — clicking the link still navigates as before; only the share icon opens
  the dialog.

## Out of scope

- Serving sibling/relative assets referenced by HTML (CSS/JS/images). Artifacts
  are assumed self-contained (inline styles/scripts/data URIs).
- A cleanup cron for expired rows. Expiry is enforced on access (`410`); rows are
  left in place.
- CDN/caching of served output.

## Testing

**Backend — create (`POST /shared-artifacts`):**
- Stores normalized bare key from a bucket-prefixed input.
- `password` mode hashes the password; `password_hash` never returned.
- Duplicate `name` → `409`.
- `password` mode without a password, or past `expires_at` → `400`.

**Backend — meta (`GET /shared-artifacts/:name/meta`):**
- Without `internal-key` → `401`.
- Returns `auth_mode`/`expires_at`/`filename`; never `password_hash` or bytes.
- Missing → `404`; expired → `410`.

**Backend — content (`GET /shared-artifacts/:name/content`):**
- `public` + valid `internal-key` → `200`, correct `Content-Type`.
- `password`: correct `x-share-password` → `200`; wrong → `401`.
- `regular`: viewer with RBAC access → `200`; viewer without → `401`/`403`;
  no token → `401`.
- HTML key → `text/html` inline headers; non-HTML → `Content-Disposition:
  attachment`.
- Expired row → `410`; missing S3 object → `404`.

**Frontend route (`/artifacts/[artifact_name]`):**
- `public` link renders/downloads without a login.
- `password` link shows the form; correct password serves, wrong re-prompts.
- `regular` link redirects an anonymous visitor to `/login?destination=…` and
  serves an authorized logged-in viewer.
- HTML artifact renders inline (sandboxed); pdf/docx/xlsx download.
- Expired / unknown name → expired / not-found pages.

**Frontend — inline S3-URL detection (message renderer):**
- A message link whose base matches `s3_endpoint` (from `/api/config`) shows the
  share CTA; a non-S3 link does not.
- The key is extracted correctly from both markdown-link and bare-URL forms,
  with the bucket prefix stripped, and seeds the dialog.
- Clicking the link still navigates; the CTA opens `ShareArtifactDialog`.
