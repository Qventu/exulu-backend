# Generic Routine Inbound Webhook — Design

**Date:** 2026-07-27
**Status:** Approved design, pre-implementation
**Repos:** backend (`exulu/backend`) + frontend (`exulu/frontend`)
**Supersedes the entry layer of:** `2026-07-15-email-triggered-routines-design.md` (Mailgun-specific intake). The downstream pipeline from that design is kept as-is.

## 1. Summary

The email-triggered-routines feature (spec 2026-07-15, merged to `develop`, **not yet released**) shipped a Mailgun-specific inbound path: a single global endpoint `POST /webhooks/email/mime`, authenticated by a Mailgun HMAC over `timestamp + token`, routing to a routine by matching a `recipient` address against a server-generated `{slug}-{hex}@{inbound_domain}` mailbox, all gated by a super-admin `email_inbound` platform config (provider, inbound domain, AES-encrypted signing key).

We do not want to force clients onto Mailgun. Clients should arrange inbound-email forwarding however they prefer (Mailgun, Amazon SES, Postmark, a `.forward`/sendmail rule, or a low-code tool like Zapier/n8n/Power Automate) and simply POST to a webhook we provide. This design **replaces the entry + routing + platform-config layer** while **keeping the entire downstream pipeline unchanged**: MIME normalization into `InboundEmail`, the guard chain (auto-reply, allowlist, rate limits, dedup, filters), session-backed run creation, attachment handling, and the approval pause/resume execution engine. That downstream code is already provider-agnostic and is the valuable part.

**New model:** every routine trigger owns a **secret capability URL** — `POST /webhooks/routine/{secret}`. The URL both routes (secret → trigger) and authenticates (holding it = authorized), the standard incoming-webhook pattern (Slack/Stripe/GitHub). The endpoint is **content-type-adaptive**: it accepts raw RFC822 MIME, Mailgun-style multipart with a raw-MIME part, and a documented JSON shape — all normalized into the existing `InboundEmail`. Clients that can sign requests may additionally enable an **optional per-trigger HMAC** for body integrity.

A small **test panel** in the routine's Triggers section lets an admin POST a custom payload through the real pipeline and see the resulting run (real send).

### Explicitly in scope
- New public endpoint `POST /webhooks/routine/{secret}` with three content-type adapters into `InboundEmail`.
- Per-trigger `secret` (capability URL) replacing the generated email address + platform inbound domain; a **Regenerate** action.
- Optional per-trigger HMAC signing (`signing_secret`, AES-encrypted at rest) verifying `X-Exulu-Signature` over the raw body, with an optional timestamp-based replay guard.
- Per-trigger `last_fired_at` setup-debugging aid (replaces platform-level `last_webhook_at`).
- Test panel: `testFireWorkflowTrigger` mutation that runs the real webhook→intake path in-process and returns the created run.
- Removal of the Mailgun-specific pieces: `email_inbound` platform config + its resolvers, the `/configuration/email` admin surface, the Mailgun signature verifier (generalized), and Mailgun setup docs/i18n.

### Explicitly out of scope (v1)
- Everything the 2026-07-15 spec already delivered downstream of `InboundEmail` (guard chain, session-backed runs, approvals, runs views) — unchanged.
- Provider-specific JSON auto-mapping (a configurable `payload.mail.from`-style field mapping). The documented fixed JSON shape covers scripting tools; see §9.
- Amazon SES + client-owned-S3 adapter (still slots into `InboundEmail` unchanged) — §9.
- Outbound replies (existing `send_email` tool remains the way agents send mail).

## 2. Current state (verified in code)

- Webhook: `POST /webhooks/email/mime` registered in `src/exulu/routes.ts:755-759`, wired to `createEmailWebhookHandler` (`src/exulu/email-inbound/webhook.ts`) with a `latin1` byte-faithful multipart parser (`createEmailMultipartParser`, `routes.ts:203-277`).
- Auth: `verifyMailgunSignature` (`src/exulu/email-inbound/verify-mailgun.ts:13-29`) — HMAC-SHA256 over `timestamp + token` with the Mailgun signing key; `isReplay` (`verify-mailgun.ts:38-63`) — ±300 s window + Redis `SETNX` token cache (TTL 900 s), degrading to window-only without Redis.
- Durability ordering (`webhook.ts:99-119`): verify → persist raw MIME to S3 (`email-inbound/{uuid}.eml`) → enqueue `email_intake` BullMQ job carrying the S3 key → ACK 200. Pre-ACK failure → 5xx.
- Platform config (`src/exulu/email-inbound/config.ts`): `platform_configurations` key `email_inbound` = `{ provider, inbound_domain, enabled, last_webhook_at, signing_key (AES-encrypted) }`. AES crypto is `encrypt`/`decrypt` from `@SRC/exulu/auth/credential-store` (`config.ts:5`). 30 s cache in `routes.ts:694-705`.
- Normalization seam: `parseRawMime()` (`src/exulu/email-inbound/normalize.ts`, `mailparser`) → `InboundEmail` (`src/exulu/email-inbound/types.ts:6-20`). Everything downstream consumes `InboundEmail` only.
- Intake job (`src/exulu/email-inbound/intake.ts`): `resolveTriggerByAddress(db, recipient)` (`intake.ts:55-62`, `LOWER(address) = ?`) → guard chain (`guards.ts`; order auto-reply → allowlist → trigger rate limit → sender rate limit → DB dedup → filters) → session-backed run.
- Trigger table `workflow_triggers` (`ee/schemas.ts:432+`): `RBAC:false`, `graphql:false`; columns `workflow, type, enabled, address (unique, indexed), config (json), run_as_user, run_as_role`, core fields. Access checked via the parent routine in custom resolvers.
- GraphQL (`src/graphql/schemas/index.ts`): `workflowTriggers(workflow)` (`:809`, `:1195`), `upsertWorkflowEmailTrigger(workflow, enabled, config)` (`:709`, `:1213`), `deleteWorkflowTrigger(id)` (`:710`, `:1285`), `emailInboundConfig` (`:810`, `:1305`), `updateEmailInboundConfig` (`:711`, `:1314`). `WorkflowTrigger` returns `address`.
- Frontend: per-routine `TriggersSection` (`app/(application)/workflows/[id]/sections/triggers.tsx`) shows the generated address + copy, and an "email intake not configured → open email settings" empty state that depends on `emailInboundConfig`. Super-admin surface `EmailIntakeView` (`app/(application)/configuration/components/email-intake-view.tsx`, route `/configuration/email`) with provider (hardcoded `mailgun-eu`), inbound domain, write-only signing key, webhook URL, last-webhook timestamp, 6-step Mailgun checklist. i18n under `configuration.emailIntake` + `routines.triggers` in `messages/{en,de}.json`. No schema flag gates the trigger UI (ships with the routines section).
- Tests: `webhook.test.ts`, `normalize.test.ts`, `guards.test.ts`, `intake.test.ts`, `config.test.ts`, `trigger-config.test.ts`, `resolver-helpers.test.ts` with `buildMultipart()` / `makeDeps()` fixtures.

## 3. Data model

Because the trigger feature is **unshipped and undeployed**, `workflow_triggers` is edited in place — no backfill or compatibility shim.

### 3.1 `workflow_triggers` changes

| Change | Column | Notes |
|---|---|---|
| **drop** | `address` (text, unique) | No longer routing by mailbox. |
| **add** | `secret` (text, **UNIQUE, indexed**) | 32-byte `base64url` random (~192 bits), generated server-side on create. The routing + auth key; lookup `WHERE secret = ?`. |
| **add** | `signing_secret` (text, nullable) | Optional shared HMAC secret, **AES-encrypted at rest** (reuse `encrypt`/`decrypt` from `@SRC/exulu/auth/credential-store`). Never returned by the API; API exposes `has_signing_secret: boolean`. |
| **add** | `last_fired_at` (timestamp, nullable) | Stamped on every verified webhook hit; per-trigger setup-debugging aid replacing platform `last_webhook_at`. |
| keep | `workflow, type ('email'), enabled, config (json), run_as_user, run_as_role`, core fields | `config` shape unchanged (`allowed_senders, filters, filtered_run_retention, rate_limit_per_hour, sender_rate_limit_per_hour`). |

Migration lives in `src/postgres/init-exulu-db.ts`, gated by column-existence checks (project convention: one-time migrations in init-db, never a standalone script). The unique index on `secret` is required for constant-time routing.

**Naming:** `type` stays `'email'` and the GraphQL mutation stays `upsertWorkflowEmailTrigger` — the payloads are still email-shaped (`InboundEmail`) and renaming ripples into the frontend for no functional gain. Docs state plainly that "email trigger" == "generic inbound webhook."

### 3.2 Platform config removal

Delete the `email_inbound` platform config entirely:

- Backend: `src/exulu/email-inbound/config.ts`, the 30 s cache block in `routes.ts:690-705`, and the `emailInboundConfig` / `updateEmailInboundConfig` resolvers.
- The global kill switch is replaced by the existing per-trigger `enabled` flag plus the `queues` license check (email triggers already require the queues entitlement).
- The `platform_configurations` row (`email_inbound` key) is orphaned harmlessly; a one-line delete in the init-db migration removes it for tidiness (idempotent, `WHERE config_key = 'email_inbound'`).

## 4. Webhook contract & endpoint

### 4.1 Endpoint

`POST /webhooks/routine/{secret}` — public, registered in `src/exulu/routes.ts`. The old `/webhooks/email/mime` route is removed.

Order of operations in the rewritten `createRoutineWebhookHandler` (keeps the current durability ordering):

1. **Rate-limit backstop**: the existing cheap in-process fixed-window limiter (`emailWebhookRateLimitExceeded`, 300/min) stays as a DoS guard → `429`.
2. **License**: `queues` entitlement required → `503` if absent.
3. **Resolve trigger** by `secret` (`resolveTriggerBySecret(db, secret)` → `WHERE secret = ?`). Unknown, disabled, or missing → **`404`** (do not distinguish reasons — avoid an enumeration/authorization oracle) + log, no row. The ~192-bit secret makes brute-forcing infeasible, so constant-time comparison of the secret itself is unnecessary; the DB equality match is sufficient.
4. **Optional HMAC** (if `trigger.signing_secret` set): verify `X-Exulu-Signature` over the raw request body (§4.4). Missing/mismatch → `401`. If unset, the URL secret alone authorizes.
5. **Adapt payload** by `Content-Type` → raw MIME bytes or a normalized JSON object (§4.2).
6. **Persist before ACK**: stream the raw payload to S3 (`inbound-webhook/{uuid}.{eml|json}`), stamp `last_fired_at` (best-effort), enqueue the intake job carrying `{ s3Key, triggerId, format }`, then ACK `200`. Any pre-ACK failure → `5xx` (forwarders that retry get their retry; DB `message_id` dedup makes retries safe).

### 4.2 Content-type adapters

All three produce the existing `InboundEmail` (via `normalize.ts`), so the guard chain and run-firing code are untouched.

| `Content-Type` | Adapter | Source |
|---|---|---|
| `message/rfc822`, `text/plain`, or raw body | existing `parseRawMime(buffer)` | RFC822 bytes forwarded directly — SES, Postmark, sendmail, `.forward`. |
| `multipart/form-data` with a raw-MIME part named `body-mime`, `email`, or `message` | pull that part → `parseRawMime(buffer)` | Mailgun-style raw forwarders keep working (no signature required). |
| `application/json` | **new** `jsonToInboundEmail(obj)` | Scripting / low-code tools (Zapier, n8n, Power Automate, curl). |

**Documented JSON shape** (only `from` required):

```jsonc
{
  "from": "service@kone.com",              // or { "address": "…", "name": "…" }
  "subject": "Ersatzteil-Anfrage",         // default ''
  "text": "…plain body…",                  // default ''
  "html": "<p>…</p>",                       // optional; if text absent, derived from html
  "message_id": "<abc@kone.com>",           // optional; generated (uuid@webhook.local) if absent — the dedup key
  "attachments": [                           // optional
    { "filename": "part.pdf", "content_type": "application/pdf", "content_base64": "…" }
  ]
}
```

`jsonToInboundEmail` maps this onto `InboundEmail`:
- `from` accepts a bare address string or `{ address, name }`; missing/invalid → validation error → `400`.
- `recipient` (routing field in the old model) is no longer meaningful; set to `trigger:{id}` for the untrusted-data framing block only.
- `text` derived from `html` (via a minimal html→text) when `text` absent, mirroring `parseRawMime`'s behavior.
- `attachments[].content_base64` decoded to a `Buffer`; malformed base64 → `400`.
- `headers` seeded with any recognized fields (e.g. `message-id`) so downstream header checks are consistent.

Size caps mirror today's parser (raw ≤ 30 MB; JSON body ≤ a comparable cap). The `latin1` byte-fidelity handling for raw MIME is preserved for adapters 1 & 2.

### 4.3 Intake job

`intake.ts` changes only at the entry point:

- The job payload carries `triggerId` (+ `format`) instead of `recipient`. `resolveTriggerByAddress(db, recipient)` → **`resolveTriggerById(db, triggerId)`**.
- The intake loads the S3 payload and runs `parseRawMime` (`eml`) or `jsonToInboundEmail` (`json`).
- The guard chain, dedup (by `message_id`), attachment upload, session creation, variable pre-population (`email_from`, `email_subject`, `email_body`), and run firing are **unchanged**. `filtered`/`fired`/`failed` semantics, per-trigger retention pruning, and the `trigger:'email'` stamping are all retained.

### 4.4 Optional HMAC signing

Generalize `verify-mailgun.ts` → `verify-signature.ts` (keep the `isReplay` helper, de-Mailgun the naming/comments):

- **Scheme**: header `X-Exulu-Signature: sha256=<hex>` where `<hex>` = `HMAC-SHA256(rawBodyBytes, signing_secret)`, compared with `timingSafeEqual`. Missing header or mismatch → `401`.
- **Replay (optional)**: if the caller also sends `X-Exulu-Timestamp` (unix seconds), the signed message becomes `timestamp + "." + rawBody`, and the handler enforces the ±300 s window + Redis `SETNX` replay cache (reusing `isReplay`, keyed `routine_webhook:replay:{sig}`). If `X-Exulu-Timestamp` is absent, signature is over the raw body only and replay defense falls back to `message_id` dedup. This keeps simple tools working while letting security-conscious clients opt into full Stripe-style protection.
- The shared secret is generated by us (§5), shown once, stored AES-encrypted. The signature-scheme snippet is surfaced in the UI (§6) so clients can reproduce it.

## 5. GraphQL API

- `workflowTriggers(workflow)` — unchanged access (routine read). Returned `WorkflowTrigger` type: `address` → **`webhook_url`** (`{BACKEND}/webhooks/routine/{secret}`), returned **only to callers with routine write access**; read-only callers receive `webhook_url: null` + `has_webhook: true` so the secret never leaks to viewers. Adds `has_signing_secret: Boolean` and `last_fired_at`.
- `upsertWorkflowEmailTrigger(workflow, enabled, config)` — unchanged signature for the config editor; generates `secret` server-side on first create (unique, retry on collision). The signing-secret lifecycle is handled by its own mutation (below), not by `config`.
- **New** `regenerateWorkflowTriggerSecret(id): WorkflowTrigger` — mints a new `secret`, invalidates the old URL, returns the new `webhook_url`. Requires routine write + `workflows:write`.
- **New** `setWorkflowTriggerSigningSecret(id, enable: Boolean): WorkflowTrigger` — when `enable` true, generates a signing secret, stores it AES-encrypted, and returns the plaintext **once** (`signing_secret_once` field, null on every subsequent read) plus `has_signing_secret: true`; when false, clears it. Requires routine write + `workflows:write`.
- **New** `testFireWorkflowTrigger(id, contentType: String!, payload: String!): TestFireResult` — runs the **real** webhook→intake path in-process (bypassing the URL-secret lookup and HMAC, since the caller is already GraphQL-authenticated with routine write access), through the full guard chain and run firing. Returns `{ outcome: 'fired'|'filtered'|'error', jobResultId, filteredReason, error }` so the UI can deep-link to the created run or show why it was filtered/rejected. Real send — subject to rate limits and dedup like any inbound message.
- **Remove** `emailInboundConfig` and `updateEmailInboundConfig`.

Resolver access control is unchanged in principle: trigger reads/writes check the parent routine (`workflow_templates` RBAC incl. teams) + `workflows:write` for mutations; `job_results` remain access-filtered by routine.

## 6. Frontend

### 6.1 Triggers section (`app/(application)/workflows/[id]/sections/triggers.tsx`)

- Replace the "generated address + copy" display with a **Webhook URL** copy field + a **Regenerate** button (confirm dialog: "The old URL will stop working immediately"). Shows `webhook_url` for writers; a muted "URL hidden — you have read-only access" for viewers.
- Remove the `emailInboundConfig` dependency and the "email intake not configured → open email settings" empty state entirely. The section is always available (gated only by routine write access + queues entitlement, surfaced inline).
- Keep the allowlist / filter-rules / retention / rate-limit editors unchanged.
- **New "Require signed payloads" subsection**: a *Generate signing secret* button (`setWorkflowTriggerSigningSecret(enable:true)`) that reveals the secret **once** in a copy field with a "store it now, it won't be shown again" note; a "signing enabled" indicator (`has_signing_secret`); a *Remove* button (`enable:false`); and a copyable signature-scheme snippet (`X-Exulu-Signature: sha256=HMAC-SHA256(body, secret)`, plus the optional `X-Exulu-Timestamp` note).
- Show `last_fired_at` ("Last received: …") as the setup-verification aid.

### 6.2 Test panel (within the Triggers section)

- A content-type selector (**JSON** / **Raw MIME**), a payload `<textarea>` pre-filled with a valid sample for the chosen type (a minimal JSON `{from, subject, text}`; a small raw MIME sample), and a **Send test** button → `testFireWorkflowTrigger`.
- Inline result card: **Fired — run #123 · View run** (deep-link to the run session), **Filtered — sender_not_allowed** (with the reason), or a parse/validation **Error** with the message.
- A clear note: *"This starts a real run and counts against this trigger's rate limits."*

### 6.3 Removals

- Delete `app/(application)/configuration/components/email-intake-view.tsx`, `app/(application)/configuration/email/page.tsx`, and `lib/email-inbound/` (query + types).
- Remove the `configuration.emailIntake` i18n block from `messages/{en,de}.json`; remove the `/configuration/email` nav entry.
- Replace the Mailgun setup copy under `routines.triggers` with provider-neutral strings: a short "Forward inbound messages to this webhook URL (raw email or JSON)" explainer with raw-MIME and JSON examples, plus the signing-scheme help text. Both `en` and `de`.

### 6.4 Docs

- Update the two mintlify pages that reference Mailgun for inbound email (`self-hosting/architecture.mdx`, and the webhooks/self-hosting sections) to describe the generic `POST /webhooks/routine/{secret}` contract, the three accepted formats, and optional HMAC. Remove the "clients must use Mailgun EU" framing.

## 7. Security

- **Capability URL**: the `secret` (~192-bit, `base64url`) is the credential; regenerable; returned by the API only to routine-writers. `404` on unknown/disabled avoids an enumeration oracle.
- **Optional HMAC** adds body integrity for clients that can sign; optional timestamp enables replay defense. Without it, the URL secret + `message_id` dedup + rate limits + allowlist are the controls (matching mainstream incoming-webhook posture).
- **Guard chain unchanged** as defense-in-depth: auto-reply guard, sender allowlist (glob), per-trigger + per-sender rate limits, DB dedup, regex filters with the 200-char + `safe-regex` caps.
- **Prompt injection**: inbound content is untrusted input to a tool-wielding agent — the untrusted-data framing block and approval-gating of consequential tools remain the mitigation; recommend approval-gating externally-visible tools on webhook-triggered routines (unchanged from the 2026-07-15 spec).
- **Secrets at rest**: `signing_secret` AES-encrypted (reused `credential-store` crypto); never returned after generation. Raw payloads in S3 deleted after successful processing (retained on parse failure for debugging), as today.

## 8. Testing & rollout

**Testing**
- Unit: `jsonToInboundEmail` (bare vs object `from`, missing subject/body, html→text derivation, base64 attachments, malformed base64 → 400, message_id generation); content-type routing (raw vs multipart vs JSON, unknown type → 400); `resolveTriggerBySecret` (hit / miss / disabled → 404); HMAC verify (valid / invalid / missing header / with-timestamp replay window / Redis-down degradation); `regenerateWorkflowTriggerSecret` invalidates the old secret.
- Integration: `testFireWorkflowTrigger` fires a real run through the guard chain (stubbed provider) and returns the run id; a filtered payload returns `filtered` + reason; unchanged normalize/guards/intake tests stay green.
- **Delete** `verify-mailgun.test.ts` semantics tied to `timestamp+token`; rewrite as `verify-signature.test.ts`. Remove `config.test.ts` (platform config gone). De-Mailgun the webhook fixtures (`buildMultipart` keeps raw-MIME multipart coverage; add JSON fixtures).

**Rollout**
- Feature is unshipped and undeployed → clean in-place edit of the trigger table + resolvers; no data migration beyond the init-db column swap and the orphan-config delete.
- No new schema flag: the Triggers section is already merged (unreleased); we edit it directly. The queues entitlement continues to gate email/webhook triggering.
- Release notes: the inbound webhook is provider-neutral; clients bring their own forwarding.

## 9. Roadmap (deferred)

- **Provider-specific JSON auto-mapping**: admin-configured field mapping (`payload.mail.from` → `from`) for tools whose JSON doesn't match the documented shape. The fixed shape covers scripting tools for v1.
- **Amazon SES + client-owned S3 adapter**: mail lands in the client's bucket; a second adapter fetches + normalizes into `InboundEmail` without touching the pipeline.
- **Signed-delivery presets**: per-provider signature verification presets (e.g. verify a provider's own signature header) layered on the generic HMAC.

## 10. Decision log

| Decision | Choice |
|---|---|
| Provider coupling | Removed; client arranges forwarding, Exulu exposes a generic webhook |
| Payload formats | Raw MIME + Mailgun-style multipart + documented JSON, auto-detected by Content-Type |
| Routing + auth | Per-trigger secret capability URL `POST /webhooks/routine/{secret}` |
| Unknown/disabled secret | `404` (no enumeration oracle) |
| HMAC | Optional per-trigger `signing_secret` over raw body; optional timestamp for replay defense — in v1 scope |
| Secret rotation | Explicit **Regenerate** action (old URL invalidated immediately) |
| Platform config | Removed (`email_inbound` + `/configuration/email`); per-trigger `enabled` + queues license replace the kill switch |
| Setup-debug aid | Per-trigger `last_fired_at` replaces platform `last_webhook_at` |
| Test affordance | `testFireWorkflowTrigger` — **real send** through the full pipeline, deep-links to the run |
| Downstream pipeline | `InboundEmail`, guard chain, session-backed runs, approvals — unchanged |
| Naming | Keep `type:'email'` / `upsertWorkflowEmailTrigger` (email-shaped payloads); document "email trigger" == "inbound webhook" |
