# Client Info in Audit Tool-Call Records — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `client` section (IP, User-Agent, Referer, Origin, x-forwarded-for chain) to audit tool-call ndjson records, sourced from the HTTP request.

**Architecture:** A pure `extractClientInfo(req)` helper derives an `AuditClient` from the Express `req` (already in scope at the emit site). The emit call passes `client: extractClientInfo(req)`, and `buildToolCallEvent` writes it into the event as a top-level section. Absent for worker/routine runs (no `req`).

**Tech Stack:** TypeScript, Express `Request`, jest.

## Global Constraints

- Backend-only (`src/exulu/audit/` + the tool emit site). Branch `develop`; stage only files this plan names (the tree may hold unrelated changes). Commit subjects start lowercase (commitlint).
- `client` is emitted **only when present** — never an empty `{}`; absent entirely for requests-less (worker) tool calls.
- `ip` is the proxy-correct client IP: leftmost `x-forwarded-for` hop, else `req.ip`, else `req.socket?.remoteAddress`.
- Client fields are captured as-is (short metadata; not run through the input/output redaction). No new config toggle.
- No SDL/GraphQL/frontend change; the audit layer is in-process. Rebuild + restart the backend to take effect.

---

### Task 1: `AuditClient` type + `extractClientInfo` helper

**Files:**
- Modify: `src/exulu/audit/event.ts` (add `AuditClient` + `client?` on both types)
- Create: `src/exulu/audit/client-info.ts`
- Test: `src/exulu/audit/client-info.test.ts`

**Interfaces — Produces:** `AuditClient` type and `extractClientInfo(req: Request | undefined | null): AuditClient | undefined` (consumed by Task 2).

- [ ] **Step 1: Add the types** — in `src/exulu/audit/event.ts`, add before `AuditToolCallInput`:

```ts
export type AuditClient = {
  ip?: string;
  userAgent?: string;
  referer?: string;
  origin?: string;
  forwardedFor?: string;
};
```

Add `client?: AuditClient;` to the `AuditEvent` type (after `truncated?`) and to the `AuditToolCallInput` type (after `error?`).

- [ ] **Step 2: Write the failing helper test** — create `src/exulu/audit/client-info.test.ts`:

```ts
import { extractClientInfo } from "./client-info";

const req = (over: Record<string, unknown>) => over as any;

describe("extractClientInfo", () => {
  it("uses the leftmost x-forwarded-for hop for ip and keeps the full chain", () => {
    const c = extractClientInfo(
      req({
        headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2", "user-agent": "UA", referer: "http://x/y", origin: "http://x" },
        ip: "10.0.0.9",
      }),
    );
    expect(c).toEqual({
      ip: "203.0.113.7",
      forwardedFor: "203.0.113.7, 10.0.0.2",
      userAgent: "UA",
      referer: "http://x/y",
      origin: "http://x",
    });
  });
  it("falls back to req.ip then socket.remoteAddress when no x-forwarded-for", () => {
    expect(extractClientInfo(req({ headers: {}, ip: "198.51.100.4" }))).toEqual({ ip: "198.51.100.4" });
    expect(
      extractClientInfo(req({ headers: {}, socket: { remoteAddress: "198.51.100.9" } })),
    ).toEqual({ ip: "198.51.100.9" });
  });
  it("normalizes array-valued headers to the first element", () => {
    expect(
      extractClientInfo(req({ headers: { "x-forwarded-for": ["203.0.113.7"], "user-agent": ["UA1", "UA2"] } })),
    ).toEqual({ ip: "203.0.113.7", forwardedFor: "203.0.113.7", userAgent: "UA1" });
  });
  it("omits absent fields", () => {
    expect(extractClientInfo(req({ headers: { "user-agent": "UA" }, ip: "1.2.3.4" }))).toEqual({
      ip: "1.2.3.4",
      userAgent: "UA",
    });
  });
  it("returns undefined for null/undefined req or when nothing is extractable", () => {
    expect(extractClientInfo(undefined)).toBeUndefined();
    expect(extractClientInfo(null)).toBeUndefined();
    expect(extractClientInfo(req({ headers: {} }))).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && npx jest src/exulu/audit/client-info.test.ts`
Expected: FAIL — module `./client-info` not found.

- [ ] **Step 4: Implement the helper** — create `src/exulu/audit/client-info.ts`:

```ts
import type { Request } from "express";

import type { AuditClient } from "./event";

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : (v ?? undefined);

/**
 * Derive audit client info from an HTTP request. `ip` is the proxy-correct
 * client IP: leftmost x-forwarded-for hop, else req.ip, else the socket
 * remote address. Returns undefined when there is no request (e.g. worker
 * runs) or nothing could be derived, so an empty client is never emitted.
 */
export function extractClientInfo(
  req: Request | undefined | null,
): AuditClient | undefined {
  if (!req) return undefined;
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const forwardedFor = firstHeader(headers["x-forwarded-for"]);
  const ip =
    (forwardedFor ? forwardedFor.split(",")[0]?.trim() : undefined) ||
    req.ip ||
    req.socket?.remoteAddress ||
    undefined;
  const userAgent = firstHeader(headers["user-agent"]);
  const referer = firstHeader(headers["referer"]);
  const origin = firstHeader(headers["origin"]);

  const client: AuditClient = {};
  if (ip) client.ip = ip;
  if (userAgent) client.userAgent = userAgent;
  if (referer) client.referer = referer;
  if (origin) client.origin = origin;
  if (forwardedFor) client.forwardedFor = forwardedFor;

  return Object.keys(client).length > 0 ? client : undefined;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest src/exulu/audit/client-info.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit 2>&1 | grep -E "audit/client-info|audit/event" || echo "no errors in touched files"`
Expected: no errors referencing the touched files.

- [ ] **Step 7: Commit**

```bash
cd backend
git add src/exulu/audit/event.ts src/exulu/audit/client-info.ts src/exulu/audit/client-info.test.ts
git commit -m "feat(audit): add AuditClient type and extractClientInfo helper"
```

---

### Task 2: Emit `client` in tool-call records

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts:655` (the `emitToolCallAudit(...)` call)
- Modify: `src/exulu/audit/emitters/tool-call.ts` (`buildToolCallEvent` includes `client`)
- Test: `src/exulu/audit/emitters/tool-call.test.ts` (add client cases)

**Interfaces — Consumes:** `extractClientInfo` + `AuditClient` (Task 1); `AuditToolCallInput.client` (Task 1).

- [ ] **Step 1: Add the failing assertions to the emitter test** — in `src/exulu/audit/emitters/tool-call.test.ts`, add a `describe`/`it` block:

```ts
it("includes the client section when ctx.client is set, and omits it otherwise", async () => {
  const base = {
    durationMs: 1,
    tool: { id: "t1", name: "Tool 1" },
    user: { id: 1 },
    input: {},
    output: {},
    status: "ok" as const,
  };
  const withClient = await buildToolCallEvent(
    { ...base, client: { ip: "203.0.113.7", userAgent: "UA" } } as any,
    { maxBytes: 1000, captureOutput: true, redactKeys: [] },
  );
  expect(withClient.client).toEqual({ ip: "203.0.113.7", userAgent: "UA" });

  const withoutClient = await buildToolCallEvent(base as any, {
    maxBytes: 1000,
    captureOutput: true,
    redactKeys: [],
  });
  expect("client" in withoutClient).toBe(false);
});
```

(If `buildToolCallEvent` is not already imported at the top of the test file, add `import { buildToolCallEvent } from "./tool-call";`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx jest src/exulu/audit/emitters/tool-call.test.ts -t "includes the client section"`
Expected: FAIL — `withClient.client` is `undefined` (buildToolCallEvent doesn't emit it yet).

- [ ] **Step 3: Include `client` in `buildToolCallEvent`** — in `src/exulu/audit/emitters/tool-call.ts`, in the returned object, add the client spread immediately after the `target:` line and before the `credential` spread:

```ts
    target: { kind: "tool", id: ctx.tool.id, name: ctx.tool.name, category: ctx.tool.category, builtin: ctx.builtin },
    ...(ctx.client ? { client: ctx.client } : {}),
    ...(credential ? { credential } : {}),
```

- [ ] **Step 4: Run the emitter test to verify it passes**

Run: `cd backend && npx jest src/exulu/audit/emitters/tool-call.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Wire the emit site** — in `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`, in the `emitToolCallAudit(__auditLogger, { … })` argument object (~line 655-667), add a `client` field (after `error: __auditError,` is fine):

```ts
                  status: __auditStatus,
                  error: __auditError,
                  client: extractClientInfo(req),
```

Add the import near the other `@SRC/exulu/audit` / audit imports at the top of the file:

```ts
import { extractClientInfo } from "@SRC/exulu/audit/client-info";
```

(`req` is already a parameter of `convertExuluToolsToAiSdkTools`; `extractClientInfo` returns `undefined` when `req` is absent, e.g. worker runs, so no `client` key is emitted then.)

- [ ] **Step 6: Typecheck**

Run: `cd backend && npx tsc --noEmit 2>&1 | grep -E "convert-exulu-tools|audit/emitters/tool-call" || echo "no errors in touched files"`
Expected: no errors referencing the touched files.

- [ ] **Step 7: Run the audit test suite (no new failures)**

Run: `cd backend && npx jest src/exulu/audit`
Expected: the audit suites pass (including the new client assertions).

- [ ] **Step 8: Commit**

```bash
cd backend
git add src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts \
        src/exulu/audit/emitters/tool-call.ts \
        src/exulu/audit/emitters/tool-call.test.ts
git commit -m "feat(audit): record client info on tool-call audit events"
```

(Stage only these files; do NOT stage unrelated changes in the tree.)

---

## Self-Review

- **Spec coverage:** `AuditClient` + `client?` on both types (Task 1 Step 1) ✓; `extractClientInfo` with x-forwarded-for leftmost + req.ip/socket fallbacks + header normalization + undefined-on-empty (Task 1) ✓; emit `client: extractClientInfo(req)` at the emit site (Task 2 Step 5) ✓; `buildToolCallEvent` top-level `client`, present-only (Task 2 Step 3) ✓; absent for worker runs (extractClientInfo(undefined) → undefined) ✓; both spec test groups present (Tasks 1 & 2) ✓.
- **Type consistency:** `AuditClient` is the return type of `extractClientInfo`, the type of `AuditToolCallInput.client` and `AuditEvent.client`, and the shape asserted in both tests — matched across tasks.
- **No placeholders:** every code step carries the exact edit.
