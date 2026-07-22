# Tool Credentials Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the ExuluAuth `user_credentials` feature: a working credential store, model-scrubbed payloads, management endpoints (backend), and the in-chat credential form, OAuth connect button, and Settings "Connections" section (frontend).

**Architecture:** Backend short-circuits tool calls with `{ credentialRequest, result: null }` (already shipped); this plan fixes the broken store (jsonb ciphertext bug), hides the payload from the model at three layers (`toModelOutput`, history sanitization + `tools` option, system guardrail), and adds `GET/DELETE /credentials`. The frontend intercepts the payload in `makeUntypedToolPart` (the ToolCallApproval slot), renders an inline form card that POSTs to the origin-validated `submitUrl` with the session Bearer JWT, and auto-resumes via a visible follow-up user message (the `question_ask` pattern).

**Tech Stack:** Backend: Express + knex/pg, ai@6.0.49, CryptoJS, Jest 29 + ts-jest. Frontend: Next.js 16, AI SDK `useChat`, react-hook-form, shadcn/ui, next-intl, vitest 4 (node env, pure modules only).

**Spec:** `docs/superpowers/specs/2026-07-22-tool-credentials-chat-ui-design.md` (backend repo, commit 9d3317f).

## Global Constraints

- Backend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/backend`, branch `feature/tool-credentials-chat-ui` off `develop`, worktree `../backend-tool-credentials`. Frontend repo: `/Users/daniel.claessen/Desktop/Projects/exulu/frontend`, branch `feature/tool-credentials-chat-ui` off `main`, worktree `../frontend-tool-credentials`.
- Part A (backend) must be complete before Part B's UAT; Part B tasks B1–B4 only need the already-merged submit endpoint, B5 needs A3.
- Never log, toast, or render a credential **value**; never return stored values from any endpoint.
- Client-developer contract is frozen: `ExuluTool`'s `authentication` config, `CredentialField` (`"text" | "password"` only), `validate` hook, `CredentialInvalidError`, and the `{ credentialRequest, result: null }` output shape must not change.
- Auth-namespace endpoints (`/credentials/*`) use the `{ ok: boolean, error?: string }` response dialect (NOT `{ detail }`).
- Backend path aliases: `@SRC/*` → `src/*`. Backend tests: Jest (`npx jest <path>`); all `jest.mock` calls go before the import of the module under test.
- Frontend: theme tokens only (no hardcoded palette classes); i18n keys go in BOTH `messages/en.json` and `messages/de.json`, alphabetized within their object; tests are colocated pure-module `*.test.ts` files (vitest node env — never `.test.tsx`, never DOM); settings page gets no new primary/purple elements and no Cards (FormSection + Separator).
- The model-facing scrub text must never contain `submitUrl` or `nonce` values.
- Commit style: conventional commits (`feat:`/`fix:`/`test:`/`docs:` with optional scope), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

# Part A — Backend (`../backend-tool-credentials`)

### Task A0: Backend worktree setup

**Files:** none (git only)

- [ ] **Step 1: Create the worktree and branch**

```bash
git -C /Users/daniel.claessen/Desktop/Projects/exulu/backend worktree add ../backend-tool-credentials -b feature/tool-credentials-chat-ui develop
cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-tool-credentials
ln -s /Users/daniel.claessen/Desktop/Projects/exulu/backend/node_modules node_modules
```

- [ ] **Step 2: Verify the toolchain works in the worktree**

Run: `cd /Users/daniel.claessen/Desktop/Projects/exulu/backend-tool-credentials && npx jest src/exulu/auth/submit-handler.test.ts`
Expected: PASS (existing suite green in the worktree).

All subsequent Part A work happens in `/Users/daniel.claessen/Desktop/Projects/exulu/backend-tool-credentials`.

---

### Task A1: Credential store — jsonb→text migration, atomic upsert, listByUser

The `data` column is `jsonb` but the store writes a bare CryptoJS-AES base64 string — Postgres rejects it (`invalid input syntax for type json`; confirmed live 2026-07-22). No credential has ever been stored end to end. Fix: column becomes `text`, upsert becomes atomic `ON CONFLICT`, `userId` normalized to `String()` at the store boundary, and a `listByUser` method is added for Task A3.

**Files:**
- Modify: `src/postgres/core-schema.ts` (userCredentialsSchema, ~line 705)
- Modify: `src/postgres/init-exulu-db.ts` (migration block after `await knex.raw(userCredentialsSchema());` at ~line 125)
- Modify: `src/exulu/auth/credential-store.ts`
- Test: `src/exulu/auth/credential-store.integration.test.ts` (create)
- Test: `src/exulu/auth/credential-store.test.ts` (modify — upsert mock shape)

**Interfaces:**
- Produces: `credentialStore.listByUser(userId: number): Promise<{ provider: string; authType: AuthType; createdAt: Date; updatedAt: Date }[]>` (consumed by Task A3); `migrateUserCredentialsDataColumn(knex: Knex): Promise<void>` exported from `init-exulu-db.ts`.
- Unchanged signatures: `get(provider, userId)`, `upsert(record)`, `delete(provider, userId)`.

- [ ] **Step 1: Write the failing integration test**

Create `src/exulu/auth/credential-store.integration.test.ts`. It runs only when `EXULU_DB_INTEGRATION_TESTS=true` (needs a reachable Postgres via the `POSTGRES_DB_*` env vars; `postgresClient` creates the database if missing):

```typescript
/**
 * Real-Postgres roundtrip for the credential store — the exact gap that let
 * the jsonb-ciphertext bug through (spec 2026-07-22 §1.1: every other test
 * mocks the DB). Guarded: only runs with EXULU_DB_INTEGRATION_TESTS=true.
 *
 * Run:
 *   EXULU_DB_INTEGRATION_TESTS=true POSTGRES_DB_HOST=localhost \
 *   POSTGRES_DB_PORT=5432 POSTGRES_DB_USER=postgres \
 *   POSTGRES_DB_PASSWORD=password POSTGRES_DB_NAME=exulu_cred_test \
 *   npx jest src/exulu/auth/credential-store.integration.test.ts
 */
const enabled = process.env.EXULU_DB_INTEGRATION_TESTS === "true";
const describeIf = enabled ? describe : describe.skip;

import { postgresClient } from "@SRC/postgres/client";
import { userCredentialsSchema } from "@SRC/postgres/core-schema";
import { migrateUserCredentialsDataColumn } from "@SRC/postgres/init-exulu-db";
import { credentialStore } from "./credential-store";

const TEST_PROVIDER = "cred_store_itest";
const TEST_USER_ID = 987654;

describeIf("credentialStore against real Postgres", () => {
  beforeAll(async () => {
    process.env.NEXTAUTH_SECRET ??= "integration-test-secret";
    const { db } = await postgresClient();
    await db.raw(userCredentialsSchema());
    await migrateUserCredentialsDataColumn(db);
    await credentialStore.delete(TEST_PROVIDER, TEST_USER_ID);
  });

  afterAll(async () => {
    const { db } = await postgresClient();
    await credentialStore.delete(TEST_PROVIDER, TEST_USER_ID);
    await db.destroy();
  });

  it("roundtrips insert → get with encrypted-at-rest values", async () => {
    await credentialStore.upsert({
      provider: TEST_PROVIDER,
      userId: TEST_USER_ID,
      authType: "user_credentials",
      data: { subdomain: "acme", apiKey: "secret-123" },
    });
    const record = await credentialStore.get(TEST_PROVIDER, TEST_USER_ID);
    expect(record?.data).toEqual({ subdomain: "acme", apiKey: "secret-123" });

    // At rest the row must NOT contain the plaintext value.
    const { db } = await postgresClient();
    const raw = await db
      .from("user_credentials")
      .where({ provider: TEST_PROVIDER, user_id: String(TEST_USER_ID) })
      .first();
    expect(String(raw.data)).not.toContain("secret-123");
  });

  it("updates in place on second upsert (ON CONFLICT path)", async () => {
    await credentialStore.upsert({
      provider: TEST_PROVIDER,
      userId: TEST_USER_ID,
      authType: "user_credentials",
      data: { subdomain: "acme", apiKey: "rotated-456" },
    });
    const record = await credentialStore.get(TEST_PROVIDER, TEST_USER_ID);
    expect(record?.data).toEqual({ subdomain: "acme", apiKey: "rotated-456" });

    const { db } = await postgresClient();
    const count = await db
      .from("user_credentials")
      .where({ provider: TEST_PROVIDER })
      .count("id as n");
    expect(Number((count[0] as any).n)).toBe(1);
  });

  it("lists metadata (never values) and deletes", async () => {
    const list = await credentialStore.listByUser(TEST_USER_ID);
    const entry = list.find((c) => c.provider === TEST_PROVIDER);
    expect(entry?.authType).toBe("user_credentials");
    expect(entry && "data" in (entry as object)).toBe(false);

    await credentialStore.delete(TEST_PROVIDER, TEST_USER_ID);
    expect(await credentialStore.get(TEST_PROVIDER, TEST_USER_ID)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see the current bug**

Run (with the env vars from the file header, against local Postgres): `EXULU_DB_INTEGRATION_TESTS=true POSTGRES_DB_HOST=localhost POSTGRES_DB_PORT=5432 POSTGRES_DB_USER=postgres POSTGRES_DB_PASSWORD=password POSTGRES_DB_NAME=exulu_cred_test npx jest src/exulu/auth/credential-store.integration.test.ts`
Expected: FAIL — first `upsert` throws `invalid input syntax for type json` (and `migrateUserCredentialsDataColumn` is not yet exported → compile error first; that also counts as the failing state).

- [ ] **Step 3: Change the DDL to `text`**

In `src/postgres/core-schema.ts`, `userCredentialsSchema()`, change the data line:

```sql
    data text NOT NULL,
```

(was `data jsonb NOT NULL`). Fresh installs now get `text` directly.

- [ ] **Step 4: Add the gated migration**

In `src/postgres/init-exulu-db.ts`, add an exported helper (place it above `up`), and call it inside `up(knex)` immediately after the existing `await knex.raw(userCredentialsSchema());` line:

```typescript
/**
 * user_credentials.data held CryptoJS-AES ciphertext (an opaque base64
 * string) in a jsonb column — Postgres rejects it, so no credential was
 * ever stored (spec 2026-07-22-tool-credentials-chat-ui §1.1). Column
 * becomes text. Idempotent: gated on information_schema reporting jsonb
 * (knex.schema.hasColumn cannot check types). The table is empty in every
 * environment (the bug made writes impossible), so USING data::text is
 * trivially safe.
 */
export const migrateUserCredentialsDataColumn = async (knex: Knex): Promise<void> => {
  const dataType = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = 'user_credentials' AND column_name = 'data'`,
  );
  if (dataType.rows?.[0]?.data_type === "jsonb") {
    console.log("[EXULU] Migrating user_credentials.data jsonb -> text.");
    await knex.raw(
      "ALTER TABLE user_credentials ALTER COLUMN data TYPE text USING data::text",
    );
  }
};
```

Call site inside `up`:

```typescript
  await knex.raw("DROP TABLE IF EXISTS oauth_tokens CASCADE;");
  await knex.raw(userCredentialsSchema());
  await migrateUserCredentialsDataColumn(knex);
```

- [ ] **Step 5: Rewrite the store (atomic upsert, String(userId), listByUser)**

Replace the `get`/`upsert`/`del` functions and the export in `src/exulu/auth/credential-store.ts` (imports, `encrypt`/`decrypt`, `AuthType`, `CredentialRecord` stay as-is):

```typescript
async function get(provider: string, userId: number): Promise<CredentialRecord | null> {
  const { db } = await postgresClient();
  const row = await db
    .from(TABLE)
    .where({ provider, user_id: String(userId) })
    .first();
  if (!row) {
    return null;
  }
  return {
    provider,
    userId,
    authType: row.auth_type as AuthType,
    data: JSON.parse(decrypt(row.data)) as Record<string, unknown>,
  };
}

async function upsert(record: CredentialRecord): Promise<void> {
  const { db } = await postgresClient();
  const encrypted = encrypt(JSON.stringify(record.data));
  // Atomic — the previous read-then-insert raced concurrent first-time
  // submits into unique-constraint 500s (spec §1.1).
  await db
    .from(TABLE)
    .insert({
      provider: record.provider,
      user_id: String(record.userId),
      auth_type: record.authType,
      data: encrypted,
      updated_at: new Date(),
    })
    .onConflict(["provider", "user_id"])
    .merge({ auth_type: record.authType, data: encrypted, updated_at: new Date() });
}

/** Metadata only — values never leave the store through this path. */
async function listByUser(
  userId: number,
): Promise<{ provider: string; authType: AuthType; createdAt: Date; updatedAt: Date }[]> {
  const { db } = await postgresClient();
  const list = await db
    .from(TABLE)
    .where({ user_id: String(userId) })
    .orderBy("provider");
  return list.map((row: any) => ({
    provider: row.provider,
    authType: row.auth_type as AuthType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function del(provider: string, userId: number): Promise<void> {
  const { db } = await postgresClient();
  await db.from(TABLE).where({ provider, user_id: String(userId) }).del();
}

export const credentialStore = { get, upsert, listByUser, delete: del };
```

- [ ] **Step 6: Update the mocked unit tests for the new knex chain**

`src/exulu/auth/credential-store.test.ts` mocks `postgresClient` with a chain that has no `insert().onConflict().merge()` and expects numeric `user_id`. Update the mock db so `insert(values)` returns an object with `onConflict(cols)` returning `{ merge: async (values) => {...} }` implementing upsert semantics against the in-memory `rows`, add `orderBy` returning the filtered rows array for `listByUser`, and change `user_id` expectations to `String(...)`. Pattern for the chain (adapt the file's existing `mockDb`):

```typescript
const mockDb = {
  from: (_table: string) => ({
    where: (criteria: Row) => {
      const filtered = () => rows.filter((row) => matches(row, criteria));
      return {
        first: async () => filtered()[0],
        del: async () => {
          const index = rows.findIndex((row) => matches(row, criteria));
          if (index >= 0) rows.splice(index, 1);
        },
        orderBy: async (_col: string) => filtered(),
      };
    },
    insert: (values: Row) => ({
      onConflict: (_cols: string[]) => ({
        merge: async (mergeValues: Row) => {
          const existing = rows.find(
            (r) => r.provider === values.provider && r.user_id === values.user_id,
          );
          if (existing) Object.assign(existing, mergeValues);
          else rows.push({ ...values });
        },
      }),
    }),
  }),
};
```

Add one new unit test asserting `listByUser` returns `{ provider, authType, createdAt, updatedAt }` and nothing else (no `data` key), and one asserting `get`/`delete` query with `user_id: "42"` (string).

- [ ] **Step 7: Run unit + integration tests**

Run: `npx jest src/exulu/auth/credential-store.test.ts` → PASS.
Run the integration command from Step 2 → PASS (3 tests).

- [ ] **Step 8: Run the full auth suite and commit**

Run: `npx jest src/exulu/auth/` → PASS.

```bash
git add src/postgres/core-schema.ts src/postgres/init-exulu-db.ts src/exulu/auth/credential-store.ts src/exulu/auth/credential-store.test.ts src/exulu/auth/credential-store.integration.test.ts
git commit -m "fix(auth): credential store works against real Postgres

data column jsonb->text (gated migration; ciphertext is opaque), atomic
ON CONFLICT upsert, String(userId) at the store boundary, listByUser for
the Connections endpoints. Adds the real-PG integration test that the
mocked suite was missing.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task A2: Submit-handler error string fix

**Files:**
- Modify: `src/exulu/auth/submit-handler.ts:~94` (the defensive session guard)
- Test: `src/exulu/auth/submit-handler.test.ts`

- [ ] **Step 1: Update the test expectation first**

In `src/exulu/auth/submit-handler.test.ts`, find the test asserting the defensive guard (session userId not a positive integer) responds with error `"nonce invalid"` (grep for `nonce invalid` — take the case where the SESSION user id is invalid, not the nonce). Change the expected string to `"session invalid"`. If the only `"nonce invalid"` expectations are for `verifyCredentialNonce` throw paths, add a new test: mock `mockAuthenticate` to resolve `{ user: { id: 0 } }` (falsy id → caught earlier) — instead use `{ user: { id: 2.5 } }` (non-integer, passes the `!authResult.user?.id` guard), mock `mockVerifyCredentialNonce` to return `{ provider: "test_provider", userId: "2.5", expiresAt: 9999999999 }`, register the provider config, and assert status 401 with `{ ok: false, error: "session invalid" }`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/exulu/auth/submit-handler.test.ts`
Expected: FAIL — received `"nonce invalid"`.

- [ ] **Step 3: Fix the string**

In `src/exulu/auth/submit-handler.ts`, in the defensive guard that validates the session user id (`Number.isInteger(sessionUserId)` / `<= 0` check around line 94), change the response error value from `"nonce invalid"` to `"session invalid"`.

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `npx jest src/exulu/auth/submit-handler.test.ts` → PASS.

```bash
git add src/exulu/auth/submit-handler.ts src/exulu/auth/submit-handler.test.ts
git commit -m "fix(auth): session-guard error says 'session invalid', not 'nonce invalid'

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task A3: Management endpoints — GET /credentials, DELETE /credentials/:provider

**Files:**
- Create: `src/exulu/auth/manage-handlers.ts`
- Test: `src/exulu/auth/manage-handlers.test.ts`
- Modify: `src/exulu/routes.ts` (imports ~line 108, registrations after `/credentials/submit` ~line 418)

**Interfaces:**
- Consumes: `credentialStore.listByUser` (Task A1), `requestValidators.authenticate`.
- Produces: `GET /credentials` → `200 { ok: true, credentials: [{ provider, authType, createdAt, updatedAt }] }`; `DELETE /credentials/:provider` → `200 { ok: true }` (idempotent). Both `401 { ok: false, error: "authentication required" }` unauthenticated. (Consumed by Task B5.)

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/auth/manage-handlers.test.ts` (mocks before import, per the submit-handler pattern):

```typescript
const mockListByUser = jest.fn();
const mockDelete = jest.fn();
const mockAuthenticate = jest.fn();

jest.mock("./credential-store", () => ({
  credentialStore: {
    listByUser: (...args: any[]) => mockListByUser(...args),
    delete: (...args: any[]) => mockDelete(...args),
  },
}));

jest.mock("../../validators/requests", () => ({
  requestValidators: {
    authenticate: (...args: any[]) => mockAuthenticate(...args),
  },
}));

import { handleCredentialList, handleCredentialDelete } from "./manage-handlers";

const mockReq = (params: any = {}) => ({ params, body: {} }) as any;

const mockRes = () => {
  const res: any = {
    statusCode: 0,
    body: null,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: any) => {
      res.body = data;
      return res;
    }),
  };
  return res;
};

beforeEach(() => {
  jest.resetAllMocks();
});

describe("handleCredentialList", () => {
  it("401s without a session user", async () => {
    mockAuthenticate.mockResolvedValue({ error: true, message: "no", code: 401 });
    const res = mockRes();
    await handleCredentialList(mockReq(), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "authentication required" });
    expect(mockListByUser).not.toHaveBeenCalled();
  });

  it("returns the session user's credential metadata", async () => {
    mockAuthenticate.mockResolvedValue({ error: false, user: { id: 7 } });
    const stored = [
      {
        provider: "moco",
        authType: "user_credentials",
        createdAt: new Date("2026-07-22T10:00:00Z"),
        updatedAt: new Date("2026-07-22T10:00:00Z"),
      },
    ];
    mockListByUser.mockResolvedValue(stored);
    const res = mockRes();
    await handleCredentialList(mockReq(), res);
    expect(mockListByUser).toHaveBeenCalledWith(7);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, credentials: stored });
  });
});

describe("handleCredentialDelete", () => {
  it("401s without a session user", async () => {
    mockAuthenticate.mockResolvedValue({ error: true, message: "no", code: 401 });
    const res = mockRes();
    await handleCredentialDelete(mockReq({ provider: "moco" }), res);
    expect(res.statusCode).toBe(401);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("400s without a provider param", async () => {
    mockAuthenticate.mockResolvedValue({ error: false, user: { id: 7 } });
    const res = mockRes();
    await handleCredentialDelete(mockReq({}), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "provider is required" });
  });

  it("deletes for (provider, session user) and is idempotent-shaped", async () => {
    mockAuthenticate.mockResolvedValue({ error: false, user: { id: 7 } });
    mockDelete.mockResolvedValue(undefined);
    const res = mockRes();
    await handleCredentialDelete(mockReq({ provider: "moco" }), res);
    expect(mockDelete).toHaveBeenCalledWith("moco", 7);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/exulu/auth/manage-handlers.test.ts`
Expected: FAIL — cannot find module `./manage-handlers`.

- [ ] **Step 3: Implement the handlers**

Create `src/exulu/auth/manage-handlers.ts`:

```typescript
import type { Request, Response } from "express";
import { credentialStore } from "./credential-store";
import { requestValidators } from "../../validators/requests";

/**
 * GET /credentials — the caller's stored tool credentials, metadata only
 * (spec 2026-07-22-tool-credentials-chat-ui §1.3). Values never leave the
 * store through this path. Auth-namespace response dialect: { ok, ... }.
 */
export const handleCredentialList = async (req: Request, res: Response): Promise<void> => {
  const authResult = await requestValidators.authenticate(req);
  if (!authResult.user?.id) {
    res.status(authResult.code ?? 401).json({ ok: false, error: "authentication required" });
    return;
  }
  const credentials = await credentialStore.listByUser(authResult.user.id);
  res.status(200).json({ ok: true, credentials });
};

/**
 * DELETE /credentials/:provider — revoke the caller's stored credentials for
 * one provider. Idempotent: deleting an absent row still returns { ok: true }.
 * The session user is the only identity ever used (never client-supplied).
 */
export const handleCredentialDelete = async (req: Request, res: Response): Promise<void> => {
  const authResult = await requestValidators.authenticate(req);
  if (!authResult.user?.id) {
    res.status(authResult.code ?? 401).json({ ok: false, error: "authentication required" });
    return;
  }
  const provider = req.params.provider;
  if (!provider) {
    res.status(400).json({ ok: false, error: "provider is required" });
    return;
  }
  await credentialStore.delete(provider, authResult.user.id);
  res.status(200).json({ ok: true });
};
```

- [ ] **Step 4: Register the routes**

In `src/exulu/routes.ts`, extend the auth-handler import block (~line 108):

```typescript
import { handleCredentialList, handleCredentialDelete } from "./auth/manage-handlers.ts";
```

And directly after the `app.post("/credentials/submit", handleCredentialSubmit);` registration (~line 418):

```typescript
  // Lists the caller's stored tool credentials — metadata only, values are
  // never returned. Backs the /settings Connections section.
  app.get("/credentials", handleCredentialList);

  // Revokes the caller's stored credentials for one provider. Idempotent;
  // the next tool use re-prompts the credential form in chat.
  app.delete("/credentials/:provider", handleCredentialDelete);
```

- [ ] **Step 5: Run tests and commit**

Run: `npx jest src/exulu/auth/manage-handlers.test.ts` → PASS (5 tests).

```bash
git add src/exulu/auth/manage-handlers.ts src/exulu/auth/manage-handlers.test.ts src/exulu/routes.ts
git commit -m "feat(auth): GET /credentials + DELETE /credentials/:provider

Metadata-only list and idempotent revoke for the session user — backs the
/settings Connections section (spec 2026-07-22 §1.3).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task A4: toModelOutput — scrub the within-turn model view

**Files:**
- Create: `src/exulu/auth/scrub-text.ts`
- Create: `src/templates/tools/auth-tool-model-output.ts`
- Test: `src/templates/tools/auth-tool-model-output.test.ts`
- Modify: `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts` (the per-tool object in the reduce, after the `needsApproval:` line ~465)

**Interfaces:**
- Produces: `buildAuthToolModelOutput(tool: ExuluTool)` returning an ai@6 `toModelOutput` function; `SCRUBBED_CREDENTIAL_TEXT`, `SCRUBBED_OAUTH_TEXT`, `credentialScrubText(provider, labels)` from `scrub-text.ts` (also consumed by Task A5).
- Consumes: `cur.authentication` on the `ExuluTool` instance in the converter's reduce.

- [ ] **Step 1: Write the failing tests**

Create `src/templates/tools/auth-tool-model-output.test.ts`:

```typescript
import { buildAuthToolModelOutput } from "./auth-tool-model-output";

const credentialTool = {
  authentication: {
    authType: "user_credentials",
    provider: "moco",
    fields: [
      { name: "subdomain", label: "Moco subdomain", type: "text" },
      { name: "apiKey", label: "Personal API key", type: "password" },
    ],
  },
} as any;

const oauthTool = {
  authentication: { authType: "oauth", provider: "google" },
} as any;

describe("buildAuthToolModelOutput", () => {
  it("replaces credentialRequest payloads with text naming provider and labels, never nonce/submitUrl", () => {
    const toModelOutput = buildAuthToolModelOutput(credentialTool);
    const result = toModelOutput({
      toolCallId: "c1",
      input: {},
      output: {
        credentialRequest: {
          provider: "moco",
          fields: [],
          submitUrl: "http://localhost:9001/credentials/submit",
          nonce: "SECRET_NONCE_VALUE",
        },
        result: null,
      },
    }) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).toContain("moco");
    expect(result.value).toContain("Moco subdomain");
    expect(result.value).toContain("Personal API key");
    expect(result.value).not.toContain("SECRET_NONCE_VALUE");
    expect(result.value).not.toContain("/credentials/submit");
  });

  it("replaces oauth short-circuits with text that omits the URL", () => {
    const toModelOutput = buildAuthToolModelOutput(oauthTool);
    const result = toModelOutput({
      toolCallId: "c1",
      input: {},
      output: {
        result: "Authorization required: https://accounts.google.com/o/oauth2/auth?x=1",
        oauth: { authorizationUrl: "https://accounts.google.com/o/oauth2/auth?x=1" },
      },
    }) as { type: string; value: string };
    expect(result.type).toBe("text");
    expect(result.value).not.toContain("accounts.google.com");
  });

  it("passes normal outputs through as json (the AI SDK default)", () => {
    const toModelOutput = buildAuthToolModelOutput(credentialTool);
    const output = { result: JSON.stringify({ activities: [] }) };
    const result = toModelOutput({ toolCallId: "c1", input: {}, output }) as {
      type: string;
      value: unknown;
    };
    expect(result).toEqual({ type: "json", value: output });
  });

  it("handles null output", () => {
    const toModelOutput = buildAuthToolModelOutput(credentialTool);
    expect(toModelOutput({ toolCallId: "c1", input: {}, output: null })).toEqual({
      type: "json",
      value: null,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/templates/tools/auth-tool-model-output.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement scrub-text and the builder**

Create `src/exulu/auth/scrub-text.ts`:

```typescript
/**
 * Model-facing replacement text for auth short-circuit payloads (spec
 * 2026-07-22-tool-credentials-chat-ui §1.2). The model may know WHICH
 * provider/fields the form asks for — never the nonce or submitUrl.
 */
export const credentialScrubText = (provider: string, fieldLabels: string[]): string =>
  `A secure credential form for provider "${provider}"` +
  (fieldLabels.length ? ` (fields: ${fieldLabels.join(", ")})` : "") +
  ` is shown to the user in the chat UI. Never ask for these values in chat.` +
  ` After the user confirms saving, call the tool again.`;

export const SCRUBBED_CREDENTIAL_TEXT =
  "A secure credential form was shown to the user in the chat UI. " +
  "Never ask for credential values in chat. After the user confirms saving, call the tool again.";

export const SCRUBBED_OAUTH_TEXT =
  "Authorization is required. A Connect button was shown to the user in the chat UI. " +
  "Do not relay any URL in chat. After the user confirms connecting, call the tool again.";
```

Create `src/templates/tools/auth-tool-model-output.ts`:

```typescript
import type { ExuluTool } from "@SRC/exulu/tool";
import { credentialScrubText, SCRUBBED_OAUTH_TEXT } from "@SRC/exulu/auth/scrub-text";

type ModelOutput = { type: "text"; value: string } | { type: "json"; value: any };

/**
 * toModelOutput for auth-wrapped tools (spec §1.2 piece 1): the raw
 * credentialRequest / oauth short-circuit payload streams to the frontend
 * unchanged, but the MODEL sees only scrub text. Normal results keep the
 * AI SDK's default JSON encoding.
 */
export const buildAuthToolModelOutput =
  (tool: ExuluTool) =>
  ({ output }: { toolCallId: string; input: unknown; output: any }): ModelOutput => {
    if (output && typeof output === "object" && output.credentialRequest) {
      const auth = tool.authentication;
      const labels =
        auth?.authType === "user_credentials" ? auth.fields.map((f) => f.label) : [];
      const provider =
        output.credentialRequest.provider ??
        (auth && "provider" in auth ? auth.provider : "unknown");
      return { type: "text", value: credentialScrubText(provider, labels) };
    }
    if (output && typeof output === "object" && output.oauth?.authorizationUrl) {
      return { type: "text", value: SCRUBBED_OAUTH_TEXT };
    }
    return { type: "json", value: output ?? null };
  };
```

- [ ] **Step 4: Attach it in the converter**

In `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`, add the import at the top:

```typescript
import { buildAuthToolModelOutput } from "./auth-tool-model-output";
```

Inside the reduce's per-tool object (directly after the `needsApproval: ...` line, ~465), add:

```typescript
          // Auth-wrapped tools: the model sees scrub text instead of the
          // credentialRequest/oauth payload; the UI stream keeps the raw
          // output (spec 2026-07-22 §1.2).
          ...(cur.authentication ? { toModelOutput: buildAuthToolModelOutput(cur) } : {}),
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx jest src/templates/tools/auth-tool-model-output.test.ts` → PASS.
Run: `npx tsc --noEmit` → no NEW errors (compare against a pre-change run if the baseline is nonzero).

```bash
git add src/exulu/auth/scrub-text.ts src/templates/tools/auth-tool-model-output.ts src/templates/tools/auth-tool-model-output.test.ts src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts
git commit -m "feat(auth): toModelOutput scrubs credentialRequest/oauth payloads from the model view

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task A5: History replay scrub — sanitize + pass `tools` to convertToModelMessages

`toModelOutput` alone does not cover history: both `convertToModelMessages` call sites omit the `tools` option, so persisted raw payloads replay to the model on later turns. Belt and suspenders: pass `tools` AND sanitize the UI messages copy handed to the converter (guarantees the invariant for every part encoding).

**Files:**
- Create: `src/exulu/auth/sanitize-ui-messages.ts`
- Test: `src/exulu/auth/sanitize-ui-messages.test.ts`
- Modify: `src/exulu/provider.ts:652` and `src/exulu/provider.ts:1196` (both `convertToModelMessages` calls)

**Interfaces:**
- Consumes: `SCRUBBED_CREDENTIAL_TEXT`, `SCRUBBED_OAUTH_TEXT` (Task A4).
- Produces: `sanitizeAuthPayloadsInUiMessages(messages: UIMessage[]): UIMessage[]` — pure, non-mutating.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/auth/sanitize-ui-messages.test.ts`:

```typescript
import type { UIMessage } from "ai";
import { sanitizeAuthPayloadsInUiMessages } from "./sanitize-ui-messages";
import { SCRUBBED_CREDENTIAL_TEXT, SCRUBBED_OAUTH_TEXT } from "./scrub-text";

const credentialPart = {
  type: "dynamic-tool",
  toolName: "moco_list_activities",
  toolCallId: "c1",
  state: "output-available",
  input: {},
  output: {
    credentialRequest: {
      provider: "moco",
      fields: [],
      submitUrl: "http://localhost:9001/credentials/submit",
      nonce: "SECRET_NONCE",
    },
    result: null,
  },
};

const messages = (parts: any[]): UIMessage[] =>
  [{ id: "m1", role: "assistant", parts }] as unknown as UIMessage[];

describe("sanitizeAuthPayloadsInUiMessages", () => {
  it("replaces credentialRequest outputs with scrub text, without mutating the input", () => {
    const input = messages([credentialPart]);
    const out = sanitizeAuthPayloadsInUiMessages(input);
    expect((out[0] as any).parts[0].output).toEqual({ result: SCRUBBED_CREDENTIAL_TEXT });
    // Original untouched — the UI/persistence copy keeps the payload.
    expect((input[0] as any).parts[0].output.credentialRequest.nonce).toBe("SECRET_NONCE");
    expect(JSON.stringify(out)).not.toContain("SECRET_NONCE");
  });

  it("replaces oauth outputs with scrub text", () => {
    const oauthPart = {
      ...credentialPart,
      output: { result: "auth at https://x", oauth: { authorizationUrl: "https://x/auth" } },
    };
    const out = sanitizeAuthPayloadsInUiMessages(messages([oauthPart]));
    expect((out[0] as any).parts[0].output).toEqual({ result: SCRUBBED_OAUTH_TEXT });
  });

  it("leaves normal tool outputs and non-assistant messages alone (same references)", () => {
    const normalPart = { ...credentialPart, output: { result: "[]" } };
    const userMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };
    const input = [
      { id: "m1", role: "assistant", parts: [normalPart] },
      userMessage,
    ] as unknown as UIMessage[];
    const out = sanitizeAuthPayloadsInUiMessages(input);
    expect(out[0]).toBe(input[0]);
    expect(out[1]).toBe(input[1]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/exulu/auth/sanitize-ui-messages.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `src/exulu/auth/sanitize-ui-messages.ts`:

```typescript
import type { UIMessage } from "ai";
import { SCRUBBED_CREDENTIAL_TEXT, SCRUBBED_OAUTH_TEXT } from "./scrub-text";

/**
 * History-replay scrub (spec 2026-07-22-tool-credentials-chat-ui §1.2
 * piece 2): auth short-circuit payloads persisted in earlier turns must
 * never reach the model again. Applied to the COPY handed to
 * convertToModelMessages — the stored/UI messages keep the raw payload.
 * Pure and non-mutating; untouched messages keep their references.
 */
export const sanitizeAuthPayloadsInUiMessages = (messages: UIMessage[]): UIMessage[] =>
  messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray((message as any).parts)) {
      return message;
    }
    let changed = false;
    const parts = (message as any).parts.map((part: any) => {
      const output = part?.output;
      if (output && typeof output === "object" && output.credentialRequest) {
        changed = true;
        return { ...part, output: { result: SCRUBBED_CREDENTIAL_TEXT } };
      }
      if (output && typeof output === "object" && output.oauth?.authorizationUrl) {
        changed = true;
        return { ...part, output: { result: SCRUBBED_OAUTH_TEXT } };
      }
      return part;
    });
    return changed ? ({ ...message, parts } as UIMessage) : message;
  });
```

- [ ] **Step 4: Wire both provider call sites**

In `src/exulu/provider.ts`, add the import at the top of the file:

```typescript
import { sanitizeAuthPayloadsInUiMessages } from "./auth/sanitize-ui-messages";
```

Change the `generateText` call in `generateSync` (line ~652) from:

```typescript
        messages: await convertToModelMessages(messages, {
          ignoreIncompleteToolCalls: true,
        }),
```

to:

```typescript
        // tools: applies each tool's toModelOutput to historical tool results;
        // sanitize: guarantees auth payloads never reach the model regardless
        // of part encoding (spec 2026-07-22 §1.2).
        messages: await convertToModelMessages(sanitizeAuthPayloadsInUiMessages(messages), {
          ignoreIncompleteToolCalls: true,
          tools,
        }),
```

Make the identical change in `generateStream`'s `streamText` call (line ~1196). Both sites already have `tools` in scope as a local const.

- [ ] **Step 5: Run tests and the full suite, commit**

Run: `npx jest src/exulu/auth/sanitize-ui-messages.test.ts` → PASS.
Run: `npx jest src/exulu/` → PASS (no regressions in provider-adjacent suites).

```bash
git add src/exulu/auth/sanitize-ui-messages.ts src/exulu/auth/sanitize-ui-messages.test.ts src/exulu/provider.ts
git commit -m "feat(auth): scrub auth payloads from model-bound history

Pass tools to both convertToModelMessages call sites (applies
toModelOutput to history) and sanitize the converted copy so nonce and
submitUrl can never replay to the model.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task A6: Conditional system-prompt guardrail

**Files:**
- Create: `src/exulu/auth/guardrail.ts`
- Test: `src/exulu/auth/guardrail.test.ts`
- Modify: `src/exulu/provider.ts` (after the approval `system +=` append in BOTH methods: `generateSync` ~line 568, `generateStream` ~line 1100)

**Interfaces:**
- Produces: `credentialGuardrailBlock(currentTools?: ExuluTool[]): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/exulu/auth/guardrail.test.ts`:

```typescript
import { credentialGuardrailBlock, CREDENTIAL_GUARDRAIL } from "./guardrail";

const credTool = { authentication: { authType: "user_credentials" } } as any;
const oauthTool = { authentication: { authType: "oauth" } } as any;
const plainTool = {} as any;

describe("credentialGuardrailBlock", () => {
  it("returns the guardrail when a user_credentials tool is present", () => {
    expect(credentialGuardrailBlock([plainTool, credTool])).toBe(CREDENTIAL_GUARDRAIL);
  });

  it("returns null for oauth-only, plain, empty, and undefined tool lists", () => {
    expect(credentialGuardrailBlock([oauthTool, plainTool])).toBeNull();
    expect(credentialGuardrailBlock([])).toBeNull();
    expect(credentialGuardrailBlock(undefined)).toBeNull();
  });

  it("never mentions internal machinery the model could parrot", () => {
    expect(CREDENTIAL_GUARDRAIL).not.toMatch(/nonce|submitUrl/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/exulu/auth/guardrail.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/exulu/auth/guardrail.ts`:

```typescript
import type { ExuluTool } from "../tool";

/**
 * System-prompt block appended when a user_credentials tool is active
 * (spec 2026-07-22-tool-credentials-chat-ui §1.2 piece 3). Appended as its
 * own `system +=` block — agent instructions REPLACE the default preamble,
 * so a guardrail inside the default string would vanish for configured
 * agents.
 */
export const CREDENTIAL_GUARDRAIL = `Credential safety:
Some tools collect credentials (API keys, passwords, tokens) through a secure form shown directly to the user in the chat UI. Credentials are never entered in the conversation itself.
- Never ask the user to type credential values into the chat.
- If the user pastes a credential value into the chat anyway, do not repeat it, do not store it, and do not pass it to any tool. Tell them to use the secure form instead (calling the tool again shows the form if it is no longer visible).
- After the user confirms they submitted the form, call the tool again.`;

export const credentialGuardrailBlock = (currentTools?: ExuluTool[]): string | null =>
  currentTools?.some((t) => t.authentication?.authType === "user_credentials")
    ? CREDENTIAL_GUARDRAIL
    : null;
```

- [ ] **Step 4: Append in both provider methods**

In `src/exulu/provider.ts`, add the import:

```typescript
import { credentialGuardrailBlock } from "./auth/guardrail";
```

In `generateSync`, directly after the approval append (`system += "\n\n" + \`When a tool execution is not approved...\`` at ~line 568), add:

```typescript
    const credentialGuardrail = credentialGuardrailBlock(currentTools);
    if (credentialGuardrail) {
      system += "\n\n" + credentialGuardrail;
    }
```

Add the identical block in `generateStream` directly after its approval append (~line 1100). (`currentTools` is a parameter of both methods and in scope at both points.)

- [ ] **Step 5: Run tests and commit**

Run: `npx jest src/exulu/auth/guardrail.test.ts` → PASS.

```bash
git add src/exulu/auth/guardrail.ts src/exulu/auth/guardrail.test.ts src/exulu/provider.ts
git commit -m "feat(auth): system guardrail against asking for secrets in chat

Appended only when a user_credentials tool is active, as its own block
so agent instructions cannot displace it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task A7: Backend verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS (integration test file auto-skips without `EXULU_DB_INTEGRATION_TESTS`).

- [ ] **Step 2: Typecheck/build**

Run: `npm run build` (if the script exists — check `package.json`; otherwise `npx tsc --noEmit`).
Expected: success / no new errors vs. the pre-branch baseline.

- [ ] **Step 3: Report**

Do not merge to `develop` and do not push — summarize the branch state for Daniel's review (commits A1–A6, integration-test command, and the note that the migration runs automatically at next backend boot).

---

# Part B — Frontend (`../frontend-tool-credentials`)

### Task B0: Frontend worktree setup

**Files:** none (git only)

- [ ] **Step 1: Create the worktree and branch, real install**

```bash
git -C /Users/daniel.claessen/Desktop/Projects/exulu/frontend worktree add ../frontend-tool-credentials -b feature/tool-credentials-chat-ui main
cd /Users/daniel.claessen/Desktop/Projects/exulu/frontend-tool-credentials
npm install
```

(Real install, not a symlink — the Turbopack build needs it.)

- [ ] **Step 2: Verify the toolchain**

Run: `npm test`
Expected: PASS (existing vitest suite green).

All subsequent Part B work happens in `/Users/daniel.claessen/Desktop/Projects/exulu/frontend-tool-credentials`.

---

### Task B1: Pure data module — detection, origin rule, submit mapping

Frontend tests are pure-module only (vitest node env, no DOM), so all card logic that can be pure lives in a sibling module.

**Files:**
- Create: `app/(application)/chat/components/credential-request-data.ts`
- Test: `app/(application)/chat/components/credential-request-data.test.ts`
- Test: `components/message-renderer-tool-data.test.ts` (add one test)

**Interfaces:**
- Produces (consumed by B2/B3): `CredentialField`, `CredentialRequestPayload`, `OauthRequestPayload`, `extractCredentialRequest(part)`, `extractOauthRequest(part)`, `isAllowedSubmitUrl(submitUrl, configBackend)`, `SubmitOutcome`, `mapSubmitResponse(status, body)`.

- [ ] **Step 1: Write the failing tests**

Create `app/(application)/chat/components/credential-request-data.test.ts`:

```typescript
import type { DynamicToolUIPart } from "ai";
import { describe, expect, it } from "vitest";

import {
  extractCredentialRequest,
  extractOauthRequest,
  isAllowedSubmitUrl,
  mapSubmitResponse,
} from "./credential-request-data";

const toolPart = (overrides: Record<string, unknown>): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName: "moco_list_activities",
    toolCallId: "call-1",
    state: "output-available",
    input: {},
    ...overrides,
  }) as unknown as DynamicToolUIPart;

const payload = {
  provider: "moco",
  fields: [{ name: "apiKey", label: "API key", type: "password" }],
  submitUrl: "http://localhost:9001/credentials/submit",
  nonce: "n1",
};

describe("extractCredentialRequest", () => {
  it("extracts a well-formed payload from a final output", () => {
    const part = toolPart({ output: { credentialRequest: payload, result: null } });
    expect(extractCredentialRequest(part)).toEqual(payload);
  });

  it("returns null for non-final states, missing payloads, and malformed payloads", () => {
    expect(
      extractCredentialRequest(
        toolPart({ state: "input-available", output: undefined }),
      ),
    ).toBeNull();
    expect(extractCredentialRequest(toolPart({ output: { result: "[]" } }))).toBeNull();
    expect(
      extractCredentialRequest(
        toolPart({ output: { credentialRequest: { provider: "x" } } }),
      ),
    ).toBeNull();
  });
});

describe("extractOauthRequest", () => {
  it("extracts the authorizationUrl", () => {
    const part = toolPart({
      output: { result: "auth", oauth: { authorizationUrl: "https://x/auth" } },
    });
    expect(extractOauthRequest(part)).toEqual({ authorizationUrl: "https://x/auth" });
  });

  it("returns null when absent", () => {
    expect(extractOauthRequest(toolPart({ output: { result: "[]" } }))).toBeNull();
  });
});

describe("isAllowedSubmitUrl", () => {
  it("accepts only the configured backend origin", () => {
    expect(isAllowedSubmitUrl("http://localhost:9001/credentials/submit", "http://localhost:9001")).toBe(true);
    expect(isAllowedSubmitUrl("http://localhost:9001/credentials/submit", "http://localhost:9001/")).toBe(true);
    expect(isAllowedSubmitUrl("https://evil.example/credentials/submit", "http://localhost:9001")).toBe(false);
    expect(isAllowedSubmitUrl("http://localhost:9002/credentials/submit", "http://localhost:9001")).toBe(false);
    expect(isAllowedSubmitUrl("https://localhost:9001/credentials/submit", "http://localhost:9001")).toBe(false);
    expect(isAllowedSubmitUrl("not a url", "http://localhost:9001")).toBe(false);
    expect(isAllowedSubmitUrl("http://localhost:9001/x", undefined)).toBe(false);
  });
});

describe("mapSubmitResponse", () => {
  it("maps outcomes", () => {
    expect(mapSubmitResponse(200, { ok: true })).toEqual({ kind: "success" });
    expect(mapSubmitResponse(401, { ok: false, error: "nonce expired" })).toEqual({ kind: "expired" });
    expect(mapSubmitResponse(400, { ok: false, error: "validation failed: bad key" })).toEqual({
      kind: "error",
      message: "validation failed: bad key",
    });
    expect(mapSubmitResponse(500, null)).toEqual({ kind: "error", message: "HTTP 500" });
  });
});
```

Also add to `components/message-renderer-tool-data.test.ts` (inside the `computeUntypedToolData` describe):

```typescript
  it("passes a credentialRequest short-circuit output through with ok=true", () => {
    const output = {
      credentialRequest: {
        provider: "moco",
        fields: [],
        submitUrl: "http://localhost:9001/credentials/submit",
        nonce: "n",
      },
      result: null,
    };
    const part = toolPart({ output });
    const data = computeUntypedToolData(part);
    expect(data.ok).toBe(true);
    expect((data.part.output as any).credentialRequest.provider).toBe("moco");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run app/\(application\)/chat/components/credential-request-data.test.ts components/message-renderer-tool-data.test.ts`
Expected: the new module's tests FAIL (module not found). The `computeUntypedToolData` test is expected to PASS already (a `null` result is not an unparseable string). If it FAILS instead, add a guard at the top of `computeUntypedToolData` in `components/message-renderer-tool-data.ts`, before any `output.result` parsing, returning the same shape its success path returns with the part untouched:

```typescript
  // credentialRequest short-circuits carry result: null by contract
  // (spec 2026-07-22 §2.2) — they must reach the untyped tool renderer.
  const rawOutput = (part as { output?: unknown }).output;
  if (rawOutput && typeof rawOutput === "object" && (rawOutput as any).credentialRequest) {
    return { ok: true, part, reasoning: [], metricsLine: null } as ReturnType<
      typeof computeUntypedToolData
    >;
  }
```

(Match the field names/defaults of the function's existing success return exactly — read the function before applying.)

- [ ] **Step 3: Implement the module**

Create `app/(application)/chat/components/credential-request-data.ts`:

```typescript
/**
 * Pure logic for the in-chat credential form (spec — backend repo —
 * docs/superpowers/specs/2026-07-22-tool-credentials-chat-ui-design.md §2).
 * Extracted per the repo's pure-module test convention: detection of auth
 * short-circuit payloads on tool parts, the submitUrl origin rule (§2.3),
 * and submit-response mapping. No React, no fetch.
 */
import type { DynamicToolUIPart } from "ai";

export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  help?: string;
}

export interface CredentialRequestPayload {
  provider: string;
  fields: CredentialField[];
  submitUrl: string;
  nonce: string;
}

export interface OauthRequestPayload {
  authorizationUrl: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Auth short-circuits only ever surface on the FINAL tool output. */
export function extractCredentialRequest(
  part: DynamicToolUIPart,
): CredentialRequestPayload | null {
  if (part.state !== "output-available") return null;
  const output = (part as { output?: unknown }).output;
  if (!isRecord(output) || !isRecord(output.credentialRequest)) return null;
  const cr = output.credentialRequest;
  if (
    typeof cr.provider !== "string" ||
    typeof cr.submitUrl !== "string" ||
    typeof cr.nonce !== "string" ||
    !Array.isArray(cr.fields)
  ) {
    return null;
  }
  return cr as unknown as CredentialRequestPayload;
}

export function extractOauthRequest(part: DynamicToolUIPart): OauthRequestPayload | null {
  if (part.state !== "output-available") return null;
  const output = (part as { output?: unknown }).output;
  if (!isRecord(output) || !isRecord(output.oauth)) return null;
  const url = output.oauth.authorizationUrl;
  return typeof url === "string" && url.length > 0 ? { authorizationUrl: url } : null;
}

/**
 * Security rule (spec §2.3): submitUrl arrives via a tool result — model/
 * tool-influenced data. The session JWT and the secrets may only ever be
 * POSTed to the configured backend origin.
 */
export function isAllowedSubmitUrl(
  submitUrl: string,
  configBackend: string | undefined | null,
): boolean {
  if (!configBackend) return false;
  try {
    return new URL(submitUrl).origin === new URL(configBackend).origin;
  } catch {
    return false;
  }
}

export type SubmitOutcome =
  | { kind: "success" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export function mapSubmitResponse(
  status: number,
  body: { ok?: boolean; error?: string } | null,
): SubmitOutcome {
  if (status === 200 && body?.ok) return { kind: "success" };
  const error = body?.error ?? `HTTP ${status}`;
  if (status === 401 && /expired/i.test(error)) return { kind: "expired" };
  return { kind: "error", message: error };
}
```

- [ ] **Step 4: Run to verify pass, commit**

Run: `npx vitest run app/\(application\)/chat/components/credential-request-data.test.ts components/message-renderer-tool-data.test.ts` → PASS.

```bash
git add "app/(application)/chat/components/credential-request-data.ts" "app/(application)/chat/components/credential-request-data.test.ts" components/message-renderer-tool-data.test.ts
git commit -m "feat(chat): pure logic for credential-request detection, origin rule, submit mapping

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Include `components/message-renderer-tool-data.ts` in the add if the Step 2 contingency was needed.)

---

### Task B2: CredentialRequestCard + OauthConnectCard + i18n keys

**Files:**
- Create: `app/(application)/chat/components/credential-request-card.tsx`
- Modify: `messages/en.json` (inside the top-level `"chat"` object, new `"credentials"` key — alphabetical position after `"context"`-like keys; keep keys sorted)
- Modify: `messages/de.json` (same structure)

**Interfaces:**
- Consumes: everything from B1; `ConfigContext` (`@/components/shell/config-context`); `getToken` (`@/lib/api/client`).
- Produces (consumed by B3): `CredentialRequestCard({ payload, onSubmitted })`, `OauthConnectCard({ payload, providerLabel, onSubmitted })`, `CredentialGuestNotice()` — all exported from `credential-request-card.tsx`. `onSubmitted: (provider: string) => void` fires only after confirmed success (form) or the explicit "I've connected" click (oauth).

- [ ] **Step 1: Add the i18n keys**

In `messages/en.json`, inside `"chat"` (alphabetized among its siblings):

```json
    "credentials": {
      "badOrigin": "This credential request points at an unexpected server and was blocked. Contact your administrator.",
      "connectTitle": "Connect {provider}",
      "connectDescription": "This tool needs access to your {provider} account. Your values are stored encrypted and are never shown to the AI model.",
      "connected": "Connected to {provider}",
      "expired": "This form expired. Ask the agent to try again — it will show a fresh form.",
      "guestNotice": "This tool needs credentials. Sign in to the main Exulu app to connect it.",
      "noSession": "No active session — sign in again to submit credentials.",
      "oauthConnect": "Connect",
      "oauthDescription": "This tool needs authorization. Connect your account in the new tab, then come back here.",
      "oauthDone": "I've connected — retry",
      "required": "Required",
      "resumeMessage": "{provider} credentials saved — please retry.",
      "submit": "Save & retry",
      "submitting": "Checking…"
    },
```

In `messages/de.json`, same position:

```json
    "credentials": {
      "badOrigin": "Diese Zugangsdaten-Anfrage zeigt auf einen unerwarteten Server und wurde blockiert. Bitte Administrator kontaktieren.",
      "connectTitle": "{provider} verbinden",
      "connectDescription": "Dieses Tool benötigt Zugriff auf dein {provider}-Konto. Deine Werte werden verschlüsselt gespeichert und dem KI-Modell nie angezeigt.",
      "connected": "Mit {provider} verbunden",
      "expired": "Dieses Formular ist abgelaufen. Bitte den Agenten erneut fragen — es erscheint ein neues Formular.",
      "guestNotice": "Dieses Tool benötigt Zugangsdaten. Melde dich in der Exulu-Hauptanwendung an, um es zu verbinden.",
      "noSession": "Keine aktive Sitzung — bitte erneut anmelden, um Zugangsdaten zu übermitteln.",
      "oauthConnect": "Verbinden",
      "oauthDescription": "Dieses Tool benötigt eine Autorisierung. Verbinde dein Konto im neuen Tab und komm dann hierher zurück.",
      "oauthDone": "Verbunden — erneut versuchen",
      "required": "Erforderlich",
      "resumeMessage": "{provider}-Zugangsdaten gespeichert — bitte erneut versuchen.",
      "submit": "Speichern & erneut versuchen",
      "submitting": "Prüfe…"
    },
```

Run: `npm run check-messages` → PASS (key parity between locales).

- [ ] **Step 2: Implement the cards**

Create `app/(application)/chat/components/credential-request-card.tsx`:

```tsx
"use client";

/**
 * In-chat credential form + OAuth connect button (spec — backend repo —
 * docs/superpowers/specs/2026-07-22-tool-credentials-chat-ui-design.md §2).
 * Renders in the makeUntypedToolPart slot (message-column.tsx), sibling of
 * ToolCallApproval. Secrets flow browser → backend only: the submitUrl is
 * origin-validated against config.backend before anything is POSTed
 * (§2.3), values are never toasted/logged, and the collapsed success row
 * follows the QuestionAsk submitted-state pattern (§2.4).
 */

import { CheckCircle2, ExternalLink, KeyRound, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useForm } from "react-hook-form";

import { ConfigContext } from "@/components/shell/config-context";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getToken } from "@/lib/api/client";
import { cn } from "@/lib/utils";

import {
  isAllowedSubmitUrl,
  mapSubmitResponse,
  type CredentialRequestPayload,
  type OauthRequestPayload,
  type SubmitOutcome,
} from "./credential-request-data";

/** Compact success row — the QuestionAsk collapsed-state pattern. */
function ConnectedRow({ provider }: { provider: string }) {
  const t = useTranslations("chat");
  return (
    <div
      role="status"
      className="mt-3 flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2"
    >
      <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
      <span className="text-sm">{t("credentials.connected", { provider })}</span>
    </div>
  );
}

/** Blocked-origin / terminal error row. */
function BlockedRow({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
    >
      <ShieldAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span className="text-sm text-destructive">{message}</span>
    </div>
  );
}

/** Public-surface notice (spec §4): never render the form for guests. */
export function CredentialGuestNotice() {
  const t = useTranslations("chat");
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="text-sm text-muted-foreground">{t("credentials.guestNotice")}</span>
    </div>
  );
}

export interface CredentialRequestCardProps {
  payload: CredentialRequestPayload;
  /** Fires once after a confirmed 200 {ok:true} — B3 sends the resume message. */
  onSubmitted: (provider: string) => void;
}

export function CredentialRequestCard({ payload, onSubmitted }: CredentialRequestCardProps) {
  const t = useTranslations("chat");
  const config = React.useContext(ConfigContext);

  const [submitted, setSubmitted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [outcome, setOutcome] = React.useState<SubmitOutcome | null>(null);

  const defaultValues = React.useMemo(
    () => Object.fromEntries(payload.fields.map((field) => [field.name, ""])),
    [payload.fields],
  );
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Record<string, string>>({ defaultValues });

  if (submitted) return <ConnectedRow provider={payload.provider} />;

  // §2.3: tool results are untrusted input — never POST the JWT or secrets
  // anywhere but the configured backend origin.
  if (!isAllowedSubmitUrl(payload.submitUrl, config?.backend)) {
    return <BlockedRow message={t("credentials.badOrigin")} />;
  }

  if (outcome?.kind === "expired") {
    return <BlockedRow message={t("credentials.expired")} />;
  }

  const doSubmit = async (values: Record<string, string>) => {
    setSubmitting(true);
    setOutcome(null);
    try {
      const token = await getToken();
      if (!token) {
        setOutcome({ kind: "error", message: t("credentials.noSession") });
        return;
      }
      const res = await fetch(payload.submitUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ nonce: payload.nonce, values }),
      });
      const body = await res.json().catch(() => null);
      const mapped = mapSubmitResponse(res.status, body);
      if (mapped.kind === "success") {
        setSubmitted(true);
        onSubmitted(payload.provider);
      } else {
        setOutcome(mapped);
      }
    } catch (err) {
      setOutcome({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="mt-3 border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden="true" />
          {t("credentials.connectTitle", { provider: payload.provider })}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("credentials.connectDescription", { provider: payload.provider })}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form
          className="flex flex-col gap-3"
          onSubmit={handleSubmit(doSubmit)}
          autoComplete="off"
        >
          {payload.fields.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <Label htmlFor={`cred-${payload.provider}-${field.name}`}>
                {field.label} <span className="text-destructive">*</span>
              </Label>
              <Input
                id={`cred-${payload.provider}-${field.name}`}
                type={field.type === "password" ? "password" : "text"}
                placeholder={field.placeholder}
                autoComplete="off"
                aria-invalid={Boolean(errors[field.name])}
                {...register(field.name, { required: t("credentials.required") })}
              />
              {field.help ? (
                <p className="text-xs text-muted-foreground">{field.help}</p>
              ) : null}
              {errors[field.name] ? (
                <p className="text-xs text-destructive">{errors[field.name]?.message}</p>
              ) : null}
            </div>
          ))}
          {outcome?.kind === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {outcome.message}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" disabled={submitting} className={cn("h-11 sm:h-9")}>
              {submitting ? t("credentials.submitting") : t("credentials.submit")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export interface OauthConnectCardProps {
  payload: OauthRequestPayload;
  /** Humanized tool/provider label for the title. */
  providerLabel: string;
  onSubmitted: (provider: string) => void;
}

export function OauthConnectCard({ payload, providerLabel, onSubmitted }: OauthConnectCardProps) {
  const t = useTranslations("chat");
  const [done, setDone] = React.useState(false);

  if (done) return <ConnectedRow provider={providerLabel} />;

  return (
    <Card className="mt-3 border-border bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden="true" />
          {t("credentials.connectTitle", { provider: providerLabel })}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t("credentials.oauthDescription")}</p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            className="h-11 sm:h-9"
            onClick={() => window.open(payload.authorizationUrl, "_blank", "noopener")}
          >
            <ExternalLink className="size-4" aria-hidden="true" />
            {t("credentials.oauthConnect")}
          </Button>
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            onClick={() => {
              setDone(true);
              onSubmitted(providerLabel);
            }}
          >
            {t("credentials.oauthDone")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Lint and commit**

Run: `npx eslint "app/(application)/chat/components/credential-request-card.tsx"` → clean.
Run: `npm run check-messages` → PASS.

```bash
git add "app/(application)/chat/components/credential-request-card.tsx" messages/en.json messages/de.json
git commit -m "feat(chat): credential form card, oauth connect card, guest notice

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task B3: Wire the cards into makeUntypedToolPart + guest gating + resume

**Files:**
- Modify: `app/(application)/chat/components/message-column.tsx`
- Modify: `app/public/agents/[id]/components/public-chat-screen.tsx` (the `<MessageColumn controller={controller} />` line in PublicChatBody)

**Interfaces:**
- Consumes: B1 extractors, B2 cards, `controller.sendUserMessage`, `t("credentials.resumeMessage")`.
- Produces: `MessageColumnProps` gains optional `guestMode?: boolean` (default false). `makeUntypedToolPart` signature becomes `makeUntypedToolPart(onApproveForChat, onCredentialResume, guestMode)`.

- [ ] **Step 1: Extend MessageColumn**

In `app/(application)/chat/components/message-column.tsx`:

1. Add imports:

```tsx
import {
  CredentialGuestNotice,
  CredentialRequestCard,
  OauthConnectCard,
} from "./credential-request-card";
import {
  extractCredentialRequest,
  extractOauthRequest,
} from "./credential-request-data";
```

2. Extend the props interface:

```tsx
export interface MessageColumnProps {
  controller: ChatSessionController;
  /** Public /public/agents surfaces: credential/oauth short-circuits render
   *  a sign-in notice instead of the live form (spec §4 — guests must never
   *  receive a usable nonce flow, and the public page keeps the JWT
   *  server-side so a submit could not authenticate anyway). */
  guestMode?: boolean;
}
```

3. Change the factory signature and add the branch AFTER the approval-state check (approval precedes the short-circuit chronologically; when the part reaches `output-available` the approval branch no longer matches):

```tsx
function makeUntypedToolPart(
  onApproveForChat: (toolId: string) => void,
  onCredentialResume: (provider: string) => void,
  guestMode: boolean,
) {
  const UntypedToolPart = ({
    agent: _agent,
    untypedToolPart,
    callId,
    addToContext: _addToContext,
    addToolApprovalResponse,
  }: {
    agent: Agent;
    untypedToolPart: DynamicToolUIPart;
    callId: string;
    addToContext: (item: string) => void;
    addToolApprovalResponse: ChatAddToolApproveResponseFunction;
  }) => {
    // ... existing styleToolName lines unchanged ...

    if (
      untypedToolPart?.state === "approval-requested" ||
      untypedToolPart?.state === "approval-responded"
    ) {
      return (
        <ToolCallApproval
          part={untypedToolPart}
          addToolApprovalResponse={addToolApprovalResponse}
          onApproveForChat={onApproveForChat}
        />
      );
    }

    // Auth short-circuits (spec §2.2): render the credential form / connect
    // button instead of the generic collapsed Tool block. Never for guests.
    const credentialRequest = extractCredentialRequest(untypedToolPart);
    const oauthRequest = credentialRequest ? null : extractOauthRequest(untypedToolPart);
    if (credentialRequest || oauthRequest) {
      if (guestMode) {
        return <CredentialGuestNotice key={callId} />;
      }
      return credentialRequest ? (
        <CredentialRequestCard
          key={callId}
          payload={credentialRequest}
          onSubmitted={onCredentialResume}
        />
      ) : (
        <OauthConnectCard
          key={callId}
          payload={oauthRequest!}
          providerLabel={styleToolName}
          onSubmitted={onCredentialResume}
        />
      );
    }

    return (
      // ... existing collapsed Tool block unchanged ...
```

4. In the `MessageColumn` component, accept the prop, build the resume callback, and update the memo:

```tsx
export function MessageColumn({ controller, guestMode = false }: MessageColumnProps) {
  const t = useTranslations("chat");
  // ... existing code ...

  // §2.4 auto-resume: one visible follow-up user message via the existing
  // transport (the question_ask pattern) — the model re-invokes the tool,
  // which now finds stored credentials.
  const handleCredentialResume = React.useCallback(
    (provider: string) => {
      void controller.sendUserMessage(t("credentials.resumeMessage", { provider }));
    },
    [controller.sendUserMessage, t],
  );

  const UntypedToolPartComponent = useMemo(
    () =>
      makeUntypedToolPart(
        controller.approveToolForChat,
        handleCredentialResume,
        guestMode,
      ),
    [controller.approveToolForChat, handleCredentialResume, guestMode],
  );
```

(Add `import * as React from "react"` only if `React.useCallback` is not already importable — the file imports `useContext, useMemo, useState` from `react`; extend that import with `useCallback` and use it unprefixed.)

- [ ] **Step 2: Gate the public surface**

In `app/public/agents/[id]/components/public-chat-screen.tsx`, PublicChatBody, change:

```tsx
          <MessageColumn controller={controller} />
```

to:

```tsx
          {/* guestMode: credential/oauth short-circuits render a sign-in
              notice, never the live form (spec §4). */}
          <MessageColumn controller={controller} guestMode />
```

- [ ] **Step 3: Verify build + tests**

Run: `npx eslint "app/(application)/chat/components/message-column.tsx" "app/public/agents/[id]/components/public-chat-screen.tsx"` → clean.
Run: `npm test` → PASS.
Run: `npm run build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add "app/(application)/chat/components/message-column.tsx" "app/public/agents/[id]/components/public-chat-screen.tsx"
git commit -m "feat(chat): render credential form / connect button for auth short-circuits

makeUntypedToolPart branch (the ToolCallApproval slot) with guestMode
gating on public surfaces and question_ask-style auto-resume on submit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task B4: ToolCallChip redaction (nested/reasoning-step tool chips)

Today `ToolCallChip`'s expanded view prints nothing for credentialRequest outputs only because `result` is `null` — make redaction a contract, not luck.

**Files:**
- Modify: `components/message-renderer.tsx` (the `parseToolOutput` helper, ~line 1399)

- [ ] **Step 1: Add the redaction to parseToolOutput**

In `components/message-renderer.tsx`, at the top of `parseToolOutput` (before the `output == null` check's siblings — as the FIRST object-shape check):

```typescript
const parseToolOutput = (output: any): any => {
  if (output == null) return null;
  // Auth short-circuit payloads (nonce + submitUrl) must never render in a
  // chip — the credential card owns this shape (spec 2026-07-22 §2.2).
  if (typeof output === 'object' && (output.credentialRequest || output.oauth?.authorizationUrl)) {
    return null;
  }
  // ... existing logic unchanged ...
```

- [ ] **Step 2: Verify and commit**

Run: `npm test` → PASS. Run: `npx eslint components/message-renderer.tsx` → clean.

```bash
git add components/message-renderer.tsx
git commit -m "fix(chat): ToolCallChip redacts auth short-circuit payloads by contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task B5: Settings — Connections section

**Files:**
- Create: `lib/credentials.ts`
- Test: `lib/credentials.test.ts`
- Create: `app/(application)/settings/components/connections-section.tsx`
- Modify: `app/(application)/settings/components/settings-view.tsx` (add `<ConnectionsSection />` after `<UsageSection />`)
- Modify: `messages/en.json` + `messages/de.json` (`settings.connections.*`)

**Interfaces:**
- Consumes: `GET /credentials` / `DELETE /credentials/:provider` (Task A3), `request()` from `@/lib/api/client`.
- Produces: `credentialsApi.list(): Promise<StoredCredential[]>`, `credentialsApi.remove(provider)`, `useStoredCredentials()` hook, `ConnectionsSection` component.

- [ ] **Step 1: Write the failing test for the pure parts**

Create `lib/credentials.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { parseCredentialsResponse } from "./credentials";

describe("parseCredentialsResponse", () => {
  it("extracts the credentials array", () => {
    const list = parseCredentialsResponse({
      ok: true,
      credentials: [
        {
          provider: "moco",
          authType: "user_credentials",
          createdAt: "2026-07-22T10:00:00.000Z",
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.provider).toBe("moco");
  });

  it("returns [] for null/malformed responses", () => {
    expect(parseCredentialsResponse(null)).toEqual([]);
    expect(parseCredentialsResponse({ ok: true })).toEqual([]);
    expect(parseCredentialsResponse({ ok: true, credentials: "nope" })).toEqual([]);
  });
});
```

Run: `npx vitest run lib/credentials.test.ts` → FAIL (module not found).

- [ ] **Step 2: Implement lib/credentials.ts**

```typescript
/**
 * Stored tool credentials for the /settings Connections section (spec —
 * backend repo — 2026-07-22-tool-credentials-chat-ui-design.md §3).
 * Metadata only; values never reach the client. Mirrors the lib/my-usage.ts
 * REST-hook pattern (no react-query in this repo).
 */
import * as React from "react";

import { request } from "@/lib/api/client";

export interface StoredCredential {
  provider: string;
  authType: "oauth" | "user_credentials";
  createdAt: string;
  updatedAt: string;
}

export function parseCredentialsResponse(json: unknown): StoredCredential[] {
  if (
    !json ||
    typeof json !== "object" ||
    !Array.isArray((json as { credentials?: unknown }).credentials)
  ) {
    return [];
  }
  return (json as { credentials: StoredCredential[] }).credentials;
}

export const credentialsApi = {
  list: async (): Promise<StoredCredential[]> =>
    parseCredentialsResponse(await request("/credentials", "GET")),
  remove: async (provider: string): Promise<void> => {
    await request(`/credentials/${encodeURIComponent(provider)}`, "DELETE");
  },
};

export interface UseStoredCredentialsResult {
  data: StoredCredential[] | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useStoredCredentials(): UseStoredCredentialsResult {
  const [data, setData] = React.useState<StoredCredential[] | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<Error | null>(null);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const list = await credentialsApi.list();
        if (cancelled) return;
        setData(list);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refetch = React.useCallback(() => setTick((n) => n + 1), []);

  return { data, loading, error, refetch };
}
```

Run: `npx vitest run lib/credentials.test.ts` → PASS.

- [ ] **Step 3: Add i18n keys**

`messages/en.json`, inside `"settings"` (alphabetized — after `"appearance"`):

```json
    "connections": {
      "connectedOn": "Connected {date}",
      "description": "Tool credentials you have saved. Revoking one makes the tool ask again in chat.",
      "empty": "No connected tools yet — tools will ask for credentials in chat when they need them.",
      "error": "Couldn't load your connections.",
      "retry": "Retry",
      "revoke": "Revoke",
      "revokeConfirmAction": "Revoke",
      "revokeConfirmDescription": "The stored credentials for {provider} are deleted. The next time a tool needs them, the form appears again in chat.",
      "revokeConfirmTitle": "Revoke {provider}?",
      "revokedTitle": "Credentials revoked",
      "revokeErrorTitle": "Couldn't revoke credentials",
      "title": "Connections"
    },
```

`messages/de.json`, same position:

```json
    "connections": {
      "connectedOn": "Verbunden am {date}",
      "description": "Gespeicherte Tool-Zugangsdaten. Nach dem Widerruf fragt das Tool im Chat erneut.",
      "empty": "Noch keine verbundenen Tools — Tools fragen im Chat nach Zugangsdaten, wenn sie sie brauchen.",
      "error": "Deine Verbindungen konnten nicht geladen werden.",
      "retry": "Erneut versuchen",
      "revoke": "Widerrufen",
      "revokeConfirmAction": "Widerrufen",
      "revokeConfirmDescription": "Die gespeicherten Zugangsdaten für {provider} werden gelöscht. Wenn ein Tool sie das nächste Mal braucht, erscheint das Formular erneut im Chat.",
      "revokeConfirmTitle": "{provider} widerrufen?",
      "revokedTitle": "Zugangsdaten widerrufen",
      "revokeErrorTitle": "Zugangsdaten konnten nicht widerrufen werden",
      "title": "Verbindungen"
    },
```

Run: `npm run check-messages` → PASS.

- [ ] **Step 4: Implement the section**

Create `app/(application)/settings/components/connections-section.tsx`:

```tsx
"use client";

/**
 * /settings § Connections — stored tool credentials, metadata + revoke only
 * (spec — backend repo — 2026-07-22-tool-credentials-chat-ui-design.md §3).
 * UsageSection pattern: self-contained, brings its own leading Separator.
 * Page rules respected: FormSection + Separator, zero Cards, no new primary
 * elements (Revoke is outline + text-destructive). Values are never shown —
 * there is nothing to reveal, only revoke.
 */

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/primitives/confirm-dialog";
import { FormSection } from "@/components/primitives/form-section";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  credentialsApi,
  useStoredCredentials,
  type StoredCredential,
} from "@/lib/credentials";

export function ConnectionsSection() {
  const t = useTranslations("settings");
  const { data, loading, error, refetch } = useStoredCredentials();
  const [revokeTarget, setRevokeTarget] = React.useState<StoredCredential | null>(null);
  const [revoking, setRevoking] = React.useState(false);

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await credentialsApi.remove(revokeTarget.provider);
      toast.success(t("connections.revokedTitle"), { duration: 3000 });
      setRevokeTarget(null);
      refetch();
    } catch (err) {
      toast.error(t("connections.revokeErrorTitle"), {
        description: err instanceof Error ? err.message : String(err),
        duration: 5000,
      });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <Separator />
      <FormSection
        id="connections"
        className="scroll-mt-24"
        title={t("connections.title")}
        description={t("connections.description")}
      >
        {error ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">{t("connections.error")}</p>
            <Button variant="outline" size="sm" onClick={refetch}>
              {t("connections.retry")}
            </Button>
          </div>
        ) : loading || data === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("connections.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.map((credential) => (
              <li
                key={credential.provider}
                className="flex items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{credential.provider}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("connections.connectedOn", {
                      date: new Date(credential.updatedAt).toLocaleDateString(),
                    })}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="h-11 text-destructive hover:text-destructive md:h-8"
                  onClick={() => setRevokeTarget(credential)}
                >
                  {t("connections.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </FormSection>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t("connections.revokeConfirmTitle", {
          provider: revokeTarget?.provider ?? "",
        })}
        description={t("connections.revokeConfirmDescription", {
          provider: revokeTarget?.provider ?? "",
        })}
        actionLabel={t("connections.revokeConfirmAction")}
        onConfirm={confirmRevoke}
        loading={revoking}
      />
    </>
  );
}
```

NOTE: before writing the `ConfirmDialog` usage, read `components/primitives/confirm-dialog.tsx` and match its actual prop names (`actionLabel`/`onConfirm`/`loading` may differ — e.g. `confirmLabel`, `onAction`, `pending`). Use the props exactly as that component defines them; the settings Language control already uses it as a reference call site.

- [ ] **Step 5: Mount it in settings-view**

In `app/(application)/settings/components/settings-view.tsx`, add the import and mount after `<UsageSection />`:

```tsx
import { ConnectionsSection } from "./connections-section";
```

```tsx
        <UsageSection />

        <ConnectionsSection />
```

- [ ] **Step 6: Verify, commit**

Run: `npx vitest run lib/credentials.test.ts` → PASS.
Run: `npm run check-messages` → PASS.
Run: `npm run build` → succeeds.

```bash
git add lib/credentials.ts lib/credentials.test.ts "app/(application)/settings/components/connections-section.tsx" "app/(application)/settings/components/settings-view.tsx" messages/en.json messages/de.json
git commit -m "feat(settings): Connections section — list and revoke stored tool credentials

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task B6: Frontend verification + end-to-end UAT gate

**Files:** none (verification only)

- [ ] **Step 1: Full frontend gates**

Run in `../frontend-tool-credentials`: `npm test` → PASS; `npm run lint` → clean (no NEW warnings vs. main); `npm run build` → succeeds.

- [ ] **Step 2: End-to-end UAT with the moco tools (manual, with Daniel's ai.open stack)**

Prerequisites: Part A branch built into the backend the ai.open stack loads (`@exulu/backend` symlink → rebuild dist + restart server), frontend dev server running from the B worktree.

Checklist:
1. New chat with the moco agent → "list my moco activities from last week" → approval card → approve → **credential form card renders** (Moco subdomain + masked API key, help texts visible).
2. LiteLLM spend logs: the tool message for that turn contains the scrub text, NOT the nonce/submitUrl (`docker exec pgvector-db psql -U postgres -d litellm -c "SELECT ..."` on the latest row).
3. Submit wrong credentials → inline error, values preserved. Submit right ones → collapsed "Connected to moco" row + visible resume message + the agent retries and answers with real activities.
4. Follow-up turn in the same chat: model view (spend logs) still free of nonce/submitUrl (history scrub).
5. /settings → Connections lists "moco" → Revoke → next moco request in chat re-prompts the form.
6. Public agent page with the same agent (guest mode): credential request renders the sign-in notice, never the form.

- [ ] **Step 3: Report**

Do not merge or push — summarize both branches, remaining risks, and the UAT results for Daniel.

---

## Self-review checklist (for the plan author, completed)

- Spec coverage: §1.1→A1, §1.2→A4+A5+A6, §1.3→A3, §1.4→A2 (+ nonce/MCP accepted limitations need no task), §2.1–2.4→B1+B2+B3, §2.5→B2/B3 (OauthConnectCard), §3→B5, §4→B3 (guestMode) + B2 (notice), §5→cross-cutting (origin rule B1/B2, no-log constraint global), §6→A1 integration test, A3–A6 unit tests, B1/B5 pure tests, B6 UAT.
- No placeholders; every code step contains the code. Two explicitly-bounded read-before-write points (computeUntypedToolData contingency in B1 Step 2; ConfirmDialog props in B5 Step 4).
- Type consistency: `credentialStore.listByUser` (A1) matches A3's handler and B5's `StoredCredential` (dates serialize to ISO strings over JSON); `makeUntypedToolPart(onApproveForChat, onCredentialResume, guestMode)` consistent between B3 steps; scrub-text exports match A4/A5 imports.
