# ExuluTool OAuth — Design

**Date:** 2026-06-10
**Status:** Approved

## Summary

Add first-class OAuth 2.0 support to `ExuluTool`. A developer declares an `oauth` config
property on the tool constructor; the framework transparently wraps the tool's `execute`
so that it only runs when a valid access token exists for the calling `(toolId, userId)`
pair. When no valid token exists, the tool short-circuits and returns an authorization
URL the agent can show the user. A single generic backend callback route completes the
flow and persists tokens. The developer never writes OAuth plumbing.

This replaces the earlier idea of an exported `ExuluOauth` utility that devs would call
manually at the start of `execute` — the config-property approach removes boilerplate
and makes it impossible to forget the check.

## Scope

- Generic OAuth 2.0 **authorization-code grant** (with PKCE, on by default). Works with
  any standards-compliant provider (Google, Slack, GitHub, HubSpot, ...).
- All OAuth parameters declared **in code** by the developer (sourced from env vars or
  however they like). No auto-added tool config variables, no admin UI in v1.
- No per-provider presets, no other grant types (client credentials, device code), and
  no frontend changes in v1. The structured result field is forward-compatible with a
  future frontend "Connect" button.

## Developer API

```ts
new ExuluTool({
  id: "hubspot_crm",
  name: "HubSpot CRM",
  description: "...",
  type: "function",
  config: [],
  oauth: {
    authorizationUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    clientId: process.env.HUBSPOT_CLIENT_ID!,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET!,
    scopes: ["crm.objects.contacts.read"],
    pkce: true, // optional, default true; set false for providers that reject PKCE
    extraAuthParams: { access_type: "offline", prompt: "consent" }, // optional passthrough
  },
  execute: async (inputs) => {
    // Only runs when a valid token exists.
    const token = inputs.oauth.accessToken;
    // ... call the provider API
  },
});
```

Inside `execute`, the framework injects `inputs.oauth = { accessToken, expiresAt, scopes }`
alongside the existing injected fields (`user`, `upload`, `exuluConfig`,
`toolVariablesConfig`, ...). Generator-based (streaming) executes pass through unchanged.

`src/index.ts` exports only the `ExuluOauthConfig` type for convenience — no new runtime
export.

## Architecture

New files under `src/exulu/oauth/`:

| File | Responsibility |
|---|---|
| `types.ts` | `ExuluOauthConfig` type |
| `registry.ts` | Module-level `Map<toolId, ExuluOauthConfig>`, populated at tool construction, read by the callback route |
| `token-store.ts` | get/upsert/delete against `oauth_tokens`; AES-encrypts token values with `NEXTAUTH_SECRET` (same CryptoJS pattern as the variables table) |
| `flow.ts` | Auth-URL builder (PKCE S256 + encrypted state) and code/refresh exchanges against `tokenUrl` |

Changed files:

- `src/exulu/tool.ts` — optional `oauth` constructor param. When present the constructor:
  1. validates the config and that `process.env.BACKEND` is set, throwing immediately
     with a message naming the tool and the missing piece (same fail-fast style as the
     existing type guard);
  2. registers the tool in the oauth registry;
  3. wraps the dev's `execute` before handing it to the AI SDK `tool()` factory.
- `src/exulu/routes.ts` — new `GET /oauth/callback` route inside `createExpressRoutes()`.
- `src/postgres/` — `oauth_tokens` table added to the core schema; created in init-db
  gated by an existence check, per the project's migration convention.

## Data flow

**Happy path (valid token exists):**
agent calls tool → wrapper reads `inputs.user.id` → token store finds row for
`(tool_id, user_id)` → if access token expired and a refresh token exists, refresh
against `tokenUrl` and upsert → inject `inputs.oauth` → run the dev's `execute`.

**Authorization path (no token, or refresh failed):**
wrapper builds the auth URL — `authorizationUrl` + `response_type=code`, `client_id`,
`redirect_uri=${process.env.BACKEND}/oauth/callback`, `scope` (space-joined), PKCE
`code_challenge` (S256), and `state` — and short-circuits **without** calling the dev's
`execute`, returning:

```ts
{
  result: "Authorization required. Show the user this link and ask them to retry after connecting: <url>",
  oauth: { authorizationUrl: "<url>" }
}
```

The `result` text makes the agent relay the link today; the structured `oauth` field
lets the frontend render a connect button later. After the user authorizes, they retry
the tool call in chat, which now takes the happy path.

**State param:** an AES-encrypted (`NEXTAUTH_SECRET`, CryptoJS — same as variables)
JSON blob `{ toolId, userId, codeVerifier, exp }` with a 10-minute expiry.
Self-contained: survives server restarts, needs no state table. Failure to decrypt is
treated as tampering and rejected.

**Callback — `GET /oauth/callback?code&state`:** no auth middleware (the user arrives
from the provider's redirect; identity comes from the decrypted state). Steps:

1. If the provider sent `?error=...` (e.g. `access_denied`), render the failure page.
2. Decrypt and validate state (decryptability = authenticity; reject if expired).
3. Resolve the tool's oauth config from the registry by `toolId`.
4. POST `code`, `code_verifier`, `client_id`, `client_secret`, `redirect_uri`,
   `grant_type=authorization_code` to `tokenUrl`.
5. Upsert `oauth_tokens` for `(toolId, userId)`.
6. Respond with a minimal HTML page: "✓ Connected — you can close this tab and return
   to your chat." Failures render an HTML page asking the user to retry the tool in
   chat (which generates a fresh URL).

## Schema — `oauth_tokens`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| tool_id | text | unique together with user_id |
| user_id | integer | references users |
| access_token | longText | AES-encrypted |
| refresh_token | longText nullable | AES-encrypted |
| token_type | text | usually "Bearer" |
| scopes | text | space-joined |
| expires_at | timestamp nullable | null = treated as non-expiring |
| created_at / updated_at | timestamp | |

## Security

- `clientSecret` never leaves the server — the auth URL contains only public params;
  the secret is used only in the server-side token exchange.
- PKCE (S256) on by default.
- Tokens encrypted at rest with `NEXTAUTH_SECRET`.
- State expiry (10 min) bounds the replay window; the encrypted blob cannot be forged
  without the secret.
- Tokens are strictly scoped to `(toolId, userId)` — no cross-tool or cross-user
  sharing.

## Error handling and edge cases

- **Construction time:** missing oauth fields or `process.env.BACKEND` unset → throw
  immediately, naming the tool and missing piece.
- **No user in context** (e.g. unauthenticated public-agent run): the wrapper returns a
  result stating the tool requires a signed-in user; it does not throw.
- **Refresh failure** (revoked/expired refresh token): delete the stale row and fall
  back to the authorization path — the user re-connects; no error loops.
- **Token-endpoint failure during callback:** render the failure page with the
  provider's error description; persist nothing.
- **Mid-flight revocation** (provider 401s inside the dev's execute despite a
  locally-valid token): out of scope for v1; the dev's API call fails normally. A
  `inputs.oauth.invalidate()` helper is a candidate for v2.
- **No `expires_in` in token response:** store `expires_at = null`, treat as
  non-expiring.
- **Refresh token only sent on first consent** (Google): the upsert preserves the
  existing `refresh_token` when the new token response omits it. Document
  `extraAuthParams: { prompt: "consent", access_type: "offline" }` as the Google
  recipe.
- **Concurrent calls with no token:** both return auth URLs (different state nonces);
  last callback wins on upsert — harmless.

## Testing

- **Unit:** state encrypt/decrypt round-trip and expiry rejection; auth-URL
  construction (params, PKCE challenge derivation); token-store encryption round-trip
  and upsert semantics (refresh-token preservation); wrapper behavior — short-circuit
  (no token), pass-through (valid token), auto-refresh (expired + refresh token) — with
  mocked store and fetch.
- **Route:** callback happy path, expired state, garbled state, provider `error` param,
  token-endpoint 4xx — via supertest against `createExpressRoutes()`.
- No live-provider integration tests in v1; token exchange is mocked.

## Decisions log

| Decision | Choice |
|---|---|
| OAuth scope | Generic OAuth 2.0 authorization-code flow, no presets |
| Configuration | Everything declared in code via `oauth` constructor property (pivot away from exported `ExuluOauth` utility) |
| Surfacing the auth URL | Structured result field `{ result, oauth: { authorizationUrl } }` |
| Token storage | New `oauth_tokens` table, encrypted, keyed `(tool_id, user_id)` |
| Token refresh | Automatic, with fallback to re-authorization |
| Public base URL | `process.env.BACKEND` (present in all deployments) |
| Callback architecture | Single generic route + in-memory registry + encrypted state blob |
