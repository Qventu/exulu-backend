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
    const pickedPoint = points[picked] ?? [0, 0, 0];
    centroids.push([finite(pickedPoint[0]), finite(pickedPoint[1]), finite(pickedPoint[2])]);
  }

  // Writes each point's nearest centre into `assignments`, and says whether
  // anything changed. A tie goes to the earlier centre, which is the rule the
  // client's membership function follows too.
  const assignAll = (assignments: number[]): boolean => {
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
    return moved;
  };

  const assignments = new Array<number>(n).fill(0);
  for (let it = 0; it < iterations; it += 1) {
    const moved = assignAll(assignments);
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
  // One final pass against the centres actually being returned. The loop
  // assigns against the previous iteration's centres and then moves them — on
  // the `!moved` break as well as on the cap — so without this the returned
  // assignments describe a partition one step behind the returned centroids.
  // computeTopics counts those assignments into each region's stored `count`
  // while the client recomputes "nearest centre" from the stored centroids, so
  // the two have to describe the same partition or they disagree on exactly the
  // boundary points. A centre left with no points by this pass is simply not a
  // region: computeTopics drops it along with the empty clusters.
  assignAll(assignments);
  return { assignments, centroids };
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** A lexeme with no letter in it is a year, a part number or an identifier. */
const hasLetter = (lexeme: string): boolean => /\p{L}/u.test(lexeme);

/**
 * A fragment of a uuid or hash, not a word. Document ids embedded in chunk text
 * make ideal-looking labels — they sit in few chunks, so idf rates them highly,
 * and they cluster together, so coverage does too. Measured on a real corpus
 * (1,134-chunk hydraulics base): five of twelve regions were named by these
 * before the rule, two of them by the same fragment.
 *
 * All hexadecimal, carrying both a letter and a digit, eight characters or more.
 * The floor stays at eight because four to seven is where the domain lives:
 * measured on this corpus, that band holds EU directive references, position
 * codes ("c2a1", "d2b16") and document numbers ("31256de") — 755 distinct
 * lexemes at length four alone. Lowering it to catch the short uuid pieces
 * would delete the vocabulary to remove the noise.
 * The rule caught all 298 such lexemes across three real bases and kept every
 * product-code shape in them. It can only harm a code built solely from the
 * letters a-f and digits, and only by barring it from NAMING a region: nothing
 * here touches search, retrieval or display, so an over-rejection costs a region
 * its second-choice word while an under-rejection shows a reader "6adc924b".
 */
const isIdentifierFragment = (lexeme: string): boolean => {
  // Hyphens and underscores only, never slashes. Measured on a real standards
  // corpus: uuids separate with hyphens ("ac-8b9d-1ddabdf2c341"), while EU
  // directive references separate with slashes ("2002/91/ec", "89/655/eec") and
  // collapse to something indistinguishable from a hash if slashes go too.
  const bare = lexeme.replace(/[-_]/g, "");
  return bare.length >= 8 && /^[0-9a-f]+$/.test(bare) && /[0-9]/.test(bare) && /[a-f]/.test(bare);
};

/**
 * Names a cluster from words frequent inside it and rare outside:
 *
 *     score = (df / clusterSize) * ln(sampleSize / corpusDf)
 *
 * Coverage inside the cluster times inverse document frequency over the fit's
 * whole sample. The second factor is rarity proper, which the first version of
 * this (`df / corpusDf`) was not: for a lexeme spread evenly across the corpus
 * that ratio is just the cluster's share of it, so on a large cluster a word
 * present in every chunk of the base scored that share and beat any exclusive
 * term not covering more than it. German function words survive into the
 * lexemes whenever a base's configured language does not match its content,
 * which is common, and k-means on this kind of cloud routinely produces one
 * dominant cluster — so the region whose name matters most was the one most
 * likely to end up called "und".
 *
 * Under idf a lexeme the whole sample carries scores exactly zero and is
 * dropped, while a rare term still has to earn its place through coverage.
 * Lexemes with no letter in them are dropped too: a cluster-exclusive year or
 * part number outscores real words on coverage alone and names nothing.
 */
export function pickLabel(
  inCluster: Map<string, number>, corpus: Map<string, number>, index: number,
  clusterSize: number, sampleSize: number, taken: Set<string> = new Set(),
): string {
  const scored = [...inCluster.entries()]
    .filter(([lexeme, df]) =>
      df >= TOPIC_MIN_DF && lexeme.length >= TOPIC_MIN_LEXEME && hasLetter(lexeme)
      && !isIdentifierFragment(lexeme) && !taken.has(lexeme))
    .map(([lexeme, df]) => {
      const corpusDf = Math.max(1, corpus.get(lexeme) ?? 1);
      const size = Math.max(1, clusterSize);
      const sample = Math.max(1, sampleSize);
      return { lexeme, df, score: (df / size) * Math.log(sample / corpusDf) };
    })
    // Zero is not merely the lowest score: a lexeme the whole sample carries
    // says nothing about one region, so the ordinal fallback is the honest name.
    // (A corpus count above the sample size cannot happen — df is counted over
    // the sampled chunks — but it would read as a negative score, so guard it
    // here rather than trust the arithmetic.)
    .filter((s) => s.score > 0)
    .sort((a, b) =>
      (b.score - a.score) ||
      (b.df - a.df) ||
      (a.lexeme < b.lexeme ? -1 : a.lexeme > b.lexeme ? 1 : 0));

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
export async function configuredLanguages(db: any, chunksTable: string): Promise<string[]> {
  // The fit works from the database, not from the declared contexts, so the
  // languages come from the generated column itself: it is built as one
  // to_tsvector per configured language, concatenated.
  try {
    const result = await db.raw(
      `SELECT pg_get_expr(a.attgenerated_expr, a.attrelid) AS expr
         FROM (SELECT attrelid, attname,
                      (SELECT adbin FROM pg_attrdef d
                        WHERE d.adrelid = at.attrelid AND d.adnum = at.attnum) AS attgenerated_expr
                 FROM pg_attribute at
                WHERE at.attrelid = ?::regclass AND at.attname = 'fts') a`,
      [chunksTable],
    );
    const expr = String((result?.rows ?? result ?? [])[0]?.expr ?? "");
    const found = [...expr.matchAll(/'([a-z_]+)'::regconfig/g)].map((m) => m[1] as string);
    return [...new Set(found)];
  } catch {
    return [];
  }
}

/**
 * Lexemes any configured language treats as a stop word.
 *
 * A base indexed in more than one language concatenates one to_tsvector per
 * language, and each language only removes ITS OWN stop words — so on a German
 * base also indexed in English, every German function word survives in the
 * English half, where it is just an unknown word. Measured on a real 1,134-chunk
 * base, "Fährt" and "Nein" named regions; the umlaut gives away which half they
 * came from. Rarity cannot remove them: they are not universal enough for idf
 * to flatten.
 *
 * Postgres answers this directly — converting a stop word yields an empty
 * vector — so ask it once for the whole candidate set rather than guessing at a
 * word list.
 */
export async function stopLexemes(db: any, languages: string[], lexemes: string[]): Promise<Set<string>> {
  if (languages.length === 0 || lexemes.length === 0) return new Set();
  try {
    // The language is a SQL literal, never a binding: regconfig is a type, and
    // these names come from the column definition, never from a request.
    const anyEmpty = languages.map((lang) => `to_tsvector('${lang}', w) = ''`).join(" OR ");
    const result = await db.raw(
      `SELECT w FROM unnest(?::text[]) AS w WHERE ${anyEmpty}`,
      [lexemes],
    );
    return new Set((result?.rows ?? result ?? []).map((r: any) => String(r.w)));
  } catch (error) {
    console.error(
      "[EXULU] could not check lexemes for stop words; labels may include them",
      error instanceof Error ? error.message : String(error),
    );
    return new Set();
  }
}

export async function lexemeCounts({
  db, chunksTable, ids, assignments,
}: { db: any; chunksTable: string; ids: string[]; assignments: number[] }): Promise<Map<number, Map<string, number>>> {
  if (ids.length !== assignments.length) throw new Error("ids and assignments must have equal length");
  const result = await db.raw(
    `SELECT a.cluster AS cluster, l.lexeme AS lexeme, count(*)::int AS df
       FROM unnest(?::uuid[], ?::int[]) AS a(id, cluster)
       JOIN ?? ch ON ch.id = a.id
       CROSS JOIN LATERAL unnest(ch.fts) AS l(lexeme, positions, weights)
      WHERE length(l.lexeme) >= ?
      GROUP BY 1, 2`,
    [ids, assignments, chunksTable, TOPIC_MIN_LEXEME],
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

const TOPICS_TABLE = "context_map_topics";

/**
 * Whether a failed statement failed because the relation is not there, as
 * opposed to for any reason worth failing a fit over. `code` is what pg sets;
 * the message is the fallback for a driver (or a fake) that carries none.
 */
const isMissingTable = (e: unknown): boolean => {
  if ((e as { code?: unknown } | null)?.code === "42P01") return true;
  return /relation .*does not exist/i.test(e instanceof Error ? e.message : String(e));
};

/** The one line a fit logs when the base is mapped without regions. */
const announceMissingTable = (contextId: string): void => {
  console.log(`[EXULU] ${contextId} was fitted without regions: ${TOPICS_TABLE} is not there yet (it is created when the server boots this build)`);
};

/**
 * Whether this connection can see the topic table.
 *
 * `context_map_topics` is created by the boot migration, and the fit script
 * opens its own pool and runs none — so a fit against a database whose server
 * has not yet booted this build finds no table. The probe is what makes that
 * survivable rather than fatal: a statement that raises inside a transaction
 * aborts the whole transaction, so the catch in `replaceTopics` would come too
 * late to save the projection row the caller writes next (fit.ts). The read
 * side probes for exactly the same reason (`contextMapTopics`).
 *
 * A connection with no schema builder cannot be probed — only a test stub is
 * ever shaped that way — and so is assumed able to take the write, which then
 * carries the guard on its own.
 */
async function topicTableExists(db: any): Promise<boolean> {
  if (typeof db?.schema?.hasTable !== "function") return true;
  try {
    return await db.schema.hasTable(TOPICS_TABLE);
  } catch {
    return true;
  }
}

/**
 * Replaces the context's topic rows, treating a missing table as "this base has
 * no regions" rather than as a failure. Anything else is re-thrown: a deadlock
 * or a constraint violation swallowed here would commit a projection row whose
 * regions had been deleted and never replaced, with nothing said about it.
 */
async function replaceTopics(db: any, contextId: string, rows: any[]): Promise<number> {
  const context = sanitizeName(contextId);
  try {
    await db(TOPICS_TABLE).where({ context }).delete();
    if (rows.length) await db(TOPICS_TABLE).insert(rows);
    return rows.length;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    announceMissingTable(contextId);
    return 0;
  }
}

/**
 * Clusters the sampled coordinates, names every region and replaces the
 * context's topic rows. Runs inside the caller's transaction, so a failure
 * leaves the previous topics untouched rather than half-replaced.
 *
 * Returns 0 without writing when the topic table does not exist: a base without
 * regions is a supported state (the cloud simply draws without labels), and the
 * fit that found no table has already backfilled every coordinate.
 */
export async function computeTopics({
  db, contextId, ids, coordinates, seed, fittedAt, clusteringFn = kmeans,
}: {
  db: any; contextId: string; ids: string[]; coordinates: number[][]; seed: number; fittedAt: Date;
  clusteringFn?: (points: number[][], k: number, seed: number) => { assignments: number[]; centroids: number[][] };
}): Promise<number> {
  if (!(await topicTableExists(db))) {
    announceMissingTable(contextId);
    return 0;
  }
  if (ids.length === 0) return replaceTopics(db, contextId, []);
  if (ids.length !== coordinates.length) {
    console.error(`[EXULU] Length mismatch in computeTopics: ${ids.length} ids but ${coordinates.length} coordinates`);
    throw new Error("ids and coordinates must have equal length");
  }
  const { assignments, centroids } = clusteringFn(coordinates, topicCount(ids.length), seed);
  const counts = await lexemeCounts({ db, chunksTable: getChunksTableName(contextId), ids, assignments });

  const corpus = new Map<string, number>();
  for (const perCluster of counts.values()) {
    for (const [lexeme, df] of perCluster) corpus.set(lexeme, (corpus.get(lexeme) ?? 0) + df);
  }

  // Drop every lexeme any configured language calls a stop word. Done here
  // rather than in the counting query so the corpus denominator above is still
  // the true count: removing candidates must not change how rare the survivors
  // look.
  const languages = await configuredLanguages(db, getChunksTableName(contextId));
  const stop = await stopLexemes(db, languages, [...corpus.keys()]);
  if (stop.size > 0) {
    for (const perCluster of counts.values()) for (const lexeme of stop) perCluster.delete(lexeme);
  }

  const size = centroids.map(() => 0);
  for (const a of assignments) size[a] = (size[a] ?? 0) + 1;

  const filtered = centroids
    .map((centre, index) => ({
      centre, index, count: size[index] ?? 0,
    }))
    // An empty cluster is an artefact of k-means++ on a tiny base, not a region.
    .filter((r) => r.count > 0)
    // Filter out any region whose coordinates are not all finite
    .filter((r) => {
      const allFinite = Number.isFinite(r.centre[0] ?? 0) && Number.isFinite(r.centre[1] ?? 0) && Number.isFinite(r.centre[2] ?? 0);
      if (!allFinite) console.error(`[EXULU] Dropped topic region with non-finite coordinates from context ${contextId}`);
      return allFinite;
    });

  // Label the largest region first and never let a second one reuse a word: two
  // regions carrying the same name is worse than one carrying its second choice,
  // because a chip row then shows the same label twice with nothing to tell them
  // apart. Measured on a real base, two of twelve pairs collided.
  const taken = new Set<string>();
  const labels = new Map<number, string>();
  // The ordinal fallback has to read the index the ROW will carry, not the one
  // the cluster had before empty regions were dropped, or a legend shows
  // "Topic 4" on the row stored as 2.
  const finalIndex = new Map(filtered.map((r, i) => [r.index, i]));
  for (const { index: origIndex, count } of [...filtered].sort((a, b) => b.count - a.count)) {
    const label = pickLabel(
      counts.get(origIndex) ?? new Map(), corpus, finalIndex.get(origIndex) ?? 0, count, ids.length, taken,
    );
    labels.set(origIndex, label);
    for (const word of label.split(" & ")) taken.add(word.toLowerCase());
  }

  const rows = filtered.map(({ centre, index: origIndex, count }, newIndex) => ({
    context: sanitizeName(contextId),
    topic_index: newIndex,
    label: labels.get(origIndex) ?? `Topic ${newIndex + 1}`,
    count,
    x: centre[0] ?? 0, y: centre[1] ?? 0, z: centre[2] ?? 0,
    version: PROJECTION_VERSION,
    fitted_at: fittedAt,
  }));

  return replaceTopics(db, contextId, rows);
}
