import { getChunksTableName } from "@SRC/exulu/table-names";
import { sanitizeName } from "@SRC/utils/sanitize-name";

import {
  TOPIC_ITERATIONS, TOPIC_LABEL_WORDS, TOPIC_MAX, TOPIC_MIN, TOPIC_MIN_DF, TOPIC_MIN_LEXEME,
} from "./constants";
import { PROJECTION_VERSION } from "./constants";
import { rng } from "./math";

/** One region per ten points, within bounds a legend can still read. */
export function topicCount(n: number): number {
  return Math.max(TOPIC_MIN, Math.min(TOPIC_MAX, Math.round(Math.sqrt(n / 2))));
}

const distance2 = (a: number[], b: number[]): number => {
  let d = 0;
  for (let i = 0; i < 3; i += 1) { const t = (a[i] ?? 0) - (b[i] ?? 0); d += t * t; }
  return d;
};

/**
 * k-means over three-dimensional coordinates, k-means++ seeded so one context
 * always clusters the same way. Three dimensions and at most FIT_SAMPLE points
 * make this milliseconds next to the layout.
 */
export function kmeans(
  points: number[][], k: number, seed: number, iterations = TOPIC_ITERATIONS,
): { assignments: number[]; centroids: number[][] } {
  const random = rng(seed);
  const n = points.length;
  const want = Math.max(1, Math.min(k, n));

  // k-means++: first centre at random, each next one far from what exists.
  const centroids: number[][] = [[...(points[Math.floor(random() * n)] ?? [0, 0, 0])]];
  while (centroids.length < want) {
    const d = points.map((p) => Math.min(...centroids.map((c) => distance2(p, c))));
    const total = d.reduce((s, v) => s + v, 0);
    let target = random() * total;
    let picked = n - 1;
    for (let i = 0; i < n; i += 1) { target -= d[i] ?? 0; if (target <= 0) { picked = i; break; } }
    centroids.push([...(points[picked] ?? [0, 0, 0])]);
  }

  const assignments = new Array<number>(n).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = distance2(points[i] ?? [], centroids[c] ?? []);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; moved = true; }
    }
    const sums = centroids.map(() => [0, 0, 0]);
    const counts = centroids.map(() => 0);
    for (let i = 0; i < n; i += 1) {
      const c = assignments[i] ?? 0;
      counts[c] = (counts[c] ?? 0) + 1;
      for (let d = 0; d < 3; d += 1) sums[c]![d] = (sums[c]![d] ?? 0) + (points[i]?.[d] ?? 0);
    }
    for (let c = 0; c < centroids.length; c += 1) {
      // An empty cluster keeps its previous centre rather than becoming NaN.
      if ((counts[c] ?? 0) === 0) continue;
      for (let d = 0; d < 3; d += 1) centroids[c]![d] = (sums[c]![d] ?? 0) / (counts[c] ?? 1);
    }
    if (!moved) break;
  }
  return { assignments, centroids };
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Names a cluster from words frequent inside it and rare outside. The score is
 * in-cluster document frequency over corpus document frequency, so a word in
 * every cluster scores near zero however often it occurs here.
 */
export function pickLabel(
  inCluster: Map<string, number>, corpus: Map<string, number>, index: number,
): string {
  const scored = [...inCluster.entries()]
    .filter(([lexeme, df]) => df >= TOPIC_MIN_DF && lexeme.length >= TOPIC_MIN_LEXEME)
    .map(([lexeme, df]) => ({ lexeme, df, score: df / Math.max(1, corpus.get(lexeme) ?? df) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.df - a.df || a.lexeme.localeCompare(b.lexeme))
    .slice(0, TOPIC_LABEL_WORDS);
  if (scored.length === 0) return `Topic ${index + 1}`;
  return scored.map((s) => titleCase(s.lexeme)).join(" & ");
}

/**
 * Per-cluster lexeme document frequencies, read from the generated tsvector the
 * chunks table already carries — the same mechanism the edge query uses, so no
 * chunk text is loaded. The assignment list goes into a temp table because a
 * VALUES list of twenty thousand rows is a megabyte of SQL.
 */
export async function lexemeCounts({
  db, chunksTable, ids, assignments,
}: { db: any; chunksTable: string; ids: string[]; assignments: number[] }): Promise<Map<number, Map<string, number>>> {
  await db.raw("CREATE TEMP TABLE map_topic_assign (id uuid PRIMARY KEY, cluster int) ON COMMIT DROP");
  const batch = 1000;
  for (let i = 0; i < ids.length; i += batch) {
    const values = ids.slice(i, i + batch).map((id, j) => ({ id, cluster: assignments[i + j] ?? 0 }));
    if (values.length) await db("map_topic_assign").insert(values);
  }
  const result = await db.raw(
    `SELECT a.cluster AS cluster, l.lexeme AS lexeme, count(*)::int AS df
       FROM map_topic_assign a
       JOIN ?? ch ON ch.id = a.id
       CROSS JOIN LATERAL unnest(ch.fts) AS l(lexeme, positions, weights)
      GROUP BY 1, 2`,
    [chunksTable],
  );
  const rows: any[] = result?.rows ?? result ?? [];
  const out = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const cluster = Number(row.cluster);
    if (!out.has(cluster)) out.set(cluster, new Map());
    out.get(cluster)!.set(String(row.lexeme), Number(row.df));
  }
  return out;
}

/**
 * Clusters the sampled coordinates, names every region and replaces the
 * context's topic rows. Runs inside the caller's transaction, so a failure
 * leaves the previous topics untouched rather than half-replaced.
 */
export async function computeTopics({
  db, contextId, ids, coordinates, seed, fittedAt,
}: {
  db: any; contextId: string; ids: string[]; coordinates: number[][]; seed: number; fittedAt: Date;
}): Promise<number> {
  if (ids.length === 0 || ids.length !== coordinates.length) return 0;
  const { assignments, centroids } = kmeans(coordinates, topicCount(ids.length), seed);
  const counts = await lexemeCounts({ db, chunksTable: getChunksTableName(contextId), ids, assignments });

  const corpus = new Map<string, number>();
  for (const perCluster of counts.values()) {
    for (const [lexeme, df] of perCluster) corpus.set(lexeme, (corpus.get(lexeme) ?? 0) + df);
  }

  const size = centroids.map(() => 0);
  for (const a of assignments) size[a] = (size[a] ?? 0) + 1;

  const rows = centroids
    .map((centre, index) => ({
      context: sanitizeName(contextId),
      topic_index: index,
      label: pickLabel(counts.get(index) ?? new Map(), corpus, index),
      count: size[index] ?? 0,
      x: centre[0] ?? 0, y: centre[1] ?? 0, z: centre[2] ?? 0,
      version: PROJECTION_VERSION,
      fitted_at: fittedAt,
    }))
    // An empty cluster is an artefact of k-means++ on a tiny base, not a region.
    .filter((r) => r.count > 0);

  await db("context_map_topics").where({ context: sanitizeName(contextId) }).delete();
  if (rows.length) await db("context_map_topics").insert(rows);
  return rows.length;
}
