# Feature plan — ExuluReadApi: RBAC-safe reads for retrieval clients (PROSE + snippet)

## Sources of truth

- Code: `src/exulu/read-api.ts` (whole module), export at `src/index.ts:18`
  (`export { ExuluReadApi } from "./exulu/read-api.ts";`)
- Commits: `7db27d5` (table-name resolvers), `1b613e0` (leaf module refactor),
  `9fe7f98` (entitiesAvailable), `5a796d2` (authorizedRead + RBAC-aware
  getItems), `c57d088` (full VectorSearchChunkResult shape), `fbb860b`
  (embedQuery)
- No spec doc — the module docblocks are the spec.

## What shipped

A supported, RBAC-safe read namespace on the SDK for retrieval clients (the
agentic harness is the first consumer). Everything a custom retrieval pipeline
used to hand-roll against raw tables — with the access-control clause it was
one refactor away from forgetting — is now one import:

- `authorizedRead(context, user, role, opts)` — direct chunk reads for known
  items, joining `<ctx>_chunks → <ctx>_items` with `applyAccessControl` applied
  on the items alias in SQL. Must be constrained by `itemIds` or `externalIds`
  (throws otherwise — no accidental table scans); optional `chunkIndexRange`.
  Returns full `VectorSearchChunkResult` rows.
- `embedQuery(context, text, opts)` — embed a query with the same embedder the
  context indexes with, resolved per caller (`inputType` defaults to `"query"`).
- `entitiesAvailable(context)` — capability probe: true only when the context
  declares an entities config AND its `_chunk_entities` table physically exists
  (`to_regclass` check), so a package version without the entity layer can't
  break callers.
- Table-name resolvers: `getTableName`, `getChunksTableName`,
  `getEntitiesTableName`, `getChunkEntitiesTableName`.
- Companion: `ExuluContext.getItems` became RBAC-aware (opt-in via `user`).

## Hook

**"Build retrieval on authorized rows — not on raw tables."** The read shapes
`search()` can't express, with visibility enforced in SQL, one import away.

## Surface area

SDK / developer feature (recipe B territory, but prose-only on this page — no
video). Audience: engineers building custom retrieval/agents on `@exulu/backend`.

## Page prose plan (2–3 paragraphs)

1. The problem: custom retrieval clients need reads that `context.search()`
   can't express — "give me chunks 0–20 of this exact file", "does this context
   have an entity layer?" — and hand-rolled SQL silently skips RBAC.
2. What you get: the four calls above; stress that `authorizedRead` refuses
   unconstrained reads and that access control is applied inside the query, so
   a user can never receive a chunk from an item they can't see.
3. Where it's used: this is the exact API the agentic retrieval pipeline
   (announced 2026-07-07) runs on — it's supported surface, not internals.

## Code snippet — EARNED (TypeScript, SDK)

All symbols verbatim from `src/exulu/read-api.ts` / `src/index.ts`:

```ts
import { ExuluReadApi } from "@exulu/backend";

// RBAC-safe chunk read for a known file — access control applied in SQL.
const chunks = await ExuluReadApi.authorizedRead(context, user, roleId, {
  externalIds: ["handbook.pdf"],
  chunkIndexRange: { from: 0, to: 20 },
});

// Embed with the context's own embedder, resolved per caller.
const vector = await ExuluReadApi.embedQuery(context, "notice period");

// Probe the entity layer before wiring entity tools.
const hasEntities = await ExuluReadApi.entitiesAvailable(context);
```

Label on page: "From the SDK".
