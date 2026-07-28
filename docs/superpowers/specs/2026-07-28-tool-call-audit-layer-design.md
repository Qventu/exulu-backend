# Audit layer: tool-call logging to S3

**Date:** 2026-07-28
**Status:** Approved (design review with Daniel, 2026-07-28)
**Repo:** `exulu/backend` (branch off `develop`)

## Context

Devs consuming the `@exulu/backend` npm package define their own `ExuluTool` instances and register them via `ExuluApp.create({ tools })`. Tools may carry an `authentication` config (`oauth` or `user_credentials`), and the auth layer injects real tokens/credentials into the tool's `inputs` at call time (`inputs.oauth`, `inputs.credentials`) — already scrubbed from the model but never persisted anywhere.

A client wants an **auditable trail of tool calls** — which agent called which tool, on whose behalf, using which credentials, with what payload — stored to **S3** for a **configurable retention period**, for security/compliance. Configured via the `ExuluApp` `config` property.

The relevant facts from code research:

- **Config hook.** `ExuluApp.create({ config })` takes an `ExuluConfig` (`src/exulu/app/index.ts:96-138`) with nested sections (`telemetry`, `logger`, `workers`, `fileUploads` for S3, `privacy`). A new `audit` section fits the existing pattern.
- **Single tool-call chokepoint.** Every tool execution flows through one async-generator `execute` in `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:470-638`. In scope there: the `agent` (closure), the `ExuluTool` (`cur.id`/`cur.name`/`cur.category`/`cur.authentication`), `user` (`id`/`email`/`role`), `sessionID`, the AI-SDK `toolCallId`, the input payload, and the result/error. `updateStatistic` (`:597-605`) is already an established side-effect at this point. Duration is **not** measured today and thrown tool errors bubble uncaught.
- **S3 infra exists.** `src/uppy/index.ts` (AWS SDK v3, `@aws-sdk/client-s3@3.338.0`, MinIO-compatible via `endpoint` + `forcePathStyle`, checksum `WHEN_REQUIRED`, signature-error retry with backoff) driven by `config.fileUploads`. `src/exulu/storage.ts` wraps it. The uppy client applies **user-prefixing** we do not want for audit.
- **Retention precedent.** `ee/queues/prune-job-results.ts` (createdAt-boundary pruning) and BullMQ exist; but S3 lifecycle rules are the cleaner path for time-based expiry.
- **Graceful shutdown.** `src/exulu/otel.ts` already handles `SIGTERM` — the flush-on-shutdown hook joins there.
- **Secret-injection hazard.** The auth wrapper puts live tokens into `inputs`; the audit path must never persist that material.

## Goals

- A **general audit layer** — a type-agnostic event pipeline that batches structured `AuditEvent`s and ships them to S3 as NDJSON, with configurable retention.
- **Tool-call logging as its first emitter**: one record per tool call capturing agent, tool, actor, session, credential *identity* (never secrets), input, output, status, error, and duration.
- Configured entirely through `ExuluConfig.audit`; **off by default**.
- Designed so future surfaces (auth events, config changes, data access, agent runs) become audited by adding an emitter — not by touching the core.

## Non-goals

- **No in-product query UI or DB index** — S3 archive only; the client ingests it into their own tooling. (Per-type partitioning is provisioned so a queryable index could be layered on later.)
- **No secret material, ever** — no tokens, refresh tokens, passwords, or `user_credentials` field values. "Which credentials" means the credential *identity* (provider, account, authType, non-secret token metadata).
- **No changes to the `ExuluTool` / `ExuluAuthConfig` developer contract.**
- **No custom-event emission API for consumer tools in v1** — the extension point is documented but not built (see §8).

## 1. Configuration — `ExuluConfig.audit`

New optional section on `ExuluConfig` (`src/exulu/app/index.ts`), validated at `app.create()` alongside the other sections:

```ts
audit?: {
  enabled: boolean;                    // master switch for the whole layer; default off
  s3?: {                               // omit → falls back to config.fileUploads
    s3region: string; s3key: string; s3secret: string; s3Bucket: string;
    s3endpoint?: string;               // MinIO / S3-compatible
    s3prefix?: string;                 // default "audit/"
  };
  retentionDays: number;               // the "configurable amount of time" (> 0)
  manageLifecycle?: boolean;           // apply the S3 lifecycle rule at startup; see §5.2 for default
  spoolDir?: string;                   // local fallback dir; default os.tmpdir()/exulu-audit-spool
  flush?: { maxRecords?: number; maxIntervalMs?: number };   // defaults 100 / 5000
  payload?: { maxBytes?: number; captureOutput?: boolean; redactKeys?: string[] }; // defaults 32768 / true / []
  failureMode?: "open" | "closed";     // default "open"
  sources?: {
    toolCalls?: { enabled?: boolean; include?: string[]; exclude?: string[] };
    // future: authEvents?, configChanges?, dataAccess?, agentRuns? ...
  };
};
```

**Validation** (`src/exulu/audit/config.ts`, called from `app.create`):

- `enabled: false` (or `audit` absent) → the layer resolves to a **no-op** (§2.2); no S3 client, no validation of S3 fields.
- When enabled: resolve `target = audit.s3 ?? config.fileUploads`; error clearly if neither is present. `retentionDays` must be a positive integer. Normalize `s3prefix` to end in `/`.
- `sources.toolCalls.enabled` defaults to `true` when the layer is enabled (the client's headline use case). `include`/`exclude` are lists of tool `id`s; `exclude` wins over `include`; empty `include` means "all".

## 2. The general audit layer (type-agnostic core)

New module `src/exulu/audit/`. Nothing here knows what a "tool call" is.

### 2.1 `AuditEvent` envelope — `audit/event.ts`

```ts
export type AuditEvent = {
  v: 1;
  ts: string;                          // ISO-8601 UTC
  type: string;                        // dotted namespace, e.g. "tool.call"
  actor: {                             // who/what initiated
    kind?: "user" | "agent" | "system";
    userId?: string; email?: string; roleId?: string; projectId?: string;
  };
  context?: {                          // correlation
    sessionId?: string; agentId?: string; agentName?: string; requestId?: string;
    [k: string]: unknown;
  };
  target?: { kind?: string; id?: string; name?: string; [k: string]: unknown };
  credential?: {                       // credential IDENTITY only — never secrets
    provider: string; authType: "oauth" | "user_credentials";
    account?: string; scopes?: string[]; expiresAt?: string | null;
  };
  status: "ok" | "error" | "denied" | "auth_required";
  error?: { name?: string; message: string };
  data?: Record<string, unknown>;      // type-specific, already redacted + capped
  durationMs?: number;
  truncated?: Record<string, boolean>;
};
```

`credential` is promoted to a first-class envelope field (not buried in `data`) because "which credentials" is an explicit client requirement and a plausibly-common audit dimension for future auth-using events. `audit/event.ts` also exports `AUDIT_EVENT_TYPES` string constants (`TOOL_CALL = "tool.call"`, reserved names for future types) so emitters stay consistent.

### 2.2 `AuditLogger` façade — `audit/logger.ts`

Held on the app as `app.audit`, always present:

```ts
interface AuditLogger {
  record(event: AuditEvent): void;           // general entry for any call site
  recordToolCall(ctx: ToolCallAuditContext): void;  // typed helper (§3)
  flush(): Promise<void>;
  close(): Promise<void>;                     // flush + stop timers
}
```

- **Enabled** → a real logger wrapping the sink (§2.3).
- **Disabled** → a **no-op** implementation (every method resolves immediately). Call sites never null-check `app.audit`.

Typed helpers accrete one per emitter as new surfaces are audited; `record(event)` is the open door for anything.

### 2.3 Sink — `audit/sink.ts`

Owns the in-memory buffer and flush lifecycle. Type-agnostic: it moves `AuditEvent`s, not tool calls.

- `record(event)` → run through the redaction safety net (§2.5), push to buffer. **Non-blocking.**
- **Flush triggers:** buffer length ≥ `flush.maxRecords`, or a timer every `flush.maxIntervalMs`, or explicit `flush()`/`close()`.
- **Flush:** serialize the batch as NDJSON (one JSON object per line), hand to the S3 writer (§2.4) at a date-partitioned key (§5.1).
- **Failure handling (fail-open, default):** writer retries with backoff (reuse uppy's pattern); on ultimate failure, spool the NDJSON batch to `spoolDir` and emit a Winston `error` (alertable). A background pass on the flush timer re-uploads spooled files and deletes them on success. The spool is size-bounded; when exceeded, drop the oldest with a **loud** warning (accepted under fail-open, and logged so it is never silent).
- **`failureMode: "closed"`** overrides batching for durability: `record` for a closed-mode layer performs a synchronous, retried write of that single record and **throws** if it ultimately fails. In the chokepoint (§3.1) that surfaces as a tool error — tool execution is blocked when its audit record cannot be persisted. Slower; opt-in.
- **`close()`** flushes the remaining buffer; wired into the existing `SIGTERM` path so nothing is lost on graceful shutdown.

### 2.4 S3 writer — `audit/s3-writer.ts`

A thin, purpose-built writer over `@aws-sdk/client-s3` (already a dependency). **Does not** reuse the uppy client, to avoid its user-prefixing and singleton-per-`fileUploads` caching.

- Builds one `S3Client` from the resolved audit `target`, mirroring uppy's MinIO-safe settings: `endpoint` + `forcePathStyle` when `s3endpoint` is set, `requestChecksumCalculation: "WHEN_REQUIRED"`, region/credentials from config.
- `putNdjson(key, body)` → `PutObjectCommand` with `ContentType: application/x-ndjson`, retry-on-signature-error backoff (2s/4s/8s, as uppy does).
- Exposes the lifecycle helpers used by §5.2.

### 2.5 Redaction safety net — `audit/redact.ts`

Applied by the sink to **every** event's `data` (and `target`) regardless of type — defense-in-depth, so the security guarantee protects future emitters too, even if one forgets:

- **Recursive secret sweep:** drop any key matching a denylist (case-insensitive): `oauth`, `credentials`, `accessToken`, `refreshToken`, `password`, `secret`, `token`, `apiKey`, `authorization`, plus any `payload.redactKeys`. Replace with `"[redacted]"`.
- **Strip injected framework internals** (tool inputs are enriched with these): `req`, `model`, `contexts`, `upload`, `memory`, `exuluConfig`, `toolVariablesConfig`, `allExuluTools`, `currentTools`, `sessionItems`.
- **Size cap:** serialize; if a field exceeds `payload.maxBytes`, truncate and mark it in `event.truncated`.

Emitters still hand over already-clean `data`; this layer is the backstop, not the primary defense.

### 2.6 Retention — see §5.2.

## 3. Tool-call emitter (first consumer)

### 3.1 Chokepoint hook — `convert-exulu-tools-to-ai-sdk-tools.ts:470-638`

Inside the per-tool `execute` async generator:

1. **Gate.** If the layer is disabled or `sources.toolCalls` excludes `cur.id`, run exactly as today (no overhead).
2. **Time it.** Capture `startedAt` before invoking `cur.tool.execute(...)`. Wrap the existing invocation/iteration in `try/catch/finally`.
   - **Streaming tools:** the record is emitted once, when the generator is exhausted (in `finally`), not per yielded chunk.
   - **Thrown error:** catch → `status: "error"`, capture `error.name`/`message`, emit, **re-throw** (tool-error propagation is unchanged; audit never swallows).
   - **Auth short-circuit:** when the (auth-wrapped) result carries `credentialRequest` or `oauth.authorizationUrl`, `status: "auth_required"` and the tool did not really run. Only the provider is logged — never the nonce/`submitUrl`/authorization URL.
3. **Output.** Capture the **post-`guardToolOutput`** result, so an offloaded large output is recorded as its `{ sessionFile }` reference rather than a huge blob; the §2.5 cap applies on top.
4. **Emit.** `app.audit.recordToolCall({...})` — non-blocking in the default (open) mode. The `app.audit` handle reaches the chokepoint via the existing `inputs` enrichment (which already threads `exuluConfig`).

`updateStatistic` (`:597-605`) stays as-is; audit is additive.

### 3.2 `buildToolCallEvent` + record shape — `audit/emitters/tool-call.ts`

Pure function `ToolCallAuditContext → AuditEvent` with `type: "tool.call"`:

```jsonc
{
  "v": 1, "ts": "2026-07-28T12:34:56.789Z", "type": "tool.call",
  "actor":  { "kind": "user", "userId": "…", "email": "…", "roleId": "…", "projectId": "…" },
  "context":{ "sessionId": "…", "agentId": "…", "agentName": "…" },
  "target": { "kind": "tool", "id": "…", "name": "…", "category": "…", "builtin": false },
  "credential": { "provider": "google", "authType": "oauth", "account": "<userId>", "scopes": ["…"], "expiresAt": "…" },
  "status": "ok",            // | "error" | "auth_required"
  "error":  { "name": "…", "message": "…" },     // only when status = error
  "data":   { "input": { /* redacted, capped */ }, "output": { /* redacted, capped, or {sessionFile} */ } },
  "durationMs": 123,
  "truncated": { "output": true }
}
```

`builtin` distinguishes framework tools (todo/question/perplexity/email) from consumer-defined ones. `credential` present only for authenticated tools.

### 3.3 Credential identity — `src/exulu/auth/describe.ts`

The auth wrapper injects the live token *inside* the wrapped execute; the chokepoint must **not** read `inputs.oauth`/`inputs.credentials`. Instead a small, non-secret describer:

```ts
export async function describeCredentialIdentity(
  auth: ExuluAuthConfig, userId: string,
): Promise<AuditEvent["credential"] | undefined>;
```

- `provider` + `authType` come straight from the tool's `authentication` config.
- `account` = the acting `userId`.
- For `oauth`, best-effort read of the stored token's **non-secret** metadata (`scopes`, `expiresAt`) from the credential store — never `accessToken`/`refreshToken`.
- For `user_credentials`, no field values — only that a credential exists for `(provider, userId)`.
- Best-effort and cheap (one indexed read for authenticated tools only; tool calls are LLM-gated / low-frequency). On any error it returns provider+authType+account without the extras; it never blocks or throws into the tool path.

## 4. Wiring in `ExuluApp`

- `app.create()`: validate `audit` (§1), construct the `AuditLogger` (real or no-op), store as `app.audit`. When enabled, apply the S3 lifecycle rule (§5.2) once at startup.
- Thread `app.audit` into the tool-conversion path via the existing `inputs` enrichment in `convertExuluToolsToAiSdkTools` (same mechanism that already passes `exuluConfig`).
- Register `app.audit.close()` in the `SIGTERM` graceful-shutdown path alongside the existing OTel shutdown.
- **Public exports** (`src/index.ts`): `AuditEvent`, `AuditLogger`, and the `audit` shape on `ExuluConfig` — so internal call sites and (later) consumers can emit and type events.

## 5. Storage & retention

### 5.1 Key layout

Single date-partitioned stream, mixed event types (`type` is a field):

```
<s3prefix>dt=YYYY-MM-DD/HH/<epochMs>-<uuid>.ndjson       // default prefix: audit/
```

Date partitioning makes both lifecycle expiry and time-range retrieval trivial. Per-**type** partitioning (`type=<t>/dt=…`) with per-prefix lifecycle rules is a reserved extension for when a future event type needs a different retention window (§8).

### 5.2 Lifecycle (retention)

At startup, when enabled and `manageLifecycle` is on, upsert an S3 lifecycle rule:

```jsonc
{ "ID": "exulu-audit-retention", "Filter": { "Prefix": "<s3prefix>" },
  "Status": "Enabled", "Expiration": { "Days": retentionDays } }
```

S3 auto-expires objects; zero ongoing compute.

- **Safe upsert, not overwrite.** `PutBucketLifecycleConfiguration` replaces the *entire* bucket config. So we `GET` the existing configuration, replace only the rule with our `ID`, preserve all others, and `PUT` back. This matters because the audit bucket may be the **shared** `fileUploads` bucket.
- **Default for `manageLifecycle`:** `true` when a **dedicated** `audit.s3` bucket is configured; `false` (documented, not auto-applied) when falling back to the shared `fileUploads` bucket — we don't silently touch the lifecycle of a bucket also holding user files. The consumer can force it on.
- **Missing permission** (`s3:PutLifecycleConfiguration` / `AccessDenied`): log a `warn` with the exact rule JSON for the consumer to apply by hand. Never fatal.
- **Immutability is consumer-side and compatible:** a dedicated bucket with Object Lock + write-only IAM is supported by this design; we neither require nor configure it.

## 6. Failure & performance summary

- Default path (open + batched): tool calls never block on audit; a flush is a single batched `PutObject`.
- Volume is LLM-gated, so batching keeps request count low; `describeCredentialIdentity` adds ≤1 indexed read per *authenticated* call only.
- Fail-open guarantees availability; the local spool + loud warnings ensure loss is bounded and never silent. `failureMode: "closed"` trades latency for per-record durability when a consumer needs it.

## 7. Testing (TDD)

- **`redact`** — oauth/credentials/token/password and injected internals never survive; nested/recursive cases; `redactKeys` honored; size cap sets `truncated`.
- **`sink`** — flush on size and on interval; NDJSON framing; `close()` drains the buffer; write failure → spool + warn (open); spool re-upload + delete on recovery; closed mode writes synchronously and throws on failure; **an arbitrary non-`tool.call` event type flows through identically** (proves generality).
- **`lifecycle`** — builds the correct rule; **preserves** unrelated existing rules on upsert; `AccessDenied` → warn with rule JSON, non-fatal; `manageLifecycle` default differs for dedicated vs shared bucket.
- **`describeCredentialIdentity`** — returns provider/authType/account (+ scopes/expiry for oauth); never returns token material; degrades gracefully on store error.
- **tool-call emitter / chokepoint integration** — exactly one record per call; `error` path sets `status:"error"` and re-throws; auth short-circuit → `status:"auth_required"` with provider only; excluded tool → no record; layer disabled → no-op with zero overhead; streaming tool → single record on completion; offloaded output recorded as `{ sessionFile }`.

S3 mocked (or MinIO) in tests.

## 8. Extension recipe & items to verify

**Adding a future audited surface** = (1) a new `audit/emitters/<surface>.ts` producing a `type: "<ns>.<verb>"` event, (2) a `sources.<surface>` toggle in config, (3) a typed helper on `AuditLogger` (or just call `app.audit.record(...)`). Core, sink, writer, redaction, and lifecycle are untouched. Optionally thread the `app.audit` handle into tool `inputs` so consumer-defined tools can emit their own domain events — **flagged, not built in v1.**

**Verify during implementation (do not assume):**

1. **Agent identity at the chokepoint** — the exact fields on the closure `agent` and how **nested / sub-agent** calls attribute, so "which agent" is always correct. If a sub-agent invokes a tool, the record must name the invoking agent.
2. **`app.audit` reachability** — confirm the `inputs` enrichment in `convertExuluToolsToAiSdkTools` is the cleanest carrier for the handle vs. a module singleton keyed by app.
3. **`describeCredentialIdentity` store read** — confirm the credential store exposes (or can cheaply expose) non-secret metadata without decrypting into the tool path more than necessary.
4. **Post-`guardToolOutput` capture point** — confirm the exact line where the guarded output is final, so the audit reads the offloaded reference, not the raw blob.
```
