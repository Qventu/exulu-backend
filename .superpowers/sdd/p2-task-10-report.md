# Task 10 Report — POST /webhooks/email/mime

**Status:** DONE

**Commit:** `0cc9c8b` — `feat(email-inbound): POST /webhooks/email/mime with persist-before-ACK`

**Files created/modified:**
- `src/exulu/email-inbound/webhook.ts` — handler + `EmailWebhookDeps` interface + module-level rate limiter
- `src/exulu/email-inbound/webhook.test.ts` — 8-test status-matrix suite (verbatim from brief)
- `src/exulu/routes.ts` — added 4 imports + wired `/webhooks/email/mime` after the recall webhook block

**Test summary:** 8/8 webhook tests pass; full suite 586/586 (70 suites) green.

**Self-review checklist:**
- ACK ordering: 200 only after `putRawEmail` resolves AND `enqueueIntake` resolves — 500 path tested
- Signature verified BEFORE any S3/queue work — 401 path confirms `putRawEmail` never called
- `bumpLastWebhookAt` is fire-and-forget (`void …catch`) — does not affect response path
- No secret/token values logged — only `[EXULU-EMAIL] webhook rejected (invalid signature)` and replay messages

**Concerns:** None — pre-existing type errors (openai-gateway.ts etc.) and lint test-file parser errors are unchanged from before.

**Report path:** /Users/daniel.claessen/Desktop/Projects/exulu/backend-email-routines/.superpowers/sdd/p2-task-10-report.md

---

## Review-fix note — `b7ee1d5` (amends `0cc9c8b`)

### Finding 1 (Critical): byte-faithful multipart field decode

**Root-cause confirmed:** multer@2 passes `defParamCharset` (field-name charset) to busboy but does NOT pass `defCharset` (field-value charset). busboy's multipart handler therefore always decodes field values as UTF-8 (line 240: `const defCharset = (cfg.defCharset || 'utf8')`). 8-bit bytes such as 0xE9 and 0xFC become U+FFFD before the handler sees the string.

**Path taken:** replaced multer on this route with a hand-rolled busboy middleware (busboy is already multer's dep; added explicit `"busboy": "^1.6.0"` to production dependencies so the direct import is declared). The middleware uses `defCharset: "latin1"`, `limits: { fieldSize: 30MB, files: 0 }`, and replicates the exact error-code mapping (LIMIT_FIELD_VALUE → 413, malformed → 400, unexpected file → 400).

**Handler change:** `Buffer.from(bodyMime, "utf8")` → `Buffer.from(bodyMime, "latin1")` with a comment explaining why latin1 is correct (byte fidelity, not character semantics). The status matrix and ordering (429→503→503→401 sig→401 replay→400→500→200) are unchanged.

**Files changed:**
- `src/exulu/routes.ts` — removed `emailMimeUpload = multer(…)`, added `emailMultipartParser` (busboy direct), 30s config cache (`getCachedEmailInboundConfig`), `getEmailConfig` dep passed to handler; added `import Busboy from "busboy"` and `import { getEmailInboundConfig }`.
- `src/exulu/email-inbound/webhook.ts` — added optional `getEmailConfig` to `EmailWebhookDeps`; handler falls back to `getEmailInboundConfig(db)` when not injected (tests stay pure); encoding changed to `latin1`.
- `src/exulu/email-inbound/webhook.test.ts` — added `describe("byte-fidelity…")` with 2 tests: one drives busboy directly with a hand-built multipart payload containing 0xE9 and 0xFC bytes and asserts hex round-trip; one exercises the handler end-to-end with a latin1-decoded string.
- `package.json` — added `"busboy": "^1.6.0"` to production dependencies.

### Finding 2 (Important): unauthenticated per-request DB read

**Fix:** module-level `_emailConfigCache` + `_emailConfigCacheAt` in `routes.ts` (the wiring layer). Cache TTL = 30 s (Date.now monotonic check). Comment documents accepted staleness window. Handler remains pure — tests inject `getEmailConfig` only when needed.

### Test summary

`npm test -- --testPathPattern="email-inbound|webhook"` → **79/79 pass** (7 suites). 2 new byte-fidelity tests + 8 existing status-matrix tests all green.

`npx tsc --noEmit` → zero new errors (pre-existing set: openai-gateway, openai-transformer, sanitize-and-hydrate-fields, convert-exulu-tools, memory-tool unchanged).

`npm run lint:errors` → no new errors (pre-existing: `sanitizeTagPrefix` unused + `err` unused in routes.ts, test-file parsing-error class).

**New HEAD:** `b7ee1d5`

---

## Review-fix note — settled-guard (amends `b7ee1d5`)

### Defect fixed: double-dispatch after already-settled terminal branch

**Root-cause confirmed (busboy@1.6.0 live repro):**
- `filesLimit` → `close` — both fired; old code sent 400 in `filesLimit`, then `close` called `next()` → handler ran after rejection.
- `error("Unexpected end of form")` → `close` — same double-dispatch pattern.
- `error("Malformed part header")` — error fires with NO close; old code handled this correctly but was fragile (no guard to prevent a hypothetical close).

**Fix applied:**
- Extracted the middleware logic into a new exported `createEmailMultipartParser(fieldSizeLimit)` factory at module level in `src/exulu/routes.ts`.
- The factory uses a single `let settled = false` flag with a `settle(act)` helper that no-ops if already settled.
- Every terminal event (`filesLimit`, `file`, `error`, `close`) is wrapped in `settle(...)` — only the first one acts.
- Failure branches also call `abort()` (`req.unpipe(bb); bb.removeAllListeners(); req.resume()`) to stop consuming the half-piped stream.
- The inline `emailMultipartParser` closure inside `createExpressRoutes` is replaced by a single-line delegation: `createEmailMultipartParser(EMAIL_MIME_MAX_BYTES)`.

**Files changed:**
- `src/exulu/routes.ts` — added `createEmailMultipartParser` exported factory; replaced duplicated closure with delegation.
- `src/exulu/email-inbound/webhook.test.ts` — added import for `createEmailMultipartParser`; added `describe("emailMultipartParser settled-guard")` with 4 tests:
  1. file part (filesLimit → close) → exactly ONE 400, next() never called.
  2. truncated body (error → close) → exactly ONE 400, next() never called.
  3. malformed part header (error, no close) → exactly ONE 400, no hang.
  4. happy path → next() called exactly once, no response sent.

**Test summary:**
`npm test -- --testPathPattern="email-inbound|webhook"` → **83/83 pass** (7 suites). 4 new guard tests + 10 existing byte-fidelity/status-matrix tests all green.

`npx tsc --noEmit` → zero new errors (pre-existing set unchanged: openai-gateway, openai-transformer, sanitize-and-hydrate-fields, convert-exulu-tools, memory-tool).

**Guarantee:** `next()` can never follow a sent response — the `settled` flag is checked before every action in every terminal event handler, so the second event to fire always no-ops.
