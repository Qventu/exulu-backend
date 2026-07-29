# Client Info in Audit Tool-Call Records — Design

- **Date:** 2026-07-29
- **Status:** Approved (ready for implementation plan)
- **Repo:** `exulu/backend` — the audit layer (`src/exulu/audit/`) + the tool emit site.

## Goal

Enrich each audit tool-call ndjson record with information about the HTTP client
that triggered the tool call: IP address, User-Agent, Referer, Origin, and the
full `x-forwarded-for` chain.

## Context (existing infrastructure)

- The audit layer writes ndjson tool-call events to S3. Records are built by
  `buildToolCallEvent` (`src/exulu/audit/emitters/tool-call.ts`) from an
  `AuditToolCallInput` (`src/exulu/audit/event.ts`), and currently carry
  `actor / context / target / credential / status / error / data / durationMs /
  truncated` — no client/request fields.
- Tool-call audits are emitted at `convertExuluToolsToAiSdkTools`
  (`src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:655`) via
  `emitToolCallAudit(...)`. **The Express `req` is already a parameter of that
  function** (line 177) — threaded from the `/agent` route → `generateSync` /
  `generateStream` (`src/exulu/generate-stream.ts`) → the converter. So the
  request is already in scope at the emit site; no new plumbing is needed.

## Non-goals

- No client info for **routine-run** tool calls: the BullMQ worker executes runs
  with no HTTP `req` (email/schedule/API triggers), so `client` is simply
  omitted for those records. Not an error — there is no browser client.
- No redaction/hashing toggle for client fields now (they're short metadata, not
  the input/output payload). Captured as-is. A redaction option can come later
  if needed (YAGNI).
- No change to the audit sink, S3 writer, flush, retention, or config.

## Design

### 1. Types — `src/exulu/audit/event.ts`

Add:

```ts
export type AuditClient = {
  ip?: string;
  userAgent?: string;
  referer?: string;
  origin?: string;
  forwardedFor?: string;
};
```

Add `client?: AuditClient` to both `AuditToolCallInput` and `AuditEvent`.

### 2. Extractor — `src/exulu/audit/client-info.ts` (new, pure, unit-tested)

```ts
export function extractClientInfo(req: Request | undefined | null): AuditClient | undefined
```

- `forwardedFor`: the raw `x-forwarded-for` header value (all hops), if present.
- `ip`: the **leftmost** entry of `x-forwarded-for` (trimmed) if present, else
  `req.ip`, else `req.socket?.remoteAddress`. Proxy-correct client IP (the stack
  runs behind a proxy).
- `userAgent`: `user-agent` header.
- `referer`: `referer` header.
- `origin`: `origin` header.
- Header values that are string arrays are normalized to the first element;
  each field is omitted when absent. Returns `undefined` when `req` is
  null/undefined or when no field could be derived (so an empty `client` is
  never emitted).

### 3. Emit — `convert-exulu-tools-to-ai-sdk-tools.ts:655`

Add to the `emitToolCallAudit(...)` argument object:

```ts
client: extractClientInfo(req),
```

(`req` is already the function's parameter; `extractClientInfo` returns
`undefined` when there is no request, e.g. worker runs.)

### 4. Record — `emitters/tool-call.ts` (`buildToolCallEvent`)

Include `client` as a **top-level** section of the returned `AuditEvent`,
alongside `actor` / `context` / `target`, only when present:

```ts
...(ctx.client ? { client: ctx.client } : {}),
```

## Resulting record (interactive chat)

```json
{
  "v": 1, "ts": "…", "type": "tool.call",
  "actor": { "kind": "user", "userId": "1", "email": "…" },
  "context": { "sessionId": "…", "agentId": "…", "toolCallId": "…" },
  "target": { "kind": "tool", "id": "…", "name": "…" },
  "client": {
    "ip": "203.0.113.7",
    "userAgent": "Mozilla/5.0 … Chrome/150",
    "referer": "http://localhost:3000/chat/…",
    "origin": "http://localhost:3000",
    "forwardedFor": "203.0.113.7, 10.0.0.2"
  },
  "status": "ok", "data": { … }, "durationMs": 42
}
```

Routine-run records are identical but with no `client` key.

## Testing

- **`extractClientInfo` (jest):** x-forwarded-for present → `ip` = leftmost hop +
  `forwardedFor` = full string; no x-forwarded-for → `ip` falls back to `req.ip`,
  then `req.socket.remoteAddress`; header string-array normalized to first
  element; each header maps to the right field; missing headers omitted;
  `undefined`/null req → `undefined`; a req with nothing extractable →
  `undefined`.
- **`buildToolCallEvent` (jest):** includes `client` verbatim when
  `ctx.client` is set; omits the `client` key entirely when `ctx.client` is
  absent (worker case).

## Sequencing

1. Types (`AuditClient` + `client?` on both types).
2. `extractClientInfo` helper + its test.
3. Wire `client: extractClientInfo(req)` at the emit site.
4. `buildToolCallEvent` includes `client` + its test.

Backend-only; the audit layer runs in-process, so no SDL/GraphQL or frontend
change. Rebuild + restart the backend to take effect.
