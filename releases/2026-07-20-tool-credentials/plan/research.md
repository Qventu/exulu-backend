# Research: EXULU TOOL AUTH — from OAuth-only to a general authentication union

> **Source of truth:** branch `feat/auth-user-credentials` (19 commits, `7975c0f..76d164e`,
> 2026-07-20/21), **NOT merged into `develop`** as of 2026-07-22. All file:line refs below are
> against that branch (`git show feat/auth-user-credentials:<path>`). There is **no spec doc**
> for this feature — the lineage is two OAuth specs (see below) plus the commit trail.
> The e2e test commit is `798c205` ("test: end-to-end user_credentials flow through ExuluTool").

Commit trail (oldest → newest):
`7975c0f` rename src/exulu/oauth → src/exulu/auth · `ffd77ba` ExuluAuthConfig union ·
`a21f85f` user_credentials table replaces oauth_tokens · `cc65999` credentialStore replaces
oauthTokenStore · `656db63` authRegistry keyed by union · `ae484f8` validateAuthConfig union
switch · `242daa2` ExuluTool.oauth → ExuluTool.authentication · `7441f82` wrapExecuteWithAuth
union dispatch · `651d425` CredentialInvalidError · `6f738d7` buildCredentialRequest (AES nonce) ·
`8c8112a` POST /credentials/submit · `78d1118` getValidUserCredentials · `68459bf`
credentialRequestResult · `f066b6a` wrap-execute inject/short-circuit/re-prompt · `798c205` e2e
test · `1a99e37`+`76d164e` session + userId cross-check hardening.

---

## What shipped & why it matters

Since June (spec `docs/superpowers/specs/2026-06-10-exulu-tool-oauth-design.md`), an `ExuluTool`
could declare an `oauth` config and Exulu would transparently wrap its `execute`: no valid token →
short-circuit with an authorization URL the agent shows the user; valid token → inject
`inputs.oauth.accessToken` and run. July 3's follow-up
(`docs/superpowers/specs/2026-07-03-oauth-provider-scoped-tokens-design.md`) made tokens
provider-scoped — six `jira_*` tools, one consent screen. But it was OAuth-only: any service that
hands out plain API keys, tokens, or username/password (most internal systems, most SaaS APIs)
had no framework path — developers would have had to hardcode secrets or build their own prompt flow.

This release generalizes the whole subsystem into **authentication**. `src/exulu/oauth/` became
`src/exulu/auth/`, and the config became a discriminated union — `ExuluAuthConfig =
ExuluOauthConfig | ExuluUserCredentialsConfig` — discriminated on `authType`. The new
`user_credentials` variant lets a tool declare a list of typed form fields ("API Key", password,
etc.). At execute time, if the calling user has no stored credentials, the tool short-circuits with
a **credential request**: a structured payload (provider, fields, submit URL, AES-encrypted nonce)
the chat can render as a form. The user submits once via `POST /credentials/submit`; values are
stored AES-encrypted per `(provider, userId)` in the new `user_credentials` table (JSON blob +
`auth_type` discriminator, replacing `oauth_tokens`). Every subsequent call decrypts and injects
`inputs.credentials` into the tool's `execute`.

The lifecycle is closed-loop: when a stored key stops working (the classic 401), the tool's
`execute` throws `CredentialInvalidError(provider)` — Exulu deletes the stale row and returns a
fresh credential request, so the user is re-prompted in chat instead of the tool failing forever.
Security posture: credentials never transit the LLM; the submit endpoint requires an authenticated
session and cross-checks the session's userId against the userId sealed inside the AES nonce
(15-minute TTL), so a leaked nonce can't be replayed by another user to overwrite someone else's
credentials. For tool authors it is entirely declarative — one `authentication` property, zero
auth plumbing in `execute`.

---

## Developer surfaces

### 1. The `ExuluAuthConfig` union (verbatim)

`src/exulu/auth/types.ts:43-65` (union tag at :58):

```ts
export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  help?: string;
}

export interface ExuluUserCredentialsConfig {
  authType: "user_credentials";
  provider: string;
  fields: CredentialField[];
  validate?: (values: Record<string, string>) => Promise<void>;
}

export type ExuluAuthConfig = ExuluOauthConfig | ExuluUserCredentialsConfig;

export interface ExuluCredentialsToolContext {
  userId: string;
  provider: string;
  credentials: Record<string, string>;
}
```

The OAuth half of the union (`src/exulu/auth/types.ts:14-41`, now with explicit tag at :15):

```ts
export interface ExuluOauthConfig {
  authType: "oauth";
  provider: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  pkce?: boolean;
  extraAuthParams?: Record<string, string>;
}
```

Package exports — `src/index.ts:21-29` and `:218`:

```ts
export { ExuluTool } from "./exulu/tool"
export type {
  ExuluAuthConfig,
  ExuluOauthConfig,
  ExuluUserCredentialsConfig,
  CredentialField,
  ExuluOauthToolContext,
  ExuluCredentialsToolContext,
} from "./exulu/auth/types"
// ...
export { CredentialInvalidError } from "./exulu/auth/errors";
```

### 2. THE snippet — defining a tool with `authentication`

The `ExuluTool` constructor now takes `authentication?: ExuluAuthConfig`
(`src/exulu/tool.ts:43` public field, `:61` ctor param, `:76-82` doc comment, `:110-114`
validate + register, `:126` wrap):

```ts
execute: authentication ? wrapExecuteWithAuth(id, authentication, execute) : execute,
```

Realistic definition — assembled ONLY from real fields, modeled directly on the e2e test
(`src/exulu/auth/e2e.test.ts:61-76` and `:101-115`) which constructs exactly this shape:

```ts
import { ExuluTool, CredentialInvalidError } from "@exulu/backend";
import { z } from "zod";

new ExuluTool({
  id: "acme_crm",
  name: "Acme CRM",
  description: "Query the Acme CRM API.",
  type: "function",
  config: [],
  inputSchema: z.object({ query: z.string() }),
  authentication: {
    authType: "user_credentials",
    provider: "acme",
    fields: [
      { name: "apiKey", label: "API Key", type: "password" },
    ],
  },
  execute: async (inputs) => {
    // Only runs when stored credentials exist — injected as inputs.credentials.
    const res = await fetch("https://api.acme.com/v1/search?q=" + inputs.query, {
      headers: { Authorization: `Bearer ${inputs.credentials.apiKey}` },
    });
    if (res.status === 401) throw new CredentialInvalidError("acme"); // → re-prompt
    return { result: await res.text() };
  },
});
```

Real optional extras on `fields` entries: `placeholder`, `help` (types.ts:47-48). Real optional
`validate?: (values) => Promise<void>` hook on the config (types.ts:55) — runs server-side at
submit time; a thrown error becomes a 400 `validation failed: <message>` (submit-handler.ts:79-89).

Validation at construction (`src/exulu/auth/validate.ts:52-110`): provider non-empty/trimmed,
`fields` non-empty, field names unique + trimmed, `type` must be `"text" | "password"`, and the
`BACKEND` env var must be set. Registry (`src/exulu/auth/registry.ts:51-60`): tools sharing a
provider must declare structurally identical fields (same names, types, order) — same
one-consent-per-provider model as OAuth.

### 3. POST /credentials/submit

Mounted in `src/exulu/routes.ts:417` (right after the OAuth callback at :413):

```ts
app.post("/credentials/submit", handleCredentialSubmit);
```

Handler `src/exulu/auth/submit-handler.ts` (body schema :8-11, flow :18-107):

**Request body** (zod):

```ts
const bodySchema = z.object({
  nonce: z.string().min(1),
  values: z.record(z.string(), z.string()),
});
```

**Responses** (all `{ ok: boolean, ... }` shape):

| Status | Body | When |
|---|---|---|
| 200 | `{ ok: true }` | credentials persisted |
| 401 | `{ ok: false, error: "authentication required" }` | no session (submit-handler.ts:21-25) |
| 400 | `{ ok: false, error: "invalid body" }` | zod parse failure (:29-34) |
| 401 | `{ ok: false, error: "nonce expired" \| "nonce invalid" }` | AES nonce bad / >15 min old (:39-47) |
| 403 | `{ ok: false, error: "userId mismatch" }` | session userId ≠ nonce userId (:49-56) |
| 400 | `{ ok: false, error: "provider is not a user_credentials provider" }` | unknown/oauth provider (:58-65) |
| 400 | `{ ok: false, error: "field set mismatch" }` | submitted keys ≠ declared fields (:67-77) |
| 400 | `{ ok: false, error: "validation failed: ..." }` | config.validate threw (:79-89) |

Persistence uses the **session** userId as source of truth, not the nonce's
(submit-handler.ts:98-105): `credentialStore.upsert({ provider, userId: sessionUserId,
authType: "user_credentials", data: values })`.

### 4. The credential request payload

`src/exulu/auth/credentials-request.ts:6-36` — this is what the tool returns instead of running:

```ts
export interface CredentialRequestPayload {
    provider: string;
    fields: CredentialField[];
    submitUrl: string;   // `${BACKEND}/credentials/submit`
    nonce: string;       // AES-encrypted {provider, userId, expiresAt}; TTL 15 min
}
```

Wrapped by `credentialRequestResult` (`src/exulu/auth/short-circuit.ts:3-5`):

```ts
export function credentialRequestResult(request: CredentialRequestPayload) {
  return { credentialRequest: request, result: null };
}
```

Nonce claims + verification: `CredentialNonceClaims {provider, userId, expiresAt}`
(credentials-request.ts:13-17), `DEFAULT_TTL_SECONDS = 15 * 60` (:4), `verifyCredentialNonce`
throws `"Invalid credential nonce"` / `"Malformed credential nonce claims"` /
`"Credential nonce expired"` (:38-52). Encryption reuses the store's AES helpers
(CryptoJS.AES with `process.env.NEXTAUTH_SECRET`, credential-store.ts:9-12 — same at-rest
pattern as the ExuluVariables table).

### 5. Runtime flow, step by step (from the e2e test)

`src/exulu/auth/e2e.test.ts` (commit 798c205) drives a **real ExuluTool** via `.tool.execute()`
(the AI SDK-wrapped fn), mocking only `credentialStore` and `postgresClient`. Combined with
`src/exulu/auth/wrap-execute.ts:40-77` (`wrapUserCredentials`), the exact runtime behavior:

1. **Construction** (e2e.test.ts:60-88): `new ExuluTool({ ..., authentication: { authType:
   "user_credentials", provider, fields } })` → `validateAuthConfig` (tool.ts:111) →
   `authRegistry.register` (tool.ts:112) → execute wrapped by `wrapExecuteWithAuth` (tool.ts:126).
   `authRegistry.getByTool("e2e_creds_tool")` returns the config.
2. **Agent calls the tool.** `convertExuluToolsToAiSdkTools` injects `user` into inputs
   (`src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:283`); the wrapper reads
   `inputs.user.id` (wrap-execute.ts:46). No user → plain result string: `The "<toolId>" tool
   requires user-supplied credentials, which needs a signed-in user. ...` (wrap-execute.ts:48-51).
3. **First call, no stored credentials** (e2e.test.ts:117-130): `getValidUserCredentials`
   (`src/exulu/auth/state.ts:4-16`) returns null → tool returns
   `{ credentialRequest: { provider, fields, submitUrl, nonce }, result: null }`. The inner
   execute NEVER runs. Asserted: `result.credentialRequest.provider === PROVIDER`,
   `fields === [{ name: "apiKey", label: "API Key", type: "password" }]`, `result.result === null`.
4. **User submits the form** → `POST /credentials/submit` with `{ nonce, values: { apiKey: "..." } }`
   → session check, nonce decrypt, userId cross-check, field-set equality, optional validate hook →
   AES-encrypted upsert into `user_credentials` → `{ ok: true }`.
5. **Second call** (e2e.test.ts:132-146): store now has `data: { apiKey: "good" }` →
   `getValidUserCredentials` decrypts + shapes to `Record<string, string>` → wrapper calls
   `execute({ ...inputs, credentials: values })` (wrap-execute.ts:66) → test asserts the tool
   received the injected value: result `{ echoed: "good" }`.
6. **Invalidation** (wrap-execute.ts:67-74; asserted in wrap-execute.test.ts, commits f066b6a +
   5f44226): inner execute throws `CredentialInvalidError` with matching provider →
   `credentialStore.delete(provider, userId)` → fresh `buildCredentialRequest` returned → user is
   re-prompted. Mismatched-provider or other errors are re-thrown untouched.

### 6. Storage

`credentialStore` (`src/exulu/auth/credential-store.ts:59`, API `{ get, upsert, delete }`,
:24-57): single `user_credentials` table, values AES-encrypted as one JSON blob per row.

Table DDL (`src/postgres/core-schema.ts:705-717`):

```sql
CREATE TABLE IF NOT EXISTS user_credentials (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL,
    user_id text NOT NULL,
    auth_type text NOT NULL CHECK (auth_type IN ('oauth', 'user_credentials')),
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, user_id)
);
```

Note: the `auth_type` CHECK admits `'oauth'` too — the table is designed as the union-wide
credential store (oauth token rows can migrate into the same blob format later).

---

## UI reconstruction cues

**There is no dedicated frontend UI for the credential prompt yet.** Frontend search
(`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`) finds zero hits for
`credentialRequest`, `credentials/submit`, or `authorizationUrl`. Chat renders unknown tool
results through the generic tool-part path in
`frontend/components/message-renderer.tsx:1042-1110` (`UntypedToolPartComponent` +
`computeUntypedToolData` from `frontend/components/message-renderer-tool-data.ts`) — a collapsible
tool-call card showing the tool's input/output JSON.

So what the user actually sees today when a tool requests credentials:

- The tool call completes "successfully" with output
  `{ "credentialRequest": { "provider": "acme", "fields": [{ "name": "apiKey", "label": "API Key",
  "type": "password" }], "submitUrl": "https://<BACKEND>/credentials/submit",
  "nonce": "<AES blob>" }, "result": null }` inside the generic tool card.
- The **agent** sees that same payload as the tool result and relays it in prose — telling the
  user the tool needs credentials. (Contrast with OAuth, where the wrapper bakes the instruction
  into `result` text: `"Authorization required. Show the user this link and ask them to run the
  tool again after connecting: <url>"` — wrap-execute.ts:104.) For `user_credentials` the `result`
  is `null` and the structured `credentialRequest` field is the frontend's render contract: the
  payload is purpose-built for a form (ordered fields with `label`, `type: "text" | "password"`,
  optional `placeholder`/`help`; `submitUrl` + `nonce` = the POST target and its one-time,
  15-minute auth token).
- Exact user-facing strings that exist in code: field labels come verbatim from the tool's config
  (e.g. `"API Key"`); wrapper fallback messages: `The "<toolId>" tool requires user-supplied
  credentials, which needs a signed-in user. No user identity is available for this run.`
  (wrap-execute.ts:49) and `The "<toolId>" tool requires the BACKEND env var to build the
  credential submit URL.` (wrap-execute.ts:55).

For the release page: mock the intended experience as a small in-chat form card — title from
`provider`, one input per `fields` entry (`password` type masked), submit → `POST submitUrl` with
`{ nonce, values }` → `{ ok: true }` → user re-runs / agent retries the tool.

---

## Demo-worthy moments

**Demo 1 — the in-chat credential loop (hero demo):**
1. User: "Look up the Miller account in Acme CRM." Agent calls `acme_crm`.
2. Tool short-circuits — chat shows a credential card: **API Key** (masked input), from
   `credentialRequest.fields`.
3. User pastes the key → `POST /credentials/submit` → `{ ok: true }` (stored AES-encrypted,
   per-user).
4. Agent retries the tool — this time `inputs.credentials.apiKey` is injected and real results
   stream back. Every future run skips straight to step 4.

**Demo 2 — pure code, zero plumbing (developer snippet):**
1. Show the `authentication: { authType: "user_credentials", provider: "acme", fields: [...] }`
   block being added to a plain `ExuluTool` — diff-style, ~8 lines.
2. Beat: `execute` just reads `inputs.credentials.apiKey`. No prompt code, no storage code, no
   routes — Exulu wrapped it (`tool.ts:126`).
3. Punch: same property, other union arm — flip `authType: "oauth"` and the identical mechanism
   does 3-legged OAuth. One field, whole auth spectrum.

**Demo 3 — self-healing on revoked keys:**
1. A stored API key gets revoked upstream. Tool run → provider 401 → `throw new
   CredentialInvalidError("acme")`.
2. Exulu deletes the stale row and returns a fresh credential form in the same turn
   (wrap-execute.ts:68-72) — no dead tool, no admin ticket.
3. User pastes the new key; the run continues. (Wrong-provider errors pass through untouched —
   commit 5f44226.)

---

## Flags / requirements

- **Not merged:** everything lives on `feat/auth-user-credentials`; `develop` still has
  `src/exulu/oauth/` and OAuth-only tools. Merge required before release.
- **Env vars (both hard requirements, both pre-existing):**
  - `BACKEND` — public base URL; used to build `submitUrl` (`${BACKEND}/credentials/submit`,
    wrap-execute.ts:53, credentials-request.ts:33). Tool construction fails without it
    (validate.ts:106-110); at runtime the tool returns an explanatory message instead.
  - `NEXTAUTH_SECRET` — AES key for both the at-rest credential encryption and the request nonce
    (credential-store.ts:9-12). Same pattern as the ExuluVariables table.
- **Breaking API rename:** `ExuluTool({ oauth })` → `ExuluTool({ authentication })`, and existing
  OAuth configs must now carry the explicit `authType: "oauth"` tag. `wrapExecuteWithOauth` →
  `wrapExecuteWithAuth`; `ExuluOauthConfig` is still exported but as a union member.
- **DB migration** (`src/postgres/init-exulu-db.ts:128-132`, runs at init):
  `DROP TABLE IF EXISTS oauth_tokens CASCADE;` then create `user_credentials`. **Destructive, no
  backfill** — commit comment: "No backfill is required — the feature had no production users."
  Any dev-install OAuth connections require re-consent.
- **Nonce TTL:** credential requests expire after 15 minutes (`DEFAULT_TTL_SECONDS = 15 * 60`,
  credentials-request.ts:4) — a stale form submit returns 401 `nonce expired`; the tool must be
  re-run to get a fresh nonce.
- **Security hardening (commits 1a99e37, 76d164e):** `/credentials/submit` requires an
  authenticated session and rejects on session-vs-nonce userId mismatch (403); persistence keys on
  the session userId, never the nonce's.
- **Frontend gap:** no credential-form component exists yet — the flow currently surfaces through
  the generic tool card + agent prose. The `credentialRequest` payload is the ready-made contract
  for that form.
- Minor internal inconsistency (not user-visible): the SQL column is `user_id text` while
  `credentialStore` types `userId: number` (credential-store.ts:18) — knex coerces on write/read.
