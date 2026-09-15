import type { VectorSearchChunkResult } from "./vector-search";

/**
 * Neighbour-chunk expansion ("expand": include N chunks before/after each hit).
 *
 * The previous implementation issued one database query per neighbour chunk, awaited
 * per result: a search with 100 hits and expand 7 meant ~1,400 round trips to Cloud SQL
 * and a search phase of 20+ seconds. This plans the neighbours once (deduplicated,
 * non-negative, excluding chunks already in the result set) so the caller can fetch them
 * with a single query per search and merge them back in order.
 */

export type NeighbourPlan = Map<string, Set<number>>;

export function planNeighbourFetch(
  results: Array<{ item_id: string; chunk_index: number }>,
  expand: { before?: number; after?: number },
): NeighbourPlan {
  const before = Math.max(0, expand.before ?? 0);
  const after = Math.max(0, expand.after ?? 0);
  const plan: NeighbourPlan = new Map();
  if (before === 0 && after === 0) return plan;
  const present = new Set(results.map((r) => `${r.item_id}-${r.chunk_index}`));
  for (const r of results) {
    for (let i = r.chunk_index - before; i <= r.chunk_index + after; i++) {
      if (i < 0 || i === r.chunk_index || present.has(`${r.item_id}-${i}`)) continue;
      if (!plan.has(r.item_id)) plan.set(r.item_id, new Set());
      plan.get(r.item_id)!.add(i);
    }
  }
  return plan;
}

export type NeighbourRow = {
  id: string;
  source: string;
  chunk_index: number;
  content: string;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

/** Attach fetched neighbour rows (only those in the plan) to the results, ordered per item by chunk_index. */
export function mergeNeighbours(
  results: VectorSearchChunkResult[],
  rows: NeighbourRow[],
  plan: NeighbourPlan,
  context: { name: string; id: string },
): VectorSearchChunkResult[] {
  const byItem = new Map<string, VectorSearchChunkResult>();
  for (const r of results) if (!byItem.has(r.item_id)) byItem.set(r.item_id, r);
  const merged = new Map<string, VectorSearchChunkResult>();
  for (const r of results) merged.set(`${r.item_id}-${r.chunk_index}`, r);
  for (const row of rows) {
    if (!plan.get(row.source)?.has(row.chunk_index)) continue;
    const key = `${row.source}-${row.chunk_index}`;
    if (merged.has(key)) continue;
    const parent = byItem.get(row.source);
    if (!parent) continue;
    merged.set(key, {
      chunk_content: row.content,
      chunk_index: row.chunk_index,
      chunk_id: row.id,
      chunk_source: row.source,
      chunk_metadata: row.metadata,
      chunk_created_at: row.createdAt,
      chunk_updated_at: row.updatedAt,
      item_updated_at: parent.item_updated_at,
      item_created_at: parent.item_created_at,
      item_id: parent.item_id,
      item_external_id: parent.item_external_id,
      item_name: parent.item_name,
      chunk_cosine_distance: 0,
      chunk_fts_rank: 0,
      chunk_hybrid_score: 0,
      context,
    } as VectorSearchChunkResult);
  }
  return Array.from(merged.values()).sort((a, b) =>
    a.item_id === b.item_id ? a.chunk_index - b.chunk_index : 0,
  );
}
