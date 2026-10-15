import { postgresClient } from "@SRC/postgres/client";
import { getChunksTableName } from "@SRC/exulu/table-names";
import type { ChunkWithScore } from "./types";

/** Measured separation: copies of one page score 0.982–0.996; the same table in the
 *  predecessor manual scores 0.9415. See the design spec for the full table. */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.97;

/**
 * Builds the near-duplicate lookup handed to rerankResults. Candidates are grouped by
 * context because each knowledge base stores its chunks in its own table; cross-context
 * pairs are deliberately not computed. Any context whose query fails simply contributes
 * no pairs.
 *
 * `contextIds` must be the set of known knowledge-base context ids (e.g. from
 * `contextsById.keys()`). A candidate's context is only queried when it's a member of
 * that set — in particular this excludes the synthetic "memory" context, which chunks
 * are tagged with but which has no `memory_chunks` table (the real table is
 * `newton_memory_context_chunks`, named after the memory *context*, not this tag).
 */
export function makeNearDuplicateFinder(opts: {
  contextIds: string[];
  threshold?: number;
  db?: { raw: (sql: string, bindings?: any) => Promise<{ rows: Array<{ a: string; b: string }> }> };
}) {
  const known = new Set(opts.contextIds);
  const threshold = opts.threshold ?? DUPLICATE_SIMILARITY_THRESHOLD;

  return async (candidates: ChunkWithScore[]): Promise<Array<[string, string]>> => {
    const byContext = new Map<string, string[]>();
    for (const c of candidates) {
      const ctxId = c.context?.id;
      if (!c.chunk_id || !ctxId || !known.has(ctxId)) continue;
      byContext.set(ctxId, [...(byContext.get(ctxId) ?? []), c.chunk_id]);
    }
    const work = [...byContext.entries()].filter(([, ids]) => ids.length > 1);
    if (work.length === 0) return [];

    // The whole lookup is optional and must never block a turn — acquiring the
    // connection is wrapped here too, not left for rerank.ts's own try/catch to
    // cover, so the finder honours the "never throws" contract on its own.
    try {
      const db = opts.db ?? (await postgresClient()).db;
      const results = await Promise.all(
        work.map(async ([ctxId, ids]) => {
          // getChunksTableName applies sanitizeName and is the same helper 12+
          // other call sites use (e.g. context-map.ts), double-quoted there too —
          // direct interpolation is fine since the result is sanitized, unlike a
          // bare `${ctxId}_chunks` which would skip that.
          const table = getChunksTableName(ctxId);
          try {
            const res = await db.raw(
              `select a.id as a, b.id as b
                 from "${table}" a
                 join "${table}" b on a.id < b.id
                where a.id = any(?) and b.id = any(?)
                  and a.embedding is not null and b.embedding is not null
                  and (1 - (a.embedding <=> b.embedding)) >= ?`,
              [ids, ids, threshold],
            );
            return (res.rows ?? []).map((r) => [r.a, r.b] as [string, string]);
          } catch (err) {
            console.warn(`[EXULU pipeline] near-duplicate query failed for "${ctxId}":`, err);
            return [] as Array<[string, string]>;
          }
        }),
      );
      return results.flat();
    } catch (err) {
      console.warn("[EXULU pipeline] near-duplicate lookup failed to acquire a database connection:", err);
      return [];
    }
  };
}
