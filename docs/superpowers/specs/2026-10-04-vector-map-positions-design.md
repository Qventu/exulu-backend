# Agent memory redesign — sub-project 3c-1: vector positions and the map API

Date: 2026-10-04 · Status: design approved in conversation, spec for review · Branch: `feat/vector-map-positions` (backend from develop b599aa5)

Sub-project 3c (the memory map) was split on 2026-10-04 into **3c-1: positions, the fit and the read API (this spec)** and **3c-2: the 3D view** on both the memory base page and the knowledge workspace. 3c-1 is backend only.

## 1. Purpose

Every chunk already carries a high-dimensional embedding. This sub-project gives every chunk a position in three dimensions, derived from that embedding, so a base can be drawn as a cloud where near means similar. The positions are stored, computed once per chunk, and recomputed automatically whenever the chunk is re-embedded. Lines between points come from the existing full-text index rather than from the entity layer, because entity extraction is not enabled on most bases.

Decisions Daniel made on 2026-10-04:

| Decision | Choice |
|---|---|
| How vectors become positions | **a fitted layout plus a learned linear map**: the script runs UMAP for a genuinely cluster-separated layout, then stores a linear map so a new embedding can be placed immediately |
| When positions are computed | at embedding time for new chunks; a **script** fits the base and backfills existing chunks |
| What the lines mean | lexical similarity from the existing tsvector index (Postgres full-text ranking, **not** literally BM25 — no BM25 extension is installed) |
| Where it applies | the projection is generic to every context; 3c-2 puts the view on memory bases **and** knowledge bases |
| Dimensions | three, rendered in 3D; no 2D fallback |

## 2. Data

### 2.1 Chunk coordinates

Three nullable `real` columns on every `<ctx>_chunks` table: `px`, `py`, `pz`.

- `createChunksTable` (`src/exulu/context.ts`) adds them for new contexts.
- Existing chunk tables have no field-sync path, so the init-db context loop gains an idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for each of the three, next to the existing "create the chunks table if missing" step.
- A partial index `(<ctx>_chunks) WHERE px IS NOT NULL` is **not** created; the map always reads by `source`/item and the existing `source` index covers it.

### 2.2 `context_projections` (new core table, no RBAC flag)

One row per context, holding everything needed to place a vector.

| Field | Type | Notes |
|---|---|---|
| `context` | text, unique | context id |
| `dims` | number | source dimensionality `D` |
| `components` | number | intermediate dimensionality `k` (default 50) |
| `mean` | json | `D` floats — the sample mean of the normalized vectors |
| `basis` | json | `k × D` — orthonormal rows, the linear reduction |
| `map` | json | `3 × k` — the learned map onto the layout |
| `intercept` | json | 3 floats |
| `method` | text | `umap+linear` |
| `version` | number | bumped when the pipeline changes; a mismatch means "refit needed" |
| `sample_size` | number | vectors the fit used |
| `residual` | number | mean placement error of the linear map relative to the cloud radius (0 = perfect) |
| `fitted_at` | date | |

The payload is roughly 1 MB of JSON for a 1536-dimension model with `k = 50`. It is read once per process and cached per context, invalidated by `fitted_at`.

## 3. The fit

`npx tsx scripts/fit-context-projection.ts --context <id> [--sample 20000] [--components 50] [--dry-run] [--all]` (the existing one-off script pattern: `postgresClient()`, `--dry-run`, console summary).

1. **Load** up to `--sample` chunk vectors of the context whose item is not archived, sampled deterministically (`ORDER BY md5(id::text || '<context>')`) so a rerun on an unchanged base reproduces the same fit.
2. **Normalize** each vector to unit length — the space is cosine, which is also what Daniel meant by normalized vectors.
3. **Centre** on the sample mean.
4. **Reduce to `k` dimensions** with a randomized PCA: three power iterations against a seeded random `D × k` matrix with Gram-Schmidt re-orthonormalisation, on typed arrays. This costs `N·D·k` per pass, seconds at the default sample, where a full covariance eigendecomposition would be minutes.
5. **Lay out** the reduced vectors with UMAP to three components (cosine metric, 15 neighbours, min distance 0.1, seeded).
6. **Normalise the layout** so the cloud is centred on the origin and its 99th-percentile radius is 1. Every base then frames identically in the camera.
7. **Learn the map**: ridge least squares from the `k`-dimensional vectors onto the layout, solving the `k × k` normal equations by Gaussian elimination. Store the 3 × k matrix, the intercept and the residual.
8. **Store** the projection row (`version` bumped on pipeline changes).
9. **Backfill**: stream every chunk of the context in batches of 500, project, write `px`, `py`, `pz`. Chunks without an embedding keep null coordinates.

Contexts are declared by the consuming application, not by this package, so the script works from the database: `--context` names one, `--all` fits every base that has a chunks table, and a base with fewer than `components + 1` embedded chunks is skipped with a reason. `--dry-run` reports sample size, residual and how many chunks would be written, and stores nothing.

Refitting moves existing points. That is inherent to a layout algorithm; the API reports `fittedAt` so the UI can say when the picture was last redrawn.

New dependency: a pure-JavaScript UMAP implementation (`umap-js`). The PCA, the ridge solve and the normalisation are ~150 lines of tested linear algebra in this repo, so no matrix library is added.

## 4. Positions at embedding time

In the one place chunks are inserted (`src/exulu/context.ts`, after `resolved.embed(...)`):

- load the context's projection (process cache keyed by context id and `fitted_at`),
- for each chunk vector: normalize, centre, apply `basis`, apply `map`, add `intercept`,
- include `px`, `py`, `pz` in the insert.

No projection row, a dimension mismatch, or a `version` mismatch means the coordinates are written as null and one line is logged. A failure in the projection never fails the embedding: it is wrapped and logged, exactly like the memory-usage writer.

Because coordinates are written with the chunks, re-embedding an item refreshes them for free. The linear map places a new chunk approximately; the stored `residual` says how approximately, and a refit corrects it.

## 5. Read API

Three queries, registered next to the memory ones. Points and edges carry item content, so both apply the **item-level access control** the generated item resolvers and vector search already use (`applyAccessControl(table, query, user, "items")`); no extra area gate, matching how `<ctx>_itemsPagination` behaves. The status query returns counts only and needs an authenticated user.

```graphql
enum ContextMapMode { DOCUMENTS  PASSAGES }

type ContextMapPoint {
  id: ID!            # item id (DOCUMENTS) or chunk id (PASSAGES)
  itemId: ID!
  x: Float!  y: Float!  z: Float!
  label: String!     # item name, or the first 120 characters of the chunk in PASSAGES
  group: String      # value of the requested grouping field, for colouring
  chunks: Int!       # chunks behind this point (1 in PASSAGES)
}
type ContextMapPoints { points: [ContextMapPoint!]!  total: Int!  sampled: Boolean! }
type ContextMapEdge { source: ID!  target: ID!  score: Float! }
type ContextProjectionStatus {
  fitted: Boolean!  method: String  fittedAt: String  sampleSize: Int
  dims: Int  components: Int  residual: Float
  mappedChunks: Int!  totalChunks: Int!
}

contextMapPoints(contextId: ID!, mode: ContextMapMode = DOCUMENTS, groupField: String, search: String, limit: Int = 5000): ContextMapPoints
contextMapEdges(contextId: ID!, nodeId: ID!, limit: Int = 8): [ContextMapEdge!]!
contextProjectionStatus(contextId: ID!): ContextProjectionStatus
```

- **Points**, `DOCUMENTS`: one row per item, positioned at the average of its chunk coordinates, with the chunk count. A document whose chunks scatter lands between them; that is the standard compromise and `PASSAGES` exists for when it matters. `PASSAGES`: one row per chunk.
- `groupField` is validated against the context's declared fields and returned as `group` (memory bases pass `type`); an unknown field is ignored rather than erroring.
- `search` narrows to items whose name or text matches, through the existing full-text index.
- `limit` defaults to 5,000 and is capped at 20,000. Above the cap the result is the same deterministic sample used by the fit, with `sampled: true` and the true `total`.
- **Edges** take one node and return its strongest lexical neighbours. The node's first chunk is reduced to the twelve lexemes that carry it, by asking Postgres to unnest the chunk's own `tsvector` and keep the most frequent, longest ones. Those are OR-ed into one `to_tsquery`, matched against the other items' chunks through the tsvector index, ranked with `ts_rank`, the node itself excluded, best per item, capped by `limit`. A whole-graph edge mesh needs precomputed edges and is deliberately left to 3c-2's design.

  Corrected on 2026-10-04 during execution (controller Ruling 24). The original design said the node's text was "turned into a query with the existing query-preprocessing helper". That helper deliberately refuses the lenient OR form above twelve terms and falls back to a strict AND over every lexeme, which it documents as acceptable because a semantic branch carries such queries in hybrid search. Edges have no semantic branch, so every node longer than a sentence would have returned nothing. The twelve-lexeme cap keeps the measured-safe term count the helper itself uses.
- **Status** reports whether a usable projection exists (row present, version current, dimensions matching the context's model) and the coordinate coverage.

## 6. Privacy and error handling

| Case | Behaviour |
|---|---|
| Viewer may not read an item | its point and every edge touching it are absent; counts in `total` are scoped the same way |
| Base never fitted | `fitted: false`, points empty, the UI shows "not mapped yet" |
| Projection version or dimensions stale | treated as not fitted; the script refits |
| Chunk without an embedding | null coordinates, excluded from points |
| Projection fails at embedding time | coordinates null, one log line, the embedding still succeeds |
| Edges query fails | the error surfaces on that query only; points are unaffected |
| Context without an embedder | all three queries answer empty / not fitted |

Coordinates are derived from content, so they are treated as content: they are only ever returned for items the viewer may read.

## 7. Testing

- Backend (jest): normalisation and projection maths against fixed vectors; randomized PCA recovering known axes on synthetic data; the ridge solve reproducing its training targets within tolerance; layout normalisation (centre and radius); the projection cache invalidating on `fitted_at`; the chunk-insert path writing coordinates and surviving a missing or mismatched projection; the three resolvers against a fake database covering access scoping, `DOCUMENTS` versus `PASSAGES`, the cap and sampling flag, `groupField` validation, and edges excluding the node itself.
- The script's pure pieces are unit-tested; the script itself is exercised by a dry run in UAT.
- UAT (Daniel): fit Newton's memory base and a real knowledge base, check the residual and coverage the script reports, query points for both modes, confirm a second user sees fewer points on a base with private items, save a new memory in chat and confirm it gets coordinates without a refit.

## 8. Out of scope

The 3D view and both its surfaces (3c-2), a whole-graph edge mesh, fitting from the UI or a queued job, recomputing positions when an item changes without re-embedding, and any 2D fallback.
