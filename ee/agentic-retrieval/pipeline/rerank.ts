import type { ResolvedReranker } from "@SRC/exulu/resolve-reranker";
import { extractIdentifierTokens, itemMatchesIdentifierToken } from "./text-utils";
import { CHUNK_GROUP_MAX } from "./config";
import type { Chunk, ChunkWithScore, RerankState, RerankResult } from "./types";

export function splitChunksIntoGroups(chunks: Chunk[]): Chunk[][] {
  if (chunks.length === 0) return [];
  const groups: Chunk[][] = [];
  let currentGroup: Chunk[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const curr = chunks[i]!;
    const hasGap = (curr.chunk_index || 0) - (prev.chunk_index || 0) > 1;
    if (currentGroup.length >= CHUNK_GROUP_MAX || hasGap) {
      groups.push(currentGroup);
      currentGroup = [curr];
    } else {
      currentGroup.push(curr);
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);
  return groups;
}

function buildRerankObjects(chunks: Chunk[]): Chunk[] {
  const itemsMap = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    if (!itemsMap.has(chunk.item_id)) itemsMap.set(chunk.item_id, []);
    itemsMap.get(chunk.item_id)!.push(chunk);
  }
  for (const items of itemsMap.values()) {
    items.sort((a, b) => (a.chunk_index || 0) - (b.chunk_index || 0));
  }
  const objects: Chunk[] = [];
  for (const items of itemsMap.values()) {
    if (!items[0]) continue;
    for (const group of splitChunksIntoGroups(items)) {
      if (!group[0]) continue;
      objects.push({
        chunk_content: group.map(c => c.chunk_content).join('\n'),
        chunk_index: group[0].chunk_index,
        chunk_id: group[0].chunk_id,
        chunk_source: group[0].chunk_source,
        chunk_metadata: group[0].chunk_metadata,
        chunk_created_at: group[0].chunk_created_at,
        chunk_updated_at: group[0].chunk_updated_at,
        item_id: group[0].item_id,
        item_external_id: group[0].item_external_id,
        item_name: group[0].item_name,
        item_updated_at: group[0].item_updated_at,
        item_created_at: group[0].item_created_at,
      });
    }
  }
  return objects;
}

export async function rerankResults(opts: {
  chunks: Chunk[];
  query: string;
  state: RerankState;
  reranker?: ResolvedReranker;
  tuning: { topK: number; pinBoost: number; identifierBoost: number; pageWindow: number };
}): Promise<RerankResult> {
  const { chunks, query, state, reranker, tuning } = opts;

  // Empty input fast path
  if (chunks.length === 0) {
    return { limited_results: [], sorted_reranked_results: [], rerank_score_max_genuine: 0 };
  }

  const rerankObjs = buildRerankObjects(chunks);

  let sorted: ChunkWithScore[] = [];
  let rerank_score_max_genuine = 0;
  let useFallback = false;

  if (reranker !== undefined) {
    const reranked = await reranker.rerank(query, rerankObjs);
    if (reranked.length === 0 && rerankObjs.length > 0) {
      // reranker internal error path: non-empty input → empty output
      console.warn("[EXULU pipeline] reranker returned [] for non-empty input — falling back to hybrid-score ordering");
      useFallback = true;
    } else {
      sorted = (reranked as ChunkWithScore[]).sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0));
      rerank_score_max_genuine = sorted[0]?.rerank_score ?? 0;
    }
  } else {
    useFallback = true;
  }

  if (useFallback) {
    // Sort groups by max chunk_hybrid_score from original chunks (per item)
    const maxHybridByItem = new Map<string, number>();
    for (const c of chunks) {
      const cur = maxHybridByItem.get(c.item_id) ?? 0;
      maxHybridByItem.set(c.item_id, Math.max(cur, c.chunk_hybrid_score ?? 0));
    }
    sorted = [...rerankObjs].sort((a, b) =>
      (maxHybridByItem.get(b.item_id) ?? 0) - (maxHybridByItem.get(a.item_id) ?? 0)
    ) as ChunkWithScore[];
    // DO NOT set rerank_score; rerank_score_max_genuine stays 0
  }

  // Pin boost — no-op in fallback (rerank_score is undefined on fallback chunks)
  if (state.pinnedItemIds.size > 0) {
    for (const r of sorted) {
      if (r.item_id && state.pinnedItemIds.has(r.item_id) && r.rerank_score !== undefined) {
        r.rerank_score = Math.min(1, r.rerank_score + tuning.pinBoost);
      }
    }
    if (!useFallback) {
      sorted.sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0));
    }
  }

  // Identify pinned groups for force-inclusion in limited_results. Force-inclusion is
  // capped at topK groups (taken in current score order, i.e. the best-scoring pins):
  // an unbounded cap made the output size proportional to the pin count — with a broad
  // pin set the tool returned 30+ concatenated chunk-groups per call (hundreds of
  // thousands of tokens), overflowing the calling agent's context window. Worst case
  // is now ~2×topK groups regardless of how many items are pinned.
  const pinnedGroups: ChunkWithScore[] = [];
  if (state.pinnedItemIds.size > 0) {
    const seen = new Set<string>();
    for (const r of sorted) {
      if (pinnedGroups.length >= tuning.topK) break;
      if (r.item_id && state.pinnedItemIds.has(r.item_id) && !seen.has(r.item_id)) {
        seen.add(r.item_id);
        pinnedGroups.push(r);
      }
    }
  }

  // Identifier boost — no-op in fallback (rerank_score is undefined)
  const identifierTokens = extractIdentifierTokens([state.importantKeyword, ...state.keywords, query]);
  if (identifierTokens.length > 0) {
    let boosted = 0;
    for (const r of sorted) {
      if (itemMatchesIdentifierToken(r.item_name, identifierTokens) && r.rerank_score !== undefined) {
        r.rerank_score = Math.min(1, r.rerank_score + tuning.identifierBoost);
        boosted++;
      }
    }
    if (boosted > 0 && !useFallback) {
      sorted.sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0));
    }
  }

  // Top-K selection with pinned-item force-inclusion
  const { topK } = tuning;
  let limited_results: ChunkWithScore[] = (() => {
    const top = sorted.slice(0, topK);
    if (pinnedGroups.length === 0) return top;
    const byId = new Map<string, ChunkWithScore>();
    for (const r of [...pinnedGroups, ...top]) {
      if (r.chunk_id && !byId.has(r.chunk_id)) byId.set(r.chunk_id, r);
    }
    return Array.from(byId.values())
      .sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0))
      .slice(0, Math.max(topK, pinnedGroups.length + topK));
  })();

  // Page filter — applies to all paths; scoped to userPinnedItemIds when non-empty
  if (state.userRequestedPage !== null) {
    const scopeToUserPinned = state.userPinnedItemIds.size > 0;
    const pageMatched = sorted.filter(r => {
      if (scopeToUserPinned && !(r.item_id && state.userPinnedItemIds.has(r.item_id))) return false;
      const p = (r.chunk_metadata as { page?: unknown } | undefined)?.page;
      return typeof p === 'number' && Math.abs(p - state.userRequestedPage!) <= tuning.pageWindow;
    });
    if (pageMatched.length > 0) limited_results = pageMatched.slice(0, topK);
  }

  return { limited_results, sorted_reranked_results: sorted, rerank_score_max_genuine };
}
