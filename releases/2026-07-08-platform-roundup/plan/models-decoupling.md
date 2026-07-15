# Feature plan — Models: agents decoupled from providers (PROSE + snippet)

## Sources of truth

- Spec: `docs/superpowers/specs/2026-05-23-models-entity-agent-decoupling-design.md`
- Backend: commit `815efc3` — `agents.provider`/`agents.providerapikey` dropped,
  `agents.model` added, `resolveModel()` (`src/exulu/resolve-model.ts:179`)
  replaces 8 duplicated lookup sites, `agent_messages.model` persisted,
  per-request override header `x-exulu-model-override`
  (`src/exulu/routes.ts:749`, `:1055`)
- Frontend: commit `0d6d0c1` — `/models` rebuilt as a read-only LiteLLM catalog
  over `GET_LITELLM_CATALOG` (`frontend/queries/queries.ts:1168`), search,
  detail sheet, cost per million tokens; catalog strings in en.json `models.*`
  ("Read-only — models are managed in LiteLLM.", banner "Configured in
  LiteLLM" / "Models live in LiteLLM's config.yaml. …")
- Related: `ab3af43` exposes `model_info.type`/`active` on the catalog and
  filters STT/TTS models out of chat selection.

## What shipped

Agents no longer hard-wire a provider + API-key pair. Model selection is
mediated by a central catalog: the LiteLLM proxy owns model config
(`config.yaml`), the platform reads it through one GraphQL query, and every
consumer — chat routes, the OpenAI-compatible gateway, MCP, evals, tools —
resolves "agent → language model" through a single `resolveModel()` with RBAC
in the loop. Concretely:

- **/models page**: a read-only catalog of everything the proxy serves — context
  windows, modalities (Vision / PDF / Audio / Tools), input/output cost per
  million tokens, active status, tags — with search and a per-model detail sheet.
- **Per-message provenance**: the model used is persisted on every assistant
  message (`agent_messages.model`), so "which model wrote this?" is queryable.
- **Per-request override**: the `x-exulu-model-override` header swaps only the
  language model for that call — the chat model selector rides on this.

Do NOT announce per-model rate-limit/budget columns as enforcement — budgets
and limits are enforced by the LiteLLM proxy layer (already announced in the
Knowledge & Cost release).

## Hook

**"One model catalog. Every agent, every route, one resolver."**

## Surface area

Backend + admin surface, prose-only on this page (the /models catalog UI is
calm-tables, not motion). Audience: platform admins and integrators.

## Page prose plan (3 paragraphs)

1. Before/after: provider + key columns per agent (and 8 copies of the lookup
   dance) → one catalog, one resolver, RBAC-visible model choice.
2. The catalog: LiteLLM `config.yaml` is the single source of truth; the
   platform renders it read-only with cost and capability metadata — no drift
   between what admins configure and what agents can use.
3. Traceability: per-message model persistence + the override header for
   per-request swaps.

## Code snippet — EARNED (GraphQL)

Operation verbatim from `frontend/queries/queries.ts` (`GET_LITELLM_CATALOG`),
field list trimmed to fit:

```graphql
query GetLiteLLMCatalog {
  litellmCatalog {
    model_name
    active
    type
    max_input_tokens
    max_output_tokens
    supports_vision
    supports_function_calling
    input_cost_per_million_tokens
    output_cost_per_million_tokens
  }
}
```

Label on page: "GraphQL — the catalog the UI renders".
