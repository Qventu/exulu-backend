# API key scoping and per-agent rate limits

**Date:** 2026-05-21
**Status:** Approved (design)
**Scope:** Backend (`/Users/daniel.claessen/Desktop/Projects/exulu/backend`) + frontend admin UI (`/Users/daniel.claessen/Desktop/Projects/exulu/frontend`)

## Problem

The new feedback chat exposes an API key in the browser. Today, every API key inherits broad access via the `isApi` shortcut in `checkRecordAccess` — any key can call any agent and any GraphQL mutation. There is no per-agent rate limiting. A leaked browser-exposed key can therefore trivially abuse any agent and burn through provider quotas.

## Goal

Two features that ship together:

1. **API key scoping.** Each key declares a `scope_mode`. `admin` keeps today's broad behavior. `agents`-scoped keys store a whitelist of agent IDs and can ONLY call the agent run route for those IDs.
2. **Per-agent rate limits.** Each agent gains an optional `rate_limits` config with three independent metrics: `requests`, `input_tokens`, `output_tokens`. Limits are enforced per `(agent, caller)` in Redis. All callers are limited — human JWT users, admin API keys, agents-scoped API keys, and anonymous callers (by IP).

## Non-goals

- No new auth methods, no key rotation, no key expiration.
- No rate limits on non-agent routes (GraphQL, embedders, MCP, OpenAI gateway, workflows).
- No quota / billing semantics. Sliding windows only.
- No per-tool or per-skill scoping within an agent.
- No frontend changes to the feedback chat itself.
- No edit-in-place for an existing key's scope (matches today's pattern for role: change via dropdown is out of scope; recreate the key).

## Decisions

| Topic | Decision |
|---|---|
| Scope model | `scope_mode: 'admin' \| 'agents'`. `admin` = today's behavior. `agents` = whitelist of agent IDs. |
| What agents-scoped keys can do | ONLY the agent run route (`POST /<slug>/{instance}`) for whitelisted IDs. Nothing else. |
| Rate-limit storage | New `rate_limits` JSON field on the agents table. |
| Limit dimension | Per-`(agent, caller_id)`. Different keys/users don't share a budget. |
| Over-limit response | HTTP 429 with `Retry-After` header + `{ detail, metric, retryAfter }` JSON body. |
| Token-limit timing | Pre-check: reject if current window's token counter is already at/over limit. Post-deduct: increment counters on `onFinish`. One-shot overshoot accepted. |
| Who's limited | All callers. Counter partner is `user:<id>` for authenticated, `ip:<addr>` for anonymous. |
| Migration | Existing keys default to `scope_mode: 'admin'`. No behavior change. |
| Admin UI placement | Scope on API keys page. Rate limits + live usage on agent detail page. |
| Live usage observability | Read live Redis counters; show per-caller usage table on agent detail. |

## Architecture

### Request flow for `POST /<slug>/{instance}` (the agent run route)

```
authenticate
  ↓
checkApiKeyScope(user, agentId)         ← NEW: blocks agents-scoped keys from non-whitelisted agents
  ↓
checkRecordAccess(agent, "read", user)  ← MODIFIED: isApi bypass narrowed to admin keys;
                                          but agents-scoped keys are allowed when
                                          agent.id ∈ user.agent_ids (centralizes access logic)
  ↓
preCheckAgentRateLimit(agentId, callerId, agent.rate_limits)  ← NEW: 429 if over
  ↓
run agent (stream / non-stream)
  ↓
onFinish:
  updateStatistic(...)                          (existing)
  recordAgentTokenUsage(...)                    ← NEW: post-deduct counter increment
```

`checkApiKeyScope` runs first and is the early reject for an agents-scoped key targeting a non-whitelisted agent. `checkRecordAccess` then makes the final allow decision; for agents-scoped keys it honors the same allowlist (see §3.2). The two checks could theoretically be collapsed into one, but keeping them separate makes the route's intent readable and gives unit tests a clean seam.

### Files affected

**Backend (new):**
- `src/utils/check-api-key-scope.ts` — pure helper.
- `src/utils/check-agent-rate-limit.ts` — pre-check + post-record + caller-id resolver.

**Backend (modified):**
- `src/postgres/core-schema.ts` — add `scope_mode` (text), `agent_ids` (json) to users; add `rate_limits` (json) to agents.
- `src/auth/auth.ts` — include `scope_mode` and `agent_ids` on the returned user object for API key auth.
- `src/utils/check-record-access.ts` — narrow the `isApi` bypass to admin-mode keys only.
- `src/exulu/routes.ts` — wire `checkApiKeyScope`, `preCheckAgentRateLimit`, and `recordAgentTokenUsage` into the agent run handler.
- `src/graphql/...` — expose new fields and a `agentRateLimitUsage(agentId)` resolver. Exact files determined during implementation.

**Backend (types):**
- `@EXULU_TYPES/models/user` — add `scope_mode?: 'admin' | 'agents'` and `agent_ids?: string[]`.
- `@EXULU_TYPES/models/agent` — add `rate_limits?: AgentRateLimits`.

**Frontend (modified):**
- `frontend/app/(application)/keys/page.tsx` — scope selector + agent multi-select on create, scope column in table.
- `frontend/app/(application)/agents/[id]/...` (agent detail page; exact path verified at impl) — new "Rate limits" card + "Current usage" live table.
- `frontend/queries/queries.ts` (or equivalent) — extend `CREATE_API_USER`, `UPDATE_AGENT`, `GET_USERS`; add `AGENT_RATE_LIMIT_USAGE`.
- `frontend/components/feedback/feedback-chat.tsx` — small `onError` adjustment to also parse `detail` (server sends `detail` not `message`).

## Data model

### `users` table — three relevant fields

| Field | Type | Default | Purpose |
|---|---|---|---|
| `scope_mode` | text | `'admin'` for existing rows | `'admin'` \| `'agents'`. |
| `agent_ids` | json | `null` | Agent UUIDs allowlist. Only meaningful when `scope_mode='agents'`. |
| `super_admin` (existing) | boolean | unchanged | Forced to `false` at creation time when `scope_mode='agents'`. |

**Migration:** Set `scope_mode` default to `'admin'` so existing rows behave unchanged. `agent_ids` defaults to `null`. The `role` FK is untouched: it still drives behavior for `admin`-mode keys; it is ignored at runtime for `agents`-mode keys (route gating + scope check do the work).

### `agents` table — one new field

| Field | Type | Default | Purpose |
|---|---|---|---|
| `rate_limits` | json | `null` | Per-agent rate-limit config. `null` = no enforcement. |

Shape when present:

```ts
type AgentRateLimits = {
  requests?:      { limit: number; window_seconds: number };
  input_tokens?:  { limit: number; window_seconds: number };
  output_tokens?: { limit: number; window_seconds: number };
};
```

Each sub-field is independently optional. Missing sub-field = that metric is unlimited.

### Redis counters

```
exulu/ratelimit/agent/<agent_id>/caller/<caller_id>/<metric>
```

- `<metric>` ∈ `{ requests, input_tokens, output_tokens }`.
- `<caller_id>` resolution order:
  1. `user:<user.id>` — any authenticated user (human or API).
  2. `ip:<remote_ip>` — anonymous fallback. `remote_ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.ip ?? "unknown"`.
- Increment via `INCRBY`. Set TTL via `EXPIRE` only on first increment (matches existing `providerRateLimiter`).
- Redis unavailable → fail-open with a console warning. Matches existing pattern.

## Enforcement

### `src/utils/check-api-key-scope.ts`

```ts
import type { User } from "@EXULU_TYPES/models/user";

export type ScopeCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; code: 401 | 403 };

export function checkApiKeyScope(
  user: User | undefined,
  agentId: string,
): ScopeCheckResult {
  if (!user || user.type !== "api") return { allowed: true };
  if (!user.scope_mode || user.scope_mode === "admin") return { allowed: true };

  if (user.scope_mode === "agents") {
    const ids: string[] = Array.isArray(user.agent_ids) ? user.agent_ids : [];
    if (!ids.includes(agentId)) {
      return {
        allowed: false,
        reason: `API key is not scoped to agent ${agentId}.`,
        code: 403,
      };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: "Unknown scope_mode.", code: 401 };
}
```

### `src/utils/check-record-access.ts` — narrow the `isApi` bypass, honor agent scope

```ts
// Before:
const isApi = user ? user.type === "api" : false;
if (isPublic || isCreator || isAdmin || isApi) { ... }

// After:
const isApi = user ? user.type === "api" : false;
const isAdminApi = isApi && (!user!.scope_mode || user!.scope_mode === "admin");
// Agents-scoped keys: allow READ on records explicitly listed in agent_ids.
// `record` here is whatever object the caller passed in. For the agent run route
// this is the agent itself; the id check matches it against the key's allowlist.
const isAgentsScopedApi =
  isApi &&
  user!.scope_mode === "agents" &&
  request === "read" &&
  Array.isArray(user!.agent_ids) &&
  user!.agent_ids.includes(String(record.id));
if (isPublic || isCreator || isAdmin || isAdminApi || isAgentsScopedApi) { ... }
```

Three cases now coexist cleanly:

1. **Admin-mode API key** (`isAdminApi`): bypasses for any record, same as today.
2. **Agents-mode API key** (`isAgentsScopedApi`): bypasses ONLY for read access on agents whose `id` is in `user.agent_ids`. Any other record/route → denied (no `super_admin`, no user-level RBAC).
3. **Human users**: unchanged.

This keeps access logic centralized in `checkRecordAccess` and avoids the gotcha where `checkApiKeyScope` would approve but `checkRecordAccess` would still deny. `checkApiKeyScope` remains as the early, route-level reject for clearer error messaging when an agents-scoped key targets the wrong agent (`403` with "API key is not scoped to agent X" rather than the generic "you don't have access").

### `src/utils/check-agent-rate-limit.ts`

```ts
import { redisClient } from "../redis/client.ts";
import type { Request } from "express";

export type AgentRateLimits = {
  requests?:      { limit: number; window_seconds: number };
  input_tokens?:  { limit: number; window_seconds: number };
  output_tokens?: { limit: number; window_seconds: number };
};

export type RateLimitOk = { ok: true };
export type RateLimitDenied = { ok: false; metric: string; retryAfter: number };

export function resolveCallerId(req: Request, userId?: string | number): string {
  if (userId !== undefined && userId !== null && userId !== "") {
    return `user:${userId}`;
  }
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)
    ?.split(",")[0]
    ?.trim();
  return `ip:${fwd ?? req.ip ?? "unknown"}`;
}

const key = (agentId: string, callerId: string, metric: string) =>
  `exulu/ratelimit/agent/${agentId}/caller/${callerId}/${metric}`;

export async function preCheckAgentRateLimit(args: {
  agentId: string;
  callerId: string;
  limits: AgentRateLimits | null | undefined;
}): Promise<RateLimitOk | RateLimitDenied> {
  if (!args.limits) return { ok: true };
  const { client } = await redisClient();
  if (!client) {
    console.warn("[EXULU] Rate limiting disabled - Redis not available");
    return { ok: true };
  }

  // 1. Pre-check token counters (read-only)
  for (const metric of ["input_tokens", "output_tokens"] as const) {
    const cfg = args.limits[metric];
    if (!cfg) continue;
    const k = key(args.agentId, args.callerId, metric);
    const raw = await client.get(k);
    const used = raw ? Number(raw) : 0;
    if (used >= cfg.limit) {
      const ttl = await client.ttl(k);
      return { ok: false, metric, retryAfter: Math.max(ttl, 1) };
    }
  }

  // 2. Increment request counter
  const reqCfg = args.limits.requests;
  if (reqCfg) {
    const k = key(args.agentId, args.callerId, "requests");
    const current = await client.incrBy(k, 1);
    if (current === 1) await client.expire(k, reqCfg.window_seconds);
    if (current > reqCfg.limit) {
      const ttl = await client.ttl(k);
      return { ok: false, metric: "requests", retryAfter: Math.max(ttl, 1) };
    }
  }

  return { ok: true };
}

export async function recordAgentTokenUsage(args: {
  agentId: string;
  callerId: string;
  limits: AgentRateLimits | null | undefined;
  inputTokens?: number;
  outputTokens?: number;
}): Promise<void> {
  if (!args.limits) return;
  const { client } = await redisClient();
  if (!client) return;

  const work: Promise<unknown>[] = [];
  for (const metric of ["input_tokens", "output_tokens"] as const) {
    const cfg = args.limits[metric];
    if (!cfg) continue;
    const count = metric === "input_tokens" ? args.inputTokens : args.outputTokens;
    if (!count || count <= 0) continue;
    const k = key(args.agentId, args.callerId, metric);
    work.push((async () => {
      const v = await client.incrBy(k, count);
      if (v === count) await client.expire(k, cfg.window_seconds);
    })());
  }
  await Promise.allSettled(work);
}
```

### Wiring in `src/exulu/routes.ts`

Inside the agent run handler, immediately after `checkRecordAccess` succeeds and before tool/skill assembly:

```ts
const scope = checkApiKeyScope(user, instance);
if (!scope.allowed) {
  res.status(scope.code).json({ detail: scope.reason });
  return;
}

const callerId = resolveCallerId(req, user?.id);
const preCheck = await preCheckAgentRateLimit({
  agentId: instance,
  callerId,
  limits: agent.rate_limits ?? null,
});
if (!preCheck.ok) {
  res.setHeader("Retry-After", String(preCheck.retryAfter));
  res.status(429).json({
    detail: `Rate limit exceeded for ${preCheck.metric} on agent ${agent.name}.`,
    metric: preCheck.metric,
    retryAfter: preCheck.retryAfter,
  });
  return;
}
```

Inside the streaming `onFinish` callback (where `updateStatistic` is invoked), append:

```ts
await recordAgentTokenUsage({
  agentId: instance,
  callerId,
  limits: agent.rate_limits ?? null,
  inputTokens: metadata?.inputTokens,
  outputTokens: metadata?.outputTokens,
});
```

For the non-streaming branch, the same call goes after the LLM response returns and tokens are known.

### Auth surface

`src/auth/auth.ts` must pass `scope_mode` and `agent_ids` through on the returned user. The current code returns the raw `users` row plus the joined `role`. The new fields land in the row by default; just confirm they are present in the SELECT and on the `User` type.

## Admin UI

### API Keys page (`frontend/app/(application)/keys/page.tsx`)

**Create card** gains a Scope row under the name/role inputs:

```
Scope:  ( ) admin    (•) agents
        ┌─ Agents (visible only when "agents" selected) ─┐
        │ [+ Add agent ▾]   [chip] [chip]                │
        └────────────────────────────────────────────────┘
```

- `admin` selected → role selector enabled (current behavior). Mutation sends no scope fields → server defaults to `scope_mode: 'admin'`.
- `agents` selected → role selector disabled with helper "Role is ignored for agents-scoped keys". Agent multi-select (using existing agents query — verify name at impl) appears. Mutation sends `scope_mode: "agents"`, `agent_ids: [...]`, `super_admin: false`. Generate button disabled until ≥1 agent selected.

**Keys table** gains a "Scope" column:
- `admin` → default badge.
- `agents (N)` → secondary badge, hover tooltip listing agent names.

No edit-in-place for scope. Same as role today.

### Agent detail page (path verified at impl time)

**Rate limits card** — three independently toggleable metrics, each with `limit` + `window_seconds` inputs. Unchecked → omitted from saved JSON. Save uses `UPDATE_AGENT` mutation with the new `rate_limits` field.

**Current usage card** (visible only when `rate_limits` is set) — table with one row per active caller in Redis:

| Caller | Requests | Input tokens | Output tokens |

`Caller` shows the human-friendly name for `user:<id>` callers (resolved server-side) and the raw IP for `ip:<addr>`. Refresh button + 10s poll.

### New resolver `agentRateLimitUsage(agentId)`

- `SCAN MATCH exulu/ratelimit/agent/<agentId>/caller/*/*` (SCAN, never KEYS).
- Group by caller; emit `{ callerId, callerLabel, requests, inputTokens, outputTokens }`.
- For `user:<id>` callers, look up the user name. For `ip:<addr>`, return the raw address.
- GraphQL: `agentRateLimitUsage(agentId: ID!): [RateLimitUsageRow!]!`.

### GraphQL changes

- `CREATE_API_USER` — accept optional `scope_mode`, `agent_ids`.
- `UPDATE_AGENT` — accept optional `rate_limits` JSON.
- `GET_USERS` — include `scope_mode`, `agent_ids` in selection set.
- `AGENT_RATE_LIMIT_USAGE` — new query.

Type additions to GraphQL schema:
- `User.scope_mode: String`, `User.agent_ids: [String!]`.
- `Agent.rate_limits: JSON` (use the project's JSON scalar convention).

## Error responses

| Failure | Status | Body |
|---|---|---|
| Agents-scoped key for non-whitelisted agent | 403 | `{ detail: "API key is not scoped to agent <id>." }` |
| Rate-limit exceeded | 429 + `Retry-After` header | `{ detail: "Rate limit exceeded for <metric> on agent <name>.", metric, retryAfter }` |

Frontend `feedback-chat.tsx` `onError` parser needs a one-line update to also try `parsed?.detail`. Captured as an implementation step.

## Testing

### Unit tests

1. **`check-api-key-scope.test.ts`**
   - Allows for `undefined` user (defer).
   - Allows for non-API user.
   - Allows for API user with no `scope_mode` (legacy).
   - Allows for `admin` scope.
   - Allows for `agents` scope when agent is in `agent_ids`.
   - Denies with `403` for `agents` scope and agent not in `agent_ids`.
   - Denies with `403` for `agents` scope and missing/non-array `agent_ids`.
   - Denies with `401` for unknown `scope_mode`.

2. **`check-agent-rate-limit.test.ts`** (with mocked Redis)
   - `preCheckAgentRateLimit` returns `ok` when `limits` is null.
   - Returns `ok` when Redis unavailable (fail-open).
   - Increments `requests` counter and denies with `metric: "requests"` on over-limit call.
   - Denies with `metric: "input_tokens"` when input_tokens counter already at/over limit.
   - Denies with `metric: "output_tokens"` when output_tokens counter already at/over limit.
   - `recordAgentTokenUsage` is no-op for null limits / no Redis / zero tokens.
   - `recordAgentTokenUsage` increments correct keys and sets TTL on first increment.
   - `resolveCallerId` returns `user:<id>`, `ip:<x-forwarded-for-first>`, `ip:<req.ip>`, `ip:unknown` in that priority.

3. **`check-record-access.test.ts`** (extend if existing)
   - Admin-mode API user still bypasses for any record (existing behavior preserved).
   - Agents-mode API user with `super_admin: false` and record id IN `agent_ids` returns `true` for `read`.
   - Agents-mode API user with `super_admin: false` and record id NOT in `agent_ids` returns `false`.
   - Agents-mode API user with `super_admin: false` and `request: "write"` returns `false` even if record id is in `agent_ids` (read-only).
   - Agents-mode API user with `agent_ids` null/undefined/non-array returns `false`.

### Manual integration checklist

1. **Admin key, no scope set (legacy path).** Works on all routes.
2. **New admin key created via UI.** Works identically to legacy.
3. **Agents-scoped key, in-scope agent.** `POST /agent/{bugId}` succeeds; `POST /agent/{featureId}` returns 403; any GraphQL mutation denied.
4. **Agents-scoped key embedded in browser** (feedback chat usage). Same checks fire.
5. **Rate limit: requests.** `requests: { limit: 3, window_seconds: 60 }`. Calls 1–3 succeed; 4 returns 429 with `Retry-After`. After window, succeeds again.
6. **Rate limit: input_tokens.** `input_tokens: { limit: 1000, window_seconds: 3600 }`. Verify pre-check rejects when counter ≥ limit; first overshoot call still ran.
7. **Rate limit: output_tokens.** Same flow; verify `onFinish` increment.
8. **Rate limit: human caller (JWT).** Counter is `user:<jwt-user-id>`. Same enforcement.
9. **Rate limit: anonymous public agent.** Two different IPs maintain independent counters.
10. **Per-(agent, caller) isolation.** Two API keys; one being over-limit does not block the other.
11. **Frontend error surface.** Trigger 429 in feedback chat; verify Alert shows `detail` text (after `onError` fix).
12. **Live usage table.** Refresh after a few requests; rows appear with current/limit.
13. **Redis down.** Stop Redis → fail-open; warning logged; restart → enforcement resumes.
14. **Migration.** Run `init-db` on a DB with existing API keys; all keep `scope_mode: 'admin'` (or NULL treated as admin) and continue to work.
15. **super_admin enforcement.** Manually flip an agents-scoped key's `super_admin: true` in DB; confirm `checkApiKeyScope` still denies non-whitelisted agents (scope check runs before record access). Confirm UI prevents creating an agents-scoped key with `super_admin: true`.

### Edge cases & assumptions

- **Frontend `onError` parses `detail`.** One-line fix: `parsed?.detail ?? parsed?.message ?? e?.message`.
- **Agent deleted while `agent_ids` references it.** Existing 404 fires before scope check. No cleanup needed.
- **`agent_ids` updates take effect immediately.** No caching of `user.agent_ids` beyond the request.
- **Counter precision.** Token counts come from `metadata.inputTokens` / `outputTokens` in `onFinish` — same source as `updateStatistic`. If the provider returns nothing, the counter doesn't move; the request still counts toward `requests`. Acceptable.
- **Window starts on first increment** (existing pattern). Not aligned to clock boundaries.
- **`scope_mode` / `agent_ids` are not secrets.** Same security posture as `role`. Not encrypted at rest.
- **GraphQL JSON scalar.** Use the project's existing convention; verify at impl time.
- **IP-based partitioning of anonymous callers** is imperfect under NAT. Documented limitation.

## Rollout

Single PR. Order:
1. Backend schema migration with safe defaults.
2. Backend auth + helpers + route wiring + tests.
3. Frontend GraphQL type updates + queries/mutations.
4. Frontend keys page scope selector + table column.
5. Frontend agent detail page rate-limits card + live usage table.

**Backwards compatible by default.** No existing key changes behavior. No existing agent gets a rate limit. Operators opt in by creating new keys with `scope_mode: 'agents'` or by setting `rate_limits` on individual agents.

No data migration beyond the schema add.

## Open items (for implementation)

- Confirm GraphQL JSON scalar name used by the project (for `rate_limits` and `agent_ids`).
- Confirm exact path of the agent detail page in the frontend app router.
- Confirm names of existing GraphQL operations to extend: `CREATE_API_USER`, `UPDATE_AGENT`, `GET_USERS`, and the agents-list query used by the multi-select.
- Update `feedback-chat.tsx` `onError` to read `parsed?.detail` alongside `parsed?.message`.
