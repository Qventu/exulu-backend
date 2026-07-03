import { RRF_K } from "./config";
import type { Chunk } from "./types";

export type SearchCallConfig = {
  method: "hybridSearch" | "tsvector" | "cosineDistance";
  cutoffs?: { hybrid?: number; cosineDistance?: number; tsvector?: number };
  expand?: { before: number; after: number };
  limit: number;
};

/**
 * Performs a single search with the given query and configuration.
 * Wraps the context.search call in try/catch to handle failures gracefully.
 */
export async function singleSearch({
  query,
  config,
  user,
  role,
  pinnedItemIds,
  context,
}: {
  query: string;
  config: SearchCallConfig;
  user: any;
  role: any;
  pinnedItemIds: string[];
  context: any;
}): Promise<Chunk[]> {
  try {
    const itemFilters =
      pinnedItemIds.length > 0 ? [{ id: { in: pinnedItemIds } }] : [];

    const results = await context.search({
      query,
      chunkFilters: [],
      itemFilters,
      user,
      role,
      method: config.method,
      sort: {
        field: "createdAt",
        direction: "desc",
      },
      cutoffs: config.cutoffs,
      expand: config.expand,
      trigger: "tool",
      limit: config.limit,
      page: 1,
    });

    return results.chunks || [];
  } catch (e) {
    console.warn("[EXULU] singleSearch failed for query:", query, e);
    return [];
  }
}

/**
 * Performs multiple searches with different query variations and merges results
 * using Reciprocal Rank Fusion (RRF) to combine rankings from different queries.
 */
export async function multiQuerySearch({
  queries,
  config,
  user,
  role,
  pinnedItemIds,
  context,
}: {
  queries: string[];
  config: SearchCallConfig;
  user: any;
  role: any;
  pinnedItemIds: string[];
  context: any;
}): Promise<Chunk[]> {
  // Run searches for each query in parallel
  const searchPromises = queries.map((query) =>
    singleSearch({
      query,
      config,
      user,
      role,
      pinnedItemIds,
      context,
    }),
  );

  const results = await Promise.all(searchPromises);

  // Merge results using Reciprocal Rank Fusion (RRF)
  const merged = mergeResultsWithRRF(results, queries);

  return merged;
}

/**
 * Merges search results from multiple queries using Reciprocal Rank Fusion (RRF).
 * RRF formula: score(chunk) = sum(1 / (k + rank_in_query_i)) for all queries where chunk appears
 * where k is RRF_K (typically 60).
 *
 * Boosts the hybrid score for chunks appearing in multiple result sets:
 * boosted_score = original_score * (1 + 0.2 * (appearances - 1))
 *
 * For chunks without a hybrid score, falls back to rrfScore * 10.
 */
function mergeResultsWithRRF(
  resultSets: Chunk[][],
  queries: string[],
): Chunk[] {
  const chunkScores = new Map<
    string,
    {
      chunk: Chunk;
      rrfScore: number;
      appearances: number;
    }
  >();

  // Calculate RRF scores for each chunk
  resultSets.forEach((results) => {
    results.forEach((chunk, rank) => {
      const chunkId = chunk.chunk_id;
      const rrfContribution = 1 / (RRF_K + rank + 1); // rank is 0-indexed

      if (!chunkScores.has(chunkId)) {
        chunkScores.set(chunkId, {
          chunk,
          rrfScore: 0,
          appearances: 0,
        });
      }

      const entry = chunkScores.get(chunkId)!;
      entry.rrfScore += rrfContribution;
      entry.appearances += 1;
    });
  });

  // Convert map to array and sort by RRF score
  const merged = Array.from(chunkScores.values())
    .map((entry) => ({
      ...entry.chunk,
      // Boost score if chunk appears in multiple query results
      chunk_hybrid_score: entry.chunk.chunk_hybrid_score
        ? entry.chunk.chunk_hybrid_score * (1 + 0.2 * (entry.appearances - 1))
        : entry.rrfScore * 10, // Fallback if no hybrid score
    }))
    .sort((a, b) => (b.chunk_hybrid_score || 0) - (a.chunk_hybrid_score || 0));

  console.log(
    `[EXULU] Multi-query search merged ${resultSets.reduce((sum, r) => sum + r.length, 0)} results into ${merged.length} unique chunks.`,
  );

  return merged;
}
