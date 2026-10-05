import { getChunksTableName } from "@SRC/exulu/table-names";
import { sanitizeName } from "@SRC/utils/sanitize-name";

import {
  PROJECTION_VERSION,
  TOPIC_ITERATIONS, TOPIC_LABEL_WORDS, TOPIC_MAX, TOPIC_MIN, TOPIC_MIN_DF, TOPIC_MIN_LEXEME,
} from "./constants";
import { finite, rng } from "./math";

/** Topic count follows sqrt(n/2), bounded between TOPIC_MIN and TOPIC_MAX. */
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
  const first = points[Math.floor(random() * n)] ?? [0, 0, 0];
  const centroids: number[][] = [[finite(first[0]), finite(first[1]), finite(first[2])]];
  while (centroids.length < want) {
    const d = points.map((p) => Math.min(...centroids.map((c) => distance2(p, c))));
    const total = d.reduce((s, v) => s + v, 0);
    let target = random() * total;
    let picked = n - 1;
    for (let i = 0; i < n; i += 1) { target -= d[i] ?? 0; if (target <= 0) { picked = i; break; } }
    const picked_point = points[picked] ?? [0, 0, 0];
    centroids.push([finite(picked_point[0]), finite(picked_point[1]), finite(picked_point[2])]);
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
      for (let d = 0; d < 3; d += 1) sums[c]![d] = (sums[c]![d] ?? 0) + finite(points[i]?.[d]);
    }
    for (let c = 0; c < centroids.length; c += 1) {
      // An empty cluster keeps its previous centre rather than becoming NaN.
      if ((counts[c] ?? 0) === 0) continue;
      for (let d = 0; d < 3; d += 1) centroids[c]![d] = finite((sums[c]![d] ?? 0) / (counts[c] ?? 1));
    }
    if (!moved) break;
  }
  return { assignments, centroids };
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Names a cluster from words frequent inside it and rare outside. The score weights
 * the lexeme's rarity in the corpus by its coverage within the cluster: (df / corpusDf) * (df / clusterSize).
 * This implements both "rare outside" and "frequent inside", and avoids cluster-exclusive
 * singletons outscoring common terms.
 */
export function pickLabel(
  inCluster: Map<string, number>, corpus: Map<string, number>, index: number, clusterSize: number,
): string {
  const scored = [...inCluster.entries()]
    .filter(([lexeme, df]) => df >= TOPIC_MIN_DF && lexeme.length >= TOPIC_MIN_LEXEME)
    .map(([lexeme, df]) => {
      const corpusDf = corpus.get(lexeme) ?? 1;
      return { lexeme, df, score: (df / corpusDf) * (df / clusterSize) };
    })
    .sort((a, b) => b.score - a.score || b.df - a.df || a.lexeme < b.lexeme ? 1 : -1);

  const selected: string[] = [];
  for (const s of scored) {
    if (selected.length >= TOPIC_LABEL_WORDS) break;
    // Skip if this lexeme is a prefix of or has an earlier lexeme as its prefix
    if (selected.some((prev) => s.lexeme.startsWith(prev) || prev.startsWith(s.lexeme))) continue;
    selected.push(s.lexeme);
  }

  if (selected.length === 0) return `Topic ${index + 1}`;
  return selected.map(titleCase).join(" & ");
}

/**
 * Per-cluster lexeme document frequencies, read from the generated tsvector the
 * chunks table already carries — the same mechanism the edge query uses, so no
 * chunk text is loaded. Uses array binds to avoid a temp table, which only works
 * inside a transaction and would be dropped before the insert on a pooled connection.
 * The length filter is pushed into SQL since pickLabel discards lexemes shorter
 * than TOPIC_MIN_LEXEME anyway. The document-frequency floor must NOT be pushed,
 * because computeTopics sums the per-cluster maps to get the corpus denominator,
 * and dropping singletons there would inflate every score.
 */
export async function lexemeCounts({
  db, chunksTable, ids, assignments,
}: { db: any; chunksTable: string; ids: string[]; assignments: number[] }): Promise<Map<number, Map<string, number>>> {
  if (ids.length !== assignments.length) throw new Error("ids and assignments must have equal length");
  const result = await db.raw(
    `SELECT a.cluster AS cluster, l.lexeme AS lexeme, count(*)::int AS df
       FROM unnest(?::uuid[], ?::int[]) AS a(id, cluster)
       JOIN ?? ch ON ch.id = a.id
       CROSS JOIN LATERAL unnest(ch.fts) AS l(lexeme, positions, weights)
      WHERE length(l.lexeme) >= 3
      GROUP BY 1, 2`,
    [ids, assignments, chunksTable],
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
  if (ids.length === 0) {
    await db("context_map_topics").where({ context: sanitizeName(contextId) }).delete();
    return 0;
  }
  if (ids.length !== coordinates.length) {
    console.error(`Length mismatch in computeTopics: ${ids.length} ids but ${coordinates.length} coordinates`);
    throw new Error("ids and coordinates must have equal length");
  }
  const { assignments, centroids } = kmeans(coordinates, topicCount(ids.length), seed);
  const counts = await lexemeCounts({ db, chunksTable: getChunksTableName(contextId), ids, assignments });

  const corpus = new Map<string, number>();
  for (const perCluster of counts.values()) {
    for (const [lexeme, df] of perCluster) corpus.set(lexeme, (corpus.get(lexeme) ?? 0) + df);
  }

  const size = centroids.map(() => 0);
  for (const a of assignments) size[a] = (size[a] ?? 0) + 1;

  const filtered = centroids
    .map((centre, index) => ({
      centre, index, count: size[index] ?? 0,
    }))
    // An empty cluster is an artefact of k-means++ on a tiny base, not a region.
    .filter((r) => r.count > 0);

  const rows = filtered.map(({ centre, index: origIndex, count }, newIndex) => ({
    context: sanitizeName(contextId),
    topic_index: newIndex,
    label: pickLabel(counts.get(origIndex) ?? new Map(), corpus, newIndex, count),
    count,
    x: centre[0] ?? 0, y: centre[1] ?? 0, z: centre[2] ?? 0,
    version: PROJECTION_VERSION,
    fitted_at: fittedAt,
  }));

  await db("context_map_topics").where({ context: sanitizeName(contextId) }).delete();
  if (rows.length) await db("context_map_topics").insert(rows);
  return rows.length;
}
