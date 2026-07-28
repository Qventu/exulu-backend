# Audit Layer (Tool-Call Logging to S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a general, type-agnostic audit layer that batches structured `AuditEvent`s to S3 as NDJSON with configurable retention, and wire its first emitter to log every tool call (agent, tool, actor, credential identity, input, output, status, duration) — configured via `ExuluConfig.audit`, off by default.

**Architecture:** A new `src/exulu/audit/` module owns the core (event envelope, redaction safety-net, config resolution, a thin S3 NDJSON writer, an S3-lifecycle retention manager, a batching sink, and an `AuditLogger` façade held as a config-keyed module singleton). Tool-call logging is one emitter (`audit/emitters/tool-call.ts`) invoked from the single tool-execution chokepoint in `convert-exulu-tools-to-ai-sdk-tools.ts`. Credential *identity* (never secrets) comes from a new read-only `auth/describe.ts`.

**Tech Stack:** TypeScript (ESM, `.ts` extension imports), `@aws-sdk/client-s3` (installed 3.1001.0), Node `crypto`/`os`/`fs/promises`, Jest + ts-jest (co-located `*.test.ts`, jest globals, `@SRC/` path alias).

## Global Constraints

- **Never persist secret material.** No `accessToken`, `refreshToken`, `password`, `user_credentials` field values, `clientSecret`, nonces, or authorization URLs. Credential logging is identity-only. This is enforced by an emitter that hands over clean data AND a recursive redaction safety-net in the sink.
- **Off by default.** Absent or `audit.enabled !== true` ⇒ the whole layer is a no-op with zero overhead on the tool path.
- **Fail-open by default.** An audit write failure must never break a tool call (default `failureMode: "open"`). `failureMode: "closed"` is opt-in and blocks the tool call on durable write.
- **Do not mutate `guarded`.** The tool-output guard (`guardToolOutput`) preserves reference identity; the caller relies on `guarded !== lastValue`. Audit code must only read it.
- **House style:** 2-space indent; `[EXULU]` prefix on `console.log`/`console.error`; camelCase exports; `_`-prefixed private class fields; `.ts` extensions on relative imports; `@SRC/` alias in tests.
- **No `tool()` helper at the chokepoint.** The per-tool object is a plain `Tool`-shaped literal with an `async *execute(inputs, options)` method spanning lines 470–639 of `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`.
- **AWS SDK checksum settings are load-bearing** for S3-compatible stores (MinIO): any `S3Client` built here MUST set `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"`, plus the conditional `forcePathStyle: true` + `endpoint` spread when `s3endpoint` is set.
- **Run a single test file with:** `npx jest <path> -t "<name>"` (runner is `jest`; `npm test` runs the whole suite).

---

## File Structure

**Create:**
- `src/exulu/audit/event.ts` — `AuditEvent` type + `AUDIT_EVENT_TYPES` constants + `AuditToolCallInput` type.
- `src/exulu/audit/redact.ts` — recursive secret sweep + framework-internal strip + size cap (`sanitizeData`).
- `src/exulu/audit/config.ts` — `AuditConfig` (config shape) + `resolveAuditConfig(config)` (validate/default/fallback) + `ResolvedAuditConfig`.
- `src/exulu/audit/s3-writer.ts` — thin injectable S3 writer: `createAuditS3Writer(target)` → `{ putNdjson, getLifecycle, putLifecycle }`.
- `src/exulu/audit/lifecycle.ts` — `applyRetentionLifecycle(writer, { prefix, retentionDays, manage })` upsert-by-ID.
- `src/exulu/audit/sink.ts` — `AuditSink` (buffer, flush timers, NDJSON, close, spool, closed-mode) + a `SpoolStore` fs default.
- `src/exulu/audit/logger.ts` — `AuditLogger` interface, real + no-op impls, `getAuditLogger`/`initAudit`/`__resetAuditForTests`.
- `src/exulu/audit/emitters/tool-call.ts` — `buildToolCallEvent(ctx)` (pure, async).
- `src/exulu/auth/describe.ts` — `describeCredentialIdentity(auth, userId, toolId?)` (read-only, non-secret).
- Co-located `*.test.ts` for each of the above.

**Modify:**
- `src/exulu/app/index.ts` — add `audit?` to `ExuluConfig`; call `initAudit` in `create()`; expose `app.audit`.
- `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` — wrap the `execute` generator; emit one tool-call record per call.
- `src/index.ts` — export `AuditEvent`, `AuditLogger`, `AuditConfig`.
- `README.md` — a short "Audit logging" config section.

---

## Task 1: Redaction safety-net (`redact.ts`) + event types (`event.ts`)

**Files:**
- Create: `src/exulu/audit/event.ts`, `src/exulu/audit/redact.ts`
- Test: `src/exulu/audit/redact.test.ts`

**Interfaces:**
- Produces: `type AuditEvent`; `AUDIT_EVENT_TYPES` (`{ TOOL_CALL: "tool.call" }`); `sanitizeData(value: unknown, opts: { maxBytes: number; redactKeys?: string[] }): { value: unknown; truncated: boolean }`; `SECRET_KEY_DENYLIST`, `FRAMEWORK_INTERNAL_KEYS`.

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/redact.test.ts`

```ts
import { sanitizeData } from "./redact";

describe("sanitizeData", () => {
  it("removes secret-bearing keys anywhere in the tree", () => {
    const { value } = sanitizeData(
      { q: "hi", oauth: { accessToken: "x" }, nested: { password: "p", ok: 1 } },
      { maxBytes: 10_000 },
    );
    const s = JSON.stringify(value);
    expect(s).not.toContain("accessToken");
    expect(s).not.toContain("\"password\"");
    expect(s).toContain("[redacted]");
    expect(value).toMatchObject({ q: "hi", nested: { ok: 1 } });
  });

  it("strips injected framework internals at the top level", () => {
    const { value } = sanitizeData(
      { arg: 1, req: { headers: {} }, model: {}, exuluConfig: {}, contexts: {} },
      { maxBytes: 10_000 },
    );
    expect(value).toEqual({ arg: 1 });
  });

  it("honors extra redactKeys and caps oversized payloads", () => {
    const big = "a".repeat(5000);
    const r1 = sanitizeData({ email: "me@x.com", keep: 1 }, { maxBytes: 10_000, redactKeys: ["email"] });
    expect(JSON.stringify(r1.value)).not.toContain("me@x.com");

    const r2 = sanitizeData({ blob: big }, { maxBytes: 200 });
    expect(r2.truncated).toBe(true);
    expect((r2.value as any)._truncated).toBe(true);
    expect(JSON.stringify(r2.value).length).toBeLessThan(600);
  });

  it("never throws on circular / non-serializable input", () => {
    const a: any = { name: "x" };
    a.self = a;
    expect(() => sanitizeData(a, { maxBytes: 100 })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/redact.test.ts`
Expected: FAIL — `Cannot find module './redact'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/event.ts`

```ts
import type { ExuluAuthConfig } from "@SRC/exulu/auth/types";

export const AUDIT_EVENT_TYPES = {
  TOOL_CALL: "tool.call",
} as const;

export type AuditEvent = {
  v: 1;
  ts: string; // ISO-8601 UTC
  type: string; // dotted namespace, e.g. "tool.call"
  actor: {
    kind?: "user" | "agent" | "system";
    userId?: string;
    email?: string;
    roleId?: string;
    projectId?: string;
  };
  context?: {
    sessionId?: string;
    agentId?: string;
    agentName?: string;
    toolCallId?: string;
    [k: string]: unknown;
  };
  target?: { kind?: string; id?: string; name?: string; [k: string]: unknown };
  credential?: {
    provider: string;
    authType: "oauth" | "user_credentials";
    account?: string;
    scopes?: string[];
    expiresAt?: string | null;
  };
  status: "ok" | "error" | "denied" | "auth_required";
  error?: { name?: string; message: string };
  data?: Record<string, unknown>;
  durationMs?: number;
  truncated?: Record<string, boolean>;
};

// Context handed to the tool-call emitter (see emitters/tool-call.ts).
export type AuditToolCallInput = {
  durationMs: number;
  agent?: { id?: string; name?: string; slug?: string };
  tool: { id: string; name: string; category?: string; authentication?: ExuluAuthConfig };
  builtin: boolean;
  user?: { id?: unknown; email?: string; role?: { id?: unknown } };
  projectId?: string;
  sessionID?: string;
  toolCallId?: string;
  input: unknown;
  output: unknown;
  status: "ok" | "error" | "auth_required";
  error?: unknown;
};
```

Then `src/exulu/audit/redact.ts`:

```ts
// Aggressive by design: substring match, so "token" also catches accessToken.
export const SECRET_KEY_DENYLIST = [
  "oauth", "credentials", "accesstoken", "refreshtoken",
  "password", "secret", "token", "apikey", "authorization",
];

// Injected by convertExuluToolsToAiSdkTools into tool inputs — never audited.
export const FRAMEWORK_INTERNAL_KEYS = new Set([
  "req", "model", "contexts", "upload", "memory", "exuluConfig",
  "toolVariablesConfig", "allExuluTools", "currentTools", "sessionItems", "audit",
]);

const isSecretKey = (key: string, extra: string[]): boolean => {
  const k = key.toLowerCase();
  if (extra.some((e) => e.toLowerCase() === k)) return true;
  return SECRET_KEY_DENYLIST.some((term) => k.includes(term));
};

const redact = (value: unknown, redactKeys: string[], seen: WeakSet<object>): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, redactKeys, seen));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FRAMEWORK_INTERNAL_KEYS.has(key)) continue;
    if (isSecretKey(key, redactKeys)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = redact(val, redactKeys, seen);
  }
  return out;
};

export const sanitizeData = (
  value: unknown,
  opts: { maxBytes: number; redactKeys?: string[] },
): { value: unknown; truncated: boolean } => {
  let cleaned: unknown;
  try {
    cleaned = redact(value, opts.redactKeys ?? [], new WeakSet());
  } catch {
    cleaned = "[unserializable]";
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned) ?? "";
  } catch {
    return { value: "[unserializable]", truncated: false };
  }
  if (serialized.length <= opts.maxBytes) return { value: cleaned, truncated: false };
  return {
    value: { _truncated: true, preview: serialized.slice(0, opts.maxBytes) },
    truncated: true,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/redact.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/event.ts src/exulu/audit/redact.ts src/exulu/audit/redact.test.ts
git commit -m "feat(audit): AuditEvent type + recursive redaction safety-net"
```

---

## Task 2: Credential identity describer (`auth/describe.ts`)

**Files:**
- Create: `src/exulu/auth/describe.ts`
- Test: `src/exulu/auth/describe.test.ts`

**Interfaces:**
- Consumes: `credentialStore.get` (`src/exulu/auth/credential-store.ts`), `providerKeyFor` (`src/exulu/auth/provider-key.ts`), `ExuluAuthConfig` (`src/exulu/auth/types.ts`).
- Produces: `describeCredentialIdentity(auth: ExuluAuthConfig, userId: number, toolId?: string): Promise<{ provider: string; authType: "oauth" | "user_credentials"; account: string; scopes?: string[]; expiresAt?: string | null } | undefined>`.

**Key facts (from code research):**
- `credentialStore.get(provider, userId)` is read-only (SELECT + decrypt + parse); it does NOT refresh/delete. `getValidAccessToken` DOES (never call it here).
- Stored oauth blob keys: `accessToken`, `refreshToken`, `tokenType`, `scopes: string|null` (space-joined GRANTED scopes), `expiresAt: string|null` (ISO). Read only `scopes`/`expiresAt`.
- No provider-side account is stored; `account` = the acting platform `userId` (`String(userId)`).
- `provider`/`authType` are always known from the `auth` config even when no token is stored yet.

- [ ] **Step 1: Write the failing test** — `src/exulu/auth/describe.test.ts`

```ts
const rows: any[] = [];
const mockDb = {
  from: () => ({
    where: (criteria: any) => ({
      first: async () => rows.find((r) => r.provider === criteria.provider && r.user_id === criteria.user_id),
    }),
  }),
};
jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn(async () => ({ db: mockDb })) }));

import CryptoJS from "crypto-js";
import { describeCredentialIdentity } from "./describe";

const seedOauth = (provider: string, userId: number, blob: object) => {
  process.env.NEXTAUTH_SECRET = "test-secret";
  rows.push({
    provider,
    user_id: String(userId),
    auth_type: "oauth",
    data: CryptoJS.AES.encrypt(JSON.stringify(blob), "test-secret").toString(),
  });
};

beforeEach(() => { rows.length = 0; });

describe("describeCredentialIdentity", () => {
  it("returns non-secret oauth identity (never the token)", async () => {
    seedOauth("google", 42, {
      accessToken: "SECRET", refreshToken: "SECRET2", tokenType: "Bearer",
      scopes: "a b c", expiresAt: "2030-01-01T00:00:00.000Z",
    });
    const out = await describeCredentialIdentity(
      { authType: "oauth", provider: "google", authorizationUrl: "", tokenUrl: "", clientId: "", clientSecret: "", scopes: [] },
      42,
    );
    expect(out).toEqual({
      provider: "google", authType: "oauth", account: "42",
      scopes: ["a", "b", "c"], expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("returns identity from config when no token is stored yet", async () => {
    const out = await describeCredentialIdentity(
      { authType: "user_credentials", provider: "moco", fields: [] },
      7,
    );
    expect(out).toEqual({ provider: "moco", authType: "user_credentials", account: "7" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/auth/describe.test.ts`
Expected: FAIL — `Cannot find module './describe'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/auth/describe.ts`

```ts
import { credentialStore } from "./credential-store";
import { providerKeyFor } from "./provider-key";
import type { ExuluAuthConfig } from "./types";

// Narrow read type — deliberately omits accessToken/refreshToken so they
// never enter scope here (defense-in-depth against leaking secrets).
type OauthNonSecret = { scopes?: string | null; expiresAt?: string | null };

export type CredentialIdentity = {
  provider: string;
  authType: "oauth" | "user_credentials";
  account: string;
  scopes?: string[];
  expiresAt?: string | null;
};

export const describeCredentialIdentity = async (
  auth: ExuluAuthConfig,
  userId: number,
  toolId?: string,
): Promise<CredentialIdentity | undefined> => {
  const provider = providerKeyFor(toolId ?? auth.provider, auth);
  const base: CredentialIdentity = {
    provider,
    authType: auth.authType,
    account: String(userId),
  };
  if (auth.authType !== "oauth") return base;
  try {
    const row = await credentialStore.get(provider, userId);
    if (!row || row.authType !== "oauth") return base;
    const blob = row.data as OauthNonSecret;
    return {
      ...base,
      ...(blob.scopes ? { scopes: blob.scopes.split(" ").filter(Boolean) } : {}),
      ...(blob.expiresAt !== undefined ? { expiresAt: blob.expiresAt } : {}),
    };
  } catch (error) {
    console.error(`[EXULU] describeCredentialIdentity failed for provider "${provider}":`, error);
    return base;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/auth/describe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/auth/describe.ts src/exulu/auth/describe.test.ts
git commit -m "feat(auth): read-only credential-identity describer (non-secret)"
```

---

## Task 3: Audit config resolution (`config.ts`)

**Files:**
- Create: `src/exulu/audit/config.ts`
- Test: `src/exulu/audit/config.test.ts`

**Interfaces:**
- Produces: `type AuditConfig` (the `ExuluConfig.audit` shape); `type ResolvedAuditConfig`; `resolveAuditConfig(config: { audit?: AuditConfig; fileUploads?: S3Target }): ResolvedAuditConfig | null`.
- Consumed by: Task 8 (`logger.ts`).

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/config.test.ts`

```ts
import { resolveAuditConfig } from "./config";

const s3 = { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b" };

describe("resolveAuditConfig", () => {
  it("returns null when disabled or absent", () => {
    expect(resolveAuditConfig({})).toBeNull();
    expect(resolveAuditConfig({ audit: { enabled: false, retentionDays: 30 } })).toBeNull();
  });

  it("falls back to fileUploads and defaults manageLifecycle off for the shared bucket", () => {
    const r = resolveAuditConfig({ audit: { enabled: true, retentionDays: 30 }, fileUploads: s3 })!;
    expect(r.target.s3Bucket).toBe("b");
    expect(r.target.s3prefix).toBe("audit/");
    expect(r.usingSharedFileUploadsBucket).toBe(true);
    expect(r.manageLifecycle).toBe(false);
    expect(r.failureMode).toBe("open");
    expect(r.flush).toEqual({ maxRecords: 100, maxIntervalMs: 5000 });
    expect(r.toolCalls.enabled).toBe(true);
  });

  it("defaults manageLifecycle on for a dedicated audit bucket", () => {
    const r = resolveAuditConfig({ audit: { enabled: true, retentionDays: 30, s3: { ...s3, s3prefix: "x" } } })!;
    expect(r.usingSharedFileUploadsBucket).toBe(false);
    expect(r.manageLifecycle).toBe(true);
    expect(r.target.s3prefix).toBe("x/");
  });

  it("throws when no S3 target and when retentionDays is invalid", () => {
    expect(() => resolveAuditConfig({ audit: { enabled: true, retentionDays: 30 } })).toThrow(/S3/);
    expect(() => resolveAuditConfig({ audit: { enabled: true, retentionDays: 0 }, fileUploads: s3 })).toThrow(/retentionDays/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/config.ts`

```ts
import os from "os";
import path from "path";

export type S3Target = {
  s3region: string; s3key: string; s3secret: string; s3Bucket: string;
  s3endpoint?: string; s3prefix?: string;
};

export type AuditConfig = {
  enabled: boolean;
  s3?: S3Target;
  retentionDays: number;
  manageLifecycle?: boolean;
  spoolDir?: string;
  flush?: { maxRecords?: number; maxIntervalMs?: number };
  payload?: { maxBytes?: number; captureOutput?: boolean; redactKeys?: string[] };
  failureMode?: "open" | "closed";
  sources?: { toolCalls?: { enabled?: boolean; include?: string[]; exclude?: string[] } };
};

export type ResolvedAuditConfig = {
  target: Required<Pick<S3Target, "s3region" | "s3key" | "s3secret" | "s3Bucket" | "s3prefix">> &
    Pick<S3Target, "s3endpoint">;
  retentionDays: number;
  manageLifecycle: boolean;
  usingSharedFileUploadsBucket: boolean;
  spoolDir: string;
  flush: { maxRecords: number; maxIntervalMs: number };
  payload: { maxBytes: number; captureOutput: boolean; redactKeys: string[] };
  failureMode: "open" | "closed";
  toolCalls: { enabled: boolean; include: string[]; exclude: string[] };
};

const normalizePrefix = (p?: string): string => {
  const raw = (p ?? "audit").trim().replace(/^\/+|\/+$/g, "");
  return `${raw || "audit"}/`;
};

const hasAllS3Fields = (t?: S3Target): t is S3Target =>
  !!t && !!t.s3region && !!t.s3key && !!t.s3secret && !!t.s3Bucket;

export const resolveAuditConfig = (
  config: { audit?: AuditConfig; fileUploads?: S3Target },
): ResolvedAuditConfig | null => {
  const a = config.audit;
  if (!a || a.enabled !== true) return null;

  const dedicated = hasAllS3Fields(a.s3);
  const source = dedicated ? a.s3! : config.fileUploads;
  if (!hasAllS3Fields(source)) {
    throw new Error(
      "[EXULU] audit.enabled is true but no S3 target is configured. Set config.audit.s3 or config.fileUploads.",
    );
  }
  if (!Number.isInteger(a.retentionDays) || a.retentionDays <= 0) {
    throw new Error(`[EXULU] audit.retentionDays must be a positive integer, got ${a.retentionDays}.`);
  }

  const usingSharedFileUploadsBucket = !dedicated;
  return {
    target: {
      s3region: source.s3region,
      s3key: source.s3key,
      s3secret: source.s3secret,
      s3Bucket: source.s3Bucket,
      s3prefix: normalizePrefix(source.s3prefix),
      ...(source.s3endpoint ? { s3endpoint: source.s3endpoint } : {}),
    },
    retentionDays: a.retentionDays,
    manageLifecycle: a.manageLifecycle ?? !usingSharedFileUploadsBucket,
    usingSharedFileUploadsBucket,
    spoolDir: a.spoolDir ?? path.join(os.tmpdir(), "exulu-audit-spool"),
    flush: {
      maxRecords: a.flush?.maxRecords ?? 100,
      maxIntervalMs: a.flush?.maxIntervalMs ?? 5000,
    },
    payload: {
      maxBytes: a.payload?.maxBytes ?? 32_768,
      captureOutput: a.payload?.captureOutput ?? true,
      redactKeys: a.payload?.redactKeys ?? [],
    },
    failureMode: a.failureMode ?? "open",
    toolCalls: {
      enabled: a.sources?.toolCalls?.enabled ?? true,
      include: a.sources?.toolCalls?.include ?? [],
      exclude: a.sources?.toolCalls?.exclude ?? [],
    },
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/config.ts src/exulu/audit/config.test.ts
git commit -m "feat(audit): resolve/validate audit config with fileUploads fallback"
```

---

## Task 4: Thin S3 NDJSON writer (`s3-writer.ts`)

**Files:**
- Create: `src/exulu/audit/s3-writer.ts`
- Test: `src/exulu/audit/s3-writer.test.ts`

**Interfaces:**
- Consumes: `ResolvedAuditConfig["target"]` (Task 3).
- Produces: `type AuditS3Client` (minimal `{ send(command): Promise<any> }`); `createAuditS3Writer(target, client?): AuditWriter` where `AuditWriter = { putNdjson(key, body): Promise<void>; getLifecycle(): Promise<any>; putLifecycle(config): Promise<void> }`.
- Consumed by: Task 5 (`lifecycle.ts`), Task 6/8 (`sink.ts`/`logger.ts`).

**Notes:** Inject the client for unit tests; default builds a real `S3Client`. Mirror uppy's construction + retry-only-on-auth-errors backoff.

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/s3-writer.test.ts`

```ts
import { createAuditS3Writer } from "./s3-writer";

const target = { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b", s3prefix: "audit/" };

describe("createAuditS3Writer", () => {
  it("PUTs the NDJSON body to the bucket/key", async () => {
    const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd.input ?? cmd); } };
    const writer = createAuditS3Writer(target, client as any);
    await writer.putNdjson("audit/dt=2026-07-28/12/1-x.ndjson", "{\"a\":1}\n");
    expect(sent).toHaveLength(1);
    expect(sent[0].Bucket).toBe("b");
    expect(sent[0].Key).toBe("audit/dt=2026-07-28/12/1-x.ndjson");
    expect(sent[0].ContentType).toBe("application/x-ndjson");
    expect(Buffer.from(sent[0].Body).toString()).toBe("{\"a\":1}\n");
  });

  it("retries once on SignatureDoesNotMatch then succeeds", async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        if (calls === 1) { const e: any = new Error("sig"); e.name = "SignatureDoesNotMatch"; throw e; }
      },
    };
    const writer = createAuditS3Writer(target, client as any, { backoffMs: () => 0 });
    await writer.putNdjson("k", "body");
    expect(calls).toBe(2);
  });

  it("throws immediately on a non-auth error", async () => {
    const client = { send: async () => { throw new Error("boom"); } };
    const writer = createAuditS3Writer(target, client as any, { backoffMs: () => 0 });
    await expect(writer.putNdjson("k", "body")).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/s3-writer.test.ts`
Expected: FAIL — `Cannot find module './s3-writer'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/s3-writer.ts`

```ts
import {
  S3Client,
  PutObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import type { ResolvedAuditConfig } from "./config";

export type AuditS3Client = { send: (command: unknown) => Promise<unknown> };
type Target = ResolvedAuditConfig["target"];

const RETRYABLE = new Set(["SignatureDoesNotMatch", "InvalidAccessKeyId", "AccessDenied"]);

export const buildAuditS3Client = (t: Target): S3Client =>
  new S3Client({
    region: t.s3region,
    ...(t.s3endpoint ? { forcePathStyle: true, endpoint: t.s3endpoint } : {}),
    credentials: { accessKeyId: t.s3key, secretAccessKey: t.s3secret },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

export type AuditWriter = {
  putNdjson: (key: string, body: string) => Promise<void>;
  getLifecycle: () => Promise<any>;
  putLifecycle: (config: any) => Promise<void>;
};

export const createAuditS3Writer = (
  target: Target,
  client?: AuditS3Client,
  opts?: { maxRetries?: number; backoffMs?: (attempt: number) => number },
): AuditWriter => {
  const c: AuditS3Client = client ?? (buildAuditS3Client(target) as unknown as AuditS3Client);
  const maxRetries = opts?.maxRetries ?? 3;
  const backoffMs = opts?.backoffMs ?? ((attempt: number) => Math.pow(2, attempt) * 1000);

  const putNdjson = async (key: string, body: string): Promise<void> => {
    const command = new PutObjectCommand({
      Bucket: target.s3Bucket,
      Key: key,
      Body: Buffer.from(body, "utf8"),
      ContentType: "application/x-ndjson",
    });
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await c.send(command);
        return;
      } catch (error: any) {
        lastError = error;
        if (RETRYABLE.has(error?.name) && attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
          continue;
        }
        throw error;
      }
    }
    if (lastError) throw lastError;
  };

  const getLifecycle = async (): Promise<any> =>
    c.send(new GetBucketLifecycleConfigurationCommand({ Bucket: target.s3Bucket }));

  const putLifecycle = async (config: any): Promise<void> => {
    await c.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: target.s3Bucket,
        LifecycleConfiguration: config,
      }),
    );
  };

  return { putNdjson, getLifecycle, putLifecycle };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/s3-writer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/s3-writer.ts src/exulu/audit/s3-writer.test.ts
git commit -m "feat(audit): thin injectable S3 NDJSON writer with auth-error retry"
```

---

## Task 5: Retention lifecycle (`lifecycle.ts`)

**Files:**
- Create: `src/exulu/audit/lifecycle.ts`
- Test: `src/exulu/audit/lifecycle.test.ts`

**Interfaces:**
- Consumes: `AuditWriter` (Task 4).
- Produces: `AUDIT_LIFECYCLE_RULE_ID = "exulu-audit-retention"`; `applyRetentionLifecycle(writer: Pick<AuditWriter, "getLifecycle" | "putLifecycle">, opts: { prefix: string; retentionDays: number; manage: boolean }): Promise<void>`.

**Behavior:** upsert our rule by ID, preserving existing rules; when `manage: false` or on `AccessDenied`, log the rule JSON as a warning instead of applying it (never throw).

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/lifecycle.test.ts`

```ts
import { applyRetentionLifecycle, AUDIT_LIFECYCLE_RULE_ID } from "./lifecycle";

const opts = { prefix: "audit/", retentionDays: 30, manage: true };

describe("applyRetentionLifecycle", () => {
  it("upserts our rule while preserving unrelated existing rules", async () => {
    const existing = { Rules: [{ ID: "other", Status: "Enabled", Expiration: { Days: 5 }, Filter: { Prefix: "x/" } }] };
    let put: any;
    const writer = {
      getLifecycle: async () => existing,
      putLifecycle: async (cfg: any) => { put = cfg; },
    };
    await applyRetentionLifecycle(writer, opts);
    const ids = put.Rules.map((r: any) => r.ID);
    expect(ids).toContain("other");
    const ours = put.Rules.find((r: any) => r.ID === AUDIT_LIFECYCLE_RULE_ID);
    expect(ours.Expiration.Days).toBe(30);
    expect(ours.Filter.Prefix).toBe("audit/");
  });

  it("treats a missing lifecycle config as an empty rule set", async () => {
    let put: any;
    const err: any = new Error("nope"); err.name = "NoSuchLifecycleConfiguration";
    const writer = {
      getLifecycle: async () => { throw err; },
      putLifecycle: async (cfg: any) => { put = cfg; },
    };
    await applyRetentionLifecycle(writer, opts);
    expect(put.Rules).toHaveLength(1);
  });

  it("does not throw and does not PUT when manage is false", async () => {
    let putCalled = false;
    const writer = { getLifecycle: async () => ({}), putLifecycle: async () => { putCalled = true; } };
    await expect(applyRetentionLifecycle(writer, { ...opts, manage: false })).resolves.toBeUndefined();
    expect(putCalled).toBe(false);
  });

  it("swallows AccessDenied on PUT and does not throw", async () => {
    const err: any = new Error("denied"); err.name = "AccessDenied";
    const writer = { getLifecycle: async () => ({ Rules: [] }), putLifecycle: async () => { throw err; } };
    await expect(applyRetentionLifecycle(writer, opts)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/lifecycle.test.ts`
Expected: FAIL — `Cannot find module './lifecycle'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/lifecycle.ts`

```ts
import type { AuditWriter } from "./s3-writer";

export const AUDIT_LIFECYCLE_RULE_ID = "exulu-audit-retention";

const buildRule = (prefix: string, retentionDays: number) => ({
  ID: AUDIT_LIFECYCLE_RULE_ID,
  Filter: { Prefix: prefix },
  Status: "Enabled",
  Expiration: { Days: retentionDays },
});

export const applyRetentionLifecycle = async (
  writer: Pick<AuditWriter, "getLifecycle" | "putLifecycle">,
  opts: { prefix: string; retentionDays: number; manage: boolean },
): Promise<void> => {
  const rule = buildRule(opts.prefix, opts.retentionDays);
  const config = { Rules: [rule] };

  if (!opts.manage) {
    console.warn(
      `[EXULU] audit retention: not managing the S3 lifecycle for this bucket. Apply this rule manually:\n${JSON.stringify(config, null, 2)}`,
    );
    return;
  }

  try {
    let existing: any[] = [];
    try {
      const current = await writer.getLifecycle();
      existing = (current?.Rules ?? []).filter((r: any) => r.ID !== AUDIT_LIFECYCLE_RULE_ID);
    } catch (error: any) {
      if (error?.name !== "NoSuchLifecycleConfiguration") throw error;
    }
    await writer.putLifecycle({ Rules: [...existing, rule] });
    console.log(`[EXULU] audit retention: S3 lifecycle set to expire "${opts.prefix}" after ${opts.retentionDays} days.`);
  } catch (error: any) {
    console.warn(
      `[EXULU] audit retention: could not set the S3 lifecycle (${error?.name ?? "error"}). Apply this rule manually:\n${JSON.stringify(config, null, 2)}`,
    );
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/lifecycle.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/lifecycle.ts src/exulu/audit/lifecycle.test.ts
git commit -m "feat(audit): S3 lifecycle retention (upsert-by-id, preserve others)"
```

---

## Task 6: Batching sink — buffer, flush, close (`sink.ts`)

**Files:**
- Create: `src/exulu/audit/sink.ts`
- Test: `src/exulu/audit/sink.test.ts`

**Interfaces:**
- Consumes: `AuditEvent` (Task 1), `AuditWriter` (Task 4), `ResolvedAuditConfig` (Task 3).
- Produces: `type SpoolStore = { write(name, body): Promise<void>; list(): Promise<string[]>; read(name): Promise<string>; remove(name): Promise<void> }`; `createFsSpoolStore(dir): SpoolStore`; `class AuditSink` with `record(event): void`, `flush(): Promise<void>`, `close(): Promise<void>`, and `recordDurable(event): Promise<void>`.
- Consumed by: Task 8 (`logger.ts`).

**Design:** buffer array; flush when `length >= flush.maxRecords` or on an interval timer; serialize buffered events as NDJSON (`events.map(JSON.stringify).join("\n") + "\n"`); key = `${prefix}dt=YYYY-MM-DD/HH/${Date.now()}-${randomUUID()}.ndjson`. On write failure (open mode) spool the NDJSON body and warn. `recordDurable` (closed mode) writes one event synchronously and rethrows on failure. Inject `writer`, `spool`, and a `now()` clock for tests.

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/sink.test.ts`

```ts
import { AuditSink } from "./sink";

const baseCfg = {
  target: { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b", s3prefix: "audit/" },
  flush: { maxRecords: 2, maxIntervalMs: 60_000 },
  failureMode: "open" as const,
};

const evt = (n: number) => ({ v: 1 as const, ts: "t", type: "tool.call", actor: {}, status: "ok" as const, data: { n } });

const makeSpool = () => {
  const store: Record<string, string> = {};
  return {
    api: {
      write: async (name: string, body: string) => { store[name] = body; },
      list: async () => Object.keys(store),
      read: async (name: string) => store[name],
      remove: async (name: string) => { delete store[name]; },
    },
    store,
  };
};

describe("AuditSink", () => {
  it("flushes a batch as NDJSON when the buffer hits maxRecords", async () => {
    const puts: { key: string; body: string }[] = [];
    const writer = { putNdjson: async (key: string, body: string) => { puts.push({ key, body }); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const spool = makeSpool();
    const sink = new AuditSink(baseCfg as any, writer, spool.api, { now: () => new Date("2026-07-28T12:00:00Z") });
    sink.record(evt(1));
    sink.record(evt(2)); // triggers flush at maxRecords=2
    await sink.flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toMatch(/^audit\/dt=2026-07-28\/12\/\d+-[0-9a-f-]+\.ndjson$/);
    const lines = puts[0].body.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).data.n).toBe(1);
  });

  it("close() drains the remaining buffer", async () => {
    const puts: any[] = [];
    const writer = { putNdjson: async (k: string, b: string) => { puts.push(b); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const sink = new AuditSink(baseCfg as any, writer, makeSpool().api, { now: () => new Date("2026-07-28T12:00:00Z") });
    sink.record(evt(1));
    await sink.close();
    expect(puts).toHaveLength(1);
  });

  it("spools the batch and warns (does not throw) when the write fails (open mode)", async () => {
    const writer = { putNdjson: async () => { throw new Error("s3 down"); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const spool = makeSpool();
    const sink = new AuditSink(baseCfg as any, writer, spool.api, { now: () => new Date("2026-07-28T12:00:00Z") });
    sink.record(evt(1));
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(Object.keys(spool.store)).toHaveLength(1);
  });

  it("recordDurable writes one event synchronously and rethrows on failure", async () => {
    const writer = { putNdjson: async () => { throw new Error("s3 down"); }, getLifecycle: async () => ({}), putLifecycle: async () => {} };
    const sink = new AuditSink({ ...baseCfg, failureMode: "closed" } as any, writer, makeSpool().api, { now: () => new Date("2026-07-28T12:00:00Z") });
    await expect(sink.recordDurable(evt(1))).rejects.toThrow("s3 down");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/sink.test.ts`
Expected: FAIL — `Cannot find module './sink'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/sink.ts`

```ts
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { AuditEvent } from "./event";
import type { ResolvedAuditConfig } from "./config";
import type { AuditWriter } from "./s3-writer";

export type SpoolStore = {
  write: (name: string, body: string) => Promise<void>;
  list: () => Promise<string[]>;
  read: (name: string) => Promise<string>;
  remove: (name: string) => Promise<void>;
};

export const createFsSpoolStore = (dir: string): SpoolStore => ({
  write: async (name, body) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), body, "utf8");
  },
  list: async () => {
    try { return (await fs.readdir(dir)).filter((f) => f.endsWith(".ndjson")); }
    catch { return []; }
  },
  read: async (name) => fs.readFile(path.join(dir, name), "utf8"),
  remove: async (name) => { await fs.rm(path.join(dir, name), { force: true }); },
});

const pad = (n: number) => String(n).padStart(2, "0");

export class AuditSink {
  private buffer: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private now: () => Date;

  constructor(
    private cfg: Pick<ResolvedAuditConfig, "target" | "flush" | "failureMode">,
    private writer: Pick<AuditWriter, "putNdjson">,
    private spool: SpoolStore,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  private objectKey(): string {
    const d = this.now();
    const dt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return `${this.cfg.target.s3prefix}dt=${dt}/${pad(d.getUTCHours())}/${Date.now()}-${randomUUID()}.ndjson`;
  }

  private serialize(events: AuditEvent[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  record(event: AuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.cfg.flush.maxRecords) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.cfg.flush.maxIntervalMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const body = this.serialize(batch);
    try {
      await this.writer.putNdjson(this.objectKey(), body);
      await this.drainSpool();
    } catch (error) {
      const name = `${Date.now()}-${randomUUID()}.ndjson`;
      try {
        await this.spool.write(name, body);
        console.warn(`[EXULU] audit: S3 write failed, spooled ${batch.length} record(s) to disk (${name}).`, error);
      } catch (spoolError) {
        console.error(`[EXULU] audit: S3 write AND local spool failed — ${batch.length} record(s) lost.`, spoolError);
      }
    }
  }

  private async drainSpool(): Promise<void> {
    const names = await this.spool.list();
    for (const name of names) {
      try {
        const body = await this.spool.read(name);
        await this.writer.putNdjson(this.objectKey(), body);
        await this.spool.remove(name);
      } catch {
        return; // stop on first failure; retry on the next flush
      }
    }
  }

  async recordDurable(event: AuditEvent): Promise<void> {
    await this.writer.putNdjson(this.objectKey(), this.serialize([event]));
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/sink.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/sink.ts src/exulu/audit/sink.test.ts
git commit -m "feat(audit): batching NDJSON sink with spool fallback + durable path"
```

---

## Task 7: Tool-call emitter (`emitters/tool-call.ts`)

**Files:**
- Create: `src/exulu/audit/emitters/tool-call.ts`
- Test: `src/exulu/audit/emitters/tool-call.test.ts`

**Interfaces:**
- Consumes: `AuditEvent`, `AuditToolCallInput` (Task 1); `sanitizeData` (Task 1); `describeCredentialIdentity` (Task 2).
- Produces: `buildToolCallEvent(ctx: AuditToolCallInput, opts: { maxBytes: number; captureOutput: boolean; redactKeys: string[]; nowIso?: () => string }): Promise<AuditEvent>`.

**Status mapping:** if `ctx.status === "error"` → `"error"` (+`error`); else if the output looks like an auth short-circuit (`output.credentialRequest` or `output.oauth?.authorizationUrl`) → `"auth_required"`; else `"ok"`. `credential` present only when `ctx.tool.authentication` exists.

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/emitters/tool-call.test.ts`

```ts
jest.mock("@SRC/exulu/auth/describe", () => ({
  describeCredentialIdentity: jest.fn(async () => ({ provider: "google", authType: "oauth", account: "42", scopes: ["a"] })),
}));

import { buildToolCallEvent } from "./tool-call";

const opts = { maxBytes: 10_000, captureOutput: true, redactKeys: [], nowIso: () => "2026-07-28T00:00:00.000Z" };

const baseCtx = {
  durationMs: 12,
  agent: { id: "ag1", name: "Support" },
  tool: { id: "my_tool", name: "my_tool", category: "default" },
  builtin: false,
  user: { id: 42, email: "u@x.com", role: { id: 3 } },
  sessionID: "sess1",
  toolCallId: "tc1",
  input: { query: "hi", oauth: { accessToken: "SECRET" } },
  output: { result: "done" },
  status: "ok" as const,
};

describe("buildToolCallEvent", () => {
  it("builds a tool.call event with redacted input and no credential block for unauth tools", async () => {
    const ev = await buildToolCallEvent(baseCtx, opts);
    expect(ev.type).toBe("tool.call");
    expect(ev.status).toBe("ok");
    expect(ev.durationMs).toBe(12);
    expect(ev.target).toMatchObject({ kind: "tool", id: "my_tool", builtin: false });
    expect(ev.actor).toMatchObject({ userId: "42", email: "u@x.com", roleId: "3" });
    expect(ev.context).toMatchObject({ sessionId: "sess1", agentId: "ag1", toolCallId: "tc1" });
    expect(ev.credential).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("SECRET");
  });

  it("includes credential identity for authenticated tools", async () => {
    const ev = await buildToolCallEvent(
      { ...baseCtx, tool: { ...baseCtx.tool, authentication: { authType: "oauth", provider: "google" } as any } },
      opts,
    );
    expect(ev.credential).toEqual({ provider: "google", authType: "oauth", account: "42", scopes: ["a"] });
  });

  it("maps error and auth-short-circuit outputs to the right status", async () => {
    const errEv = await buildToolCallEvent({ ...baseCtx, status: "error", error: new Error("nope") }, opts);
    expect(errEv.status).toBe("error");
    expect(errEv.error?.message).toBe("nope");

    const authEv = await buildToolCallEvent({ ...baseCtx, output: { credentialRequest: { provider: "google" } } }, opts);
    expect(authEv.status).toBe("auth_required");
  });

  it("omits output when captureOutput is false", async () => {
    const ev = await buildToolCallEvent(baseCtx, { ...opts, captureOutput: false });
    expect(ev.data?.output).toBeUndefined();
    expect(ev.data?.input).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/emitters/tool-call.test.ts`
Expected: FAIL — `Cannot find module './tool-call'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/emitters/tool-call.ts`

```ts
import { AUDIT_EVENT_TYPES } from "../event";
import type { AuditEvent, AuditToolCallInput } from "../event";
import { sanitizeData } from "../redact";
import { describeCredentialIdentity } from "@SRC/exulu/auth/describe";

const str = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);

const isAuthShortCircuit = (output: unknown): boolean => {
  if (!output || typeof output !== "object") return false;
  const o = output as Record<string, any>;
  return !!o.credentialRequest || !!o.oauth?.authorizationUrl;
};

export const buildToolCallEvent = async (
  ctx: AuditToolCallInput,
  opts: { maxBytes: number; captureOutput: boolean; redactKeys: string[]; nowIso?: () => string },
): Promise<AuditEvent> => {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());

  const status: AuditEvent["status"] =
    ctx.status === "error" ? "error" : isAuthShortCircuit(ctx.output) ? "auth_required" : "ok";

  const input = sanitizeData(ctx.input, { maxBytes: opts.maxBytes, redactKeys: opts.redactKeys });
  const data: Record<string, unknown> = { input: input.value };
  const truncated: Record<string, boolean> = {};
  if (input.truncated) truncated.input = true;

  if (opts.captureOutput && status !== "auth_required") {
    const output = sanitizeData(ctx.output, { maxBytes: opts.maxBytes, redactKeys: opts.redactKeys });
    data.output = output.value;
    if (output.truncated) truncated.output = true;
  }

  let credential: AuditEvent["credential"];
  if (ctx.tool.authentication && ctx.user?.id !== undefined) {
    credential = await describeCredentialIdentity(
      ctx.tool.authentication,
      Number(ctx.user.id),
      ctx.tool.id,
    );
  }

  const err = ctx.error as any;
  return {
    v: 1,
    ts: nowIso(),
    type: AUDIT_EVENT_TYPES.TOOL_CALL,
    actor: {
      kind: "user",
      userId: str(ctx.user?.id),
      email: ctx.user?.email,
      roleId: str(ctx.user?.role?.id),
      projectId: ctx.projectId,
    },
    context: {
      sessionId: ctx.sessionID,
      agentId: ctx.agent?.id,
      agentName: ctx.agent?.name,
      toolCallId: ctx.toolCallId,
    },
    target: { kind: "tool", id: ctx.tool.id, name: ctx.tool.name, category: ctx.tool.category, builtin: ctx.builtin },
    ...(credential ? { credential } : {}),
    status,
    ...(status === "error" ? { error: { name: err?.name, message: String(err?.message ?? err ?? "unknown error") } } : {}),
    data,
    durationMs: ctx.durationMs,
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/emitters/tool-call.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/emitters/tool-call.ts src/exulu/audit/emitters/tool-call.test.ts
git commit -m "feat(audit): tool-call emitter (redacted, credential-identity only)"
```

---

## Task 8: AuditLogger façade + singleton (`logger.ts`)

**Files:**
- Create: `src/exulu/audit/logger.ts`
- Test: `src/exulu/audit/logger.test.ts`

**Interfaces:**
- Consumes: `resolveAuditConfig` (Task 3), `createAuditS3Writer` (Task 4), `applyRetentionLifecycle` (Task 5), `AuditSink` + `createFsSpoolStore` (Task 6), `buildToolCallEvent` (Task 7), `AuditToolCallInput` (Task 1).
- Produces:
  - `interface AuditLogger { enabled: boolean; failClosed: boolean; shouldAuditTool(id, builtin?): boolean; isBuiltin(id): boolean; record(event): void; recordToolCall(ctx): Promise<void>; flush(): Promise<void>; close(): Promise<void>; }`
  - `getAuditLogger(config: { audit?: any; fileUploads?: any }): AuditLogger` (config-keyed module singleton, lazy).
  - `initAudit(config, opts?: { builtinToolIds?: Set<string> }): Promise<AuditLogger>` (builds singleton, applies lifecycle, registers SIGTERM/SIGINT).
  - `__resetAuditForTests(): void`.

- [ ] **Step 1: Write the failing test** — `src/exulu/audit/logger.test.ts`

```ts
import { getAuditLogger, __resetAuditForTests } from "./logger";

const s3 = { s3region: "r", s3key: "k", s3secret: "s", s3Bucket: "b" };
beforeEach(() => __resetAuditForTests());

describe("getAuditLogger", () => {
  it("returns a no-op logger when audit is disabled", async () => {
    const logger = getAuditLogger({});
    expect(logger.enabled).toBe(false);
    logger.record({ v: 1, ts: "t", type: "x", actor: {}, status: "ok" });
    await expect(logger.recordToolCall({} as any)).resolves.toBeUndefined();
    expect(logger.shouldAuditTool("anything")).toBe(false);
  });

  it("returns the same singleton instance across calls", () => {
    const cfg = { audit: { enabled: true, retentionDays: 30 }, fileUploads: s3 };
    expect(getAuditLogger(cfg)).toBe(getAuditLogger(cfg));
  });

  it("respects the tool include/exclude filter when enabled", () => {
    const logger = getAuditLogger({
      audit: { enabled: true, retentionDays: 30, sources: { toolCalls: { exclude: ["noisy"] } } },
      fileUploads: s3,
    });
    expect(logger.enabled).toBe(true);
    expect(logger.shouldAuditTool("normal")).toBe(true);
    expect(logger.shouldAuditTool("noisy")).toBe(false);
  });

  it("disables tool auditing when sources.toolCalls.enabled is false", () => {
    const logger = getAuditLogger({
      audit: { enabled: true, retentionDays: 30, sources: { toolCalls: { enabled: false } } },
      fileUploads: s3,
    });
    expect(logger.shouldAuditTool("normal")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/audit/logger.test.ts`
Expected: FAIL — `Cannot find module './logger'`.

- [ ] **Step 3: Write minimal implementation** — `src/exulu/audit/logger.ts`

```ts
import type { AuditEvent, AuditToolCallInput } from "./event";
import { resolveAuditConfig, type ResolvedAuditConfig } from "./config";
import { createAuditS3Writer } from "./s3-writer";
import { applyRetentionLifecycle } from "./lifecycle";
import { AuditSink, createFsSpoolStore } from "./sink";
import { buildToolCallEvent } from "./emitters/tool-call";

export interface AuditLogger {
  enabled: boolean;
  failClosed: boolean;
  isBuiltin: (id: string) => boolean;
  shouldAuditTool: (id: string) => boolean;
  record: (event: AuditEvent) => void;
  recordToolCall: (ctx: AuditToolCallInput) => Promise<void>;
  flush: () => Promise<void>;
  close: () => Promise<void>;
}

const noop: AuditLogger = {
  enabled: false,
  failClosed: false,
  isBuiltin: () => false,
  shouldAuditTool: () => false,
  record: () => {},
  recordToolCall: async () => {},
  flush: async () => {},
  close: async () => {},
};

class RealAuditLogger implements AuditLogger {
  enabled = true;
  failClosed: boolean;
  private sink: AuditSink;
  constructor(private resolved: ResolvedAuditConfig, private builtinToolIds: Set<string>) {
    this.failClosed = resolved.failureMode === "closed";
    const writer = createAuditS3Writer(resolved.target);
    this.sink = new AuditSink(resolved, writer, createFsSpoolStore(resolved.spoolDir));
  }
  lifecycleWriter() { return createAuditS3Writer(this.resolved.target); }
  isBuiltin(id: string) { return this.builtinToolIds.has(id); }
  shouldAuditTool(id: string): boolean {
    const t = this.resolved.toolCalls;
    if (!t.enabled) return false;
    if (t.exclude.includes(id)) return false;
    if (t.include.length > 0) return t.include.includes(id);
    return true;
  }
  record(event: AuditEvent) { this.sink.record(event); }
  async recordToolCall(ctx: AuditToolCallInput): Promise<void> {
    const event = await buildToolCallEvent(ctx, {
      maxBytes: this.resolved.payload.maxBytes,
      captureOutput: this.resolved.payload.captureOutput,
      redactKeys: this.resolved.payload.redactKeys,
    });
    if (this.failClosed) await this.sink.recordDurable(event);
    else this.sink.record(event);
  }
  flush() { return this.sink.flush(); }
  close() { return this.sink.close(); }
  get resolvedConfig() { return this.resolved; }
}

let _instance: AuditLogger | undefined;

const build = (
  config: { audit?: any; fileUploads?: any },
  builtinToolIds: Set<string>,
): AuditLogger => {
  const resolved = resolveAuditConfig(config);
  return resolved ? new RealAuditLogger(resolved, builtinToolIds) : noop;
};

export const getAuditLogger = (config: { audit?: any; fileUploads?: any }): AuditLogger => {
  if (!_instance) _instance = build(config, new Set());
  return _instance;
};

export const initAudit = async (
  config: { audit?: any; fileUploads?: any },
  opts?: { builtinToolIds?: Set<string> },
): Promise<AuditLogger> => {
  _instance = build(config, opts?.builtinToolIds ?? new Set());
  if (_instance instanceof RealAuditLogger) {
    const r = _instance.resolvedConfig;
    await applyRetentionLifecycle(_instance.lifecycleWriter(), {
      prefix: r.target.s3prefix,
      retentionDays: r.retentionDays,
      manage: r.manageLifecycle,
    });
    const close = () => { void _instance?.close(); };
    process.on("SIGTERM", close);
    process.on("SIGINT", close);
  }
  return _instance;
};

export const __resetAuditForTests = (): void => { _instance = undefined; };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/exulu/audit/logger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/logger.ts src/exulu/audit/logger.test.ts
git commit -m "feat(audit): AuditLogger facade + config-keyed singleton + init"
```

---

## Task 9: Wire the tool-call chokepoint

**Files:**
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (the `async *execute` body, lines ~470–638)
- Test: `src/templates/tools/audit-chokepoint.test.ts`

**Interfaces:**
- Consumes: `getAuditLogger` (Task 8). The `agent` closure param (`agent?.id`/`.name`/`.slug`), `cur` (`.id`/`.name`/`.category`/`.authentication`), `user`, `sessionID`, `options.toolCallId`, `inputs`, `exuluConfig` — all already in scope.

Because the full chokepoint file is large and DB-heavy, the unit test targets an **extracted pure helper** that captures the wrapping logic, then the generator body calls it. Add the helper next to the emitter.

- [ ] **Step 1: Write the failing test** — `src/templates/tools/audit-chokepoint.test.ts`

```ts
import { emitToolCallAudit } from "@SRC/exulu/audit/emit-tool-call";

describe("emitToolCallAudit", () => {
  it("does nothing when the tool is not audited", async () => {
    const logger = { shouldAuditTool: () => false, isBuiltin: () => false, failClosed: false, recordToolCall: jest.fn() };
    await emitToolCallAudit(logger as any, { durationMs: 1, tool: { id: "t", name: "t" }, user: { id: 1 }, input: {}, output: {}, status: "ok" } as any);
    expect(logger.recordToolCall).not.toHaveBeenCalled();
  });

  it("records once and sets builtin from the logger, awaiting only in fail-closed", async () => {
    const calls: any[] = [];
    const logger = { shouldAuditTool: () => true, isBuiltin: (id: string) => id === "todo", failClosed: false, recordToolCall: async (c: any) => { calls.push(c); } };
    await emitToolCallAudit(logger as any, { durationMs: 1, tool: { id: "todo", name: "todo" }, user: { id: 1 }, input: {}, output: {}, status: "ok" } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].builtin).toBe(true);
  });

  it("never throws even if recordToolCall rejects (open mode)", async () => {
    const logger = { shouldAuditTool: () => true, isBuiltin: () => false, failClosed: false, recordToolCall: async () => { throw new Error("x"); } };
    await expect(emitToolCallAudit(logger as any, { durationMs: 1, tool: { id: "t", name: "t" }, user: { id: 1 }, input: {}, output: {}, status: "ok" } as any)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/templates/tools/audit-chokepoint.test.ts`
Expected: FAIL — `Cannot find module '@SRC/exulu/audit/emit-tool-call'`.

- [ ] **Step 3a: Write the helper** — `src/exulu/audit/emit-tool-call.ts`

```ts
import type { AuditLogger } from "./logger";
import type { AuditToolCallInput } from "./event";

// Thin adapter: applies the audit gate, sets `builtin` from the logger, and
// fire-and-forgets in open mode (awaits only in fail-closed). Never throws in
// open mode — audit must not break a tool call.
export const emitToolCallAudit = async (
  logger: AuditLogger,
  ctx: Omit<AuditToolCallInput, "builtin">,
): Promise<void> => {
  if (!logger.shouldAuditTool(ctx.tool.id)) return;
  const full: AuditToolCallInput = { ...ctx, builtin: logger.isBuiltin(ctx.tool.id) };
  if (logger.failClosed) {
    await logger.recordToolCall(full);
    return;
  }
  logger.recordToolCall(full).catch((error) =>
    console.error(`[EXULU] audit: recordToolCall failed for tool "${ctx.tool.id}":`, error),
  );
};
```

- [ ] **Step 3b: Wire the chokepoint** — `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`

At the top of the file, add the imports:

```ts
import { getAuditLogger } from "@SRC/exulu/audit/logger";
import { emitToolCallAudit } from "@SRC/exulu/audit/emit-tool-call";
```

Inside `async *execute(inputs, options)`, immediately after the opening `console.log("[EXULU] Executing tool", ...)` block, add capture vars and open the `try`:

```ts
            const __auditStart = Date.now();
            let __auditOutput: unknown;
            let __auditStatus: "ok" | "error" = "ok";
            let __auditError: unknown;
            try {
```

Immediately before **each** of the three `return` sites, capture the value:
- before `return lastValue;` (the offload-exempt generator branch): `__auditOutput = lastValue;`
- before `return guarded;` (generator branch): `__auditOutput = guarded;`
- before `return guarded;` (non-generator branch): `__auditOutput = guarded;`

Then close the `try` and add `catch`/`finally` at the very end of the method body (after the existing `if/else` block, before the method's closing brace):

```ts
            } catch (error) {
              __auditStatus = "error";
              __auditError = error;
              throw error;
            } finally {
              const __auditLogger = getAuditLogger(exuluConfig ?? {});
              if (__auditLogger.shouldAuditTool(cur.id)) {
                const __emit = emitToolCallAudit(__auditLogger, {
                  durationMs: Date.now() - __auditStart,
                  agent: agent ? { id: agent.id, name: agent.name, slug: (agent as any).slug } : undefined,
                  tool: { id: cur.id, name: cur.name, category: cur.category, authentication: cur.authentication },
                  user,
                  projectId: (project as any)?.id ? String((project as any).id) : undefined,
                  sessionID,
                  toolCallId: options?.toolCallId,
                  input: inputs,
                  output: __auditOutput,
                  status: __auditStatus,
                  error: __auditError,
                });
                if (__auditLogger.failClosed) await __emit;
              }
            }
```

Note: `getAuditLogger` returns the instance built during `app.create()`; it is safe to call every invocation (a no-op when disabled). `project` is the 11th positional param already in scope; guard it defensively as shown.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/templates/tools/audit-chokepoint.test.ts`
Expected: PASS (3 tests).
Run: `npx tsc --noEmit` (or `npm run type-check`)
Expected: no new type errors in the modified file.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/audit/emit-tool-call.ts src/templates/tools/audit-chokepoint.test.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts
git commit -m "feat(audit): emit one audit record per tool call at the chokepoint"
```

---

## Task 10: Add `audit` to `ExuluConfig` + init in `create()` + expose `app.audit`

**Files:**
- Modify: `src/exulu/app/index.ts`
- Test: `src/exulu/app/audit-wiring.test.ts`

**Interfaces:**
- Consumes: `initAudit`, `getAuditLogger`, `AuditLogger` (Task 8); `AuditConfig` (Task 3).
- Produces: `ExuluConfig.audit?: AuditConfig`; `app.audit` accessor.

- [ ] **Step 1: Write the failing test** — `src/exulu/app/audit-wiring.test.ts`

```ts
import { computeBuiltinToolIds } from "./audit-wiring-helpers";

describe("computeBuiltinToolIds", () => {
  it("collects ids from the built-in tool arrays only", () => {
    const ids = computeBuiltinToolIds({
      todoTools: [{ id: "todo_a" }],
      questionTools: [{ id: "ask" }],
      perplexityTools: [],
      emailTool: { id: "email" },
      imageGenerationTools: [{ id: "img" }],
    } as any);
    expect(ids.has("todo_a")).toBe(true);
    expect(ids.has("ask")).toBe(true);
    expect(ids.has("email")).toBe(true);
    expect(ids.has("img")).toBe(true);
    expect(ids.size).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/app/audit-wiring.test.ts`
Expected: FAIL — `Cannot find module './audit-wiring-helpers'`.

- [ ] **Step 3a: Add the helper** — `src/exulu/app/audit-wiring-helpers.ts`

```ts
import type { ExuluTool } from "@SRC/exulu/tool";

export const computeBuiltinToolIds = (builtins: {
  todoTools: ExuluTool[];
  questionTools: ExuluTool[];
  perplexityTools: ExuluTool[];
  emailTool: ExuluTool;
  imageGenerationTools: ExuluTool[];
}): Set<string> =>
  new Set(
    [
      ...builtins.todoTools,
      ...builtins.questionTools,
      ...builtins.perplexityTools,
      builtins.emailTool,
      ...builtins.imageGenerationTools,
    ]
      .filter(Boolean)
      .map((t) => t.id),
  );
```

- [ ] **Step 3b: Add `audit?` to `ExuluConfig`** in `src/exulu/app/index.ts`

At the top add the import:
```ts
import type { AuditConfig } from "./audit/config";
```
(Adjust the relative path to `../audit/config` — the audit module lives at `src/exulu/audit/`, `app/index.ts` at `src/exulu/app/`, so use `"../audit/config"`.)

Inside the `ExuluConfig` type (after the `privacy?` block, before `requireSystemDependencies?`), add:
```ts
  /**
   * Audit logging. When enabled, structured audit events (starting with one
   * per tool call) are batched to S3 as NDJSON with configurable retention.
   * Off by default. See docs/superpowers/specs/2026-07-28-tool-call-audit-layer-design.md.
   */
  audit?: AuditConfig;
```

- [ ] **Step 3c: Declare the private field + init in `create()`** in `src/exulu/app/index.ts`

Add the import:
```ts
import { initAudit, getAuditLogger, type AuditLogger } from "./audit/logger";
import { computeBuiltinToolIds } from "./audit-wiring-helpers";
```
(Use `"../audit/logger"` for the logger import path.)

Add the backing field with the other `private _` fields (~line 147):
```ts
  private _audit?: AuditLogger;
```

Right after `this._tools = [ ... ];` (the merge block, ~line 247), add:
```ts
    this._audit = await initAudit(config, {
      builtinToolIds: computeBuiltinToolIds({
        todoTools,
        questionTools,
        perplexityTools,
        emailTool,
        imageGenerationTools,
      }),
    });
```

Add the accessor near the other getters (e.g. after the `contexts` getter, ~line 582):
```ts
  public get audit(): AuditLogger {
    return this._audit ?? getAuditLogger(this._config ?? {});
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/exulu/app/audit-wiring.test.ts`
Expected: PASS (1 test).
Run: `npm run type-check`
Expected: no new type errors.

- [ ] **Step 5: Commit**

```bash
git add src/exulu/app/audit-wiring-helpers.ts src/exulu/app/audit-wiring.test.ts src/exulu/app/index.ts
git commit -m "feat(audit): wire audit config + init into ExuluApp.create, expose app.audit"
```

---

## Task 11: Public exports + consumer docs

**Files:**
- Modify: `src/index.ts`, `README.md`

- [ ] **Step 1: Add exports** to `src/index.ts` (alongside the existing `export type { ExuluAuthConfig, ... }` block):

```ts
export type { AuditEvent } from "./exulu/audit/event";
export type { AuditConfig } from "./exulu/audit/config";
export type { AuditLogger } from "./exulu/audit/logger";
```

- [ ] **Step 2: Verify the package still type-checks and builds**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 3: Add a README section.** Append an "Audit logging" section to `README.md`:

````markdown
## Audit logging

Enable an auditable, S3-backed trail of tool calls (which agent called which
tool, on whose behalf, using which credential identity, with what payload).
Off by default. Configure via `ExuluApp.create({ config })`:

```ts
await app.create({
  tools,
  config: {
    // ...existing config...
    audit: {
      enabled: true,
      retentionDays: 90,            // S3 lifecycle expiry
      // Optional: a dedicated, isolated bucket. Omit to reuse `fileUploads`.
      s3: {
        s3region: process.env.AUDIT_S3_REGION!,
        s3key: process.env.AUDIT_S3_KEY!,
        s3secret: process.env.AUDIT_S3_SECRET!,
        s3Bucket: process.env.AUDIT_S3_BUCKET!,
        s3prefix: "audit/",
      },
      // failureMode: "open" (default) | "closed"
      // sources: { toolCalls: { exclude: ["noisy_tool"] } },
    },
  },
});
```

Records are written as newline-delimited JSON under
`audit/dt=YYYY-MM-DD/HH/…​.ndjson`. **Secret material is never logged** — only
credential identity (provider, account, authType, non-secret scopes/expiry).
When reusing the shared `fileUploads` bucket, the S3 lifecycle rule is not
applied automatically (to avoid touching a bucket that also holds user files);
the exact rule to apply is logged at startup. Set `manageLifecycle: true` to
apply it anyway.
````

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "docs(audit): export audit types + document the audit config"
```

---

## Task 12: Full suite + optional MinIO integration test

**Files:**
- Create (optional): `src/exulu/audit/s3-writer.integration.test.ts`

- [ ] **Step 1: Run the full test suite and type-check**

Run: `npm run type-check && npx jest src/exulu/audit src/exulu/auth/describe.test.ts src/templates/tools/audit-chokepoint.test.ts src/exulu/app/audit-wiring.test.ts`
Expected: all audit + wiring tests PASS.

- [ ] **Step 2: (Optional) Add an env-gated real-S3/MinIO writer test** mirroring `credential-store.integration.test.ts`:

```ts
const enabled = process.env.EXULU_S3_INTEGRATION_TESTS === "true";
const describeIf = enabled ? describe : describe.skip;

import { createAuditS3Writer } from "./s3-writer";

describeIf("audit S3 writer against a real bucket", () => {
  const target = {
    s3region: process.env.AUDIT_S3_REGION!,
    s3key: process.env.AUDIT_S3_KEY!,
    s3secret: process.env.AUDIT_S3_SECRET!,
    s3Bucket: process.env.AUDIT_S3_BUCKET!,
    s3prefix: "audit-itest/",
    ...(process.env.AUDIT_S3_ENDPOINT ? { s3endpoint: process.env.AUDIT_S3_ENDPOINT } : {}),
  };

  it("PUTs an NDJSON object and applies a lifecycle rule", async () => {
    const writer = createAuditS3Writer(target as any);
    await writer.putNdjson(`${target.s3prefix}itest-${Date.now()}.ndjson`, "{\"ok\":true}\n");
    await writer.putLifecycle({ Rules: [{ ID: "exulu-audit-retention", Filter: { Prefix: target.s3prefix }, Status: "Enabled", Expiration: { Days: 1 } }] });
    const lc = await writer.getLifecycle();
    expect(lc.Rules.some((r: any) => r.ID === "exulu-audit-retention")).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 3: Commit (if the integration test was added)**

```bash
git add src/exulu/audit/s3-writer.integration.test.ts
git commit -m "test(audit): env-gated MinIO/S3 writer integration test"
```

---

## Self-Review

**Spec coverage:**

- §1 config shape → Task 3 (`config.ts`), Task 10 (added to `ExuluConfig`). ✅
- §2.1 `AuditEvent` envelope → Task 1. ✅
- §2.2 `AuditLogger` façade + no-op → Task 8. ✅
- §2.3 sink (batch/flush/close/spool/closed) → Task 6. ✅
- §2.4 S3 writer → Task 4. ✅
- §2.5 redaction safety-net → Task 1. ✅
- §2.6 / §5.2 retention lifecycle (upsert, shared-bucket default off, AccessDenied warn) → Task 5 + Task 3 (`manageLifecycle` default) + Task 8 (`initAudit` applies it). ✅
- §3.1 chokepoint hook (once-per-call, timing, error, auth short-circuit, post-guard output) → Task 9. ✅
- §3.2 record schema + `builtin` flag → Task 7 + Task 10 (`computeBuiltinToolIds`). ✅
- §3.3 credential identity → Task 2. ✅
- §4 wiring (init in create, `app.audit`, exports, SIGTERM) → Task 8 (SIGTERM), Task 10 (init + accessor), Task 11 (exports). ✅
- §5.1 key layout → Task 6 (`objectKey`). ✅
- §6 failure/perf → Task 6 + Task 9. ✅
- §7 testing → tests in every task. ✅
- §8 extension recipe + verify items → resolved: agent attribution = the tool-set's owning agent (`agent?.id`), no sub-agent distinction exists (Task 9 comment); `app.audit` reached via config-keyed singleton, not the app instance (Task 8/9); `credentialStore.get` confirmed side-effect-free (Task 2); post-guard output captured at the three `return` sites (Task 9). ✅

**Placeholder scan:** No `TBD`/`TODO`; every code step has real content. ✅

**Type consistency:** `AuditLogger` interface (Task 8) matches usage in Task 9 (`shouldAuditTool`, `isBuiltin`, `failClosed`, `recordToolCall`). `AuditToolCallInput` (Task 1) matches `buildToolCallEvent` (Task 7) and `emitToolCallAudit` (Task 9). `ResolvedAuditConfig` (Task 3) fields (`target`, `flush`, `failureMode`, `payload`, `toolCalls`, `spoolDir`, `manageLifecycle`) match `AuditSink` (Task 6) and `RealAuditLogger` (Task 8). `AuditWriter` (Task 4) `{ putNdjson, getLifecycle, putLifecycle }` matches Task 5 and Task 6 usage. ✅

**Note for the implementer:** an unrelated uncommitted edit exists on `src/exulu/email-inbound/intake.ts` (present at plan-authoring time). Leave it alone; stage only the files each task names.
