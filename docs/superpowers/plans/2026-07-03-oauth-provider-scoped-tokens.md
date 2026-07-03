# OAuth Provider-Scoped Tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move OAuth token storage in `@exulu/backend` from `(tool_id, user_id)` to `(provider, user_id)` so tools sharing a provider share a single consent per user.

**Architecture:** Add an optional `provider: string` to `ExuluOauthConfig`. Every hop that used `toolId` as the storage key now derives `providerKey = providerKeyFor(toolId, config) = config.provider ?? toolId`. `oauth_tokens` gains a `provider` column that becomes the key; the existing `tool_id` column stays for audit. A one-boot backfill (`provider ← tool_id`) preserves all existing user tokens.

**Tech Stack:** TypeScript, Node, Jest (ts-jest), Knex/PostgreSQL, AES-encrypted at-rest tokens.

## Global Constraints

- 2-space indentation (matches every existing file under `src/exulu/oauth/`).
- Every `*.test.ts` file uses Jest with the mocking style shown in `src/exulu/oauth/token-store.test.ts` and `flow.test.ts` (in-file `jest.mock(...)` before the SUT import).
- Never expose `client_secret` in error messages, logs, or thrown text.
- Never overwrite a stored `refresh_token` with a nullish value (Google only sends it on first consent — see current `token-store.ts:44-48`).
- Backward compatible: any tool that omits `oauth.provider` must behave exactly as it does today. `providerKey` for such a tool is its `id`.
- Idempotent migration: the boot-time backfill and index swap must be safe to run on a fresh DB, a DB with mixed old/new rows, and a DB that has already been migrated.
- Commit style: conventional commits (`feat(oauth):`, `refactor(oauth):`, `test(oauth):`), imperative subject, 72-char max.

---

## File Structure

```
src/exulu/oauth/
  types.ts                    # MODIFY — add optional provider?: string
  provider-key.ts             # CREATE — providerKeyFor(toolId, config)
  provider-key.test.ts        # CREATE
  registry.ts                 # REWRITE — byProvider + byTool maps, assertCompatible
  registry.test.ts            # CREATE
  token-store.ts              # MODIFY — key by (provider, user_id); upsert takes toolId for audit
  token-store.test.ts         # MODIFY — reflect new signatures
  flow.ts                     # MODIFY — OauthState.provider; getValidAccessToken({providerKey, ...})
  flow.test.ts                # MODIFY — provider in state; token store mock args
  wrap-execute.ts             # MODIFY — derive providerKey, pass to flow
  wrap-execute.test.ts        # MODIFY — no functional change externally; internal expectations shift
  callback-handler.ts         # MODIFY — resolve by state.provider; upsert with providerKey + toolId
  callback-handler.test.ts    # MODIFY — reflect new state shape
  validate.ts                 # (no change — provider is optional; no new required fields)
src/postgres/
  core-schema.ts              # MODIFY — add provider field to oauthTokensSchema
  init-exulu-db.ts            # MODIFY — backfill provider column + swap unique index
```

Every task ends with an independently testable deliverable and the codebase compiles at every commit boundary.

---

## Task 1: Add `provider` field and `providerKeyFor` helper

Introduces the new concept without wiring it anywhere. Callers still pass `toolId` everywhere; nothing observable changes.

**Files:**
- Modify: `src/exulu/oauth/types.ts`
- Create: `src/exulu/oauth/provider-key.ts`
- Create: `src/exulu/oauth/provider-key.test.ts`

**Interfaces:**
- Consumes: `ExuluOauthConfig` from `./types`
- Produces:
  - `ExuluOauthConfig.provider?: string`
  - `providerKeyFor(toolId: string, config: ExuluOauthConfig): string`

- [ ] **Step 1: Write the failing test — `src/exulu/oauth/provider-key.test.ts`**

```ts
import type { ExuluOauthConfig } from "./types";
import { providerKeyFor } from "./provider-key";

const baseConfig: ExuluOauthConfig = {
  authorizationUrl: "https://p.example/authorize",
  tokenUrl: "https://p.example/token",
  clientId: "cid",
  clientSecret: "sec",
  scopes: [],
};

describe("providerKeyFor", () => {
  it("returns config.provider when set", () => {
    expect(providerKeyFor("some_tool", { ...baseConfig, provider: "acme" })).toBe("acme");
  });

  it("falls back to toolId when provider is undefined", () => {
    expect(providerKeyFor("google_calendar", baseConfig)).toBe("google_calendar");
  });

  it("falls back to toolId when provider is an empty string", () => {
    expect(providerKeyFor("google_calendar", { ...baseConfig, provider: "" })).toBe("google_calendar");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/oauth/provider-key.test.ts`
Expected: FAIL — `Cannot find module './provider-key'`.

- [ ] **Step 3: Add `provider?: string` to `ExuluOauthConfig`**

Edit `src/exulu/oauth/types.ts`. Insert the following block immediately after the opening `export type ExuluOauthConfig = {` and before the existing `authorizationUrl` field:

```ts
  /**
   * Identifier for the OAuth provider (e.g., "google", "jira", "github").
   * Tools sharing the same provider share tokens under (provider, userId) —
   * one consent screen per provider per user instead of per tool. When
   * omitted, defaults to the tool's `id`, preserving per-tool behavior for
   * tools that don't opt in.
   */
  provider?: string;
```

- [ ] **Step 4: Implement `src/exulu/oauth/provider-key.ts`**

```ts
import type { ExuluOauthConfig } from "./types";

/**
 * Resolves the token-storage key for a tool: the explicit provider name when
 * declared, otherwise the tool's own id (preserves legacy per-tool behavior).
 * Centralized here so no callsite forgets the fallback rule.
 */
export const providerKeyFor = (toolId: string, config: ExuluOauthConfig): string =>
  config.provider && config.provider.length > 0 ? config.provider : toolId;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/exulu/oauth/provider-key.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Verify the rest of the oauth suite still passes**

Run: `npx jest src/exulu/oauth`
Expected: All existing tests still green (type-only change; no runtime effect).

- [ ] **Step 7: Commit**

```bash
git add src/exulu/oauth/types.ts src/exulu/oauth/provider-key.ts src/exulu/oauth/provider-key.test.ts
git commit -m "feat(oauth): add provider field and providerKeyFor helper"
```

---

## Task 2: Registry — key by provider with `assertCompatible`

Rewrites `oauthRegistry` to index by provider AND by tool, and rejects at construction time when two tools claim the same provider but disagree on client/URLs/scopes. Keeps the existing `oauthRegistry.get(toolId)` API as an alias so `callback-handler.ts` compiles unchanged for now.

**Files:**
- Modify: `src/exulu/oauth/registry.ts`
- Create: `src/exulu/oauth/registry.test.ts`

**Interfaces:**
- Consumes: `ExuluOauthConfig` (Task 1); `providerKeyFor` (Task 1)
- Produces:
  - `oauthRegistry.register(toolId: string, config: ExuluOauthConfig): void` — throws when a later registration disagrees with an earlier one on the same provider
  - `oauthRegistry.getByProvider(providerKey: string): ExuluOauthConfig | undefined`
  - `oauthRegistry.getByTool(toolId: string): ExuluOauthConfig | undefined`
  - `oauthRegistry.get(toolId: string): ExuluOauthConfig | undefined` — alias for `getByTool`, deprecated but retained until Task 4
  - Test-only: `__resetOauthRegistryForTests(): void` (exported for the test file's `beforeEach`)

- [ ] **Step 1: Write the failing test — `src/exulu/oauth/registry.test.ts`**

```ts
import type { ExuluOauthConfig } from "./types";
import { __resetOauthRegistryForTests, oauthRegistry } from "./registry";

const baseConfig: ExuluOauthConfig = {
  authorizationUrl: "https://auth.example/authorize",
  tokenUrl: "https://auth.example/token",
  clientId: "cid",
  clientSecret: "sec",
  scopes: ["read:a", "write:b"],
};

beforeEach(() => {
  __resetOauthRegistryForTests();
});

describe("oauthRegistry.register", () => {
  it("registers a config keyed by toolId when provider is absent", () => {
    oauthRegistry.register("solo_tool", baseConfig);
    expect(oauthRegistry.getByTool("solo_tool")).toBe(baseConfig);
    expect(oauthRegistry.getByProvider("solo_tool")).toBe(baseConfig);
  });

  it("registers a config keyed by provider when set", () => {
    const cfg = { ...baseConfig, provider: "jira" };
    oauthRegistry.register("jira_search", cfg);
    expect(oauthRegistry.getByProvider("jira")).toBe(cfg);
    expect(oauthRegistry.getByTool("jira_search")).toBe(cfg);
  });

  it("shares a registry entry between two tools with the same provider and identical config", () => {
    const cfg = { ...baseConfig, provider: "jira" };
    oauthRegistry.register("jira_search", cfg);
    oauthRegistry.register("jira_get", { ...cfg });
    expect(oauthRegistry.getByTool("jira_search")).toBeDefined();
    expect(oauthRegistry.getByTool("jira_get")).toBeDefined();
    expect(oauthRegistry.getByProvider("jira")).toBeDefined();
  });

  it("throws when a second tool on the same provider disagrees on clientId", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        clientId: "different",
      }),
    ).toThrow(/oauth\.clientId disagrees.*provider "jira"/);
  });

  it("throws when a second tool on the same provider disagrees on clientSecret", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        clientSecret: "different",
      }),
    ).toThrow(/oauth\.clientSecret disagrees/);
  });

  it("throws when a second tool on the same provider disagrees on authorizationUrl", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        authorizationUrl: "https://other.example/authorize",
      }),
    ).toThrow(/oauth\.authorizationUrl disagrees/);
  });

  it("throws when a second tool on the same provider disagrees on tokenUrl", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        tokenUrl: "https://other.example/token",
      }),
    ).toThrow(/oauth\.tokenUrl disagrees/);
  });

  it("throws when a second tool on the same provider declares a different scope set", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        scopes: ["read:a"],
      }),
    ).toThrow(/oauth\.scopes disagrees/);
  });

  it("scope comparison is order-insensitive", () => {
    oauthRegistry.register("jira_search", {
      ...baseConfig,
      provider: "jira",
      scopes: ["read:a", "write:b"],
    });
    expect(() =>
      oauthRegistry.register("jira_get", {
        ...baseConfig,
        provider: "jira",
        scopes: ["write:b", "read:a"],
      }),
    ).not.toThrow();
  });

  it("re-registering the same toolId with identical config is a no-op", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(() =>
      oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" }),
    ).not.toThrow();
  });

  it("preserves the deprecated get() alias for existing callers", () => {
    oauthRegistry.register("jira_search", { ...baseConfig, provider: "jira" });
    expect(oauthRegistry.get("jira_search")).toBe(oauthRegistry.getByTool("jira_search"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/exulu/oauth/registry.test.ts`
Expected: FAIL — `__resetOauthRegistryForTests`, `getByProvider`, `getByTool` do not exist on `oauthRegistry`.

- [ ] **Step 3: Rewrite `src/exulu/oauth/registry.ts`**

Replace the entire file with:

```ts
import type { ExuluOauthConfig } from "./types";
import { providerKeyFor } from "./provider-key";

// Populated at ExuluTool construction time (tools are instantiated at app
// startup). Two indexes: byProvider is the storage key (multiple tools may
// point at one entry); byTool answers "which config governs this toolId".
type RegistryEntry = { config: ExuluOauthConfig; toolIds: Set<string> };
const byProvider = new Map<string, RegistryEntry>();
const byTool = new Map<string, string>(); // toolId -> providerKey

const STABLE_STRING_FIELDS = [
  "authorizationUrl",
  "tokenUrl",
  "clientId",
  "clientSecret",
] as const;

const assertCompatible = (
  providerKey: string,
  toolId: string,
  existing: ExuluOauthConfig,
  next: ExuluOauthConfig,
): void => {
  for (const field of STABLE_STRING_FIELDS) {
    if (existing[field] !== next[field]) {
      throw new Error(
        `ExuluTool "${toolId}": oauth.${field} disagrees with another tool that shares provider "${providerKey}". ` +
          `Every tool on the same provider must use identical authorizationUrl/tokenUrl/clientId/clientSecret.`,
      );
    }
  }
  const a = new Set(existing.scopes);
  const b = new Set(next.scopes);
  if (a.size !== b.size || [...a].some((s) => !b.has(s))) {
    throw new Error(
      `ExuluTool "${toolId}": oauth.scopes disagrees with another tool that shares provider "${providerKey}". ` +
        `Every tool on the same provider must declare the same scope superset. ` +
        `Existing: [${[...a].sort().join(", ")}]. This tool: [${[...b].sort().join(", ")}].`,
    );
  }
};

export const oauthRegistry = {
  register: (toolId: string, config: ExuluOauthConfig): void => {
    const providerKey = providerKeyFor(toolId, config);
    const existing = byProvider.get(providerKey);
    if (existing) {
      assertCompatible(providerKey, toolId, existing.config, config);
      existing.toolIds.add(toolId);
      byTool.set(toolId, providerKey);
      return;
    }
    byProvider.set(providerKey, { config, toolIds: new Set([toolId]) });
    byTool.set(toolId, providerKey);
  },
  getByProvider: (providerKey: string): ExuluOauthConfig | undefined =>
    byProvider.get(providerKey)?.config,
  getByTool: (toolId: string): ExuluOauthConfig | undefined => {
    const providerKey = byTool.get(toolId);
    return providerKey ? byProvider.get(providerKey)?.config : undefined;
  },
  // Deprecated alias retained until Task 4 removes the last caller.
  get: (toolId: string): ExuluOauthConfig | undefined => {
    const providerKey = byTool.get(toolId);
    return providerKey ? byProvider.get(providerKey)?.config : undefined;
  },
};

// Test-only. The registry is process-global; tests reset it in beforeEach.
export const __resetOauthRegistryForTests = (): void => {
  byProvider.clear();
  byTool.clear();
};
```

- [ ] **Step 4: Run registry tests**

Run: `npx jest src/exulu/oauth/registry.test.ts`
Expected: 11 tests pass.

- [ ] **Step 5: Run the full oauth suite**

Run: `npx jest src/exulu/oauth`
Expected: All prior tests still pass — `oauthRegistry.get()` still works for the callback-handler.

- [ ] **Step 6: Commit**

```bash
git add src/exulu/oauth/registry.ts src/exulu/oauth/registry.test.ts
git commit -m "feat(oauth): key registry by provider with compatibility check"
```

---

## Task 3: Schema + boot-time migration for `provider` column

Adds the `provider` column to the schema definition and wires an idempotent backfill + unique-index swap into `init-exulu-db.ts`. No runtime code reads `provider` yet; Task 4 flips the token store to use it.

**Files:**
- Modify: `src/postgres/core-schema.ts` (add field to `oauthTokensSchema`)
- Modify: `src/postgres/init-exulu-db.ts` (backfill + swap indexes)

**Interfaces:**
- Consumes: (nothing new)
- Produces:
  - `oauth_tokens` table gains a `provider text` column (nullable initially; backfilled from `tool_id`).
  - Unique index on `(provider, user_id)` replaces the old unique index on `(tool_id, user_id)`.

Manual DB verification note: this task has no unit tests. Verification is by (a) running `npm run utils:initdb` on a copy of a production DB and confirming `SELECT COUNT(*) FROM oauth_tokens WHERE provider IS NULL` returns 0, and (b) confirming both indexes exist per `\d oauth_tokens`.

- [ ] **Step 1: Add `provider` field to `oauthTokensSchema` — `src/postgres/core-schema.ts`**

Find the `oauthTokensSchema` block (search for `type: "oauth_tokens"`). Replace its `fields` array with:

```ts
  fields: [
    { name: "provider", type: "text", required: false, index: true },
    { name: "tool_id", type: "text", required: true, index: true },
    { name: "user_id", type: "number", required: true, index: true },
    { name: "access_token", type: "longText", required: true }, // AES-encrypted
    { name: "refresh_token", type: "longText", required: false }, // AES-encrypted
    { name: "token_type", type: "text", required: false },
    { name: "scopes", type: "text", required: false },
    { name: "expires_at", type: "date", required: false }, // null = non-expiring
  ],
```

`provider` is `required: false` at the schema level so the boot-time `addMissingFields` path adds a nullable column on existing installs. The backfill in Step 2 fills every row, so runtime code from Task 4 onward can treat the column as non-null.

- [ ] **Step 2: Add backfill + index swap — `src/postgres/init-exulu-db.ts`**

Find the block that currently reads:

```ts
  // The oauth token store upserts on (tool_id, user_id); enforce that key at
  // the DB level so concurrent callbacks can't produce duplicate rows.
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_tool_id_user_id_unique ON oauth_tokens (tool_id, user_id)",
  );
```

Replace those five lines with:

```ts
  // OAuth tokens migrated from (tool_id, user_id) to (provider, user_id) so
  // multiple tools sharing a provider share one consent per user. The block
  // below is idempotent: safe on a fresh DB, a mid-migration DB, and one
  // already fully migrated.
  if (await knex.schema.hasColumn("oauth_tokens", "provider")) {
    // Backfill: for legacy rows written before the provider column existed,
    // seed provider = tool_id so their tokens continue to resolve.
    await knex("oauth_tokens").whereNull("provider").update({ provider: knex.ref("tool_id") });

    // Swap the unique index. Postgres' CREATE UNIQUE INDEX IF NOT EXISTS is
    // safe to run every boot; DROP INDEX IF EXISTS is a no-op on subsequent
    // boots.
    await knex.raw("DROP INDEX IF EXISTS oauth_tokens_tool_id_user_id_unique");
    await knex.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_provider_user_id_unique ON oauth_tokens (provider, user_id)",
    );
  } else {
    // Column absent means the schema creator didn't add it yet (should not
    // happen given the schema above declares it, but guard for a partial
    // deploy). Fall back to the legacy index so writes still work.
    await knex.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_tool_id_user_id_unique ON oauth_tokens (tool_id, user_id)",
    );
  }
```

- [ ] **Step 3: Type-check the modified files**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0 (no new type errors).

- [ ] **Step 4: Run the full test suite to confirm no regressions**

Run: `npx jest`
Expected: All tests still pass — no runtime code reads `provider` yet.

- [ ] **Step 5: Commit**

```bash
git add src/postgres/core-schema.ts src/postgres/init-exulu-db.ts
git commit -m "feat(oauth): add provider column with idempotent backfill migration"
```

---

## Task 4: Re-key token access — store, flow, callback, wrap-execute

Flips every hop from `toolId` to `providerKey` in a single coordinated change. Keeps `tool_id` on every written row for audit (which tool triggered the grant/refresh) but no longer keys off it. This is the largest task in the plan because these four files are tightly coupled — the codebase would not compile between splits.

**Files:**
- Modify: `src/exulu/oauth/token-store.ts`
- Modify: `src/exulu/oauth/token-store.test.ts`
- Modify: `src/exulu/oauth/flow.ts`
- Modify: `src/exulu/oauth/flow.test.ts`
- Modify: `src/exulu/oauth/wrap-execute.ts`
- Modify: `src/exulu/oauth/wrap-execute.test.ts`
- Modify: `src/exulu/oauth/callback-handler.ts`
- Modify: `src/exulu/oauth/callback-handler.test.ts`
- Modify: `src/exulu/oauth/registry.ts` (remove deprecated `get()` alias)

**Interfaces:**
- Consumes:
  - `providerKeyFor(toolId, config)` (Task 1)
  - `oauthRegistry.getByProvider(providerKey)`, `oauthRegistry.getByTool(toolId)` (Task 2)
  - `oauth_tokens` table with `provider` column and `(provider, user_id)` unique index (Task 3)
- Produces:
  - `oauthTokenStore.get(providerKey: string, userId: number): Promise<OauthTokenRecord | null>`
  - `oauthTokenStore.upsert(providerKey: string, userId: number, toolId: string, record: OauthTokenRecord): Promise<void>` — `toolId` is written to the `tool_id` audit column
  - `oauthTokenStore.delete(providerKey: string, userId: number): Promise<void>`
  - `OauthState = { provider: string; toolId: string; userId: number; codeVerifier?: string; exp: number }`
  - `buildAuthorizationUrl({ toolId, userId, config })` — unchanged signature; derives `providerKey` internally and writes both into state
  - `getValidAccessToken({ providerKey, userId, toolId, config })` — `toolId` used only when refreshing to audit the writer
  - `wrapExecuteWithOauth(toolId, config, execute)` — unchanged signature; internally derives `providerKey`
  - `handleOauthCallback` — reads `parsed.provider`; calls `oauthRegistry.getByProvider`; upserts with `providerKey + toolId`

### Step-by-step

- [ ] **Step 1: Update `src/exulu/oauth/token-store.test.ts`**

Replace the entire `describe("oauthTokenStore", () => {...})` block with:

```ts
describe("oauthTokenStore", () => {
  it("returns null when no row exists", async () => {
    expect(await oauthTokenStore.get("jira", 1)).toBeNull();
  });

  it("encrypts tokens at rest and decrypts them on read", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", {
      accessToken: "plain-access",
      refreshToken: "plain-refresh",
      tokenType: "Bearer",
      scopes: "read:a",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });

    const row = rows[0];
    expect(row.access_token).not.toContain("plain-access");
    expect(row.refresh_token).not.toContain("plain-refresh");
    expect(
      CryptoJS.AES.decrypt(row.access_token, "test-secret").toString(CryptoJS.enc.Utf8),
    ).toBe("plain-access");
    expect(row.provider).toBe("jira");
    expect(row.tool_id).toBe("jira_search");

    const record = await oauthTokenStore.get("jira", 1);
    expect(record).toEqual({
      accessToken: "plain-access",
      refreshToken: "plain-refresh",
      tokenType: "Bearer",
      scopes: "read:a",
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
  });

  it("updates the existing row instead of inserting a duplicate", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "first" });
    await oauthTokenStore.upsert("jira", 1, "jira_get", { accessToken: "second" });
    expect(rows).toHaveLength(1);
    expect((await oauthTokenStore.get("jira", 1))!.accessToken).toBe("second");
    // tool_id column reflects the latest writer for audit
    expect(rows[0].tool_id).toBe("jira_get");
  });

  it("preserves the stored refresh token when a new response omits it", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", {
      accessToken: "first",
      refreshToken: "keep-me",
    });
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "second" });
    const record = await oauthTokenStore.get("jira", 1);
    expect(record!.accessToken).toBe("second");
    expect(record!.refreshToken).toBe("keep-me");
  });

  it("scopes rows to the (provider, userId) pair", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "user-1" });
    await oauthTokenStore.upsert("jira", 2, "jira_search", { accessToken: "user-2" });
    await oauthTokenStore.upsert("google", 1, "google_calendar", { accessToken: "other-provider" });
    expect(rows).toHaveLength(3);
    expect((await oauthTokenStore.get("jira", 2))!.accessToken).toBe("user-2");
  });

  it("deletes a row", async () => {
    await oauthTokenStore.upsert("jira", 1, "jira_search", { accessToken: "bye" });
    await oauthTokenStore.delete("jira", 1);
    expect(await oauthTokenStore.get("jira", 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the updated store test to verify it fails**

Run: `npx jest src/exulu/oauth/token-store.test.ts`
Expected: FAIL — `upsert` signature no longer matches; TS/runtime error on the 3-arg call.

- [ ] **Step 3: Rewrite `src/exulu/oauth/token-store.ts`**

Replace the entire file with:

```ts
import CryptoJS from "crypto-js";
import { postgresClient } from "@SRC/postgres/client";

export type OauthTokenRecord = {
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  /** Space-joined scopes as reported by the provider. */
  scopes?: string | null;
  /** null = the provider reported no expiry; treated as non-expiring. */
  expiresAt?: Date | null;
};

const TABLE = "oauth_tokens";

// Same at-rest encryption pattern as the variables table (see ExuluVariables
// in src/index.ts).
const encrypt = (value: string) =>
  CryptoJS.AES.encrypt(value, process.env.NEXTAUTH_SECRET).toString();
const decrypt = (value: string) =>
  CryptoJS.AES.decrypt(value, process.env.NEXTAUTH_SECRET).toString(CryptoJS.enc.Utf8);

export const oauthTokenStore = {
  get: async (providerKey: string, userId: number): Promise<OauthTokenRecord | null> => {
    const { db } = await postgresClient();
    const row = await db.from(TABLE).where({ provider: providerKey, user_id: userId }).first();
    if (!row) {
      return null;
    }
    return {
      accessToken: decrypt(row.access_token),
      refreshToken: row.refresh_token ? decrypt(row.refresh_token) : null,
      tokenType: row.token_type ?? null,
      scopes: row.scopes ?? null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    };
  },

  // toolId is stored on every written row as an audit trail — which tool
  // triggered the last grant/refresh — but does NOT participate in the key.
  upsert: async (
    providerKey: string,
    userId: number,
    toolId: string,
    record: OauthTokenRecord,
  ): Promise<void> => {
    const { db } = await postgresClient();
    const existing = await db
      .from(TABLE)
      .where({ provider: providerKey, user_id: userId })
      .first();
    const values = {
      provider: providerKey,
      tool_id: toolId,
      access_token: encrypt(record.accessToken),
      // Providers like Google only send a refresh_token on first consent;
      // never overwrite a stored one with nothing.
      refresh_token: record.refreshToken
        ? encrypt(record.refreshToken)
        : (existing?.refresh_token ?? null),
      token_type: record.tokenType ?? null,
      scopes: record.scopes ?? null,
      expires_at: record.expiresAt ?? null,
      updatedAt: new Date(),
    };
    if (existing) {
      await db
        .from(TABLE)
        .where({ provider: providerKey, user_id: userId })
        .update(values);
    } else {
      await db.from(TABLE).insert({ user_id: userId, ...values });
    }
  },

  delete: async (providerKey: string, userId: number): Promise<void> => {
    const { db } = await postgresClient();
    await db.from(TABLE).where({ provider: providerKey, user_id: userId }).del();
  },
};
```

- [ ] **Step 4: Run the store test to confirm it now passes**

Run: `npx jest src/exulu/oauth/token-store.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Update `src/exulu/oauth/flow.ts` — thread providerKey through**

In `src/exulu/oauth/flow.ts`:

**5a.** Change the `OauthState` type. Replace the current `OauthState` definition with:

```ts
export type OauthState = {
  provider: string;
  toolId: string;
  userId: number;
  codeVerifier?: string;
  exp: number;
};
```

**5b.** Update the `decryptOauthState` validation. Find:

```ts
  if (!state?.toolId || !state?.userId || !state?.exp) {
    throw new Error("[EXULU] Invalid OAuth state.");
  }
```

Replace with:

```ts
  if (!state?.provider || !state?.toolId || !state?.userId || !state?.exp) {
    throw new Error("[EXULU] Invalid OAuth state.");
  }
```

**5c.** Add the import for `providerKeyFor` at the top of the file, next to the existing `import type { ExuluOauthConfig } from "./types";`:

```ts
import { providerKeyFor } from "./provider-key";
```

**5d.** Update `buildAuthorizationUrl`. Find the `encryptOauthState` call inside it (currently 4 fields: `toolId`, `userId`, `codeVerifier`, `exp`). Replace with:

```ts
  const state = encryptOauthState({
    provider: providerKeyFor(toolId, config),
    toolId,
    userId,
    codeVerifier,
    exp: Date.now() + STATE_TTL_MS,
  });
```

**5e.** Rewrite `getValidAccessToken` to key by provider. Replace the entire function (`export const getValidAccessToken = ...` through its closing brace) with:

```ts
/**
 * Returns a usable access token for (providerKey, userId), transparently
 * refreshing an expired one. Returns null when the user needs to
 * (re-)authorize — stale rows are deleted so the caller falls back to the
 * authorization path. `toolId` is only used as the audit column when a
 * refresh writes back to the row.
 */
export const getValidAccessToken = async ({
  providerKey,
  userId,
  toolId,
  config,
}: {
  providerKey: string;
  userId: number;
  toolId: string;
  config: ExuluOauthConfig;
}): Promise<OauthTokenRecord | null> => {
  const stored = await oauthTokenStore.get(providerKey, userId);
  if (!stored) {
    return null;
  }
  const expired = stored.expiresAt
    ? stored.expiresAt.getTime() <= Date.now() + EXPIRY_SKEW_MS
    : false;
  if (!expired) {
    return stored;
  }
  if (!stored.refreshToken) {
    await oauthTokenStore.delete(providerKey, userId);
    return null;
  }
  try {
    const refreshed = await refreshAccessToken({ config, refreshToken: stored.refreshToken });
    if (!refreshed.refreshToken) {
      refreshed.refreshToken = stored.refreshToken;
    }
    await oauthTokenStore.upsert(providerKey, userId, toolId, refreshed);
    return refreshed;
  } catch (error) {
    console.error(
      `[EXULU] OAuth token refresh failed for provider "${providerKey}" tool "${toolId}" user ${userId}:`,
      error,
    );
    await oauthTokenStore.delete(providerKey, userId);
    return null;
  }
};
```

- [ ] **Step 6: Update `src/exulu/oauth/flow.test.ts`**

**6a.** Update the state round-trip test. Find:

```ts
  it("round-trips through encrypt/decrypt", () => {
    const state = {
      toolId: "my_tool",
      userId: 42,
      codeVerifier: "verifier",
      exp: Date.now() + 60_000,
    };
    expect(decryptOauthState(encryptOauthState(state))).toEqual(state);
  });
```

Replace with:

```ts
  it("round-trips through encrypt/decrypt including provider", () => {
    const state = {
      provider: "jira",
      toolId: "jira_search",
      userId: 42,
      codeVerifier: "verifier",
      exp: Date.now() + 60_000,
    };
    expect(decryptOauthState(encryptOauthState(state))).toEqual(state);
  });
```

**6b.** Find the test that asserts `decryptOauthState` rejects missing fields. It currently omits `toolId`. Add a case for missing `provider`. Search the file for a `.toThrow(/Invalid OAuth state/)` around a state literal; add a new `it` block below it:

```ts
  it("rejects state missing provider", () => {
    const raw = encryptOauthState({
      // provider intentionally omitted
      toolId: "t",
      userId: 1,
      exp: Date.now() + 60_000,
    } as any);
    expect(() => decryptOauthState(raw)).toThrow(/Invalid OAuth state/);
  });
```

**6c.** Update every `getValidAccessToken` test call site. Each currently passes `{ toolId, userId, config }`. Change to `{ providerKey, userId, toolId, config }`. For each existing case, insert `providerKey: "<same value as toolId>"` (or a distinct provider when the test's intent needs it) and keep `toolId` too. Update all matching mocks: `mockTokenStore.get.mock.calls[0][0]` was `toolId`, is now `providerKey`; `mockTokenStore.upsert.mock.calls[0]` was `[toolId, userId, record]`, is now `[providerKey, userId, toolId, record]`.

Complete rewrite guidance: search the file for every occurrence of the string `getValidAccessToken(` and update the call. For each `mockTokenStore.get.mock.calls`, `.upsert.mock.calls`, `.delete.mock.calls` assertion, update the expected argument list.

Example rewrite of the "returns stored token when not expired" case:

```ts
  it("returns the stored token when it is not expired", async () => {
    mockTokenStore.get.mockResolvedValueOnce({
      accessToken: "still-good",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const token = await getValidAccessToken({
      providerKey: "provider-x",
      userId: 1,
      toolId: "tool-x",
      config,
    });
    expect(token?.accessToken).toBe("still-good");
    expect(mockTokenStore.get).toHaveBeenCalledWith("provider-x", 1);
    expect(mockTokenStore.upsert).not.toHaveBeenCalled();
  });
```

Apply the analogous rewrite to every other `getValidAccessToken` test in the file (there are several around token expiry, refresh success, refresh failure, missing refresh token). Every `upsert` mock assertion changes to expect four positional args: `providerKey`, `userId`, `toolId`, `record`.

**6d.** Update the `buildAuthorizationUrl` test that inspects the returned URL. If a test decrypts the `state` param from the built URL and asserts its shape, update the assertion to include `provider`. Example:

```ts
  it("includes an encrypted state parameter with provider and toolId", () => {
    const url = new URL(
      buildAuthorizationUrl({
        toolId: "jira_search",
        userId: 42,
        config: { ...config, provider: "jira" },
      }),
    );
    const state = decryptOauthState(url.searchParams.get("state")!);
    expect(state.provider).toBe("jira");
    expect(state.toolId).toBe("jira_search");
    expect(state.userId).toBe(42);
  });
```

If a `buildAuthorizationUrl` test exists that omits `provider` on the config, keep it and additionally assert `state.provider === "the_tool_id"` (the fallback via `providerKeyFor`).

- [ ] **Step 7: Run flow tests**

Run: `npx jest src/exulu/oauth/flow.test.ts`
Expected: All existing tests plus the two new ones pass.

- [ ] **Step 8: Update `src/exulu/oauth/wrap-execute.ts`**

Replace the `getValidAccessToken` call. Find:

```ts
    const token = await getValidAccessToken({ toolId, userId, config });
```

Replace with:

```ts
    const providerKey = providerKeyFor(toolId, config);
    const token = await getValidAccessToken({ providerKey, userId, toolId, config });
```

Add the import at the top of the file:

```ts
import { providerKeyFor } from "./provider-key";
```

- [ ] **Step 9: Update `src/exulu/oauth/wrap-execute.test.ts`**

Find every place that asserts `getValidAccessToken` was called with `{ toolId, userId, config }` (via a mock spy on `./flow`). Update the expected argument shape to `{ providerKey, userId, toolId, config }`. If the test spies on `oauthTokenStore` directly via `./token-store`, update the expected `.get`/`.upsert`/`.delete` args to use `providerKey` in position 1.

Example: if a test looks like

```ts
    expect(mockFlow.getValidAccessToken).toHaveBeenCalledWith({
      toolId: "solo",
      userId: 7,
      config: expect.any(Object),
    });
```

Change to:

```ts
    expect(mockFlow.getValidAccessToken).toHaveBeenCalledWith({
      providerKey: "solo",
      userId: 7,
      toolId: "solo",
      config: expect.any(Object),
    });
```

Also add one new test that pins the sharing behavior:

```ts
  it("uses config.provider as the token-store key when set", async () => {
    mockFlow.getValidAccessToken.mockResolvedValueOnce({
      accessToken: "t",
      refreshToken: null,
      tokenType: "Bearer",
      scopes: null,
      expiresAt: null,
    });
    const inner = jest.fn().mockResolvedValue({ result: "ok" });
    const wrapped = wrapExecuteWithOauth(
      "jira_search",
      {
        provider: "jira",
        authorizationUrl: "https://auth.example/authorize",
        tokenUrl: "https://auth.example/token",
        clientId: "c",
        clientSecret: "s",
        scopes: [],
      },
      inner,
    );
    await wrapped({ user: { id: 3 }, x: 1 });
    expect(mockFlow.getValidAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ providerKey: "jira", toolId: "jira_search" }),
    );
  });
```

- [ ] **Step 10: Run wrap-execute tests**

Run: `npx jest src/exulu/oauth/wrap-execute.test.ts`
Expected: All updated tests plus the new sharing-behavior test pass.

- [ ] **Step 11: Update `src/exulu/oauth/callback-handler.ts`**

Find the block:

```ts
  const config = oauthRegistry.get(parsed.toolId);
  if (!config) {
    return send(404, false, `No OAuth configuration is registered for tool "${parsed.toolId}".`);
  }

  try {
    const record = await exchangeCodeForTokens({
      config,
      code,
      codeVerifier: parsed.codeVerifier,
    });
    await oauthTokenStore.upsert(parsed.toolId, parsed.userId, record);
  } catch (caught) {
```

Replace with:

```ts
  const config = oauthRegistry.getByProvider(parsed.provider);
  if (!config) {
    return send(
      404,
      false,
      `No OAuth configuration is registered for provider "${parsed.provider}".`,
    );
  }

  try {
    const record = await exchangeCodeForTokens({
      config,
      code,
      codeVerifier: parsed.codeVerifier,
    });
    await oauthTokenStore.upsert(parsed.provider, parsed.userId, parsed.toolId, record);
  } catch (caught) {
```

- [ ] **Step 12: Update `src/exulu/oauth/callback-handler.test.ts`**

Every test that constructs an `OauthState` (via `encryptOauthState({...})`) or mocks `oauthRegistry.get(...)` needs updating.

**12a.** Anywhere a state is constructed with `{ toolId, userId, ..., exp }`, add `provider` alongside `toolId`:

```ts
    const state = encryptOauthState({
      provider: "jira",
      toolId: "jira_search",
      userId: 42,
      codeVerifier: "v",
      exp: Date.now() + 60_000,
    });
```

**12b.** Any mock on `oauthRegistry.get(...)` changes to `oauthRegistry.getByProvider(...)`. Search for `oauthRegistry.get` in the test file and update.

**12c.** Every assertion on `oauthTokenStore.upsert(...)` args changes from 3 positional args to 4 (`provider, userId, toolId, record`):

```ts
    expect(mockTokenStore.upsert).toHaveBeenCalledWith(
      "jira",
      42,
      "jira_search",
      expect.objectContaining({ accessToken: "..." }),
    );
```

**12d.** The "no config registered" error path — the assertion currently checks for `/No OAuth configuration is registered for tool/`. Change to `/No OAuth configuration is registered for provider/`.

- [ ] **Step 13: Remove the deprecated `oauthRegistry.get` alias**

Now that no caller uses it, delete the entry from `src/exulu/oauth/registry.ts`. In the object literal, remove:

```ts
  // Deprecated alias retained until Task 4 removes the last caller.
  get: (toolId: string): ExuluOauthConfig | undefined => {
    const providerKey = byTool.get(toolId);
    return providerKey ? byProvider.get(providerKey)?.config : undefined;
  },
```

Update `src/exulu/oauth/registry.test.ts` — remove the "preserves the deprecated get() alias" test.

- [ ] **Step 14: Run the full oauth suite**

Run: `npx jest src/exulu/oauth`
Expected: Every test in every file passes.

- [ ] **Step 15: Run the full project test suite**

Run: `npx jest`
Expected: No new regressions elsewhere in the project.

- [ ] **Step 16: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 17: Commit**

```bash
git add src/exulu/oauth/token-store.ts src/exulu/oauth/token-store.test.ts \
        src/exulu/oauth/flow.ts src/exulu/oauth/flow.test.ts \
        src/exulu/oauth/wrap-execute.ts src/exulu/oauth/wrap-execute.test.ts \
        src/exulu/oauth/callback-handler.ts src/exulu/oauth/callback-handler.test.ts \
        src/exulu/oauth/registry.ts src/exulu/oauth/registry.test.ts
git commit -m "refactor(oauth): key tokens by provider across store/flow/callback"
```

---

## Post-implementation notes (not tasks)

- **Manual DB verification** — Before deploying, run `npm run utils:initdb` against a copy of a production DB and confirm:
  - `SELECT COUNT(*) FROM oauth_tokens WHERE provider IS NULL;` returns 0
  - `\d oauth_tokens` shows the unique index on `(provider, user_id)` and no unique index on `(tool_id, user_id)`
  - Existing users can still call any oauth-enabled tool without re-consent (they'll hit their old row, backfilled to `provider = tool_id`).
- **Cutover for downstream consumers** — Downstream apps (like ai.open's `jira_*` and `google_*` tools) opt in by adding `provider: "jira"` / `provider: "google"` to their tool's `oauth` config. First tool per provider keeps working off the backfilled row. Adding a second tool with the same provider requires a one-time re-consent (unless a follow-up data migration copies the backfilled row into the new provider key — out of scope for this plan).
- **Release notes** — Call out the schema addition, the boot-time backfill (idempotent, safe on rerun), and the new optional `provider` field on `ExuluOauthConfig`. No breaking changes for consumers who don't set `provider`.
