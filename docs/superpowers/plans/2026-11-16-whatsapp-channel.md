# WhatsApp Channel (backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin attach a WhatsApp number to a guest-published agent, and let a customer who has linked their number to their account chat with that agent over WhatsApp.

**Architecture:** A new `src/exulu/channels/` module. Pure rules (config, fixed replies, link codes, the inbound decision) are separate files with injected dependencies; one file wraps the Chat SDK and is the only place that imports it. The server's webhook hands the request to the SDK, whose handler runs the decision and either sends a fixed reply or enqueues a `channel_message` job; the worker runs the agent as the linked user through `generateSync` and posts the answer.

**Tech Stack:** TypeScript, Express 5, knex/Postgres, node-redis 4, BullMQ, `chat@4.45.0`, `@chat-adapter/whatsapp@4.45.0`, `@chat-adapter/state-pg@4.45.0`, jest.

**Spec:** `docs/superpowers/specs/2026-11-16-whatsapp-channel-design.md` — read it first. The frontend (editor section, link page) gets its own plan in `exulu/frontend`; Task 10 here defines the API it consumes.

**Resolved from spec §11** (checked against the published 4.45.0 packages):
- Posting outside a webhook handler works: `chat.thread(threadId)` exists and `WhatsAppAdapter.postMessage(threadId, { markdown })`, `startTyping(threadId)` and `markAsRead(threadId, messageId)` are public.
- `createPostgresState({ client: pg.Pool, keyPrefix, autoCreateSchema })`: the SDK needs a state store (webhook deduplication, identity aliases). It would create its five `chat_state_*` tables itself on connect; at runtime we pass `autoCreateSchema: false`, and `init-exulu-db.ts` (`npm run utils:initdb`) lets the adapter create them once with the flag on. Tables appear only during initdb, and the DDL stays the package's own. With the flag off the adapter only verifies the tables on connect and fails with a clear message if they are missing.
- Guest turn without a browser request: pass `req: { headers: { "x-public-surface": "1" } }`; `treatAsGuest` and `isPublicSurface` only read `req.headers`.
- "Active user" stays open: `users.status` is free text with no value compared anywhere in `src/`. Task 6 isolates the rule in one function.

## Global Constraints

- `chat` and its adapters publish ESM only (`exports` has an `import` condition and no `require`). At runtime that is harmless: consumers load our ESM build, and Node 22.18 can `require()` ESM anyway. It matters for jest, which runs our sources as CommonJS and cannot load the packages. So they are imported in exactly one file, `channels/chat-instance.ts`, through `await import(...)`. Every other file and every test depends on the interfaces in `channels/types.ts`, never on the SDK.
- Pin the three SDK packages to exactly `4.45.0` (no caret); they are versioned together.
- Secrets (`accessToken`, `appSecret`) are stored only inside the `secrets` column, encrypted with `encrypt`/`decrypt` from `src/exulu/auth/credential-store.ts`. No API response, log line or error message contains them or `verify_token` after creation.
- `channel_links.identity` is opaque: never parsed, never assumed to be a phone number. Displayed only through `maskIdentity`.
- No fixed reply is produced by a model. No model call happens for a sender without a valid link.
- Defaults: `linkTtlDays` 7 (allowed 1–365), `sessionIdleHours` 8 (allowed 1–168), `locale` `"de"`.
- Link code: 8 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, displayed `XXXX-XXXX`, Redis TTL 600 s, single use.
- Limits: `linkRequired` reply at most once per identity per 600 s; 5 failed codes per identity per 3600 s.
- A channel can be enabled only while `agent.guest_access === true` and `agent.guest_auth_mode === "regular"`.
- Entitlements `channels` and `queues` are both required for the webhook and for enabling.
- Commit messages follow commitlint (header ≤ 100 chars, e.g. `feat(channels): ...`). Tests: `npx jest <path>`. Types: `npx tsc --noEmit -p tsconfig.json`.
- JSON columns may come back as strings; read `config` through a `parseMaybeJson`-style parse.

## Review Focus

1. Meta redelivers a message after a slow acknowledgement → exactly one run. (Task 8: job id is the WhatsApp message id; Task 7 test.)
2. A code inside a sentence ("mein Code ist ABCD-EFGH") → not treated as a code; only a whole-message match is. A valid code typed lowercase or with spaces is accepted. (Task 4, Task 6.)
3. Redis unavailable (`redisClient()` returns `{ client: null }`) → webhook answers 503 and nothing is processed; never falls through to "treat as linked". (Task 9.)
4. Secrets cannot be decrypted (rotated `NEXTAUTH_SECRET`) or are missing → webhook 503 with a logged reason, channel reported as `needsCredentials`; no crash on boot. (Tasks 2, 8, 9.)
5. The model returns an empty answer → `runFailed` is posted, not an empty WhatsApp message. (Task 7.)

---

### Task 1: Dependencies, entitlement, tables

**Files:**
- Modify: `package.json`, `ee/entitlements.ts`, `ee/schemas.ts`, `types/exulu-table-definition.ts`, `src/postgres/init-exulu-db.ts`, `ee/queues/queues.ts`
- Test: `src/exulu/channels/schema.test.ts`

**Interfaces — Produces:**
- Entitlement key `"channels"` in `ENTITLEMENTS` (false) and in the licensed object (true).
- `agentChannelsSchema`, `channelLinksSchema` exported from `ee/schemas.ts`, both `RBAC: false, graphql: false` (same treatment as `workflowTriggersSchema`).
- `global_queues.channel_inbound = "channel_inbound"`.

Table fields, exactly:

`agent_channels`: `agent` uuid required index; `type` text required; `enabled` boolean default false; `config` json; `secrets` text hidden; `verify_token` text hidden. Unique on (`agent`, `type`).

`channel_links`: `channel` uuid required index; `identity` text required; `user` number required index; `linked_at` date; `expires_at` date; `revoked_at` date; `last_seen_at` date. Unique on (`channel`, `identity`).

- [ ] **Step 1: Write the failing test**

```ts
import { agentChannelsSchema, channelLinksSchema } from "@EE/schemas";
import { checkLicense, ENTITLEMENTS } from "@EE/entitlements";

it("keeps both tables away from auto-CRUD", () => {
  expect(agentChannelsSchema.graphql).toBe(false);
  expect(channelLinksSchema.graphql).toBe(false);
});
it("marks secrets and verify_token as hidden", () => {
  const hidden = agentChannelsSchema.fields.filter((f) => f.hidden).map((f) => f.name);
  expect(hidden.sort()).toEqual(["secrets", "verify_token"]);
});
it("declares the channels entitlement, off by default", () => {
  expect(ENTITLEMENTS.channels).toBe(false);
  process.env.EXULU_ENTERPRISE_LICENSE = "EXULU_EE_x";
  expect(checkLicense().channels).toBe(true);
});
```

- [ ] **Step 2: Run** `npx jest src/exulu/channels/schema.test.ts` — expected: FAIL, exports missing.
- [ ] **Step 3: Implement.** `npm install --save-exact chat@4.45.0 @chat-adapter/whatsapp@4.45.0 @chat-adapter/state-pg@4.45.0`. Add the two schemas next to `workflowTriggersSchema`, register them where `init-exulu-db.ts` registers `workflow_triggers`, add the composite unique indexes there, extend the `type` union, add the entitlement and the queue name. Also in `init-exulu-db.ts`: call `ensureChatStateTables(pool)` from a new file `src/exulu/channels/state-tables.ts`. It does `const { createPostgresState } = await import("@chat-adapter/state-pg")`, builds a state with `{ client: pool, keyPrefix: "exulu-channel", autoCreateSchema: true }`, calls `connect()` and then `disconnect()`. The adapter's own DDL creates the five `chat_state_*` tables, so nothing is copied and a later SDK version brings its own schema; it only ever runs inside `utils:initdb`. The function takes the loader as an optional second argument so the test can pass a stub: test asserts `autoCreateSchema: true`, the prefix, and that `connect` then `disconnect` were called.
- [ ] **Step 4: Run** the test and `npx tsc --noEmit -p tsconfig.json` — expected: PASS, no new type errors.
- [ ] **Step 5: Commit** `feat(channels): tables, entitlement and SDK dependencies`

---

### Task 2: Config rules — `config.ts`

**Files:**
- Create: `src/exulu/channels/types.ts`, `src/exulu/channels/config.ts`
- Test: `src/exulu/channels/config.test.ts`

**Interfaces — Produces:**

```ts
// types.ts
export type ChannelType = "whatsapp";
export type ChannelLocale = "de" | "en";
export interface WhatsAppChannelConfig {
  phoneNumberId: string; displayNumber: string;
  linkTtlDays: number; sessionIdleHours: number;
  locale: ChannelLocale; texts: Partial<Record<ReplyKey, string>>;
}
export interface ChannelSecrets { accessToken: string; appSecret: string }
export interface AgentChannelRow {
  id: string; agent: string; type: ChannelType; enabled: boolean;
  config: unknown; secrets: string | null; verify_token: string | null; updatedAt: string | Date;
}
export interface ChannelView {            // the ONLY projection any API may return
  id: string; agent: string; type: ChannelType; enabled: boolean;
  config: WhatsAppChannelConfig; hasSecrets: boolean; needsCredentials: boolean;
}

// config.ts
export const parseChannelConfig: (raw: unknown) => WhatsAppChannelConfig;          // applies defaults, throws ChannelConfigError on invalid
export const readSecrets: (row: AgentChannelRow) => ChannelSecrets | null;         // null when missing or undecryptable, never throws
export const sealSecrets: (s: ChannelSecrets) => string;
export const canEnableChannel: (agent: { guest_access?: boolean | null; guest_auth_mode?: string | null }) => { ok: true } | { ok: false; reason: "guest_access_off" | "guest_mode_not_regular" };
export const channelView: (row: AgentChannelRow) => ChannelView;
export const maskIdentity: (identity: string) => string;                            // "+49 •••• 1234" style: last 4 visible, rest masked
export class ChannelConfigError extends Error { field: string }
```

- [ ] **Step 1: Write the failing tests**

```ts
it("applies the defaults", () => {
  expect(parseChannelConfig({ phoneNumberId: "1", displayNumber: "+49 30 1" }))
    .toMatchObject({ linkTtlDays: 7, sessionIdleHours: 8, locale: "de", texts: {} });
});
it("accepts a JSON string", () => {
  expect(parseChannelConfig('{"phoneNumberId":"1","displayNumber":"+1"}').linkTtlDays).toBe(7);
});
it.each([[0], [366], [1.5], ["7"]])("rejects linkTtlDays %p", (v) => {
  expect(() => parseChannelConfig({ phoneNumberId: "1", displayNumber: "+1", linkTtlDays: v }))
    .toThrow(ChannelConfigError);
});
it("rejects a missing phoneNumberId, an unknown locale, and an unknown text key", () => { /* three throws */ });
it("readSecrets returns null for garbage instead of throwing", () => {
  expect(readSecrets({ ...row, secrets: "not-encrypted" })).toBeNull();
  expect(readSecrets({ ...row, secrets: null })).toBeNull();
});
it("seal/read round-trips", () => {
  expect(readSecrets({ ...row, secrets: sealSecrets({ accessToken: "a", appSecret: "b" }) }))
    .toEqual({ accessToken: "a", appSecret: "b" });
});
it("channelView never carries secrets or the verify token", () => {
  const json = JSON.stringify(channelView({ ...row, secrets: sealSecrets({ accessToken: "TOKEN", appSecret: "SECRET" }), verify_token: "VT" }));
  expect(json).not.toMatch(/TOKEN|SECRET|VT/);
});
it("needsCredentials when secrets are missing or unreadable", () => { /* both cases true, sealed case false */ });
it("canEnableChannel only for guest access in regular mode", () => {
  expect(canEnableChannel({ guest_access: true, guest_auth_mode: "regular" })).toEqual({ ok: true });
  expect(canEnableChannel({ guest_access: false, guest_auth_mode: "regular" })).toEqual({ ok: false, reason: "guest_access_off" });
  expect(canEnableChannel({ guest_access: true, guest_auth_mode: "public" })).toEqual({ ok: false, reason: "guest_mode_not_regular" });
  expect(canEnableChannel({ guest_access: true, guest_auth_mode: null })).toEqual({ ok: true }); // null means regular, as in publicAgentView
});
it("maskIdentity shows only the last four characters", () => {
  expect(maskIdentity("4915112345678")).toMatch(/5678$/);
  expect(maskIdentity("4915112345678")).not.toContain("49151");
  expect(maskIdentity("ab")).not.toContain("ab"); // shorter than 4: fully masked
});
```

- [ ] **Step 2: Run** `npx jest src/exulu/channels/config.test.ts` — FAIL.
- [ ] **Step 3: Implement** both files. `ReplyKey` comes from Task 3; declare it in `types.ts` now.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): config rules and the safe channel view`

---

### Task 3: Fixed replies — `texts.ts`

**Files:**
- Create: `src/exulu/channels/texts.ts`
- Test: `src/exulu/channels/texts.test.ts`

**Interfaces — Produces:**

```ts
export type ReplyKey = "linkRequired" | "linked" | "codeInvalid" | "textOnly" | "rateLimited"
  | "stillWorking" | "runFailed" | "newSession" | "unlinked";
export const replyText: (key: ReplyKey, config: WhatsAppChannelConfig, vars?: { linkUrl?: string; expiresAt?: Date }) => string;
```

Placeholders in texts and overrides: `{linkUrl}`, `{expiresAt}` (formatted `dd.MM.yyyy` for `de`, `yyyy-MM-dd` for `en`). An unknown placeholder is left as typed.

- [ ] **Step 1: Write the failing tests**: every key has a non-empty `de` and `en` default; `linkRequired` contains the passed `linkUrl`; `linked` contains the formatted expiry; an override in `config.texts` wins and still gets placeholders substituted; an empty-string override falls back to the default.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** German defaults address the user with "du", matching the guest UI. Keep each under 400 characters.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): fixed replies in German and English`

---

### Task 4: Link codes — `link-codes.ts`

**Files:**
- Create: `src/exulu/channels/link-codes.ts`
- Test: `src/exulu/channels/link-codes.test.ts`

**Interfaces — Produces:**

```ts
export interface KeyValueStore {                     // the slice of node-redis this module needs
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}
export const CODE_TTL_SECONDS = 600;
export const generateCode: () => string;                                  // "XXXX-XXXX", crypto.randomInt
export const normalizeCode: (text: string) => string | null;              // whole-message match only; null otherwise
export const issueCode: (kv: KeyValueStore, p: { channelId: string; userId: number }) => Promise<string>;
export const consumeCode: (kv: KeyValueStore, code: string) => Promise<{ channelId: string; userId: number } | null>;
export const codeAttemptsExceeded: (kv: KeyValueStore, channelId: string, identity: string) => Promise<boolean>; // counts this attempt; true from the 6th within 3600 s
export const linkPromptAllowed: (kv: KeyValueStore, channelId: string, identity: string) => Promise<boolean>;     // true at most once per 600 s
```

Redis keys: `channel-link:code:<sha256(code)>` → JSON, `channel-link:user:<channelId>:<userId>` → hash of that user's current code (so issuing a new one deletes the old), `channel-link:attempts:<channelId>:<identity>`, `channel-link:prompt:<channelId>:<identity>`. The plain code is never stored.

- [ ] **Step 1: Write the failing tests** against an in-memory `KeyValueStore` fake:

```ts
it("generates XXXX-XXXX from the alphabet", () => {
  for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});
it.each([["ABCD-EFGH", "ABCD-EFGH"], [" abcd efgh ", "ABCD-EFGH"], ["abcdefgh", "ABCD-EFGH"]])("normalizes %p", (i, o) =>
  expect(normalizeCode(i)).toBe(o));
it.each(["mein Code ist ABCD-EFGH", "ABCD-EFG", "ABCD-EFGHI", "ABCD-EFG1", "", "hallo"])("rejects %p", (i) =>
  expect(normalizeCode(i)).toBeNull());
it("a code works exactly once", async () => {
  const code = await issueCode(kv, { channelId: "c", userId: 7 });
  expect(await consumeCode(kv, code)).toEqual({ channelId: "c", userId: 7 });
  expect(await consumeCode(kv, code)).toBeNull();
});
it("issuing again invalidates the previous code", async () => { /* first code → null */ });
it("never stores the plain code", async () => { /* no key or value in the fake contains it */ });
it("locks out from the sixth attempt", async () => { /* five false, sixth true */ });
it("allows one link prompt per window", async () => { /* true, then false */ });
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): one-time link codes`

---

### Task 5: Link store — `links.ts`

**Files:**
- Create: `src/exulu/channels/links.ts`
- Test: `src/exulu/channels/links.test.ts`

**Interfaces — Produces:**

```ts
export interface ChannelLink { id: string; channel: string; identity: string; user: number;
  linked_at: Date; expires_at: Date; revoked_at: Date | null; last_seen_at: Date | null }
export type LinkState = { state: "valid"; link: ChannelLink } | { state: "none" | "expired" | "revoked" };
export const linkState: (link: ChannelLink | undefined, now: Date) => LinkState;      // pure
export const expiryFor: (linkedAt: Date, linkTtlDays: number) => Date;                // pure
export const createLinkStore: (db: Knex) => {
  find(channelId: string, identity: string): Promise<ChannelLink | undefined>;
  upsert(p: { channelId: string; identity: string; userId: number; linkTtlDays: number; now: Date }): Promise<ChannelLink>;
  revoke(linkId: string, now: Date): Promise<void>;
  touch(linkId: string, now: Date): Promise<void>;
  listForChannel(channelId: string): Promise<ChannelLink[]>;
  listForUser(channelId: string, userId: number): Promise<ChannelLink[]>;
  deleteForUser(userId: number): Promise<number>;
};
```

`upsert` replaces an existing (channel, identity) row and clears `revoked_at`.

- [ ] **Step 1: Write the failing tests** for the pure functions (valid; expired exactly at `expires_at`; revoked wins over unexpired; `expiryFor(new Date("2026-11-16T10:00:00Z"), 7)` equals `2026-11-23T10:00:00Z`) and, following the DB-test pattern of `src/exulu/email-inbound/intake.test.ts`, for `upsert` replacing a row and re-linking a revoked identity.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): link store`

---

### Task 6: The inbound decision — `decide.ts`

**Files:**
- Create: `src/exulu/channels/decide.ts`
- Test: `src/exulu/channels/decide.test.ts`

**Interfaces — Produces:**

```ts
export interface InboundMessage { channelId: string; threadId: string; identity: string;
  messageId: string; text: string; hasAttachments: boolean }
export type Decision =
  | { kind: "reply"; key: ReplyKey; vars?: { linkUrl?: string; expiresAt?: Date } }
  | { kind: "silent" }
  | { kind: "run"; userId: number; newSession: boolean };
export interface DecideDeps {
  now: () => Date;
  config: WhatsAppChannelConfig;
  linkUrl: string;
  links: Pick<ReturnType<typeof createLinkStore>, "find" | "upsert" | "revoke" | "touch">;
  consumeCode(code: string): Promise<{ channelId: string; userId: number } | null>;
  codeAttemptsExceeded(identity: string): Promise<boolean>;
  linkPromptAllowed(identity: string): Promise<boolean>;
  accessAllowed(userId: number): Promise<boolean>;      // user exists, isUserActive, evaluateGuestChatAccess allows
  rateLimited(userId: number): boolean;                  // externalRateLimitExceeded
  runInFlight(identity: string): Promise<boolean>;
  markNewSession(identity: string): Promise<void>;       // Redis flag, TTL 86400 s
  takeNewSession(identity: string): Promise<boolean>;    // reads and clears the flag
  audit(event: { type: "linked" | "unlinked" | "revoked" | "code_lockout" | "access_rejected"; identity: string; userId?: number }): void;
}
export const decideInbound: (msg: InboundMessage, deps: DecideDeps) => Promise<Decision>;
export const isUserActive: (user: { status?: string | null } | undefined) => boolean;
```

Order, exactly as spec §5.3: (1) `hasAttachments` or empty trimmed text → `textOnly`; (2) `normalizeCode(text)` non-null → code path; (3) commands, matched on the whole trimmed message, case-insensitive: `/neu`, `/new` → with a valid link call `markNewSession` and reply `newSession`, without one continue at (4); `/abmelden`, `/logout` → with a link (valid or expired) revoke, audit `unlinked`, reply `unlinked`, without one continue at (4); (4) link not valid → `linkRequired` if `linkPromptAllowed`, else `silent`; (5) `accessAllowed` false → revoke, audit `access_rejected`, then as (4); (6) `rateLimited` → `rateLimited`; (7) `runInFlight` → `stillWorking`; (8) `touch`, then `run` with `newSession: await takeNewSession(identity)`.

Code path: `codeAttemptsExceeded` true → `silent` (audit `code_lockout` once, on the transition); `consumeCode` null or for another channel → `codeInvalid`; otherwise `accessAllowed(userId)` must hold (else `codeInvalid`), `upsert`, audit `linked`, reply `linked` with `expiresAt`.

`isUserActive`: false for `undefined` and for status `"disabled"`, `"blocked"`, `"inactive"`, `"deleted"` (case-insensitive); true otherwise. Flag in the PR that the value set is a guess until the user-management code defines one.

- [ ] **Step 1: Write the failing tests** — one per branch with a `deps` factory of jest fns. Each non-`run` test asserts the decision **and** that no later dependency was called (for example the unlinked test asserts `rateLimited` and `runInFlight` were not called). Include: code-shaped message from an already-linked user is consumed as a code, never run; a sentence containing a code goes to step 4; a code issued for channel B sent to channel A → `codeInvalid`; link expired one millisecond ago → `linkRequired`; second prompt inside the window → `silent`; `/abmelden` from an unlinked sender → `linkRequired`, not an error; `/neu` then a question → the question's decision is `run` with `newSession: true`, and the one after it `false`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): inbound decision`

---

### Task 7: The run — `run.ts`

**Files:**
- Create: `src/exulu/channels/run.ts`
- Test: `src/exulu/channels/run.test.ts`

**Interfaces — Produces:**

```ts
export interface ChannelMessageJob { channelId: string; threadId: string; identity: string;
  userId: number; messageId: string; text: string; newSession: boolean }
export interface RunDeps {
  now: () => Date;
  loadChannel(id: string): Promise<{ row: AgentChannelRow; config: WhatsAppChannelConfig } | null>;
  lock: { acquire(key: string, ttlSeconds: number): Promise<boolean>; release(key: string): Promise<void> };
  sessions: {
    findRecent(p: { agentId: string; userId: number; channelId: string; idleHours: number; now: Date }): Promise<string | null>;
    create(p: { agentId: string; userId: number; title: string; channel: { type: "whatsapp"; id: string; identity: string } }): Promise<string>;
  };
  runAgentTurn(p: { agentId: string; userId: number; sessionId: string; text: string }): Promise<string>; // returns the final text
  transport: { post(threadId: string, markdown: string): Promise<void>; typing(threadId: string): Promise<void> };
}
export const RUN_LOCK_TTL_SECONDS = 900;
export const runLockKey: (channelId: string, identity: string) => string;
export const handleChannelMessage: (job: ChannelMessageJob, deps: RunDeps) => Promise<{ sessionId: string | null; posted: "answer" | "runFailed" | "skipped" }>;
```

Behaviour: lock not acquired → `skipped`, nothing posted (a duplicate job). Session: `newSession` true → always create; else `findRecent`, else create. Title is `text.slice(0, 50)`. Typing is refreshed every 20 s while `runAgentTurn` is pending and the timer is always cleared. Empty or whitespace-only result, or a thrown error → post `replyText("runFailed", config)`. The lock is released in `finally`. A failing `transport.post` is logged and rethrown so BullMQ records the job as failed, after the lock is released.

`runAgentTurn` is implemented in Task 9 (it needs the worker's tool and context registries); here it is a dependency.

- [ ] **Step 1: Write the failing tests**: reuses a recent session; creates one when none is recent; creates one when `newSession` is set even though a recent one exists; title cut at 50; posts the answer as returned; **empty answer posts `runFailed`**; thrown run error posts `runFailed` and still releases the lock; lock not acquired → `skipped` and `runAgentTurn` not called; typing called at least once and the interval cleared (jest fake timers); channel disabled or missing at run time → `skipped`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): run a linked user's message through the agent`

---

### Task 8: SDK wrapper — `chat-instance.ts`

**Files:**
- Create: `src/exulu/channels/chat-instance.ts`
- Test: `src/exulu/channels/chat-instance.test.ts`

**Interfaces — Produces:**

```ts
export interface ChannelTransport {
  handleWebhook(request: Request): Promise<Response>;
  post(threadId: string, markdown: string): Promise<void>;
  typing(threadId: string): Promise<void>;
  markRead(threadId: string, messageId: string): Promise<void>;
}
export interface TransportDeps {
  pgPool: import("pg").Pool;
  onMessage(msg: InboundMessage): Promise<void>;       // server passes decide+act; worker passes a no-op
  load?: () => Promise<SdkModules>;                    // test seam; default dynamically imports the three packages
}
export const getTransport: (row: AgentChannelRow, deps: TransportDeps) => Promise<ChannelTransport | null>; // null when secrets unreadable
export const toInboundMessage: (channelId: string, threadId: string, message: { id: string; text: string; attachments: unknown[] }) => InboundMessage;
export const resetTransports: () => void;
```

Decisions: one `Chat` per channel id, cached in a module-level map together with the row's `updatedAt`; a different `updatedAt` builds a new instance and calls `shutdown()` on the old one. `userName` `"exulu-agent"`. State: `createPostgresState({ client: pgPool, keyPrefix: "exulu-channel", autoCreateSchema: false })` — tables come from `utils:initdb` (Task 1). `concurrency: "concurrent"` — our own lock (Task 7) decides, and the SDK must not hold or drop messages. Register only `onDirectMessage`. `identity` is the last `:`-separated segment of `threadId`, taken with `threadId.split(":").slice(2).join(":")` so an identifier that itself contains a colon survives. `post` calls the adapter's `postMessage(threadId, { markdown })`.

- [ ] **Step 1: Write the failing tests** with a fake `load` returning stub `Chat`, `createWhatsAppAdapter`, `createPostgresState`: same row twice → one `Chat` constructed; changed `updatedAt` → second instance and `shutdown` called on the first; adapter constructed with the decrypted `accessToken`/`appSecret`, `phoneNumberId` and `verify_token` from the row; unreadable secrets → `null` and no construction; `toInboundMessage("c", "whatsapp:111:49151", …)` gives identity `"49151"` and `"whatsapp:111:US.134:9"` gives `"US.134:9"`; attachments non-empty → `hasAttachments` true.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** This is the only file with `await import("chat")`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): Chat SDK transport, one instance per channel`

---

### Task 9: Webhook, queue, worker

**Files:**
- Create: `src/exulu/channels/webhook.ts`, `src/exulu/channels/act.ts`
- Modify: `src/exulu/routes.ts` (raw-body mount near line 300, routes near line 609), `src/exulu/app/index.ts` (queue registration near line 357), `src/validators/bullmq.ts`, `ee/workers.ts` (branch next to `email_intake`, near line 1287)
- Test: `src/exulu/channels/webhook.test.ts`, `src/exulu/channels/act.test.ts`

**Interfaces — Produces:**

```ts
// webhook.ts
export interface ChannelWebhookDeps {
  entitled(): boolean;                                  // channels && queues
  rateLimitExceeded(): boolean;
  redisAvailable(): Promise<boolean>;
  loadChannel(id: string): Promise<AgentChannelRow | undefined>;
  transportFor(row: AgentChannelRow): Promise<ChannelTransport | null>;
}
export const createChannelWebhookHandler: (deps: ChannelWebhookDeps) => (req: express.Request, res: express.Response) => Promise<void>;
export const toWebRequest: (req: express.Request, rawBody: Buffer) => Request;

// act.ts — turns a Decision into effects
export const actOnDecision: (msg: InboundMessage, decision: Decision, deps: {
  config: WhatsAppChannelConfig; transport: ChannelTransport;
  enqueue(job: ChannelMessageJob): Promise<void>;
}) => Promise<void>;
```

Routes: `app.use("/webhooks/whatsapp", express.raw({ type: () => true, limit: "5mb" }))` before the JSON parsers; `app.get` and `app.post("/webhooks/whatsapp/:channelId", handler)`.

Status codes, in this order: rate limit → 429; not entitled → 503; unknown, disabled or non-`whatsapp` channel → 404 `{ detail: "not found" }`; Redis unavailable → 503; `transportFor` returns null → 503 and `console.error` naming the channel id only; otherwise write back the SDK's `Response` status, headers and body.

`actOnDecision`: `reply` → `transport.post(threadId, replyText(...))`; `silent` → nothing; `run` → `enqueue`, then `markRead` and `typing` (failures of the last two are logged, not thrown).

Queue: `ExuluQueues.register(global_queues.channel_inbound, { worker: 5, queue: 10 }, 10, 600)` in `app/index.ts` and at enqueue. Job: name `channel_message`, data `{ type: "channel_message", inputs: ChannelMessageJob }`, `jobId: "wa:" + messageId` so a redelivered message is a no-op. Add `"channel_message"` to the validator in `src/validators/bullmq.ts` alongside `email_intake`.

Worker branch builds `RunDeps`. `runAgentTurn` mirrors the non-stream branch of the run route (`routes.ts` ~1149–1190): `exuluApp.get().agent(agentId)`, `getEnabledTools`, `getEnabledSkills`, `resolveModel`, then `generateSync` with `user`, `session`, `inputMessages: [{ role: "user", parts: [{ type: "text", text }] }]`, `instructions: withGlossary(agent.instructions, agent.tools)`, `statistics: { label: agent.name, trigger: "agent" }` and `req: { headers: { "x-public-surface": "1" } }`. The worker's transport is `getTransport(row, { pgPool, onMessage: async () => {} })`. Lock is Redis `SET key 1 NX EX`.

- [ ] **Step 1: Write the failing tests.** Webhook: each status code above, in order (a disabled channel with Redis down is 404, not 503); `toWebRequest` preserves method, query string, `x-hub-signature-256` and the exact body bytes; the SDK response body and status are passed through for a `GET` challenge. Act: `reply` posts the rendered text; `silent` posts nothing; `run` enqueues with the job id `wa:<messageId>` and survives a throwing `typing`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** and wire. In `routes.ts` the SDK's `onMessage` is `async (msg) => actOnDecision(msg, await decideInbound(msg, decideDeps), actDeps)`; `runInFlight` reads the Task 7 lock key.
- [ ] **Step 4: Run** the two tests, then `npx jest src/exulu/channels` and `npx tsc --noEmit -p tsconfig.json` — PASS.
- [ ] **Step 5: Commit** `feat(channels): WhatsApp webhook, inbound queue and worker run`

---

### Task 10: API for the editor and the link page

**Files:**
- Create: `src/exulu/channels/api.ts`
- Modify: `src/exulu/routes.ts` (register next to the `/public-agents` routes, ~line 5790), the agent update path that writes `guest_access` / `guest_auth_mode`
- Test: `src/exulu/channels/api.test.ts`

**Interfaces — Produces** (all JSON; admin routes require `requestValidators.authenticate` and `checkRecordAccess(agent, "write", user)`):

| Route | Body | Returns |
|---|---|---|
| `GET /agents/:agentId/channels/whatsapp` | – | `{ channel: ChannelView \| null, webhookUrl: string, canEnable: ReturnType<typeof canEnableChannel> }` |
| `PUT /agents/:agentId/channels/whatsapp` | `{ enabled?, config?, secrets?: Partial<ChannelSecrets> }` | `{ channel: ChannelView, verifyToken?: string }` — `verifyToken` only in the response that creates the row |
| `POST /agents/:agentId/channels/whatsapp/test` | – | `{ ok: boolean, detail: string }` — `GET {graph}/v25.0/{phoneNumberId}?fields=display_phone_number,verified_name` with the stored token; `detail` is Meta's message, never the token |
| `GET /agents/:agentId/channels/whatsapp/links` | – | `{ links: { id, identityMasked, userId, linked_at, expires_at, last_seen_at, state }[] }` |
| `DELETE /agents/:agentId/channels/whatsapp/links/:linkId` | – | 204 |
| `POST /public-agents/:id/channels/whatsapp/link-code` | – | `{ code, expiresInSeconds: 600, waUrl, links: { id, identityMasked, expires_at }[] }` — authenticated user who passes `evaluateGuestChatAccess`; 404 when the channel is missing or disabled |
| `DELETE /public-agents/:id/channels/whatsapp/links/:linkId` | – | 204 — only the caller's own link, else 404 |

`webhookUrl` is `${process.env.BACKEND}/webhooks/whatsapp/<channelId>`. `waUrl` is `https://wa.me/<digits of displayNumber>?text=<code>`. The link page URL used in `linkRequired` is `${process.env.NEXTAUTH_URL}/public/agents/<agentId>/link/whatsapp`.

`PUT` rules: `enabled: true` requires `canEnableChannel` ok, readable secrets and both entitlements, else 409 with the reason; partial `secrets` merges with the stored ones; `verify_token` is `randomBytes(24).toString("base64url")`, generated once. Every write bumps `updatedAt` (Task 8's cache key).

Auto-disable: wherever an agent update changes `guest_access` to false or `guest_auth_mode` away from `regular`, set `enabled = false` on that agent's channels in the same transaction. Export `disableChannelsForAgent(db, agentId)` from `api.ts` for that call site.

- [ ] **Step 1: Write the failing tests**: no response body of any route contains the token, app secret or (after creation) verify token; `verifyToken` returned on create and absent on the second `PUT`; enabling without secrets → 409; enabling on a `public`-mode agent → 409; partial secrets update keeps the other secret; link-code route 401 anonymous, 404 on a disabled channel, and its `waUrl` contains only digits and the code; a user cannot delete another user's link (404); `disableChannelsForAgent` flips `enabled`; links list shows masked identities only.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(channels): channel config and linking API`

---

### Task 11: Audit, data export, deletion

**Files:**
- Modify: `src/exulu/routes.ts` (the `decideDeps.audit` wiring from Task 9; `GET /users/:id/data-export` ~line 5180; the user deletion path)
- Test: `src/exulu/channels/lifecycle.test.ts`

**Interfaces — Consumes:** `DecideDeps.audit`, `createLinkStore(db).deleteForUser`, `listForUser`.

- [ ] **Step 1: Write the failing tests**: `audit` forwards to `getAuditLogger(config)` with event type `channel.<type>` and a **masked** identity; the data export includes the user's links with the full identity (it is their own data); deleting a user removes their links.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Follow how the existing tool-call audit event is shaped in `src/exulu/audit/emit-tool-call.ts`.
- [ ] **Step 4: Run** `npx jest src/exulu/channels` and `npx tsc --noEmit -p tsconfig.json` — PASS.
- [ ] **Step 5: Commit** `feat(channels): audit events, data export and link cleanup`

---

## Manual verification (after Task 10, against a Meta test number)

1. Create the channel through the API, paste webhook URL and verify token into the Meta app, subscribe `messages` and `user_id_update`. Meta shows the webhook as verified.
2. From an unlinked phone send "Hallo" → the `linkRequired` text arrives once; a second message within ten minutes gets no reply.
3. Request a code through the link-code route, send it → `linked` with a date seven days ahead.
4. Ask a technical question → typing indicator, then one answer; the session appears in that user's history on the web.
5. Send a photo → `textOnly`. Send `/neu`, ask again → a second session exists.
6. Disable the user or unpublish the agent, send a message → `linkRequired`, and the link shows as revoked.
