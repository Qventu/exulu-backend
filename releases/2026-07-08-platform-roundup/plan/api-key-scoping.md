# Feature plan — API-key agent scoping (PROSE + snippet)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-05-21-api-key-scoping-and-agent-rate-limits-design.md`
  (scoping half only — see warning below)
- Backend: commit `78eec19` — `src/utils/check-api-key-scope.ts`,
  `check-record-access.ts` (narrowed `isApi` bypass), `users.scope_mode` +
  `users.agent_ids` columns
- Frontend GraphQL: `CREATE_API_USER` mutation in `frontend/queries/queries.ts`
  (~line 850) carries `$scope_mode: String` and `$agent_ids: JSON` — verified.

## ⚠️ Scope warning — do not announce rate limits

The spec's second half (per-agent rate limits) was **removed** in `9174cef`
("removed rate limit functionality from agents as this is handled via litellm
proxy"). Announce ONLY key scoping. If the page mentions limits at all, say
rate/budget enforcement lives in the LiteLLM proxy layer.

## What shipped

API keys now declare a `scope_mode`:

- `admin` — today's broad behavior, unchanged; every existing key defaults here.
- `agents` — the key carries a whitelist of agent IDs (`agent_ids`) and can
  call **only** the agent run route for those agents. Nothing else: no GraphQL
  mutations, no other agents, no admin surface. Enforcement is two-layered —
  an early `checkApiKeyScope` reject plus `checkRecordAccess`, whose blanket
  `isApi` bypass is now narrowed to admin-mode keys.

This is what makes browser-exposed keys (e.g. an embedded feedback chat) safe:
a leaked scoped key can talk to exactly the agents it was minted for.

## Hook

**"Mint a key that can talk to one agent — and nothing else."**

## Surface area

Backend + admin Keys page, enterprise-flavored, prose-only. Audience: platform
operators embedding agents in public surfaces.

## Page prose plan (2–3 paragraphs)

1. The threat model: any key used client-side is a leaked key eventually; a
   broad key means any agent + any mutation.
2. The mechanism: `scope_mode: "agents"` + `agent_ids` whitelist, enforced at
   the route AND in record access; existing keys migrate as `admin` with zero
   behavior change.
3. One sentence on where limits live: usage/budget caps are enforced in the
   LiteLLM proxy layer, so scoped keys inherit spend controls too.

## Code snippet — EARNED (GraphQL)

Trimmed verbatim from `CREATE_API_USER` in `frontend/queries/queries.ts`:

```graphql
mutation CreateUser(
  $type: String, $apikey: String,
  $scope_mode: String, $agent_ids: JSON
) {
  usersCreateOne(input: {
    type: $type, apikey: $apikey,
    scope_mode: $scope_mode,  # "admin" | "agents"
    agent_ids: $agent_ids     # whitelist when scope_mode = "agents"
  }) {
    item { id }
  }
}
```

Label on page: "GraphQL — minting a scoped key".
