# OAuth: Provider-Scoped Tokens — Design Briefing

**Date:** 2026-07-03
**Status:** Draft — pending implementation
**Author:** Daniel Claessen (with Claude)

## Summary

Change Exulu's OAuth token storage from `(tool_id, user_id)` to `(provider, user_id)` so multiple tools that talk to the same provider (e.g., all `google_*` or all `jira_*` tools) share a single consent per user instead of each tool triggering its own flow.

## The current behavior

`src/exulu/oauth/` implements a per-tool OAuth model. Every `ExuluTool` with an `oauth` config gets:

- A row in `oauthRegistry` keyed by `toolId`
- Tokens stored in `oauth_tokens` keyed by `(tool_id, user_id)` (unique index)
- `wrapExecuteWithOauth(toolId, config, execute)` that looks up tokens for that specific `toolId`
- The encrypted OAuth state parameter carries `toolId`
- `handleOauthCallback` retrieves the registry entry by `toolId` from the state, then upserts tokens against `(tool_id, user_id)`

Consequence: for a suite of six `jira_*` tools sharing the same OAuth app, a user must click **Connect** six times — once per tool. Same underlying scopes, same client, six token rows.

Files that hold this assumption:
- `src/exulu/oauth/types.ts` — `ExuluOauthConfig` shape
- `src/exulu/oauth/registry.ts` — `oauthRegistry` keyed by toolId
- `src/exulu/oauth/token-store.ts` — `oauth_tokens` queries key on `(tool_id, user_id)`
- `src/exulu/oauth/flow.ts` — `OauthState.toolId`, `getValidAccessToken({ toolId, ... })`, `buildAuthorizationUrl({ toolId, ... })`
- `src/exulu/oauth/wrap-execute.ts` — passes `toolId` into `getValidAccessToken`
- `src/exulu/oauth/callback-handler.ts` — resolves config and upserts tokens by `parsed.toolId`
- `src/postgres/core-schema.ts` — `oauthTokensSchema` field list
- `src/postgres/init-exulu-db.ts` — unique index on `(tool_id, user_id)`
- `src/exulu/tool.ts` — `ExuluTool` constructor calls `oauthRegistry.register(id, oauth)` and `wrapExecuteWithOauth(id, oauth, execute)`

## Goals

- Tools declare a `provider: string` on their OAuth config (e.g., `"google"`, `"jira"`, `"github"`).
- Two tools with the same `provider` share one token row per user.
- One consent screen per provider per user, not per tool.
- Non-breaking: existing tools that don't set `provider` keep working exactly as they do today.
- Existing token rows in production must not require re-authorization after the migration.

## Non-goals

- Merging distinct scope sets. If two tools with the same provider request different scopes, that is a developer error — reject at registration time with a clear message. No silent scope escalation.
- Cross-tenant token sharing, per-organization tokens, or delegated auth flows. Still one token per `(provider, userId)`.
- Rotating from `tool_id` to `provider` as the primary key of `oauth_tokens`. We add `provider`, keep `tool_id` for the audit history the row was originally written by.
- Client-facing behavior changes for tools that don't opt in. If `oauth.provider` is absent, everything works exactly as before.

## Design

### Add `provider` to `ExuluOauthConfig`

```ts
// src/exulu/oauth/types.ts
export type ExuluOauthConfig = {
  /**
   * Identifier for the OAuth provider (e.g., "google", "jira", "github").
   * Tools sharing the same provider share tokens under (provider, userId).
   * When omitted, defaults to the tool's `id` — preserves per-tool behavior
   * for tools that don't opt into sharing.
   */
  provider?: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  pkce?: boolean;
  extraAuthParams?: Record<string, string>;
};
```

Every hop that used `toolId` as the token-storage key now derives a `providerKey`:

```ts
// A tiny helper — centralize the fallback so nothing forgets it.
export const providerKeyFor = (toolId: string, config: ExuluOauthConfig): string =>
  config.provider ?? toolId;
```

### Registry: key by provider, allow tool-level lookup

`oauthRegistry` today maps `toolId → config`. Two changes:

```ts
// src/exulu/oauth/registry.ts
type RegistryEntry = { config: ExuluOauthConfig; toolIds: Set<string> };
const byProvider = new Map<string, RegistryEntry>();
const byTool = new Map<string, string>(); // toolId -> providerKey

export const oauthRegistry = {
  register: (toolId: string, config: ExuluOauthConfig) => {
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
};
```

`assertCompatible` rejects at construction time when two tools claim the same provider but disagree on client/URLs/scopes:

```ts
const assertCompatible = (
  providerKey: string,
  toolId: string,
  existing: ExuluOauthConfig,
  next: ExuluOauthConfig,
) => {
  const stableFields = ["authorizationUrl", "tokenUrl", "clientId", "clientSecret"] as const;
  for (const f of stableFields) {
    if (existing[f] !== next[f]) {
      throw new Error(
        `ExuluTool "${toolId}": oauth.${f} disagrees with another tool that shares provider "${providerKey}". Every tool on the same provider must use identical clientId/clientSecret/authorizationUrl/tokenUrl.`,
      );
    }
  }
  const a = new Set(existing.scopes);
  const b = new Set(next.scopes);
  if (a.size !== b.size || [...a].some((s) => !b.has(s))) {
    throw new Error(
      `ExuluTool "${toolId}": oauth.scopes disagrees with another tool that shares provider "${providerKey}". Every tool on the same provider must declare the same scope superset. Existing: [${[...a].sort().join(", ")}]. This tool: [${[...b].sort().join(", ")}].`,
    );
  }
};
```

The "same scope superset" rule is the intentional escape valve: if you need broader scope for one tool, every other tool on the provider gets it too and the consent screen shows the full set. It also makes token sharing safe — every tool knows the token has at least the declared scopes.

### Token store: swap the key column

```ts
// src/exulu/oauth/token-store.ts (only relevant lines shown)
const TABLE = "oauth_tokens";

export const oauthTokenStore = {
  get: async (providerKey: string, userId: number): Promise<OauthTokenRecord | null> => {
    const { db } = await postgresClient();
    const row = await db.from(TABLE).where({ provider: providerKey, user_id: userId }).first();
    // ...unchanged
  },
  upsert: async (providerKey: string, userId: number, toolId: string, record: OauthTokenRecord) => {
    const { db } = await postgresClient();
    const existing = await db.from(TABLE).where({ provider: providerKey, user_id: userId }).first();
    const values = {
      // ...unchanged encrypted fields
      tool_id: toolId,      // still recorded so we know which tool triggered the last grant
      provider: providerKey,
      updatedAt: new Date(),
    };
    // ...unchanged upsert branch
  },
  delete: async (providerKey: string, userId: number) => {
    const { db } = await postgresClient();
    await db.from(TABLE).where({ provider: providerKey, user_id: userId }).del();
  },
};
```

`tool_id` stays on each row for auditability — nice to know which tool the user clicked through when the token was granted — but is no longer part of the key.

### OAuth state: carry providerKey

```ts
// src/exulu/oauth/flow.ts
export type OauthState = {
  provider: string;      // was: toolId
  toolId: string;        // kept for the callback UI + audit
  userId: number;
  codeVerifier?: string;
  exp: number;
};
```

`buildAuthorizationUrl` and `getValidAccessToken` both take `(toolId, config)` and derive `providerKey` internally. This keeps the callsite from having to know the fallback rule.

### Callback handler: look up by provider

```ts
// src/exulu/oauth/callback-handler.ts (only the changed block)
const config = oauthRegistry.getByProvider(parsed.provider);
if (!config) {
  return send(404, false, `No OAuth configuration is registered for provider "${parsed.provider}".`);
}
// ...
await oauthTokenStore.upsert(parsed.provider, parsed.userId, parsed.toolId, record);
```

### Wrap-execute: derive providerKey from toolId

```ts
// src/exulu/oauth/wrap-execute.ts
const providerKey = providerKeyFor(toolId, config);
// ...
const token = await getValidAccessToken({ providerKey, userId, config });
```

### Schema + migration

Add `provider` to `oauthTokensSchema`:

```ts
// src/postgres/core-schema.ts
const oauthTokensSchema: ExuluTableDefinition = {
  type: "oauth_tokens",
  name: { plural: "oauth_tokens", singular: "oauth_token" },
  RBAC: false,
  fields: [
    { name: "provider", type: "text", required: true, index: true },
    { name: "tool_id", type: "text", required: true, index: true },
    { name: "user_id", type: "number", required: true, index: true },
    { name: "access_token", type: "longText", required: true },
    { name: "refresh_token", type: "longText", required: false },
    { name: "token_type", type: "text", required: false },
    { name: "scopes", type: "text", required: false },
    { name: "expires_at", type: "date", required: false },
  ],
};
```

In `init-exulu-db.ts`, run a backfill and swap indexes idempotently:

```ts
// After all createTable calls, before the existing unique index creation:
if (await knex.schema.hasColumn("oauth_tokens", "provider")) {
  // Backfill: for every row where provider is null, copy tool_id into provider.
  // Preserves existing tokens under their old key so nobody re-authorizes.
  await knex("oauth_tokens").whereNull("provider").update({ provider: knex.ref("tool_id") });

  // Idempotent index swap:
  //   - Drop the old (tool_id, user_id) unique index if present
  //   - Create the new (provider, user_id) unique index if absent
  await knex.raw("DROP INDEX IF EXISTS oauth_tokens_tool_id_user_id_unique");
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_provider_user_id_unique ON oauth_tokens (provider, user_id)",
  );
}
```

The backfill is the safety net: every existing row gets `provider = tool_id`, which means a user who previously consented for `google_calendar` continues to have a valid token for it — and if they later add `google_gmail` with the same `provider: "google"`, they'll be prompted to re-consent once (because there's no row keyed at `(google, userId)` yet). To completely dodge that one-time re-consent, an optional refinement:

**Optional convenience migration:** for each `(tool_id, user_id)` row whose `tool_id` maps to a registered tool declaring `provider: "google"`, `UPDATE ... SET provider = 'google' WHERE tool_id = 'google_calendar'`. Idempotent under the unique index (delete duplicates favoring the newest `updatedAt`). Nice-to-have, not required.

## Tool consumer changes

Zero code changes for tools that don't opt in. To opt in, a tool sets `provider`:

```ts
// Before: six jira_* tools each own their own token
oauth: {
  authorizationUrl: "https://auth.atlassian.com/authorize",
  // ...
  scopes: JIRA_SCOPES,
}

// After: one consent per user across all jira_* tools
oauth: {
  provider: "jira",
  authorizationUrl: "https://auth.atlassian.com/authorize",
  // ...
  scopes: JIRA_SCOPES,
}
```

## Testing

- `src/exulu/oauth/registry.test.ts`
  - Two tools with same provider + identical config → shared registry entry
  - Two tools with same provider + differing `clientId` → throws at `register`
  - Two tools with same provider + differing scopes → throws at `register`
  - No `provider` → keys by toolId (backward-compat)
  - `getByProvider` and `getByTool` both resolve to the same config
- `src/exulu/oauth/token-store.test.ts`
  - `upsert` writes `provider` and `tool_id`; `get` and `delete` key by `provider`
  - Row rewritten by a different tool with the same provider updates the same row (tool_id column reflects the latest writer)
- `src/exulu/oauth/flow.test.ts`
  - `OauthState` carries both `provider` and `toolId`; decrypt round-trips both
  - `getValidAccessToken` gets/writes tokens using `providerKey`
- `src/exulu/oauth/callback-handler.test.ts`
  - Config resolved by `state.provider`; upsert uses `state.provider`; `tool_id` column receives `state.toolId`
- `src/exulu/oauth/wrap-execute.test.ts`
  - Tool with `provider` → looks up token by that provider
  - Tool without `provider` → looks up token by toolId (unchanged)
- Migration test (integration): create an `oauth_tokens` row with only `tool_id`, run `init-exulu-db`, assert `provider = tool_id` and unique index recreated

## Rollout

Single deployment, no feature flag:

1. Merge and deploy the code change; `init-exulu-db` runs on boot, backfills and swaps the index.
2. Existing tokens continue to work (backfilled to their old `tool_id` value under the new key).
3. Update tools to declare `provider`. The first tool per provider that re-registers with the new provider name gets its old tokens under the old key; adding a second tool with the same provider requires one re-consent per user (or the optional migration in the note above dodges that too).
4. In consumer apps (e.g., ai.open), roll out `provider: "google"`, `provider: "jira"`, etc.

## Open questions

- **`provider` naming rules.** Freeform string vs. registry (`"google" | "jira" | "github"`). Freeform is simpler and matches how `category` and other soft identifiers work today. Recommendation: freeform, document conventional names in the ExuluOauthConfig type comment.
- **Should `provider` be surfaced on the frontend?** The connect button today can say "Connect Google Calendar"; with sharing, it should probably say "Connect Google". This is a downstream concern for the consuming UI, not part of this backend change.
- **Rate-limited providers with per-tool client apps.** Some providers (rare) issue different clientIds for different scopes or different verticals. If we ever hit this, an escape hatch is: `provider` is optional, so the tool can omit it and keep its own bucket. No fix needed today.
