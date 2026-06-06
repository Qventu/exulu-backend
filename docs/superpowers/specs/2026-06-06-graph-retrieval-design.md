# Graph Retrieval — Entity Layer for the Context Database — Design

**Date:** 2026-06-06
**Status:** Drafted (pending user review)
**Phase:** Phase 1 of 2 (Phase 2 — typed entity relations — documented but not built)

## Goal

Add an **optional, per-`ExuluContext` entity layer** to the Context Database that improves retrieval precision and enables agent-driven exploration of connected information — while staying entirely on Postgres + pgvector.

When switched on for a context, documents are processed (during the existing embedding flow) to extract **entities** of dev/admin-declared types. Entities are linked to chunks, normalized across languages to a canonical form, and used at query time to (a) **soft-boost** retrieval ranking when a result shares entities with the query, and (b) return an **entity-intelligence payload** so the calling agent can decide whether to explore related documents via an **entity-scoped follow-up search**.

The feature is **off by default**: a context with no entity configuration behaves byte-for-byte as it does today and creates no new tables.

## Background

The Context Database today (see `src/exulu/context.ts`, `src/exulu/embedder.ts`, `src/graphql/resolvers/vector-search.ts`):

- Each `ExuluContext` owns two per-context tables created lazily: `<ctx>_items` and `<ctx>_chunks`. Chunks carry `content`, a pgvector `embedding` (HNSW cosine index), a generated `fts` tsvector (GIN), `metadata jsonb`, and `chunk_index`.
- Ingestion: `processField` → `embedder.generateFromDocument` (chunk + embed) → `createAndUpsertEmbeddings` deletes a source's old chunks and inserts new ones. Optionally async via BullMQ.
- Retrieval: `search()` → `vector-search.ts` supports three methods — `tsvector`, `cosineDistance`, and `hybridSearch` (RRF). Supports filters, access control, query rewriting, reranking (stub), and chunk expansion.
- Admin-configurable per-context settings already exist via the `embedder_settings` core table (`src/postgres/core-schema.ts`) + the `variables` table, read at runtime by `hydrateEmbedderConfig`. Any `ExuluTableDefinition` added to `core-schema.ts` auto-generates GraphQL CRUD + admin UI.
- Model selection is centralized: agents reference a `models.id` (uuid), resolved to a callable `LanguageModel` by `resolveModel()` (`src/exulu/resolve-model.ts`), which handles provider lookup, encrypted auth, RBAC, budgets, and LiteLLM mode.

There is currently **no notion of entities or relationships** — only chunk-level metadata and item tags. This spec adds that layer.

### Priorities driving the design

1. **Primary — precision via entities.** Disambiguate/boost normal RAG using shared entities between query and chunks. Implemented as a soft re-rank that blends into the existing hybrid score.
2. **Secondary — connect facts via linked entities.** Rather than the retriever traversing the graph, the retriever **surfaces entity intelligence** (which query-relevant entities were found, how many related docs exist, which entities they connect to) and exposes an **entity-scoped follow-up search**, so the **calling agent** drives multi-hop exploration.

## Scope

**In scope (Phase 1):**
- Per-context opt-in via a new `entities` block on `ExuluContext` (off when absent).
- Dev-declared entity types (`{ name, description }`) merged with admin-declared types from a new `entity_type_settings` core table (union, dedup by name, admin wins on collision).
- Dev-defined extractor model per context (`entities.model` → `models.id`, resolved via `resolveModel`; falls back to platform default).
- LLM-based `EntityExtractor` (default implementation; internally swappable seam) run inside the existing embedding job, **non-fatal** to embeddings.
- Two new per-context tables: `<ctx>_entities` (canonical catalog + maintained counters) and `<ctx>_chunk_entities` (mention junction).
- Normalized-string-match entity resolution keyed off an LLM-supplied **canonical** name; **multilingual normalization** to a configurable `canonicalLanguage` (default English).
- Soft-boost re-ranking in `vector-search.ts`, weighted by `entities.boostWeight`.
- Entity-intelligence payload (`entityInsights`) on search results, including **derived co-occurrence** related entities (computed on demand, no edge table).
- Entity-scoped follow-up retrieval (`entityFilter`) for agent-driven exploration.
- Backfill / re-extraction lifecycle: staleness detection via per-item type-set signature; admin-initiated **full re-extraction** over stale items via BullMQ; type deactivation + opt-in purge.
- Tests (unit + integration), including an isolation guarantee that entity-free contexts are unchanged.

**Out of scope (Phase 2, documented not built):**
- Explicit **typed** entity-to-entity relations (`<ctx>_entity_relations` edge table, extracted triples). Phase 1 ships derived co-occurrence only.
- The denormalized `entity_keys text[]` GIN column on chunks (boost hot-path optimization). Added only if profiling requires it.
- Embedding-similarity or LLM-clustering entity resolution (beyond canonical-string match).

**Explicit non-goals:**
- Global/thematic corpus summarization (Microsoft GraphRAG community detection).
- A structurally-queryable knowledge graph / triple-store query language.
- Changing any existing `_items` / `_chunks` column or the current retrieval behavior for non-entity contexts.

**Frontend dependency (flagged, not implemented here):**
- Surfacing `entity_type_settings` CRUD next to embedder auth in the admin app, plus the "backfill suggested" prompt. This backend spec provides the tables, resolvers, and backfill operation; the admin UI wiring lives in the frontend repo.

## Dev-facing contract

Graph features switch on per context through a self-contained `entities` block alongside `fields`. Absent → zero behavior change.

```ts
new ExuluContext({
  id: "contracts",
  fields: [ /* ...existing... */ ],

  // Declaring this block turns the entity layer on for this context.
  entities: {
    types: [
      { name: "Person",  description: "Individuals named in the contract" },
      { name: "Company", description: "Legal entities / organizations" },
      { name: "Product", description: "Products or services referenced" },
    ],
    model: "<models.id uuid>",     // extractor LLM; resolved via resolveModel(). Optional → platform default.
    extractFrom: "chunks",         // "chunks" (default) | "document"
    boostWeight: 0.3,              // weight of the shared-entity boost term
    confidenceThreshold: 0.5,      // drop mentions below this extractor confidence
    canonicalLanguage: "english",  // target language for canonical names (default "english")
  },
});
```

Rules:
- **Absent `entities` block → no tables, no extraction, identical retrieval path.**
- Entity **types** are declared as `{ name, description }`. The effective type set is the **union** of these code types and the admin-managed `entity_type_settings` rows. If a context declares no `entities` block but an admin adds types for it, the layer activates from admin config alone.
- The `EntityExtractor` is a default LLM implementation with an internal seam so it can be swapped later (mirroring the `chunker`/`embedder` hook pattern). Phase 1 ships only the default.
- `extractFrom` defaults to `"chunks"` so each mention is precisely located to a chunk (the boost depends on chunk-level placement).

## Data model

### New core table: `entity_type_settings` (`src/postgres/core-schema.ts`)

Stores **configuration** (which entity *types* a context should extract), not extracted data. Admin-managed; auto-generates GraphQL CRUD + admin UI like `embedder_settings`. One row = one type for one context.

```ts
const entityTypeSettingsSchema: ExuluTableDefinition = {
  type: "entity_type_settings",
  name: { plural: "entity_type_settings", singular: "entity_type_setting" },
  RBAC: false,
  fields: [
    { name: "context",     type: "text" },                 // ExuluContext id
    { name: "name",        type: "text" },                 // entity type, e.g. "Person"
    { name: "description", type: "text" },                 // extraction guidance
    { name: "active",      type: "boolean", default: true },
  ],
};
```

A `hydrateEntityTypes(context)` helper (parallel to `hydrateEmbedderConfig`) reads `active` rows and unions them with the code-declared `entities.types`, deduped by lowercased `name` (admin wins on collision).

### New per-context table: `<ctx>_entities` (canonical entity catalog)

Created lazily when a graph-enabled context initializes (same `tableExists`-guarded pattern as `createChunksTable`). Machine-generated entities found in the corpus.

```
id            uuid    PK   default uuid()
type          text         -- one of the effective entity type names
canonical_key text         -- normalize(canonical name); the resolution key
display_name  text         -- canonical surface form (in canonicalLanguage)
mention_count int          -- maintained at ingest (total mentions)
doc_count     int          -- maintained at ingest (distinct items mentioning it)
metadata      jsonb        -- reserved: observed aliases / surface variants / future embeddings
createdAt / updatedAt timestamps
UNIQUE (type, canonical_key)
```

### New per-context table: `<ctx>_chunk_entities` (mention junction)

```
chunk_id     uuid   -- FK -> <ctx>_chunks(id) ON DELETE CASCADE
entity_id    uuid   -- FK -> <ctx>_entities(id)
item_id      uuid   -- denormalized FK -> <ctx>_items(id); doc-level counts + access joins
mention_text text   -- exact surface form found in this chunk (original language)
confidence   real   -- from extractor; filtered by confidenceThreshold
PRIMARY KEY (chunk_id, entity_id)
INDEX (entity_id)            -- entity -> chunks (exploration, counts, co-occurrence)
INDEX (entity_id, item_id)   -- entity -> distinct docs
-- chunk_id is the PK leading column → covers the boost candidate-set join
```

Notes:
- `item_id` denormalized so doc-level counting and access-control joins skip a hop through chunks.
- `ON DELETE CASCADE` means the existing re-embed flow (delete-then-reinsert chunks) auto-clears stale mentions; entities + counters are recomputed in the same ingest transaction.
- Counters live on the entity row so enrichment is a single-row read, never a live `COUNT(*)` over millions of rows.

### Item table additions (graph-enabled contexts only)

Two columns added to `<ctx>_items` to drive staleness detection (additive; nullable):

```
entities_updated_at      timestamp  -- last successful extraction for this item
entity_types_signature   text       -- hash of the effective type set used at last extraction
```

## Ingestion pipeline

Entity extraction hooks into the existing embedding flow (`createAndUpsertEmbeddings`); no second pass over documents.

```
processField / embeddings.generate
  └─ embedder.generateFromDocument → chunks[] (content + vector)        [unchanged]
       └─ if context.entities is active:
            EntityExtractor.extract(chunks, effectiveTypes, model)      [NEW]
            └─ single transaction:
                 • delete old chunks for source (existing) → CASCADE clears old mentions
                 • insert new chunks            (existing)
                 • upsert entities (resolve by (type, canonical_key))
                 • insert chunk_entities rows
                 • recompute mention_count / doc_count for touched entities
                 • set items.entities_updated_at + entity_types_signature
```

**`EntityExtractor` (default LLM implementation):**
- Input: an item's chunk batch + the effective `{ name, description }` types + the resolved extractor model (`resolveModel({ modelId: entities.model })`, or platform default; LiteLLM model-name string under `EXULU_USE_LITELLM=true`).
- One **batched LLM call per item** (covers all the item's chunks; very large items split to fit context) using structured output.
- Output per mention: `{ chunkIndex, type, mention, canonical, confidence }`, filtered by `confidenceThreshold`.
- Because resolution goes through the `models` row, extraction respects that model's rate-limit/token/cost budgets.

**Resolution & upsert (normalized string match on canonical):**
- `canonical_key = normalize(canonical)` — lowercase, trim, collapse whitespace, strip surrounding punctuation. Per type.
- `INSERT … ON CONFLICT (type, canonical_key) DO UPDATE` returns `entity_id`. First-seen canonical becomes `display_name`; observed surface variants may accumulate in `metadata.aliases`.
- Junction rows store `chunk_id`, `entity_id`, `item_id`, `mention_text` (original surface form), `confidence`.
- Counters recomputed for affected entities within the transaction (scoped to this item's deltas).

**Failure isolation:** extraction is best-effort. If the LLM call fails, **chunk/embedding insertion still succeeds**; the item is left un-entitied (and stale) and can be re-processed later. Embeddings never block on the entity layer — safe to enable on a live context. Runs inside the existing BullMQ embedding job; no new queue infrastructure.

## Multilingual normalization

The extractor separates the **surface form** from the **canonical form**:

```jsonc
{ "type": "City", "mention": "München", "canonical": "Munich", "confidence": 0.96 }
```

- `canonical_key = normalize(canonical)`, so "München", "Munich", "MUC" resolve to one `entity_id`.
- `mention_text` preserves the original surface form; nothing is lost for display or exact-match needs.
- `display_name` = canonical form in `canonicalLanguage` (default English).
- **Query time is symmetric:** a German or English query extracts to the same canonical key, matching stored entities regardless of document language.
- Side effect: LLM-supplied canonical also collapses within-language variants ("Acme Inc" / "ACME" → "Acme"), improving resolution beyond raw string matching (best-effort).

Extraction-prompt guardrails:
- **Do not translate identifiers** — case numbers, SKUs, product codes, proper product names stay verbatim as their own canonical.
- `canonicalLanguage` is configurable (default `"english"`), independent of the existing `languages` tsvector setting (which still governs full-text search on chunk content).

## Retrieval: boost + enrichment payload

Extends `vector-search.ts`. When the context has no entity layer, the path is byte-for-byte today's behavior.

**a) Query entity extraction.** The query runs through the same `EntityExtractor` (effective types) → query entities resolved to `entity_id`s via the `(type, canonical_key)` index. Cached per query string within a request.

**b) Soft boost.** After the existing vector/FTS/hybrid retrieval yields the candidate set (`limit*2`), `LEFT JOIN` the junction filtered to the query's `entity_id`s against those candidates and add a boost term:

```
final_score = base_score + boostWeight * f(shared_entity_count)
```

`base_score` = existing cosine / ts_rank / RRF score; `f` is saturating (e.g. `shared/(shared+1)`) so the first shared entity helps most. `boostWeight` from `entities.boostWeight`. Pure re-rank — nothing is excluded. The join is bounded by the candidate set (hundreds of rows) using the `chunk_id` PK leading column, so it is **independent of corpus size**.

**c) Enrichment payload.** Results return an entity-intelligence block so the calling agent can decide whether to explore:

```jsonc
{
  "results": [ /* chunks as today, each annotated with its entities */ ],
  "entityInsights": {
    "queryEntities": [
      {
        "id": "...", "type": "Company", "name": "Acme Corp",
        "matchedInResults": 4,       // returned chunks mentioning it
        "relatedDocCount": 12,       // maintained doc_count (single-row read)
        "relatedEntities": [         // derived co-occurrence, top-K, weighted
          { "name": "Globex", "type": "Company", "weight": 0.41 },
          { "name": "Munich", "type": "City",    "weight": 0.33 }
        ]
      }
    ]
  }
}
```

`relatedDocCount` is the maintained counter; `relatedEntities` is the on-demand co-occurrence query (below), run only for the few query entities, capped at top-K.

## Entity-to-entity relations (derived co-occurrence, Phase 1)

No edge table. Two entities are related because they co-occur in documents; relatedness is computed **on demand, scoped to one entity**, via a junction self-join:

```sql
-- "what is :entity related to, and how strongly?"
SELECT e2.id, e2.display_name, e2.type,
       COUNT(DISTINCT j2.item_id) AS shared_docs
FROM   <ctx>_chunk_entities j1
JOIN   <ctx>_chunk_entities j2 ON j1.item_id = j2.item_id
JOIN   <ctx>_entities e2       ON e2.id = j2.entity_id
WHERE  j1.entity_id = :entity_id
  AND  j2.entity_id <> :entity_id
GROUP  BY e2.id
ORDER  BY shared_docs DESC
LIMIT  :k;
```

- Gives any entity an unbounded set of weighted relations without storing N² edges; always an `entity_id` index seek for **one** entity, so it scales.
- Weight may be normalized (Jaccard: `shared / (docsA + docsB − shared)`) to discount globally-common entities so they don't look "related to everything."
- Edges are **untyped** (relatedness strength only). Typed semantic edges are Phase 2.

## Agent-facing exploration surface

Rather than the retriever traversing, expose **entity-scoped retrieval** as a follow-up the agent calls:

- `search(..., entityFilter: { entityIds | (type,name)[], mode: "any" | "all" })` — restrict retrieval to chunks mentioning the given entities, still ranked by the normal vector/FTS/hybrid score. Index seek on `entity_id`, paginated, so even a hot entity returns a capped, relevance-ordered page.

Loop: normal `search` → agent reads `entityInsights` → agent optionally calls `search` again scoped to an entity it wants to follow. Fully agent-driven; the retriever stays stateless.

## Type changes after ingestion (backfill)

**Staleness detection (precise).** Each item stores `entity_types_signature` = hash over the sorted effective type names, plus `entities_updated_at`. An item is **stale** iff `item.entity_types_signature != current_signature`. Editing an unrelated context field does not flag items; only an actual type-set change does. The stale-item count is a cheap indexed query.

**UI suggests, never silently auto-runs.** When an admin saves a new/edited type in `entity_type_settings`, the admin app shows a non-blocking prompt:

> "Added type **Product**. 142,000 existing items were processed before this type existed. Run extraction to apply it now? [Backfill now] [Later]"

It surfaces the **item count and estimated cost/time** (from the chosen `models` row's pricing). Backfill enqueues `context.entities.generate.all({ onlyStale: true })` through BullMQ — async, resumable, pausable/cancelable, idempotent, failures non-fatal.

**Backfill granularity: full re-extract.** Each stale item is re-run over the **full** effective type set (not just the new type). Simpler to build (no scoped-type extraction), self-healing (also corrects drift, e.g. after changing the extractor model). The cost tradeoff is acceptable because backfill is an explicit, admin-initiated action with cost shown upfront.

**Type deactivation / removal.** Setting `active = false` stops future extraction of that type but leaves already-extracted entities in place. Paired with an explicit, opt-in **"purge type"** action that deletes that type's entities + mentions for the context. Default is leave-in-place.

## Migrations

- `entity_type_settings` → added to `core-schema.ts`; `init-exulu-db.ts` creates it and `addMissingFields` maintains it. No manual migration.
- `<ctx>_entities` / `<ctx>_chunk_entities` → created lazily on graph-enabled context init (`tableExists`-guarded). Non-entity contexts create nothing.
- `<ctx>_items` gains `entities_updated_at` + `entity_types_signature` via the existing additive column-add path (gated by column-existence checks, per project convention — no separate manual script).
- Backfill of existing data is the idempotent, queue-driven `entities.generate.all()` operation, not a migration script.
- Fully additive — no changes to existing `_items` / `_chunks` columns; zero risk to current data.

## Performance guarantees (at 1M+ chunks)

- **Boost:** small indexed join over the `limit*2` candidate set; independent of corpus size.
- **Enrichment counts:** maintained `doc_count` / `mention_count` single-row reads; no live aggregation.
- **Co-occurrence + exploration:** `entity_id`-scoped index seeks, paginated; hot entities cannot blow up.
- **Extraction:** one batched LLM call per item, async in the existing BullMQ embedding job, budgeted via the `models` row.
- Sizing: 1M chunks × ~5 entities ≈ 5M junction rows — small for Postgres with the specified btree indexes.

## Testing

- **Unit:** `normalize()` / `canonical_key`; multilingual canonical resolution (München → Munich); `ON CONFLICT` upsert + counter maintenance; saturating boost function; co-occurrence/Jaccard query; enrichment payload shape; staleness signature.
- **Integration:** seeded bilingual (de/en) context — cross-lingual entity merge, boost re-ranking, `entityInsights` output, entity-scoped follow-up search, backfill over stale items.
- **Isolation guarantee:** a context with no `entities` block produces byte-identical search results and creates no entity tables.

## Rollout

- Off by default; opt-in per context (code, admin, or both). Extraction failures non-fatal to embeddings.
- **Phase 1 (this spec):** entity layer, extraction, soft-boost precision, enrichment payload, agent-scoped exploration, derived co-occurrence relations, multilingual normalization, backfill lifecycle.
- **Phase 2 (documented, not built):** typed extracted `entity_relations`; optional GIN `entity_keys` array boost optimization; advanced entity resolution (embedding/LLM clustering).
- **Frontend dependency:** `entity_type_settings` CRUD + backfill prompt surfaced next to embedder auth in the admin app.
