import { postgresClient } from "@SRC/postgres/client";
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
      const ctxId = (c as any).context?.id;
      if (!c.chunk_id || !ctxId || !known.has(ctxId)) continue;
      byContext.set(ctxId, [...(byContext.get(ctxId) ?? []), c.chunk_id]);
    }
    const work = [...byContext.entries()].filter(([, ids]) => ids.length > 1);
    if (work.length === 0) return [];

    const db = opts.db ?? (await postgresClient()).db;
    const results = await Promise.all(
      work.map(async ([ctxId, ids]) => {
        // `??` identifier binding would also work against a real knex instance, but the
        // table name is config-derived (restricted to the known context-id set above,
        // same trust level as the HNSW index DDL in context.ts's createChunksTable), so
        // it's interpolated directly — matching the raw-SQL convention used there.
        const table = `${ctxId}_chunks`;
        try {
          const res = await db.raw(
            `select a.id as a, b.id as b
               from ${table} a
               join ${table} b on a.id < b.id
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
  };
}
