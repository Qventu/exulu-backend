# Tool credentials: chat UI, model scrubbing, and store fixes

**Date:** 2026-07-22
**Status:** Approved (design review with Daniel, 2026-07-22)
**Repos:** `exulu/backend` (branch off `develop`), `exulu/frontend` (branch off `main`)

## Context

The `user_credentials` half of the tool-authentication union (`ExuluAuthConfig`) shipped backend-only: `wrap-execute.ts` short-circuits a tool call with `{ credentialRequest: { provider, fields, submitUrl, nonce }, result: null }` when no credentials are stored, and `POST /credentials/submit` validates and stores them. UAT with the ai.open moco tools (2026-07-22) exposed three gaps:

1. **No frontend renderer exists.** The payload falls through the generic tool chip, so the model narrates "give me your API key" and the user pastes a secret into chat — the exact leak the feature exists to prevent.
2. **The raw payload reaches the model.** The full `credentialRequest` JSON (including `submitUrl` and the nonce) is sent to the LLM as the tool result, and replays from history on every later turn.
3. **The store is broken against real Postgres** (confirmed live on the `imp` DB): `credentialStore.upsert` inserts a bare CryptoJS-AES base64 string into the `data jsonb NOT NULL` column, which Postgres rejects (`invalid input syntax for type json`). The read path is symmetrically broken. Every existing test mocks the DB; no credential has ever been stored end to end.

The OAuth arm has the same missing-frontend problem (`oauth.authorizationUrl` is never rendered as a button), and there is no UI anywhere to list or revoke stored credentials.

## Goals

- A credential form renders inline in chat when a tool requests credentials; secrets travel browser → backend only.
- The model never sees `submitUrl`/nonce and is instructed never to ask for secret values in chat.
- After a successful submit, the interrupted request auto-resumes.
- OAuth short-circuits render as a connect button.
- Users can list and revoke stored credentials in Settings.
- The store actually works against real Postgres.

## Non-goals

- No changes to the client-developer contract: `ExuluTool`'s `authentication` config, `CredentialField` (`text` | `password` only), the `validate` hook, and `CredentialInvalidError` semantics all stay as-is. `{ credentialRequest, result: null }` becomes a **stable contract** with this spec.
- No OAuth callback auto-detection (v1 uses an explicit "I've connected — retry" button).
- No credential UI for public/guest surfaces (deliberate; see §6).
- MCP and OpenAI-gateway consumers keep receiving the raw payload — accepted: those are developer surfaces and the nonce is useless without the owning user's session JWT.
- No scrubbing of *pasted* secrets from history (the guardrail directs users to the form; retroactive redaction is out of scope).

## 1. Backend

### 1.1 Store fix (`src/exulu/auth/credential-store.ts`, `src/postgres/`)

- `user_credentials.data` column: `jsonb` → `text`. Ciphertext is opaque; jsonb was never right. Migration in `src/postgres/init-db.ts`, gated on an `information_schema.columns` type check (repo convention). The table is empty in every environment (the bug made writes impossible), so the migration is trivially safe. `core-schema.ts` DDL updated to match.
- `upsert` becomes one atomic `INSERT … ON CONFLICT (provider, user_id) DO UPDATE SET data, auth_type, updated_at` (removes the check-then-insert race).
- The store normalizes `userId` with `String()` at its boundary to match the `text` column (today it passes numbers and relies on driver coercion).

### 1.2 Model scrubbing (`convertExuluToolsToAiSdkTools`, `provider.ts`)

Three pieces; all are required for the scrub to hold:

1. **`toModelOutput`** on every tool that has an `authentication` config. Normal results pass through unchanged. A `credentialRequest` output becomes plain text: *"A secure credential form for «provider» (fields: «labels») is shown to the user in the chat. Never ask for these values in chat. After the user confirms saving, call the tool again."* An `oauth` short-circuit output becomes the analogous text ("a connect button is shown…") without the URL.
2. **History replay:** both `convertToModelMessages` call sites (`provider.ts:652`, `provider.ts:1196`) must pass the `tools` option — in the installed `ai@6.0.49`, `toModelOutput` only applies to history conversion when `tools` is provided. Without this, raw payloads replay to the model on every turn after the first.
3. **Conditional guardrail:** when any active tool has `authType: "user_credentials"`, append a system-prompt block (its own `system +=` block — agent `instructions` replace the default preamble, so the guardrail must not live inside it): credentials are collected only via secure forms; never ask for secret values in chat; if the user pastes one anyway, direct them to the form and do not repeat or store it.

### 1.3 Management endpoints (`src/exulu/routes.ts`, new handlers in `src/exulu/auth/`)

- `GET /credentials` → `[{ provider, authType, createdAt, updatedAt }]` for the session user. Values are never returned.
- `DELETE /credentials/:provider` → idempotent delete for (provider, session user), `200 {ok:true}`.
- Both authenticate via `requestValidators.authenticate` (header-based, same as submit).

### 1.4 Small fixes

- `submit-handler.ts:94`: the defensive session guard's error string `"nonce invalid"` → `"session invalid"`.
- Nonce stays multi-use within its 15-minute TTL: it binds (provider, userId, expiry), and submit requires the same user's session — accepted risk, documented here.

## 2. Frontend: credential form in chat

### 2.1 `CredentialRequestCard`

New component in `app/(application)/chat/components/` (sibling of `tool-call-approval.tsx`). Inline card: title "Connect «provider»", one input per `CredentialField` (label, placeholder, help; `type: "password"` → masked input), `react-hook-form` (the `run-routine-dialog.tsx` pattern), shadcn primitives, `next-intl` strings under `chat.credentials.*` (`en.json` + `de.json`).

### 2.2 Integration

A branch in `makeUntypedToolPart` (`components/message-column.tsx`), ahead of the generic `Tool` fallback — the `ToolCallApproval` slot. Trigger: tool part in `output-available` state whose output contains `credentialRequest` (or `oauth.authorizationUrl`, §2.5). Notes from code research:

- The backend wrapper yields the same output twice (`preliminary: true`, then final); the card keys on the final state.
- `getCachedToolData` caches terminal states permanently, so post-submit collapse is component-local state (the `QuestionAsk` `submitted` pattern).
- `ToolCallChip`'s expanded output view (tools nested in reasoning steps) explicitly redacts outputs carrying `credentialRequest`. Today it prints nothing only because `result` is `null` — make it a contract, not luck.

### 2.3 Submit path and the origin rule

Submit POSTs `{ nonce, values }` with the `Authorization: Bearer` session JWT per the `lib/api/client.ts` `request()` convention (backend CORS is `origin: "*"`; cookies never reach it; `authenticate()` ignores cookies). **Security rule:** `submitUrl` arrives via a tool result, which is model/tool-influenced data. The card verifies `submitUrl`'s origin equals the configured backend origin (`config.backend`) before POSTing, and renders an error state otherwise — never send the JWT or secrets to an unverified origin.

### 2.4 States and auto-resume

idle → submitting (inputs disabled) → error → success.

- Error states map backend responses: `validation failed: …` and `field set mismatch` show inline with values preserved; `401 nonce expired` shows "form expired — ask the agent to try again".
- Success: card collapses to "✓ Connected to «provider»" and sends one **visible** follow-up user message via the chat transport — *"«provider» credentials saved — please retry."* The model re-invokes the tool, the wrapper finds stored credentials, the run continues. This is the `question_ask` resume pattern; no new streaming machinery, and the transcript stays honest.
- Approval interplay needs no special casing: `user_credentials` tools default to `needsApproval: true`, so the approval card renders first, then (after approval) the credential card — two cards in natural sequence.

### 2.5 OAuth connect button

Same branch, same card family: `output.oauth.authorizationUrl` renders "Connect «provider»" (opens in a new tab) plus "I've connected — retry" sending the same style of follow-up message.

## 3. Settings: Connections

A "Connections" card on `app/(application)/settings`: rows from `GET /credentials` ("moco · connected Jul 22, 2026"), each with Revoke (confirm → `DELETE /credentials/:provider`). Next tool use after revoke re-prompts the form in chat. Empty state: "No connected tools yet — tools will ask for credentials in chat when they need them." i18n under `settings.connections.*`. Nothing to reveal, only revoke.

## 4. Public and guest surfaces

The form renders **only** in the internal chat surface. Public agent pages reuse `MessageColumn`, so the new branch takes a surface flag (extending the existing `guestMode` concept): on public surfaces, credential/oauth outputs render a neutral notice — "This tool needs credentials. Sign in to the main Exulu app to connect it." Rationale: regular-mode guests would otherwise receive a usable nonce, and the public page deliberately keeps the backend JWT server-side, so a submit couldn't authenticate anyway. Anonymous guests keep today's text-only behavior (backlog: structured `signInRequired` payload for a deliberate rendered state).

## 5. Security summary

Secrets flow browser → backend only (Bearer-authenticated, origin-validated `submitUrl`), encrypted at rest with the established CryptoJS/`NEXTAUTH_SECRET` pattern, never logged, never rendered back, never in chat history, hidden from the model (§1.2). `validate`-hook error messages surface verbatim in the form — documented as user-visible text for tool authors.

## 6. Testing

- **Backend:** real-Postgres integration test for the store roundtrip (upsert → get → delete) — the exact gap that let the jsonb bug through; submit-handler tests for the corrected error string; endpoint tests for `GET`/`DELETE /credentials`; unit tests asserting `toModelOutput` scrubs the model view while the UI stream part keeps the payload, **including** the history path through both `convertToModelMessages` call sites; guardrail presence/absence test keyed on tool configs.
- **Frontend:** `CredentialRequestCard` component tests (states, masked fields, origin validation, resume message) and the `makeUntypedToolPart` branch, per the `message-renderer-tool-data.test.ts` precedent.
- **UAT gate:** the moco flow end to end — form appears, submit stores, run resumes and answers, Connections lists the row, revoke re-prompts.

## Backlog (explicitly not v1)

- OAuth callback completion detection (auto-resume without the "I've connected" click).
- Structured `signInRequired` payload for anonymous guests.
- `CredentialField` extensions (`required`, more field kinds) — needs a coordinated change with `validate.ts`'s type guard.
- Mintlify docs rewrite for the `oauth` → `authentication` rename (superseded by the IMP docs-site migration; the changelog page is currently the only accurate reference).
- Tool-input repair / identical-invalid-call loop guard (from the Gemini `from1Date` incident — separate concern, same UAT).

## Key implementation pointers

| Concern | File |
| --- | --- |
| Short-circuit shape | `src/exulu/auth/short-circuit.ts`, `wrap-execute.ts:58-72` |
| Nonce build/verify | `src/exulu/auth/credentials-request.ts` |
| Submit handler | `src/exulu/auth/submit-handler.ts` |
| Store (bug §1.1) | `src/exulu/auth/credential-store.ts:37-52` |
| Tool → AI SDK conversion (§1.2) | `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:164` |
| History replay call sites | `src/exulu/provider.ts:652`, `provider.ts:1196` |
| Frontend integration slot | `frontend/components/message-column.tsx` (`makeUntypedToolPart`) |
| Interactive-card precedents | `frontend/app/(application)/chat/components/tool-call-approval.tsx`, `QuestionAsk` in `components/message-renderer.tsx` |
| REST convention | `frontend/lib/api/client.ts` |
