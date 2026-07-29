# Generic Routine Inbound Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Mailgun-specific inbound-email path with a provider-neutral per-trigger secret webhook (`POST /webhooks/routine/:secret`) that accepts raw MIME + JSON, supports optional per-trigger HMAC, and adds a real-send test panel — keeping the entire downstream `InboundEmail` pipeline unchanged.

**Architecture:** Each routine trigger owns a 32-byte secret capability URL that both routes (secret → trigger) and authorizes (holding it). A single early-mounted `express.raw` middleware captures raw bytes; the handler branches on `Content-Type` into three adapters (raw MIME, multipart raw-MIME part, JSON) that all produce the existing `InboundEmail`, then persists to S3 and enqueues the existing `email_intake` job. The Mailgun platform-config, admin settings page, and HMAC-over-`timestamp+token` verifier are removed; an optional per-trigger `signing_secret` (AES-encrypted) verifies `X-Exulu-Signature` over the raw body.

**Tech Stack:** TypeScript, Express, Knex/Postgres, BullMQ/Redis, S3 (via `@SRC/uppy`), `mailparser`, `busboy`, GraphQL (custom SDL + resolvers), Jest (backend), React + Apollo + Next.js, Vitest (frontend pure helpers), next-intl.

## Global Constraints

- **Repositories:** backend = `/Users/daniel.claessen/Desktop/Projects/exulu/backend` (branch `develop`); frontend = `/Users/daniel.claessen/Desktop/Projects/exulu/frontend` (branch `main`). Verify repo + branch in the same command as any commit (parallel sessions switch the primary checkouts). Prefer isolated worktrees per repo (`superpowers:using-git-worktrees`).
- **Spec:** `docs/superpowers/specs/2026-07-27-generic-routine-webhook-design.md` — every task implements a part of it.
- **Migrations:** one-time DB migrations live in `src/postgres/init-exulu-db.ts`, gated by column/type existence checks. Never a standalone script.
- **Path alias:** backend imports use `@SRC/...` (e.g. `@SRC/uppy`, `@SRC/exulu/auth/credential-store`).
- **AES at rest:** reuse `encrypt`/`decrypt` from `@SRC/exulu/auth/credential-store` (AES with `process.env.NEXTAUTH_SECRET`). Never return a decrypted secret over the API.
- **Public base URL:** absolute webhook URLs use `process.env.BACKEND` (never a new PUBLIC_URL var).
- **Naming decision (verbatim from spec §3.1):** keep `type: 'email'` and the GraphQL mutation name `upsertWorkflowEmailTrigger`; document "email trigger" == "inbound webhook". Do NOT rename these.
- **Secret format:** `secret` = `randomBytes(32).toString("base64url")` (~192 bits); `signing_secret` (plaintext, before AES) = `randomBytes(32).toString("base64url")`.
- **Signature scheme (verbatim from spec §4.4):** header `X-Exulu-Signature: sha256=<hex>` where `<hex>` = `HMAC-SHA256(signedMessage, signing_secret)`; `signedMessage` = `timestampHeader + "." + rawBody` when `X-Exulu-Timestamp` present, else `rawBody`. `timingSafeEqual` comparison. Missing/mismatch → `401`. Replay window ±300 s + Redis `SETNX` (`routine_webhook:replay:{signature}`, TTL 900 s) only when a timestamp is supplied.
- **HTTP status contract:** unknown/disabled secret → `404` (no enumeration oracle); over rate limit → `429`; missing queues entitlement → `503`; signature required-but-invalid → `401`; malformed payload (unparseable JSON / missing `from` / bad base64) → `400`; success → `200 {ok:true}`.
- **Backend test runner:** `npm test` (Jest; finds `*.test.ts`). Run a single file with `npm test -- src/exulu/email-inbound/<file>.test.ts`.
- **Frontend test runner:** `npm test` (`vitest run`). Typecheck with `npx tsc --noEmit`.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **i18n:** every user-facing string added to BOTH `messages/en.json` and `messages/de.json`.

---

## Group A — Backend: data model & resolution helpers

### Task 1: Migrate `workflow_triggers` schema (drop `address`, add `secret` / `signing_secret` / `last_fired_at`) and remove the orphan `email_inbound` config

**Files:**
- Modify: `ee/schemas.ts:432-491` (`workflowTriggersSchema` fields)
- Modify: `src/exulu/email-inbound/types.ts:40-53` (`WorkflowTriggerRow`)
- Modify: `src/postgres/init-exulu-db.ts` (add a custom migration fn + invoke it near line 155, after `migrateUserCredentialsDataColumn`)

**Interfaces:**
- Produces: `workflow_triggers` columns `secret` (text, unique, indexed), `signing_secret` (text, nullable), `last_fired_at` (timestamp, nullable); no `address` column. `WorkflowTriggerRow` gains `secret: string`, `signing_secret: string | null`, `last_fired_at: string | Date | null`; loses `address`.

- [ ] **Step 1: Edit the schema field list.** In `ee/schemas.ts`, replace the `address` field (currently `{ name: "address", type: "text", required: true, unique: true, index: true }`) and add three columns. The fields array becomes:

```ts
      fields: [
        { name: "workflow", type: "uuid", required: true },
        // 'email' for now; extensible ('webhook' later). Payloads are still
        // email-shaped (InboundEmail); "email trigger" == "inbound webhook".
        { name: "type", type: "text", required: true },
        { name: "enabled", type: "boolean", default: false },
        // Secret capability URL key: base64url randomBytes(32). Both routes
        // and authorizes the webhook (POST /webhooks/routine/:secret).
        { name: "secret", type: "text", required: true, unique: true, index: true },
        // Optional per-trigger HMAC shared secret, AES-encrypted at rest.
        { name: "signing_secret", type: "text" },
        // Stamped on every verified webhook hit; per-trigger setup aid.
        { name: "last_fired_at", type: "timestamp" },
        { name: "config", type: "json", required: true },
        { name: "run_as_user", type: "number" },
        { name: "run_as_role", type: "uuid" },
        { name: "created_by", type: "number" },
      ],
```

- [ ] **Step 2: Update the backend `WorkflowTriggerRow` type.** In `src/exulu/email-inbound/types.ts`, change the interface (remove `address`, add the new columns):

```ts
export interface WorkflowTriggerRow {
  id: string;
  workflow: string;
  type: string;
  enabled: boolean;
  /** base64url secret; the /webhooks/routine/:secret routing + auth key. */
  secret: string;
  /** AES-encrypted HMAC shared secret, or null when signing is off. */
  signing_secret: string | null;
  last_fired_at: string | Date | null;
  /** jsonb — pg returns an object, but tolerate strings defensively. */
  config: EmailTriggerConfig | string;
  run_as_user: number | null;
  run_as_role: string | null;
  created_by?: number | string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}
```

- [ ] **Step 3: Write the drop/cleanup migration.** In `src/postgres/init-exulu-db.ts`, add a function modeled on `migrateUserCredentialsDataColumn` (the feature is unshipped, so existing `workflow_triggers` rows are throwaway dev data with now-invalid addresses — clear them so the new `NOT NULL UNIQUE secret` column can be added cleanly, then drop `address`). Also delete the orphaned `email_inbound` platform config row:

```ts
export const migrateWorkflowTriggersToSecret = async (knex: Knex): Promise<void> => {
  const hasAddress = await knex.schema.hasColumn("workflow_triggers", "address");
  if (hasAddress) {
    // Unshipped feature: old rows carry Mailgun addresses that no longer route.
    // Clear them so addMissingFields can add the NOT NULL UNIQUE `secret` column.
    console.log("[EXULU] Migrating workflow_triggers address -> secret (clearing unshipped dev rows).");
    await knex("workflow_triggers").del();
    await knex.schema.alterTable("workflow_triggers", (t) => t.dropColumn("address"));
  }
  // Remove the retired platform-level inbound config (spec §3.2).
  await knex("platform_configurations").where({ config_key: "email_inbound" }).del();
};
```

- [ ] **Step 4: Invoke the migration.** After the existing `await migrateUserCredentialsDataColumn(knex);` (line ~155), add:

```ts
  await migrateWorkflowTriggersToSecret(knex);
```

Note: `addMissingFields` (line 142, driven by `workflowTriggersSchema().fields`) adds `secret`, `signing_secret`, and `last_fired_at` automatically on the create/alter loop, which runs before this migration in the same init pass. Order is safe because `migrateWorkflowTriggersToSecret` empties the table first and the add loop tolerates existing columns.

- [ ] **Step 5: Verify the backend compiles.**

Run: `npx tsc --noEmit` (from backend root)
Expected: no errors referencing `workflow_triggers`, `address`, or `WorkflowTriggerRow`. (Downstream references to `.address` in `intake.ts`/`resolver-helpers.ts` will error — that's expected and fixed in Tasks 2, 6, 7; if you want a green typecheck now, proceed to those tasks before compiling. It is acceptable to commit this schema change with the known downstream breakage since the tasks are executed in sequence.)

- [ ] **Step 6: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add ee/schemas.ts src/exulu/email-inbound/types.ts src/postgres/init-exulu-db.ts && git commit -m "$(cat <<'EOF'
feat(webhook): migrate workflow_triggers to secret-based routing

Drop the Mailgun mailbox `address`; add `secret` (unique capability-URL
key), optional AES `signing_secret`, and `last_fired_at`. Remove the
orphan email_inbound platform config.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 2: Secret generation + trigger resolution helpers

**Files:**
- Modify: `src/exulu/email-inbound/trigger-config.ts` (add `generateTriggerSecret`, `generateSigningSecret`)
- Modify: `src/exulu/email-inbound/intake.ts:55-62` (replace `resolveTriggerByAddress` with `resolveTriggerBySecret` + `resolveTriggerById`)
- Test: `src/exulu/email-inbound/trigger-config.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `generateTriggerSecret(): string` — `randomBytes(32).toString("base64url")`
  - `generateSigningSecret(): string` — same shape (plaintext, pre-AES)
  - `resolveTriggerBySecret(db, secret: string): Promise<WorkflowTriggerRow | undefined>`
  - `resolveTriggerById(db, triggerId: string): Promise<WorkflowTriggerRow | undefined>`

- [ ] **Step 1: Write the failing test** for secret generation. Append to `src/exulu/email-inbound/trigger-config.test.ts`:

```ts
import { generateTriggerSecret, generateSigningSecret } from "./trigger-config";

describe("generateTriggerSecret", () => {
  it("produces a URL-safe ~43-char base64url string, unique per call", () => {
    const a = generateTriggerSecret();
    const b = generateTriggerSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
    expect(a).not.toEqual(b);
  });
  it("generateSigningSecret has the same shape", () => {
    expect(generateSigningSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/trigger-config.test.ts`
Expected: FAIL — `generateTriggerSecret is not a function`.

- [ ] **Step 3: Implement the generators.** In `src/exulu/email-inbound/trigger-config.ts`, add `import { randomBytes } from "node:crypto";` at the top if absent, then:

```ts
/** Capability-URL secret for /webhooks/routine/:secret (~192 bits). */
export function generateTriggerSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Plaintext HMAC shared secret (encrypt before storing). */
export function generateSigningSecret(): string {
  return randomBytes(32).toString("base64url");
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/exulu/email-inbound/trigger-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Replace the resolver in `intake.ts`.** In `src/exulu/email-inbound/intake.ts`, replace `resolveTriggerByAddress` (lines 55-62) with:

```ts
export const resolveTriggerBySecret = async (
  db: any,
  secret: string,
): Promise<WorkflowTriggerRow | undefined> =>
  db.from("workflow_triggers").where({ secret }).first();

export const resolveTriggerById = async (
  db: any,
  triggerId: string,
): Promise<WorkflowTriggerRow | undefined> =>
  db.from("workflow_triggers").where({ id: triggerId }).first();
```

(Downstream call sites in `intake.ts` are rewired in Task 8; the `handleEmailIntake` body still references `resolveTriggerByAddress` until then — leave those temporarily; this step only swaps the exported helpers.)

- [ ] **Step 6: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/trigger-config.ts src/exulu/email-inbound/trigger-config.test.ts src/exulu/email-inbound/intake.ts && git commit -m "$(cat <<'EOF'
feat(webhook): secret generators + resolve-by-secret/id helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

## Group B — Backend: signature verification & payload adapters

### Task 3: Generalize the signature verifier (`verify-mailgun.ts` → `verify-signature.ts`)

**Files:**
- Create: `src/exulu/email-inbound/verify-signature.ts`
- Delete: `src/exulu/email-inbound/verify-mailgun.ts`
- Create: `src/exulu/email-inbound/verify-signature.test.ts`
- Delete: `src/exulu/email-inbound/verify-mailgun.test.ts` (if present)

**Interfaces:**
- Produces:
  - `verifyPayloadSignature(rawBody: Buffer, signatureHeader: string, timestampHeader: string | undefined, secret: string): boolean`
  - `isReplay(redis: any, signature: string, timestamp: string): Promise<boolean>` (generalized; key `routine_webhook:replay:{signature}`)
  - `SIGNATURE_REPLAY_WINDOW_SECONDS = 300`

- [ ] **Step 1: Write the failing test.** Create `src/exulu/email-inbound/verify-signature.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { verifyPayloadSignature } from "./verify-signature";

const SECRET = "test-signing-secret";
const body = Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8");

const sign = (msg: Buffer) =>
  "sha256=" + createHmac("sha256", SECRET).update(msg).digest("hex");

describe("verifyPayloadSignature", () => {
  it("accepts a valid signature over the raw body (no timestamp)", () => {
    expect(verifyPayloadSignature(body, sign(body), undefined, SECRET)).toBe(true);
  });
  it("accepts a valid signature over timestamp + '.' + body", () => {
    const ts = "1730000000";
    const msg = Buffer.concat([Buffer.from(ts + "."), body]);
    expect(verifyPayloadSignature(body, sign(msg), ts, SECRET)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyPayloadSignature(Buffer.from("x"), sign(body), undefined, SECRET)).toBe(false);
  });
  it("rejects a missing or malformed header", () => {
    expect(verifyPayloadSignature(body, "", undefined, SECRET)).toBe(false);
    expect(verifyPayloadSignature(body, "nothex", undefined, SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/verify-signature.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `verify-signature.ts`.** Create the file (port `isReplay` from `verify-mailgun.ts` with the generalized key):

```ts
// Generic per-trigger webhook signature verification (spec §4.4). HMAC-SHA256
// over the raw request body (optionally prefixed with a timestamp for replay
// defense) using the trigger's decrypted signing_secret. Replaces the former
// Mailgun timestamp+token scheme.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_REPLAY_WINDOW_SECONDS = 300;
const REPLAY_TTL_SECONDS = 900;

/**
 * Verify `X-Exulu-Signature: sha256=<hex>` over the raw body. When a timestamp
 * header is supplied the signed message is `timestamp + "." + rawBody`.
 */
export function verifyPayloadSignature(
  rawBody: Buffer,
  signatureHeader: string,
  timestampHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const message = timestampHeader
    ? Buffer.concat([Buffer.from(`${timestampHeader}.`), rawBody])
    : rawBody;
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided.toLowerCase(), "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * True when the request must be rejected as a replay: timestamp outside the
 * window, unparseable, or a signature already seen (Redis SETNX, TTL 900 s).
 * Degrades to the timestamp window only when Redis is unavailable.
 */
export async function isReplay(redis: any, signature: string, timestamp: string): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return true;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SIGNATURE_REPLAY_WINDOW_SECONDS) return true;
  if (!redis) return false;
  try {
    const result = await redis.set(`routine_webhook:replay:${signature}`, "1", {
      NX: true,
      EX: REPLAY_TTL_SECONDS,
    });
    return result === null;
  } catch (err) {
    console.error(
      "[EXULU] routine-webhook replay guard: redis unavailable, degrading to window-only",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
```

- [ ] **Step 4: Delete the old verifier and its test.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
git rm src/exulu/email-inbound/verify-mailgun.ts
git rm --ignore-unmatch src/exulu/email-inbound/verify-mailgun.test.ts
```

- [ ] **Step 5: Run the new test to verify it passes.**

Run: `npm test -- src/exulu/email-inbound/verify-signature.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/verify-signature.ts src/exulu/email-inbound/verify-signature.test.ts && git commit -m "$(cat <<'EOF'
feat(webhook): generic HMAC signature verifier over raw body

Replace Mailgun timestamp+token verifier with per-trigger X-Exulu-Signature
over the raw body (optional timestamp for replay defense).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 4: JSON payload adapter (`jsonToInboundEmail`)

**Files:**
- Create: `src/exulu/email-inbound/adapters.ts`
- Create: `src/exulu/email-inbound/adapters.test.ts`

**Interfaces:**
- Consumes: `InboundEmail` (`./types`), `htmlToText`-style derivation (inline, mirroring `normalize.ts`).
- Produces: `jsonToInboundEmail(raw: unknown): InboundEmail` — throws `Error` with a `400`-friendly message on invalid input (missing/invalid `from`, bad base64).

- [ ] **Step 1: Write the failing test.** Create `src/exulu/email-inbound/adapters.test.ts`:

```ts
import { jsonToInboundEmail } from "./adapters";

describe("jsonToInboundEmail", () => {
  it("maps a full JSON payload including a base64 attachment", () => {
    const email = jsonToInboundEmail({
      from: { address: "service@kone.com", name: "KONE" },
      subject: "Ersatzteil",
      text: "body",
      message_id: "<abc@kone.com>",
      attachments: [
        { filename: "p.pdf", content_type: "application/pdf", content_base64: Buffer.from("hi").toString("base64") },
      ],
    });
    expect(email.from).toEqual({ address: "service@kone.com", name: "KONE" });
    expect(email.subject).toBe("Ersatzteil");
    expect(email.text).toBe("body");
    expect(email.messageId).toBe("<abc@kone.com>");
    expect(email.attachments[0].filename).toBe("p.pdf");
    expect(email.attachments[0].content.toString()).toBe("hi");
  });

  it("accepts a bare-string from and defaults subject/text to ''", () => {
    const email = jsonToInboundEmail({ from: "a@b.com" });
    expect(email.from).toEqual({ address: "a@b.com" });
    expect(email.subject).toBe("");
    expect(email.text).toBe("");
  });

  it("derives text from html when text is absent", () => {
    const email = jsonToInboundEmail({ from: "a@b.com", html: "<p>Hello <b>world</b></p>" });
    expect(email.text).toContain("Hello");
    expect(email.text).toContain("world");
    expect(email.html).toBe("<p>Hello <b>world</b></p>");
  });

  it("generates a message id when absent", () => {
    const email = jsonToInboundEmail({ from: "a@b.com" });
    expect(email.messageId).toMatch(/@webhook\.local>?$/);
  });

  it("throws on missing/invalid from", () => {
    expect(() => jsonToInboundEmail({})).toThrow(/from/i);
    expect(() => jsonToInboundEmail({ from: 123 })).toThrow(/from/i);
  });

  it("throws on malformed base64 attachment", () => {
    expect(() =>
      jsonToInboundEmail({ from: "a@b.com", attachments: [{ filename: "x", content_base64: "!!!not-base64!!!" }] }),
    ).toThrow(/base64|attachment/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/adapters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `adapters.ts`.**

```ts
// Content-type adapters that normalize non-MIME webhook payloads into the
// shared InboundEmail shape (spec §4.2). Raw MIME still goes through
// normalize.ts:parseRawMime; this module handles the documented JSON shape.
import { randomUUID } from "node:crypto";
import type { InboundEmail } from "./types";

const htmlToText = (html: string): string =>
  html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const parseFrom = (from: unknown): { address: string; name?: string } => {
  if (typeof from === "string" && from.includes("@")) return { address: from.trim() };
  if (from && typeof from === "object") {
    const address = (from as any).address;
    if (typeof address === "string" && address.includes("@")) {
      const name = (from as any).name;
      return typeof name === "string" && name ? { address: address.trim(), name } : { address: address.trim() };
    }
  }
  throw new Error("Invalid payload: `from` must be an email address or { address, name }.");
};

const decodeAttachment = (a: any): { filename: string; contentType: string; content: Buffer } => {
  const filename = typeof a?.filename === "string" && a.filename ? a.filename : "attachment";
  const contentType = typeof a?.content_type === "string" && a.content_type ? a.content_type : "application/octet-stream";
  const b64 = typeof a?.content_base64 === "string" ? a.content_base64 : "";
  // Node is lenient with base64; validate round-trip to reject junk.
  const content = Buffer.from(b64, "base64");
  if (b64 && content.toString("base64").replace(/=+$/, "") !== b64.replace(/\s|=+$/g, "")) {
    throw new Error(`Invalid attachment: "${filename}" content_base64 is not valid base64.`);
  }
  return { filename, contentType, content };
};

export function jsonToInboundEmail(raw: unknown): InboundEmail {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid payload: expected a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const from = parseFrom(obj.from);
  const subject = typeof obj.subject === "string" ? obj.subject : "";
  const html = typeof obj.html === "string" ? obj.html : undefined;
  const text = typeof obj.text === "string" && obj.text ? obj.text : html ? htmlToText(html) : "";
  const messageId = typeof obj.message_id === "string" && obj.message_id ? obj.message_id : `<${randomUUID()}@webhook.local>`;
  const attachments = Array.isArray(obj.attachments) ? obj.attachments.map(decodeAttachment) : [];
  const headers = new Map<string, string>([["message-id", messageId]]);
  return {
    messageId,
    from,
    recipient: "", // set by the intake to trigger:{id}; not a routing field here
    subject,
    text,
    ...(html ? { html } : {}),
    attachments,
    headers,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/exulu/email-inbound/adapters.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/adapters.ts src/exulu/email-inbound/adapters.test.ts && git commit -m "$(cat <<'EOF'
feat(webhook): JSON payload adapter into InboundEmail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 5: Content-type dispatch + multipart raw-MIME extraction

**Files:**
- Modify: `src/exulu/email-inbound/adapters.ts` (add `detectPayloadFormat` + `extractMultipartMimePart`)
- Modify: `src/exulu/email-inbound/adapters.test.ts` (add cases)

**Interfaces:**
- Produces:
  - `detectPayloadFormat(contentType: string): "eml" | "json" | "multipart"`
  - `extractMultipartMimePart(rawBody: Buffer, contentType: string): Promise<Buffer>` — returns the raw MIME bytes from the `body-mime` / `email` / `message` field; throws if none present.

- [ ] **Step 1: Write the failing test.** Append to `adapters.test.ts`:

```ts
import { detectPayloadFormat, extractMultipartMimePart } from "./adapters";

describe("detectPayloadFormat", () => {
  it("classifies content types", () => {
    expect(detectPayloadFormat("application/json")).toBe("json");
    expect(detectPayloadFormat("application/json; charset=utf-8")).toBe("json");
    expect(detectPayloadFormat("multipart/form-data; boundary=xyz")).toBe("multipart");
    expect(detectPayloadFormat("message/rfc822")).toBe("eml");
    expect(detectPayloadFormat("text/plain")).toBe("eml");
    expect(detectPayloadFormat("")).toBe("eml");
  });
});

describe("extractMultipartMimePart", () => {
  const build = (fieldName: string, value: string) => {
    const boundary = "----exulutest";
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${value}\r\n--${boundary}--\r\n`;
    return { buffer: Buffer.from(body, "latin1"), contentType: `multipart/form-data; boundary=${boundary}` };
  };
  it("pulls the raw MIME from a body-mime field", async () => {
    const { buffer, contentType } = build("body-mime", "Subject: hi\r\n\r\nbody");
    const mime = await extractMultipartMimePart(buffer, contentType);
    expect(mime.toString("latin1")).toContain("Subject: hi");
  });
  it("also accepts an `email` field name", async () => {
    const { buffer, contentType } = build("email", "Subject: x\r\n\r\ny");
    expect((await extractMultipartMimePart(buffer, contentType)).toString()).toContain("Subject: x");
  });
  it("throws when no known MIME field is present", async () => {
    const { buffer, contentType } = build("other", "z");
    await expect(extractMultipartMimePart(buffer, contentType)).rejects.toThrow(/body-mime|email|message/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/adapters.test.ts`
Expected: FAIL — `detectPayloadFormat`/`extractMultipartMimePart` undefined.

- [ ] **Step 3: Implement the dispatch + extraction.** Add to `adapters.ts` (import `busboy` and `Readable`):

```ts
import Busboy from "busboy";
import { Readable } from "node:stream";

export function detectPayloadFormat(contentType: string): "eml" | "json" | "multipart" {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("multipart/form-data")) return "multipart";
  if (ct.includes("application/json")) return "json";
  return "eml"; // message/rfc822, text/plain, empty → raw MIME
}

const MIME_FIELD_NAMES = new Set(["body-mime", "email", "message"]);

/** Extract the raw MIME bytes from a Mailgun-style multipart form. */
export function extractMultipartMimePart(rawBody: Buffer, contentType: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let found: Buffer | null = null;
    const bb = Busboy({ headers: { "content-type": contentType }, defParamCharset: "latin1" });
    bb.on("field", (name: string, value: string) => {
      if (found === null && MIME_FIELD_NAMES.has(name.toLowerCase())) {
        found = Buffer.from(value, "latin1"); // byte-fidelity for 8-bit MIME
      }
    });
    bb.on("close", () => {
      if (found) resolve(found);
      else reject(new Error("No raw MIME part found (expected a body-mime, email, or message field)."));
    });
    bb.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    Readable.from(rawBody).pipe(bb);
  });
}
```

Note: confirm the busboy import style matches `createEmailMultipartParser` in `routes.ts:203-277` (it uses the same library). If that file uses `import busboy from "busboy"` (lowercase default), match it exactly here.

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/exulu/email-inbound/adapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/adapters.ts src/exulu/email-inbound/adapters.test.ts && git commit -m "$(cat <<'EOF'
feat(webhook): content-type dispatch + multipart MIME extraction

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

## Group C — Backend: webhook handler, route, intake, worker

### Task 6: Rewrite the webhook handler (secret routing + HMAC + format detection)

**Files:**
- Modify: `src/exulu/email-inbound/webhook.ts` (replace the handler + deps)
- Modify: `src/exulu/email-inbound/webhook.test.ts` (rewrite for secret routing)

**Interfaces:**
- Consumes: `resolveTriggerBySecret` (Task 2), `verifyPayloadSignature` + `isReplay` (Task 3), `detectPayloadFormat` + `extractMultipartMimePart` (Task 5), `decrypt` (`@SRC/exulu/auth/credential-store`).
- Produces:
  - `RoutineWebhookDeps` interface
  - `createRoutineWebhookHandler(deps): (req, res) => Promise<void>`
  - `routineWebhookRateLimitExceeded(now?: number): boolean` (kept from the old module)

- [ ] **Step 1: Write the failing test.** Rewrite `src/exulu/email-inbound/webhook.test.ts` to cover the secret/format/HMAC paths. Replace its contents with:

```ts
import { createHmac } from "node:crypto";
import { createRoutineWebhookHandler, type RoutineWebhookDeps } from "./webhook";
import type { WorkflowTriggerRow } from "./types";

const trigger = (over: Partial<WorkflowTriggerRow> = {}): WorkflowTriggerRow => ({
  id: "trg-1", workflow: "wf-1", type: "email", enabled: true,
  secret: "s3cr3t", signing_secret: null, last_fired_at: null,
  config: {}, run_as_user: 1, run_as_role: null, ...over,
});

const makeRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
};

const makeReq = (over: any = {}) => ({
  params: { secret: "s3cr3t" },
  headers: { "content-type": "application/json" },
  body: Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8"),
  ...over,
});

const makeDeps = (over: Partial<RoutineWebhookDeps> = {}): RoutineWebhookDeps => ({
  licensedForQueues: () => true,
  getDb: async () => ({}),
  getRedis: async () => ({ set: async () => "OK" }),
  resolveTrigger: async () => trigger(),
  decryptSigningSecret: (v) => v,
  putRawPayload: jest.fn(async () => "inbound-webhook/x.json") as any,
  enqueueIntake: jest.fn(async () => undefined) as any,
  stampLastFiredAt: async () => undefined,
  rateLimitExceeded: () => false,
  ...over,
});

describe("createRoutineWebhookHandler", () => {
  it("404s on an unknown/disabled secret", async () => {
    const res = makeRes();
    await createRoutineWebhookHandler(makeDeps({ resolveTrigger: async () => undefined }))(makeReq() as any, res);
    expect(res.statusCode).toBe(404);
  });

  it("fires: persists + enqueues a json job and ACKs 200", async () => {
    const deps = makeDeps();
    const res = makeRes();
    await createRoutineWebhookHandler(deps)(makeReq() as any, res);
    expect(res.statusCode).toBe(200);
    expect((deps.enqueueIntake as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "trg-1", format: "json" }),
    );
  });

  it("401s when signing is enabled and the signature is missing", async () => {
    const res = makeRes();
    await createRoutineWebhookHandler(makeDeps({ resolveTrigger: async () => trigger({ signing_secret: "enc" }) }))(
      makeReq() as any, res,
    );
    expect(res.statusCode).toBe(401);
  });

  it("200s when signing is enabled and the signature is valid", async () => {
    const body = Buffer.from(JSON.stringify({ from: "a@b.com" }), "utf8");
    const sig = "sha256=" + createHmac("sha256", "plain").update(body).digest("hex");
    const res = makeRes();
    await createRoutineWebhookHandler(
      makeDeps({ resolveTrigger: async () => trigger({ signing_secret: "enc" }), decryptSigningSecret: () => "plain" }),
    )(makeReq({ body, headers: { "content-type": "application/json", "x-exulu-signature": sig } }) as any, res);
    expect(res.statusCode).toBe(200);
  });

  it("503s without the queues entitlement", async () => {
    const res = makeRes();
    await createRoutineWebhookHandler(makeDeps({ licensedForQueues: () => false }))(makeReq() as any, res);
    expect(res.statusCode).toBe(503);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/webhook.test.ts`
Expected: FAIL — `createRoutineWebhookHandler` not exported.

- [ ] **Step 3: Implement the new handler.** Replace the contents of `src/exulu/email-inbound/webhook.ts`:

```ts
// Public generic routine webhook (spec §4). Durability ordering: resolve
// trigger by secret → (optional) verify HMAC → detect format → persist raw
// payload to S3 → enqueue intake → ACK 200. Any failure before ACK returns
// 4xx/5xx so a retrying forwarder is safe (DB message_id dedup downstream).
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { WorkflowTriggerRow } from "./types";
import { detectPayloadFormat, extractMultipartMimePart } from "./adapters";
import { isReplay, verifyPayloadSignature } from "./verify-signature";

export const EMAIL_INBOUND_S3_PREFIX = "inbound-webhook/";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 300;
let rateWindowStart = 0;
let rateWindowCount = 0;
export const routineWebhookRateLimitExceeded = (now: number = Date.now()): boolean => {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount > RATE_MAX_REQUESTS;
};

export interface RoutineWebhookDeps {
  licensedForQueues: () => boolean;
  getDb: () => Promise<any>;
  getRedis: () => Promise<any>;
  resolveTrigger: (db: any, secret: string) => Promise<WorkflowTriggerRow | undefined>;
  decryptSigningSecret: (encrypted: string) => string;
  /** Persists the raw payload; returns the storage key for the intake job. */
  putRawPayload: (key: string, body: Buffer) => Promise<string>;
  enqueueIntake: (payload: { s3Key: string; triggerId: string; format: "eml" | "json" }) => Promise<void>;
  stampLastFiredAt: (db: any, triggerId: string) => Promise<void>;
  rateLimitExceeded?: () => boolean;
}

export const createRoutineWebhookHandler =
  (deps: RoutineWebhookDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const rateLimitExceeded = deps.rateLimitExceeded ?? routineWebhookRateLimitExceeded;
    if (rateLimitExceeded()) {
      res.status(429).json({ detail: "Too many requests." });
      return;
    }
    if (!deps.licensedForQueues()) {
      res.status(503).json({ detail: "Routine webhooks require the queues entitlement." });
      return;
    }

    const secret = String((req.params as any).secret ?? "");
    const db = await deps.getDb();
    const trigger = secret ? await deps.resolveTrigger(db, secret) : undefined;
    // 404 (not 401/403) on unknown/disabled: no enumeration oracle.
    if (!trigger || trigger.type !== "email" || !trigger.enabled) {
      console.warn("[EXULU-WEBHOOK] rejected (unknown/disabled secret).");
      res.status(404).json({ detail: "not found" });
      return;
    }

    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const contentType = String(req.headers["content-type"] ?? "");

    // Optional per-trigger HMAC (spec §4.4).
    if (trigger.signing_secret) {
      const signature = String(req.headers["x-exulu-signature"] ?? "");
      const timestamp = req.headers["x-exulu-timestamp"] ? String(req.headers["x-exulu-timestamp"]) : undefined;
      const secretPlain = deps.decryptSigningSecret(trigger.signing_secret);
      if (!verifyPayloadSignature(rawBody, signature, timestamp, secretPlain)) {
        console.warn("[EXULU-WEBHOOK] rejected (invalid signature).");
        res.status(401).json({ detail: "invalid signature" });
        return;
      }
      if (timestamp) {
        const redis = await deps.getRedis();
        if (await isReplay(redis, signature, timestamp)) {
          res.status(401).json({ detail: "replay rejected" });
          return;
        }
      }
    }

    // Detect format and reduce to raw bytes to persist (spec §4.2).
    const kind = detectPayloadFormat(contentType);
    let payloadBytes: Buffer;
    let format: "eml" | "json";
    try {
      if (kind === "multipart") {
        payloadBytes = await extractMultipartMimePart(rawBody, contentType);
        format = "eml";
      } else if (kind === "json") {
        if (!rawBody.length) throw new Error("Empty JSON body.");
        payloadBytes = rawBody;
        format = "json";
      } else {
        if (!rawBody.length) throw new Error("Empty payload.");
        payloadBytes = rawBody;
        format = "eml";
      }
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : "bad payload" });
      return;
    }

    void deps.stampLastFiredAt(db, trigger.id).catch((e: unknown) =>
      console.error("[EXULU-WEBHOOK] failed to stamp last_fired_at", e),
    );

    try {
      const ext = format === "json" ? "json" : "eml";
      const s3Key = await deps.putRawPayload(`${EMAIL_INBOUND_S3_PREFIX}${randomUUID()}.${ext}`, payloadBytes);
      await deps.enqueueIntake({ s3Key, triggerId: trigger.id, format });
    } catch (error) {
      console.error("[EXULU-WEBHOOK] persist/enqueue failed", error);
      res.status(500).json({ detail: "temporary failure, please retry" });
      return;
    }

    res.status(200).json({ ok: true });
  };
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npm test -- src/exulu/email-inbound/webhook.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/webhook.ts src/exulu/email-inbound/webhook.test.ts && git commit -m "$(cat <<'EOF'
feat(webhook): secret-routed generic handler with optional HMAC

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 7: Register the route + wire deps in `routes.ts`; remove the Mailgun route and config cache

**Files:**
- Modify: `src/exulu/routes.ts` (add raw-body middleware early; replace the `/webhooks/email/mime` block ~682-759 and imports ~99)

**Interfaces:**
- Consumes: `createRoutineWebhookHandler`, `routineWebhookRateLimitExceeded`, `EMAIL_INBOUND_S3_PREFIX` (Task 6); `resolveTriggerBySecret` (Task 2); `decrypt` (`@SRC/exulu/auth/credential-store`); `uploadFile` (`@SRC/uppy`); `ExuluQueues`, `global_queues`, `BullMqJobData` (existing).

- [ ] **Step 1: Mount an early raw-body capture for the webhook path.** In `src/exulu/routes.ts`, immediately BEFORE the global `app.use(express.json({...}))` at line ~304, add (so the raw bytes survive for HMAC — the global JSON parser would otherwise consume them):

```ts
  // Capture the raw body for the routine webhook before the global JSON/urlencoded
  // parsers consume it — the HMAC (spec §4.4) is computed over exact raw bytes.
  app.use("/webhooks/routine", express.raw({ type: () => true, limit: "30mb" }));
```

- [ ] **Step 2: Replace the imports.** At line ~99, change the import from `./email-inbound/webhook` to the new exports, remove `getEmailInboundConfig`/`getCachedEmailInboundConfig`/`verifyMailgun` usages, and add the resolver + crypto imports:

```ts
import { createRoutineWebhookHandler, EMAIL_INBOUND_S3_PREFIX, routineWebhookRateLimitExceeded } from "./email-inbound/webhook";
import { resolveTriggerBySecret } from "./email-inbound/intake";
import { decrypt } from "@SRC/exulu/auth/credential-store";
```

Remove the now-unused `import { getEmailInboundConfig } from "./email-inbound/config";` and the `createEmailMultipartParser` import if it is no longer referenced elsewhere. (Grep `createEmailMultipartParser` — if only the email route used it, delete the factory at lines 203-277 too.)

- [ ] **Step 3: Replace the webhook registration block.** Delete lines ~682-759 (the Mailgun comment, `EMAIL_MIME_MAX_BYTES`, the `getCachedEmailInboundConfig` cache, `emailMultipartParser`, `emailWebhookHandler`, and `app.post("/webhooks/email/mime", ...)`) and replace with:

```ts
  // Generic routine inbound webhook (spec §4). The secret in the path both
  // routes and authorizes; raw bytes were captured by the early express.raw
  // middleware. Durability ordering lives in createRoutineWebhookHandler.
  const routineWebhookHandler = createRoutineWebhookHandler({
    licensedForQueues: () => checkLicense()["queues"] === true,
    getDb: async () => (await postgresClient()).db,
    getRedis: async () => (await redisClient()).client,
    resolveTrigger: async (db, secret) => resolveTriggerBySecret(db, secret),
    decryptSigningSecret: (encrypted) => decrypt(encrypted),
    putRawPayload: async (key, body) => {
      const fullKey = await uploadFile(
        body, key, config, { contentType: "application/octet-stream" }, undefined, undefined, true,
      );
      return fullKey.slice(fullKey.indexOf("/") + 1);
    },
    enqueueIntake: async (payload) => {
      const queue = await ExuluQueues.register(global_queues.email_intake, { worker: 2, queue: 5 }, 5, 300).use();
      const jobData: BullMqJobData = {
        label: "Routine webhook intake",
        type: "email_intake",
        trigger: "api",
        timeoutInSeconds: 300,
        inputs: payload,
      };
      await queue.queue.add("email-intake", jobData, {
        jobId: randomUUID(),
        attempts: 3,
        removeOnComplete: 5000,
        removeOnFail: 10000,
        backoff: { type: "exponential", delay: 5000 },
      });
    },
    stampLastFiredAt: async (db, triggerId) =>
      db.from("workflow_triggers").where({ id: triggerId }).update({ last_fired_at: new Date().toISOString() }),
    rateLimitExceeded: routineWebhookRateLimitExceeded,
  });
  app.post("/webhooks/routine/:secret", routineWebhookHandler);
```

- [ ] **Step 4: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors in `routes.ts`. (Errors may remain in `intake.ts`/graphql resolvers until Tasks 8–12; those files are addressed next.)

- [ ] **Step 5: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/routes.ts && git commit -m "$(cat <<'EOF'
feat(webhook): register POST /webhooks/routine/:secret, drop Mailgun route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 8: Rewire intake entry (`handleEmailIntake`) + worker branch for `{s3Key, triggerId, format}`

**Files:**
- Modify: `src/exulu/email-inbound/intake.ts:294-385` (payload shape, format branch, trigger-by-id)
- Modify: `ee/workers.ts:1087-1106` (pass `triggerId` + `format`)
- Modify: `src/exulu/email-inbound/intake.test.ts` (payload shape + json path)

**Interfaces:**
- Consumes: `resolveTriggerById` (Task 2); `parseRawMime` (`./normalize`); `jsonToInboundEmail` (Task 4).
- Produces: `handleEmailIntake(payload: { s3Key: string; triggerId: string; format: "eml" | "json" }, deps): Promise<EmailIntakeOutcome>`.

- [ ] **Step 1: Update the intake tests.** In `src/exulu/email-inbound/intake.test.ts`, change the payload fixture (line ~130) from `{ s3Key, recipient }` to `{ s3Key: "inbound-webhook/raw-1.eml", triggerId: "trg-1", format: "eml" }`, and make the mocked trigger resolvable by id (the mock db `.where({ id })...first()` should return the trigger). Add one JSON-path case:

```ts
it("parses a JSON payload via the json format branch", async () => {
  getS3ObjectBytesSpy.mockResolvedValue(Buffer.from(JSON.stringify({ from: "a@b.com", subject: "hi", text: "yo" })));
  const outcome = await handleEmailIntake(
    { s3Key: "inbound-webhook/x.json", triggerId: "trg-1", format: "json" },
    deps,
  );
  expect(["fired", "filtered", "dropped"]).toContain(outcome.outcome);
});
```

(Keep the existing assertions on `deleteS3ObjectSpy` for fired/filtered/dropped paths; they are unchanged.)

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/intake.test.ts`
Expected: FAIL — payload/type mismatch and `format` unused.

- [ ] **Step 3: Rewrite the `handleEmailIntake` head.** In `intake.ts`, change the signature and the parse + trigger-resolution logic (lines ~294-342). Replace with:

```ts
export async function handleEmailIntake(
  payload: { s3Key: string; triggerId: string; format: "eml" | "json" },
  deps: IntakeDeps,
): Promise<EmailIntakeOutcome> {
  const { db } = await postgresClient();
  const { client: redis } = await redisClient();

  const raw = await getS3ObjectBytes(payload.s3Key, deps.config);

  // Trigger is resolved by id (the webhook already routed by secret).
  const trigger = await resolveTriggerById(db, payload.triggerId);

  let email: InboundEmail;
  try {
    email = payload.format === "json"
      ? jsonToInboundEmail(JSON.parse(raw.toString("utf8")))
      : await parseRawMime(raw);
  } catch (error) {
    // Unparseable payload (spec §9): failed row with a sanitized error; the
    // raw payload is RETAINED for debugging (see spec §9 orphan-cleanup note).
    if (!trigger) {
      console.warn(`[EXULU-WEBHOOK] dropping unparseable payload without a trigger (${payload.s3Key}).`);
      await deleteS3Object(payload.s3Key, deps.config);
      return { outcome: "dropped" };
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await db.from("job_results").insert({
      label: workflowRunLabel(trigger.workflow),
      state: "failed",
      type: "workflow",
      workflow: trigger.workflow,
      trigger: "email",
      trigger_metadata: JSON.stringify({ s3_key: payload.s3Key }),
      error: JSON.stringify({ message: `Payload parse failed: ${message}` }),
      result: null,
      metadata: {},
    });
    return { outcome: "failed" };
  }

  if (!trigger || trigger.type !== "email" || !trigger.enabled) {
    console.warn(`[EXULU-WEBHOOK] no enabled trigger ${payload.triggerId}; dropping.`);
    await deleteS3Object(payload.s3Key, deps.config);
    return { outcome: "dropped" };
  }

  // Stamp the trigger's own id as the "recipient" for the untrusted-data frame.
  email.recipient = `trigger:${trigger.id}`;
```

Leave the rest of the function (guard chain at ~344, filtered/fired branches, `fireRun`) unchanged — it already consumes `trigger`, `email`, and `payload.s3Key`.

- [ ] **Step 4: Add the imports** at the top of `intake.ts`: `import { jsonToInboundEmail } from "./adapters";` and ensure `resolveTriggerById` is defined in this module (Task 2). Remove any remaining `resolveTriggerByAddress` references.

- [ ] **Step 5: Update the worker branch.** In `ee/workers.ts`, replace the `email_intake` branch (lines ~1087-1106):

```ts
            if (data.type === "email_intake") {
              console.log("[EXULU] running a routine webhook intake job.", bullmqJob.name);
              if (!data.inputs?.s3Key || !data.inputs?.triggerId) {
                throw new Error(`Missing s3Key/triggerId for email intake job.`);
              }
              const result = await handleEmailIntake(
                {
                  s3Key: data.inputs.s3Key,
                  triggerId: data.inputs.triggerId,
                  format: data.inputs.format === "json" ? "json" : "eml",
                },
                { config, providers },
              );
              return { result, metadata: {} };
            }
```

- [ ] **Step 6: Run the tests to verify they pass.**

Run: `npm test -- src/exulu/email-inbound/intake.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors in `intake.ts` / `ee/workers.ts`.

- [ ] **Step 8: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/intake.ts src/exulu/email-inbound/intake.test.ts ee/workers.ts && git commit -m "$(cat <<'EOF'
feat(webhook): intake by triggerId + format branch (eml/json)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

## Group D — Backend: remove the platform config

### Task 9: Delete `email_inbound` platform config + its resolvers/SDL

**Files:**
- Delete: `src/exulu/email-inbound/config.ts`, `src/exulu/email-inbound/config.test.ts`
- Modify: `src/graphql/schemas/index.ts` (remove `EmailInboundConfig` type, `emailInboundConfig` query, `updateEmailInboundConfig` mutation + resolvers, and the imports at ~52)
- Modify: `src/exulu/email-inbound/resolver-helpers.ts` (remove `EmailInboundConfigShape`/`Payload`/`toEmailInboundConfigPayload`)

**Interfaces:**
- Produces: no `emailInboundConfig`/`updateEmailInboundConfig` in the schema.

- [ ] **Step 1: Grep for all references** so nothing dangles:

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
grep -rn "email-inbound/config\|EmailInboundConfig\|emailInboundConfig\|updateEmailInboundConfig\|bumpLastWebhookAt\|getEmailInboundConfig" src ee
```

- [ ] **Step 2: Delete the config module + test.**

```bash
git rm src/exulu/email-inbound/config.ts src/exulu/email-inbound/config.test.ts
```

- [ ] **Step 3: Remove SDL + resolvers.** In `src/graphql/schemas/index.ts`:
  - Delete the `type EmailInboundConfig { ... }` block (~lines 782-793).
  - Delete the `emailInboundConfig: EmailInboundConfig` query line (~810).
  - Delete the `updateEmailInboundConfig(...)` mutation line (~711).
  - Delete the `emailInboundConfig` resolver (~1305-1312) and the `updateEmailInboundConfig` resolver (~1314-1327).
  - Remove the import of `updateEmailInboundConfig` (~line 52) and any `getEmailInboundConfig`/`toEmailInboundConfigPayload` imports.

- [ ] **Step 4: Trim `resolver-helpers.ts`.** Remove `EmailInboundConfigShape`, `EmailInboundConfigPayload`, and `toEmailInboundConfigPayload` (lines ~7-39). Keep the trigger insert/retry helpers (they are re-worked in Task 10, not deleted).

- [ ] **Step 5: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no dangling references to the removed symbols. (Remaining errors should only concern the trigger resolver reshaping done in Tasks 10-12.)

- [ ] **Step 6: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add -A src/exulu/email-inbound src/graphql/schemas/index.ts && git commit -m "$(cat <<'EOF'
refactor(webhook): remove email_inbound platform config + resolvers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

## Group E — Backend: GraphQL API

### Task 10: `WorkflowTrigger` payload — `webhook_url` / `has_webhook` / `has_signing_secret` / `last_fired_at`; upsert generates `secret`

**Files:**
- Modify: `src/exulu/email-inbound/resolver-helpers.ts` (secret-based insert retry + `toWorkflowTriggerPayload`)
- Modify: `src/graphql/schemas/index.ts` (`WorkflowTrigger` SDL + `workflowTriggers`/`upsertWorkflowEmailTrigger` resolvers)
- Test: `src/exulu/email-inbound/resolver-helpers.test.ts`

**Interfaces:**
- Consumes: `generateTriggerSecret` (Task 2).
- Produces:
  - `toWorkflowTriggerPayload(row: WorkflowTriggerRow, opts: { canWrite: boolean; signingSecretOnce?: string | null }): WorkflowTriggerPayload`
  - `insertTriggerWithSecretRetry(insertFn, baseRow): Promise<any>` (replaces `insertTriggerWithRetry`/`generateTriggerAddress`)
  - SDL `type WorkflowTrigger { id, workflow, type, enabled, webhook_url, has_webhook, has_signing_secret, last_fired_at, config, run_as_user, createdAt, updatedAt, signing_secret_once }`

- [ ] **Step 1: Write the failing test.** In `resolver-helpers.test.ts`, replace address-generation cases with:

```ts
import { toWorkflowTriggerPayload } from "./resolver-helpers";
import type { WorkflowTriggerRow } from "./types";

const row: WorkflowTriggerRow = {
  id: "t1", workflow: "w1", type: "email", enabled: true,
  secret: "SECRET", signing_secret: "enc", last_fired_at: null,
  config: {}, run_as_user: 1, run_as_role: null,
};

describe("toWorkflowTriggerPayload", () => {
  it("exposes webhook_url to writers and hides it from readers", () => {
    process.env.BACKEND = "https://api.example.com";
    const writer = toWorkflowTriggerPayload(row, { canWrite: true });
    expect(writer.webhook_url).toBe("https://api.example.com/webhooks/routine/SECRET");
    expect(writer.has_webhook).toBe(true);
    expect(writer.has_signing_secret).toBe(true);
    const reader = toWorkflowTriggerPayload(row, { canWrite: false });
    expect(reader.webhook_url).toBeNull();
    expect(reader.has_webhook).toBe(true);
  });
  it("passes signing_secret_once only when provided", () => {
    expect(toWorkflowTriggerPayload(row, { canWrite: true }).signing_secret_once).toBeNull();
    expect(toWorkflowTriggerPayload(row, { canWrite: true, signingSecretOnce: "plain" }).signing_secret_once).toBe("plain");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- src/exulu/email-inbound/resolver-helpers.test.ts`
Expected: FAIL — `toWorkflowTriggerPayload` not exported.

- [ ] **Step 3: Implement the helpers.** In `resolver-helpers.ts`, replace the address helpers with:

```ts
import { generateTriggerSecret } from "./trigger-config";
import type { WorkflowTriggerRow } from "./types";

export interface WorkflowTriggerPayload {
  id: string;
  workflow: string;
  type: string;
  enabled: boolean;
  webhook_url: string | null;   // writers only
  has_webhook: boolean;
  has_signing_secret: boolean;
  last_fired_at: string | null;
  config: unknown;
  run_as_user: number | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
  signing_secret_once: string | null; // returned once on generation
}

export function toWorkflowTriggerPayload(
  row: WorkflowTriggerRow,
  opts: { canWrite: boolean; signingSecretOnce?: string | null },
): WorkflowTriggerPayload {
  const webhookUrl = `${process.env.BACKEND}/webhooks/routine/${row.secret}`;
  return {
    id: row.id,
    workflow: row.workflow,
    type: row.type,
    enabled: row.enabled,
    webhook_url: opts.canWrite ? webhookUrl : null,
    has_webhook: Boolean(row.secret),
    has_signing_secret: Boolean(row.signing_secret),
    last_fired_at: row.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    run_as_user: row.run_as_user,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    signing_secret_once: opts.signingSecretOnce ?? null,
  };
}

export interface InsertTriggerRow {
  workflow: string;
  type: string;
  enabled: boolean;
  secret: string;
  config: string;
  run_as_user: string;
  run_as_role: string | null;
  created_by: string;
}

/** Insert with a fresh secret, regenerating on a 23505 unique collision. */
export async function insertTriggerWithSecretRetry(
  insertFn: (row: InsertTriggerRow) => Promise<any>,
  baseRow: Omit<InsertTriggerRow, "secret">,
): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await insertFn({ ...baseRow, secret: generateTriggerSecret() });
    } catch (err: any) {
      if (err?.code === "23505") continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique trigger secret.");
}
```

- [ ] **Step 4: Update the SDL.** In `src/graphql/schemas/index.ts`, replace the `WorkflowTrigger` type (~773-782):

```graphql
type WorkflowTrigger {
  id: ID!
  workflow: ID!
  type: String!
  enabled: Boolean!
  webhook_url: String
  has_webhook: Boolean!
  has_signing_secret: Boolean!
  last_fired_at: Date
  config: JSON!
  run_as_user: Float
  createdAt: Date
  updatedAt: Date
  signing_secret_once: String
}
```

- [ ] **Step 5: Update the `workflowTriggers` + `upsertWorkflowEmailTrigger` resolvers.** In the `workflowTriggers` resolver (~1195-1211), after the read-access check, also compute write access and map rows:

```ts
    const canWrite = await checkRecordAccess(workflowTemplate, "write", user);
    const rows = await db.from("workflow_triggers").where({ workflow: args.workflow }).orderBy("createdAt", "asc");
    return rows.map((r: WorkflowTriggerRow) => toWorkflowTriggerPayload(r, { canWrite }));
```

In `upsertWorkflowEmailTrigger` (~1213-1282):
  - Delete the `getEmailInboundConfig` load + `inbound.enabled/inbound_domain` guard (lines ~1231-1236) — that config is gone.
  - The update branch's `return toWorkflowTriggerPayload(updated)` (line ~1257) becomes `return toWorkflowTriggerPayload(updated, { canWrite: true })`.
  - The create branch: replace `insertTriggerWithRetry(insertFn, baseRow, workflowTemplate.name, inbound.inbound_domain)` (lines ~1262-1281) with `insertTriggerWithSecretRetry(insertFn, baseRow)` (the `baseRow` keeps `workflow/type/enabled/config/run_as_user/run_as_role/created_by`; drop the `address`, `routineName`, `inbound_domain` args), and `return toWorkflowTriggerPayload(created, { canWrite: true })` (line ~1282).
  - `requireWorkflowsWriteRole(user)`, the `queues` license check, `loadWorkflowTemplateWithRBAC` + `checkRecordAccess('write')`, `validateEmailTriggerConfig(args.config)`, and the `run_as_user = user.id` / `run_as_role = user.role?.id ?? null` capture all remain unchanged.

- [ ] **Step 6: Run tests + typecheck.**

Run: `npm test -- src/exulu/email-inbound/resolver-helpers.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors in the resolver.

- [ ] **Step 7: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/exulu/email-inbound/resolver-helpers.ts src/exulu/email-inbound/resolver-helpers.test.ts src/graphql/schemas/index.ts && git commit -m "$(cat <<'EOF'
feat(webhook): WorkflowTrigger webhook_url payload + secret-retry insert

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 11: `regenerateWorkflowTriggerSecret` + `setWorkflowTriggerSigningSecret` mutations

**Files:**
- Modify: `src/graphql/schemas/index.ts` (SDL + two resolvers)

**Interfaces:**
- Consumes: `generateTriggerSecret`, `generateSigningSecret` (Task 2); `encrypt` (`@SRC/exulu/auth/credential-store`); `requireWorkflowsWriteRole`, `checkRecordAccess`; `toWorkflowTriggerPayload` (Task 10).
- Produces SDL:
  - `regenerateWorkflowTriggerSecret(id: ID!): WorkflowTrigger`
  - `setWorkflowTriggerSigningSecret(id: ID!, enable: Boolean!): WorkflowTrigger`

- [ ] **Step 1: Add the SDL mutations** near `deleteWorkflowTrigger` (~710):

```graphql
regenerateWorkflowTriggerSecret(id: ID!): WorkflowTrigger
setWorkflowTriggerSigningSecret(id: ID!, enable: Boolean!): WorkflowTrigger
```

- [ ] **Step 2: Implement `regenerateWorkflowTriggerSecret`.** Model access checks on `deleteWorkflowTrigger` (load trigger → load workflow_template → `requireWorkflowsWriteRole` + `checkRecordAccess('write')`), then:

```ts
  resolvers.Mutation["regenerateWorkflowTriggerSecret"] = async (_, args, context) => {
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const { db } = await postgresClient();
    const trigger = await db.from("workflow_triggers").where({ id: args.id }).first();
    if (!trigger) throw new Error("Trigger not found.");
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, trigger.workflow);
    if (!(await checkRecordAccess(workflowTemplate, "write", user))) throw new Error("Access denied.");

    let updated: any;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const rows = await db.from("workflow_triggers").where({ id: args.id })
          .update({ secret: generateTriggerSecret(), updatedAt: new Date().toISOString() }).returning("*");
        updated = rows[0];
        break;
      } catch (err: any) {
        if (err?.code === "23505") continue;
        throw err;
      }
    }
    if (!updated) throw new Error("Could not generate a unique trigger secret.");
    return toWorkflowTriggerPayload(updated, { canWrite: true });
  };
```

(`loadWorkflowTemplateWithRBAC(db, workflowId)` is the existing helper used at `index.ts:1225`; `checkRecordAccess` is imported at `index.ts:17`.)

- [ ] **Step 3: Implement `setWorkflowTriggerSigningSecret`.** Same access preamble, then:

```ts
  resolvers.Mutation["setWorkflowTriggerSigningSecret"] = async (_, args, context) => {
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const { db } = await postgresClient();
    const trigger = await db.from("workflow_triggers").where({ id: args.id }).first();
    if (!trigger) throw new Error("Trigger not found.");
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, trigger.workflow);
    if (!(await checkRecordAccess(workflowTemplate, "write", user))) throw new Error("Access denied.");

    let once: string | null = null;
    let signingSecret: string | null = null;
    if (args.enable) {
      once = generateSigningSecret();
      signingSecret = encrypt(once);
    }
    const rows = await db.from("workflow_triggers").where({ id: args.id })
      .update({ signing_secret: signingSecret, updatedAt: new Date().toISOString() }).returning("*");
    return toWorkflowTriggerPayload(rows[0], { canWrite: true, signingSecretOnce: once });
  };
```

- [ ] **Step 4: Add imports** at the top of `index.ts` for `generateTriggerSecret`, `generateSigningSecret` (from `@SRC/exulu/email-inbound/trigger-config`) and `encrypt` (from `@SRC/exulu/auth/credential-store`), if not already present.

- [ ] **Step 5: Typecheck + smoke.**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/graphql/schemas/index.ts && git commit -m "$(cat <<'EOF'
feat(webhook): regenerate-secret + set-signing-secret mutations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

### Task 12: `testFireWorkflowTrigger` mutation (in-process real send)

**Files:**
- Modify: `src/graphql/schemas/index.ts` (SDL type + mutation + resolver)

**Interfaces:**
- Consumes: `handleEmailIntake` (Task 8); `uploadFile` (`@SRC/uppy`); `EMAIL_INBOUND_S3_PREFIX` (Task 6); `checkRecordAccess`, `requireWorkflowsWriteRole`.
- Produces SDL:
  - `type TestFireResult { outcome: String!, jobResultId: ID, filteredReason: String, error: String }`
  - `testFireWorkflowTrigger(id: ID!, contentType: String!, payload: String!): TestFireResult`

- [ ] **Step 1: Add the SDL.** Add the result type near `WorkflowTrigger` and the mutation near the others:

```graphql
type TestFireResult {
  outcome: String!
  jobResultId: ID
  filteredReason: String
  error: String
}
```
```graphql
testFireWorkflowTrigger(id: ID!, contentType: String!, payload: String!): TestFireResult
```

- [ ] **Step 2: Implement the resolver.** It runs the real intake path in-process (bypassing the URL-secret lookup + HMAC — the caller is GraphQL-authenticated), so it exercises the full guard chain, rate limits, and dedup:

```ts
  resolvers.Mutation["testFireWorkflowTrigger"] = async (_, args, context) => {
    const user = context.user;
    requireWorkflowsWriteRole(user);
    const { db } = await postgresClient();
    const trigger = await db.from("workflow_triggers").where({ id: args.id }).first();
    if (!trigger) throw new Error("Trigger not found.");
    const workflowTemplate = await loadWorkflowTemplateWithRBAC(db, trigger.workflow);
    if (!(await checkRecordAccess(workflowTemplate, "write", user))) throw new Error("Access denied.");

    const kind = detectPayloadFormat(args.contentType);
    let bytes: Buffer;
    let format: "eml" | "json";
    try {
      if (kind === "multipart") {
        bytes = await extractMultipartMimePart(Buffer.from(args.payload, "latin1"), args.contentType);
        format = "eml";
      } else if (kind === "json") {
        JSON.parse(args.payload); // validate up front for a clean 400-style error
        bytes = Buffer.from(args.payload, "utf8");
        format = "json";
      } else {
        bytes = Buffer.from(args.payload, "latin1");
        format = "eml";
      }
    } catch (err) {
      return { outcome: "error", error: err instanceof Error ? err.message : "bad payload" };
    }

    const ext = format === "json" ? "json" : "eml";
    const fullKey = await uploadFile(
      bytes, `${EMAIL_INBOUND_S3_PREFIX}${randomUUID()}.${ext}`, config,
      { contentType: "application/octet-stream" }, undefined, undefined, true,
    );
    const s3Key = fullKey.slice(fullKey.indexOf("/") + 1);

    const outcome = await handleEmailIntake({ s3Key, triggerId: trigger.id, format }, { config, providers });
    if (outcome.outcome === "fired") return { outcome: "fired", jobResultId: outcome.jobResultId };
    if (outcome.outcome === "filtered") return { outcome: "filtered", filteredReason: outcome.reason };
    if (outcome.outcome === "failed") return { outcome: "error", error: "Payload failed to parse." };
    return { outcome: "dropped" };
  };
```

- [ ] **Step 3: Add imports** for `detectPayloadFormat`, `extractMultipartMimePart` (from `@SRC/exulu/email-inbound/adapters`), `handleEmailIntake`, `EMAIL_INBOUND_S3_PREFIX`, `uploadFile`, and confirm `config`/`providers`/`randomUUID` are in scope in this resolver factory (grep how `config` and `providers` reach the resolvers — pass them the same way the surrounding module does).

- [ ] **Step 4: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Full backend test run.**

Run: `npm test -- src/exulu/email-inbound`
Expected: all email-inbound suites PASS (adapters, verify-signature, webhook, intake, trigger-config, resolver-helpers).

- [ ] **Step 6: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add src/graphql/schemas/index.ts && git commit -m "$(cat <<'EOF'
feat(webhook): testFireWorkflowTrigger real-send mutation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

## Group F — Frontend (repo: exulu/frontend, branch main)

### Task 13: GraphQL documents — trigger selection + new mutations; delete `lib/email-inbound`

**Files:**
- Modify: `app/(application)/workflows/queries.ts:230-275`
- Delete: `lib/email-inbound/queries.ts` (after Task 14 removes its consumer — sequence: do Step 1-2 here, but only delete the file once triggers.tsx no longer imports it; the `git rm` is in Task 15)

**Interfaces:**
- Produces gql docs: `GET_WORKFLOW_TRIGGERS`, `UPSERT_WORKFLOW_EMAIL_TRIGGER`, `DELETE_WORKFLOW_TRIGGER`, `REGENERATE_WORKFLOW_TRIGGER_SECRET`, `SET_WORKFLOW_TRIGGER_SIGNING_SECRET`, `TEST_FIRE_WORKFLOW_TRIGGER` with a `WORKFLOW_TRIGGER_SELECTION` fragment exposing `webhook_url has_webhook has_signing_secret last_fired_at`.

- [ ] **Step 1: Update the selection fragment.** In `app/(application)/workflows/queries.ts`, change `WORKFLOW_TRIGGER_SELECTION` (~233-243) from `address` to the new fields:

```ts
const WORKFLOW_TRIGGER_SELECTION = `
  id
  workflow
  type
  enabled
  webhook_url
  has_webhook
  has_signing_secret
  last_fired_at
  config
  run_as_user
  createdAt
  updatedAt
`;
```

- [ ] **Step 2: Add the new mutations** after `DELETE_WORKFLOW_TRIGGER` (~275):

```ts
export const REGENERATE_WORKFLOW_TRIGGER_SECRET = gql`
  mutation RegenerateWorkflowTriggerSecret($id: ID!) {
    regenerateWorkflowTriggerSecret(id: $id) { ${WORKFLOW_TRIGGER_SELECTION} }
  }
`;

export const SET_WORKFLOW_TRIGGER_SIGNING_SECRET = gql`
  mutation SetWorkflowTriggerSigningSecret($id: ID!, $enable: Boolean!) {
    setWorkflowTriggerSigningSecret(id: $id, enable: $enable) {
      ${WORKFLOW_TRIGGER_SELECTION}
      signing_secret_once
    }
  }
`;

export const TEST_FIRE_WORKFLOW_TRIGGER = gql`
  mutation TestFireWorkflowTrigger($id: ID!, $contentType: String!, $payload: String!) {
    testFireWorkflowTrigger(id: $id, contentType: $contentType, payload: $payload) {
      outcome
      jobResultId
      filteredReason
      error
    }
  }
`;
```

- [ ] **Step 3: Typecheck.**

Run: `npx tsc --noEmit` (frontend root)
Expected: errors only in `triggers.tsx` (still references `address`/`emailInboundConfig`) — fixed in Task 14.

- [ ] **Step 4: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
test "$(git rev-parse --abbrev-ref HEAD)" = "main" && git add app/\(application\)/workflows/queries.ts && git commit -m "$(cat <<'EOF'
feat(webhook): trigger gql docs — webhook_url + regenerate/signing/test-fire

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON main — aborted"
```

---

### Task 14: Rework `triggers.tsx` — webhook URL + regenerate, signing subsection, test panel; drop `emailInboundConfig`

**Files:**
- Modify: `app/(application)/workflows/[id]/sections/triggers.tsx`

**Interfaces:**
- Consumes: gql docs (Task 13); primitives `CopyField`, `DetailSection`, `ConfirmDialog`, `Switch`, `Badge`, `toast`; helpers from `./trigger-config`.

- [ ] **Step 1: Remove the `emailInboundConfig` dependency + empty state.** Delete the `EMAIL_INBOUND_CONFIG` import (from `@/lib/email-inbound/queries`), its `useQuery` (~75-87), the `knownNotConfigured` guard (~92-95), and the `EmptyState`/CTA-to-`/configuration/email` block (~110-124). The section renders unconditionally (routine write access still gates editing via `access.canWrite`).

- [ ] **Step 2: Replace the address display with the webhook URL + Regenerate.** Where `CopyField` showed the address (~255-261), render `trigger?.webhook_url` for writers and a muted "URL hidden — read-only access" otherwise, plus a Regenerate button wired to `REGENERATE_WORKFLOW_TRIGGER_SECRET` behind a `ConfirmDialog` ("The old URL will stop working immediately."). On success, `toast.success` and refetch. Example region:

```tsx
{trigger?.webhook_url ? (
  <div className="space-y-2">
    <CopyField label={t("webhookUrlLabel")} value={trigger.webhook_url} mono />
    <Button variant="outline" size="sm" disabled={!access.canWrite} onClick={() => setConfirmRegen(true)}>
      {t("regenerate")}
    </Button>
  </div>
) : trigger ? (
  <p className="text-sm text-muted-foreground">{t("webhookUrlHidden")}</p>
) : (
  <p className="text-sm text-muted-foreground">{t("webhookUrlPending")}</p>
)}
```

Add the `ConfirmDialog` for regenerate mirroring the existing delete dialog (~496).

- [ ] **Step 3: Add the "Require signed payloads" subsection.** After the rate-limit grid (~420-464), add a block: when `trigger?.has_signing_secret` show a "Signing enabled" indicator + a **Remove** button (`SET_WORKFLOW_TRIGGER_SIGNING_SECRET` with `enable:false`); otherwise a **Generate signing secret** button (`enable:true`). On generation, read `data.setWorkflowTriggerSigningSecret.signing_secret_once` and reveal it in a one-time `CopyField` with a "store it now — it won't be shown again" note. Also render a static signature-scheme snippet:

```tsx
<CopyField label={t("signing.schemeLabel")} value={`X-Exulu-Signature: sha256=HMAC-SHA256(body, secret)`} mono />
```

- [ ] **Step 4: Add the Test panel.** After the signing subsection, add a content-type `Select` (options: `application/json`, `message/rfc822`), a payload `<textarea>` pre-filled per selection (JSON sample `{"from":"a@b.com","subject":"Test","text":"hello"}`; a small raw-MIME sample), a **Send test** button wired to `TEST_FIRE_WORKFLOW_TRIGGER`, and an inline result card reading `outcome`:
  - `fired` → "Fired — run started" + a link to the run if `jobResultId` (link target: the runs section / `/runs` if available, else show the id).
  - `filtered` → "Filtered: {filteredReason}".
  - `error`/`dropped` → the `error` text or "Dropped".
  Include the note: `t("test.realSendNote")`. Disable when `!access.canWrite` or no `trigger?.id` (must save the trigger first).

- [ ] **Step 5: Show `last_fired_at`.** Near the webhook URL, render `t("lastFiredLabel")` + a relative timestamp when `trigger?.last_fired_at`, else `t("lastFiredNever")`.

- [ ] **Step 6: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors in `triggers.tsx`. (`lib/email-inbound` import is gone.)

- [ ] **Step 7: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
test "$(git rev-parse --abbrev-ref HEAD)" = "main" && git add app/\(application\)/workflows/\[id\]/sections/triggers.tsx && git commit -m "$(cat <<'EOF'
feat(webhook): triggers UI — webhook URL, regenerate, signing, test panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON main — aborted"
```

---

### Task 15: Delete the admin email-intake surface + `lib/email-inbound`

**Files:**
- Delete: `app/(application)/configuration/components/email-intake-view.tsx`
- Delete: `app/(application)/configuration/email/page.tsx`
- Delete: `lib/email-inbound/queries.ts` (+ the `lib/email-inbound` dir if empty)
- Modify: `app/(application)/configuration/layout.tsx` and any nav config that links `/configuration/email`

**Interfaces:** none (pure removal).

- [ ] **Step 1: Grep for references** to ensure nothing else imports these:

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
grep -rn "email-intake-view\|configuration/email\|lib/email-inbound\|EMAIL_INBOUND_CONFIG\|UPDATE_EMAIL_INBOUND_CONFIG" app lib components
```

- [ ] **Step 2: Delete the files.**

```bash
git rm "app/(application)/configuration/components/email-intake-view.tsx" "app/(application)/configuration/email/page.tsx" "lib/email-inbound/queries.ts"
```

- [ ] **Step 3: Remove the nav entry.** Find where `/configuration/email` is linked (grep from Step 1 — likely a settings nav array) and delete that item. Leave `configuration/layout.tsx`'s `guardRoute("configuration")` intact (other configuration segments still use it).

- [ ] **Step 4: Typecheck + build.**

Run: `npx tsc --noEmit`
Expected: no dangling references.

- [ ] **Step 5: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
test "$(git rev-parse --abbrev-ref HEAD)" = "main" && git add -A app lib && git commit -m "$(cat <<'EOF'
refactor(webhook): remove Mailgun admin email-intake surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON main — aborted"
```

---

### Task 16: i18n — remove `configuration.emailIntake`, update `routines.triggers`

**Files:**
- Modify: `messages/en.json`, `messages/de.json`

**Interfaces:** none.

- [ ] **Step 1: Remove the `configuration.emailIntake` block** (en.json ~2100-2203; the matching de.json range) entirely.

- [ ] **Step 2: Update `routines.triggers`** (en.json ~3870-3937; de.json equivalent). Remove `addressLabel`/`addressPending` and the `notConfigured.*` keys. Add:

```json
"webhookUrlLabel": "Webhook URL",
"webhookUrlHidden": "URL hidden — you have read-only access.",
"webhookUrlPending": "Save the trigger once to generate its webhook URL.",
"regenerate": "Regenerate URL",
"regenerateConfirm": { "title": "Regenerate webhook URL?", "description": "The old URL stops working immediately. Update your forwarder afterwards.", "confirmLabel": "Regenerate" },
"lastFiredLabel": "Last received:",
"lastFiredNever": "never — send a test payload or wire up your forwarder.",
"signing": {
  "title": "Require signed payloads",
  "enabledLabel": "Signing enabled",
  "generate": "Generate signing secret",
  "remove": "Remove signing secret",
  "revealNote": "Store this secret now — it will not be shown again.",
  "schemeLabel": "Signature header"
},
"test": {
  "title": "Send a test payload",
  "contentType": "Content type",
  "payload": "Payload",
  "send": "Send test",
  "realSendNote": "This starts a real run and counts against this trigger's rate limits.",
  "fired": "Fired — run started.",
  "filtered": "Filtered: {reason}",
  "dropped": "Dropped (no run created).",
  "error": "Error: {message}"
}
```

Provide the German equivalents in `de.json` (translate each string; keep the same keys and the `{reason}`/`{message}` placeholders).

- [ ] **Step 3: Validate JSON.**

Run: `node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));JSON.parse(require('fs').readFileSync('messages/de.json','utf8'));console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend
test "$(git rev-parse --abbrev-ref HEAD)" = "main" && git add messages/en.json messages/de.json && git commit -m "$(cat <<'EOF'
i18n(webhook): provider-neutral trigger strings; drop emailIntake block

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON main — aborted"
```

---

## Group G — Docs

### Task 17: De-Mailgun the self-hosting docs

**Files:**
- Modify: `mintlify-docs/self-hosting/architecture.mdx` and the webhooks/self-hosting page(s) referencing Mailgun inbound email (grep below)

**Interfaces:** none.

- [ ] **Step 1: Find the Mailgun inbound references.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
grep -rln -i "mailgun\|email/mime\|inbound_domain\|body-mime" mintlify-docs
```

- [ ] **Step 2: Replace the inbound-email description** with the generic contract: routines expose a per-trigger secret URL `POST {BACKEND}/webhooks/routine/{secret}`; clients forward inbound mail there in any of raw RFC822 MIME, Mailgun-style multipart (`body-mime`/`email`/`message` field), or the documented JSON shape; optional per-trigger HMAC via `X-Exulu-Signature`. Remove the "clients must use Mailgun EU / set up MX + retention" framing and the platform `email_inbound` config mention. Keep it short; do not invent config keys that no longer exist.

- [ ] **Step 3: Commit.**

```bash
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend
test "$(git rev-parse --abbrev-ref HEAD)" = "develop" && git add mintlify-docs && git commit -m "$(cat <<'EOF'
docs(webhook): provider-neutral inbound webhook (drop Mailgun framing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)" || echo "NOT ON develop — aborted"
```

---

## Final verification

- [ ] **Backend:** `npm test -- src/exulu/email-inbound` (all suites PASS) and `npx tsc --noEmit` (clean).
- [ ] **Frontend:** `npm test` (vitest, `trigger-config.test.ts` PASS) and `npx tsc --noEmit` (clean).
- [ ] **Manual E2E (per project dev loop):** rebuild backend dist + restart; create a routine trigger in the UI, copy its webhook URL, `curl -X POST -H 'content-type: application/json' -d '{"from":"a@b.com","subject":"t","text":"hi"}' <url>` → 200 + a run appears; enable signing, re-`curl` unsigned → 401, signed → 200; use the UI Test panel → run appears; hit a bad secret → 404.

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §3.1 schema (secret/signing_secret/last_fired_at, drop address) | 1 |
| §3.2 remove platform config | 1, 9 |
| §4.1 endpoint + durability ordering + 404 | 6, 7 |
| §4.2 three content-type adapters + JSON shape | 4, 5, 6, 8 |
| §4.3 worker & intake (triggerId/format) | 8 |
| §4.4 optional HMAC + replay | 3, 6 |
| §5 API (webhook_url/has_webhook, regenerate, signing, test-fire, remove config) | 9, 10, 11, 12 |
| §6 frontend (URL+regenerate, signing, test panel, removals) | 13, 14, 15 |
| §6.3/§6.4 i18n + docs | 16, 17 |
| §7 security (404, capability URL, HMAC, guard chain) | 3, 6, 8 |
| §8 testing & rollout | all TDD steps + Final verification |
| §9 roadmap (failed-parse S3 orphan cleanup) | intentionally NOT implemented (noted in intake.ts Task 8 comment) |
