/**
 * Only the semantic branches of the vector-search resolver read the query
 * vector. The full-text-only method ("tsvector") ranks with ts_rank over the
 * query tokens, so embedding its query was pure overhead: an embedder API
 * round trip plus a statistics write and an embedder lookup on every call
 * (measured 1.2 s warm / 4.9 s cold via LiteLLM). The agentic pipeline's
 * memory keyword recall runs exactly that method on every retrieval turn.
 */
export function needsQueryEmbedding(method: string): boolean {
  return method !== "tsvector";
}

/**
 * Query entity extraction (an LLM call per search, see entities/extractor.ts)
 * only pays off where the result set is ranked by similarity and can be
 * re-ordered by shared entities. The full-text-only method is used for
 * keyword-selected item sets (agentic memory keyword recall), where the boost
 * changes nothing and the extraction was the whole cost of the call.
 */
export function boostsWithQueryEntities(method: string): boolean {
  return method !== "tsvector";
}
