# LiteLLM-backed Rerankers from the Catalog

**Date:** 2026-06-19
**Status:** Approved design, pending implementation plan

## Problem

Reranking is currently offered through a developer-supplied `ExuluReranker[]`
list. Each consumer hand-rolls a reranker (e.g. the Cohere SDK or Google
Discovery Engine directly), wraps it in an `ExuluReranker` instance, and passes
the array into `ExuluApp.create({ rerankers })`. That array is then threaded
through ~10 files purely as plumbing so it can reach two places:

1. The GraphQL `Query.rerankers` resolver, which feeds the admin UI dropdown
   for the agentic-retrieval tool's `reranker` tool-variable.
2. `createAgenticRetrievalToolV3`, which matches the stored
   `toolVariablesConfig["reranker"]` id against the list and calls
   `reranker.run(query, chunks)`.

We are moving reranking onto the LiteLLM proxy (its cohere-compatible `/rerank`
endpoint), the same way embeddings (`resolveEmbedder`) and OCR (`resolveOcr`)
already run through the proxy. The set of available rerankers becomes a
**catalog** discovered from `config.litellm.yaml` (models with
`model_info.type === "reranker"`), exactly like embedding models are discovered
via `parse-embedding-models.ts`.

Because the catalog is a synchronous file read available anywhere, the
developer-supplied list and all of its threading become unnecessary. The
`ExuluReranker` class is removed entirely.

## Goals

- Reranking runs through the LiteLLM proxy with tag-based cost attribution
  (user / role / project / agent / routine / context), like chat / embeddings /
  OCR.
- Available rerankers are read from `config.litellm.yaml`; developers no longer
  pass a reranker list.
- Admins continue to select a reranker per agentic-retrieval tool (unchanged
  UX); the stored value becomes a LiteLLM `model_name`.
- The `ExuluReranker` class and all `rerankers[]` threading are deleted.

## Non-goals

- No in-code provider/SDK fallback. Like `resolveEmbedder` / `resolveOcr`,
  reranking is LiteLLM-only and fails fast when `EXULU_USE_LITELLM` is off.
- No score-threshold filtering or "always return top N" fallback baked into the
  resolver (the consuming client's filters were already commented out).
- No migration of `ee/agentic-retrieval/v4/*` — it is dead code and is deleted.

## Design

### 1. Catalog discovery — `src/exulu/litellm/parse-reranker-models.ts`

Mirrors `parse-embedding-models.ts`: a comment-aware, line-based scan of
`config.litellm.yaml` (no YAML parser dependency), reusing
`resolveLiteLLMConfigPath()`.

```ts
export type RerankerModelInfo = {
  model_name: string;
  topN?: number;        // from model_info.top_n — default page size hint
  description?: string; // from model_info.description — admin-facing label text
};

export const parseRerankerModels = (configPath: string): RerankerModelInfo[];
export const getRerankerModelInfo = (
  modelName: string,
  configPath?: string,
): RerankerModelInfo; // fail-fast, actionable error if undeclared
```

Filter rule: an entry is a reranker iff `model_info.type === "reranker"`. The
only required `model_info` key is `type`; `top_n` and `description` are
optional.

Example `config.litellm.yaml` entry:

```yaml
  - model_name: rerank-v4.0-pro
    litellm_params:
      model: cohere/rerank-v4.0-pro
      api_key: os.environ/COHERE_API_KEY
    model_info:
      type: reranker
      top_n: 20            # optional
      description: "Cohere rerank v4 (pro)"   # optional
```

### 2. Resolver — `src/exulu/resolve-reranker.ts`

LiteLLM-only, parallel to `resolveEmbedder` / `resolveOcr`. Throws
`ResolveRerankerError("LITELLM_NOT_CONFIGURED")` when `isLiteLLMEnabled()` is
false or `LITELLM_MASTER_KEY` is missing; awaits `waitForLiteLLMReady()`.

```ts
export type ResolveRerankerInput = {
  model: string;            // LiteLLM model_name (e.g. "rerank-v4.0-pro")
  contextId?: string;
  contextName?: string;
  user?: User;
  userId?: number;          // when only a numeric id is available
  roleId?: string;
  project?: Project;
  agent?: ExuluAgent;
  routine?: { id: string; name: string };
};

export type RerankResult = { index: number; relevanceScore: number };

export type ResolvedReranker = {
  model: string;
  rerank: (
    query: string,
    documents: string[],
    opts?: { topN?: number },
  ) => Promise<RerankResult[]>; // ordered desc by relevanceScore
};

export async function resolveReranker(
  input: ResolveRerankerInput,
): Promise<ResolvedReranker>;
```

Implementation details:

- Calls `POST http://{host}:{port}/v1/rerank` with the cohere-compatible body
  `{ model, query, documents, top_n?, metadata: { tags } }`.
- `top_n` defaults to `documents.length` (rerank/reorder everything) unless the
  caller passes `opts.topN`.
- Tags built via `buildTags(...)` exactly as `resolveEmbedder` /
  `resolveOcr` do, including `context_id` / `context_name`.
- Lazily provisions the per-user budget tag via `provisionDefaultUserBudget`.
- Response: cohere `{ results: [{ index, relevance_score }] }` is mapped to
  `{ index, relevanceScore }`, already ordered desc by the proxy; the resolver
  returns it as-is (no re-sort needed, but ordering is not relied upon —
  callers sort).
- **Stays generic** (strings in, indices + scores out). It does not import
  `VectorSearchChunkResult` or any GraphQL type, preserving the
  `src/exulu` → `src/graphql` dependency direction.

### 3. Chunk mapping — `ee/agentic-retrieval/v3/rerank-chunks.ts`

A small helper that replaces the deleted `ExuluReranker.run`. This is where the
retrieval-specific document convention lives.

```ts
export async function rerankChunks(
  resolved: ResolvedReranker,
  query: string,
  chunks: VectorSearchChunkResult[],
  opts?: { topN?: number },
): Promise<(VectorSearchChunkResult & { rerank_score: number })[]>;
```

Behavior:
- Builds each document as `item_name + ": " + chunk_content` (matching the
  client's existing Cohere usage).
- Calls `resolved.rerank(query, documents, opts)`.
- Maps each result `index` back to its chunk, attaches `rerank_score`
  (defaulting to 0 when a chunk is missing from the response).
- Returns chunks sorted desc by `rerank_score`. No score cutoff, no min-N
  fallback — the caller decides how many to keep.

### 4. v3 wiring

- `v3/index.ts`: the `reranker` tool-variable config field **stays** (admins
  still pick per-tool). `toolVariablesConfig["reranker"]` now holds a
  **model_name**. Replace:
  ```ts
  configuredReranker = rerankers.find((r) => r.id === rerankerId);
  ```
  with a resolve against the catalog:
  ```ts
  const resolvedReranker =
    rerankerId && rerankerId !== "none"
      ? await resolveReranker({ model: rerankerId, user, roleId: role, /* contextId where available */ })
      : undefined;
  ```
  Pass the `ResolvedReranker | undefined` into the agent loop (replacing the
  `ExuluReranker | undefined` it currently receives). Remove the `rerankers`
  parameter from `createAgenticRetrievalToolV3`.
- `v3/agent-loop.ts`: replace `stepChunks = await reranker.run(query, stepChunks)`
  with `stepChunks = await rerankChunks(resolved, query, stepChunks)`. The
  `reranker?` param becomes `resolved?: ResolvedReranker`.

Bonus: rerank spend is now attributable (the old `.run(query, chunks)` carried
no caller identity).

### 5. GraphQL query — catalog-sourced

`resolvers.Query["rerankers"]` (`graphql/schemas/index.ts:1625`) reads
`parseRerankerModels(resolveLiteLLMConfigPath())` directly and maps each entry
to the existing reranker item shape:

```ts
{ id: model_name, name: model_name, description: description ?? "" }
```

(`name` stays the `model_name` so the dropdown label matches the stored value;
`description` is the optional friendly text from `model_info.description`.)

`RerankerPaginationResult` and the GraphQL schema type are unchanged. The
resolver no longer closes over a `rerankers` array.

### 6. Deletions and de-threading

Delete:
- `src/exulu/reranker.ts` (the `ExuluReranker` class).
- `export { ExuluReranker }` from `src/index.ts`.
- The entire `ee/agentic-retrieval/v4/` directory (dead code: `agent-loop.ts`,
  `context-sampler.ts`, `index.ts`, `types.ts`; nothing imports
  `createAgenticRetrievalToolV4`).

Remove `rerankers` from `ExuluApp.create({...})` (`src/exulu/app/index.ts`):
the `_rerankers` field, the constructor/create param, and the reranker entry in
the ID-validation block (IDs now come from `config.litellm.yaml`).

Strip the `rerankers[]` pass-through plumbing (it carries the array but never
uses it directly) from:
- `ee/workers.ts`
- `src/exulu/provider.ts`
- `src/exulu/routes.ts`
- `src/exulu/openai-gateway.ts`
- `src/mcp/index.ts`
- `src/utils/enabled-tools.ts`
- `src/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts`
- `src/graphql/resolvers/index.ts`, `src/graphql/mutations/index.ts`,
  `src/graphql/utilities/sanitize-and-hydrate-fields.ts`, and the
  `createQueries` / `createMutations` signatures in `src/graphql/schemas/index.ts`

## Breaking change

`ExuluApp.create({ rerankers })` no longer accepts `rerankers`, and the
`ExuluReranker` export is removed. The consuming application must drop its
`rerankers: [...]` argument and its hand-rolled reranker definitions, and
instead declare reranker models in `config.litellm.yaml` with
`model_info.type: reranker`. This is a coordinated change with the consumer.

## Result behavior

Reranking reorders all input chunks by relevance score and attaches
`rerank_score`. No score threshold and no "always return top N" fallback are
applied by default; `opts.topN` (when passed) is forwarded to the proxy as a
hint. This matches the behavior the consuming client actually ran (its
threshold/min-5 filters were commented out).

## Testing

- `src/exulu/litellm/parse-reranker-models.test.ts` — catalog parsing,
  comment-stripping, commented-out blocks skipped, `type: reranker` filter,
  `getRerankerModelInfo` fail-fast. Mirrors the embedding-models test.
- `src/exulu/resolve-reranker.test.ts` — throws when LiteLLM is off; request
  body shape (`model` / `query` / `documents` / `top_n` / `metadata.tags`); tag
  stamping; cohere → `{ index, relevanceScore }` mapping. Mirrors
  `resolve-embedder.test.ts`.

## Out of scope / future

- Per-context reranker configuration (reranker chosen on the context like
  `embedder.model`) — current design keeps per-tool selection.
- Wiring `opts.topN` to a model-info default (`top_n`) in the retrieval loop —
  the field is parsed and available but not yet consumed; left for a follow-up.
