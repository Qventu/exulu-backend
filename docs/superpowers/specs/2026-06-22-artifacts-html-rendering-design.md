# HTML Artifact Rendering Route

**Date:** 2026-06-22
**Status:** Design

## Goal

Let a user view an HTML file that was uploaded to the configured S3 server by
visiting `GET <BACKEND>/artifacts/<s3key>` in a browser. The page renders the
HTML inline. The route is authenticated: an unauthenticated visitor is met with
the browser's **native Basic-auth password prompt**, and can paste a regular
Exulu API key (as the password) to get in.

## Background

- S3 access helpers live in `src/uppy/index.ts`. `getS3ObjectBytes(key, config)`
  reads an object as a `Buffer` from the **configured default bucket**
  (`config.fileUploads.s3Bucket`); its `key` is the object key **relative to the
  bucket** (no bucket name in it).
- Authentication is centralized in `authentication({ apikey, authtoken, internalkey, db })`
  (`src/auth/auth.ts`). An API key has the format `{secret}/{name}`; the helper
  matches it against `users` of `type = "api"` via bcrypt.
- Next-auth bearer tokens are verified by `getToken(authHeader)`
  (`src/auth/get-token.ts`), which expects a `"Bearer <jwt>"` string.
- Routes are registered on an Express **5.1** app in
  `src/exulu/routes.ts` (`createExpressRoutes`).

## Decisions

These were settled during brainstorming:

1. **Access scope:** Any valid credential (any working API key, or a logged-in
   user) may view any artifact. No per-file ownership check.
2. **Delivery:** Stream the bytes through the server as `text/html`. Never expose
   a presigned URL.
3. **File types:** HTML only — keys ending in `.html` or `.htm`. Everything else
   is rejected.
4. **Bucket:** Use `getS3ObjectBytes` as-is (default configured bucket). Do not
   modify it and do not parse a bucket from the URL to override the client.
5. **Key format:** The `<s3key>` in the URL may arrive **either** as a bare
   object key **or** bucket-prefixed (as `/s3/list` returns it). The route must
   handle both.

## Design

### Route registration

Add to `createExpressRoutes` in `src/exulu/routes.ts`:

```ts
app.get("/artifacts/*splat", async (req, res) => { ... });
```

Express 5 requires named wildcards. `req.params.splat` is an **array** of path
segments; reconstruct the key with `req.params.splat.join("/")`. URL-decode each
segment.

### Key normalization

```
fullPath = decoded splat segments joined by "/"
if first segment === config.fileUploads.s3Bucket:
    key = remaining segments joined by "/"
else:
    key = fullPath
```

This makes both the bucket-prefixed and bare-object-key forms resolve to the
correct object key for `getS3ObjectBytes`.

### File-type guard

If `key` does not end (case-insensitive) in `.html` or `.htm`, respond `400`
with a JSON `{ detail: "Only .html artifacts can be rendered." }`.

### Authentication gate

A helper resolves the credential from the request, reusing the existing
`authentication()` so there is one source of truth:

1. Read the `Authorization` header.
2. If it starts with `Basic `: base64-decode the remainder, split on the **first**
   `:`. The portion **after** the colon (the password) is the API key; the
   username is ignored. Call `authentication({ apikey, db })`.
3. Else if it starts with `Bearer `: call `getToken(header)` and then
   `authentication({ authtoken, db })` — so a logged-in frontend `fetch` with a
   next-auth token still works.
4. If there is **no** `Authorization` header, or auth fails
   (`!result.user?.id`), respond:
   - status `401`
   - header `WWW-Authenticate: Basic realm="Exulu Artifacts"`
   - a short `text/plain` body ("Authentication required.")

   Setting `WWW-Authenticate` is what makes the browser show its native prompt
   and re-prompt after a wrong key.

### Delivery

On successful auth:

1. `const bytes = await getS3ObjectBytes(key, config)`.
2. Set headers:
   - `Content-Type: text/html; charset=utf-8`
   - `Cache-Control: private, no-store`
   - `X-Content-Type-Options: nosniff`
3. `res.send(bytes)`.

If the S3 read fails because the object is missing (`NoSuchKey` / `NotFound`),
respond `404`. Other errors → `500`.

### Security notes

- The rendered HTML runs JavaScript in the **BACKEND origin**. Because Exulu auth
  is header-based (API key / bearer token), there is no session cookie on the
  backend origin for malicious HTML to exfiltrate. `X-Content-Type-Options:
  nosniff` is set.
- No restrictive `Content-Security-Policy` is applied: a CSP could break
  legitimate rendering of self-contained HTML artifacts. This is a deliberate
  choice given access requires a valid credential.
- Access is "any valid credential" by design — handing someone an API key lets
  them open any artifact link. If artifact links are shared, the API key is the
  capability.

## Out of scope

- Serving non-HTML files or sibling assets referenced by relative URLs
  (CSS/JS/images). Only the single HTML document is served. Artifacts are
  expected to be self-contained (inline styles/scripts/data URIs).
- Per-file ownership / RBAC checks.
- Caching or CDN of rendered output.

## Testing

**Credential parsing helper (unit):**
- `Basic base64("anything:KEY")` → extracts `KEY` as the api key.
- `Bearer <jwt>` → routes to the token path.
- Missing header → no credential (triggers 401).
- Malformed Basic value → no credential (triggers 401).

**Route (integration-style):**
- No `Authorization` → `401` with `WWW-Authenticate: Basic` header present.
- Invalid API key → `401` with `WWW-Authenticate` header.
- Valid API key, `.html` key → `200`, `Content-Type: text/html`, body equals
  object bytes.
- Bucket-prefixed key resolves to the same object as the bare key.
- Non-`.html` key → `400`.
- Valid auth but missing object → `404`.
