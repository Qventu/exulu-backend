import { UMAP } from "umap-js";

import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import {
  BACKFILL_BATCH, COMPONENTS, FIT_SAMPLE, POWER_ITERATIONS, PROJECTION_METHOD,
  PROJECTION_VERSION, RIDGE_LAMBDA, UMAP_MIN_DIST, UMAP_NEIGHBORS,
} from "./constants";
import {
  applyMap, fitResidual, l2normalize, meanVector, normalizeLayout, principalRotation,
  projectComponents, randomizedPCA, ridgeFit, rng, rotateLayout,
} from "./math";
import { computeTopics } from "./topics";

export type StoredProjection = {
  context: string; dims: number; components: number;
  mean: number[]; basis: number[][]; map: number[][]; intercept: number[];
  method: string; version: number; sample_size: number; residual: number; fitted_at: Date;
};
export type FitResult = {
  fitted: boolean; reason?: string; sampleSize: number; components: number; residual: number; written: number;
  /** Vectors withheld from the solve the `residual` was scored on; 0 means the
   *  sample was too small to hold any out and the number is in-sample. */
  heldOut: number;
  /** Named regions stored for the base; 0 when nothing was written. */
  topics: number;
};
type UmapLike = { fit: (rows: number[][]) => number[][] };

/** pgvector returns "[1,2,3]"; a driver configured to parse it returns an array. */
export function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value as number[];
  // Only a complete bracketed literal is a vector. Stringifying anything else
  // would turn an object into "[object Object]" and a truncated value would
  // silently lose its last component instead of being rejected.
  if (typeof value !== "string" || !value.startsWith("[") || !value.endsWith("]")) return [];
  return value.slice(1, -1).split(",").map(Number);
}

const seedFrom = (id: string): number => {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

function defaultUmap(seed: number, n: number): UmapLike {
  const random = rng(seed);
  return new UMAP({
    nComponents: 3,
    nNeighbors: Math.max(2, Math.min(UMAP_NEIGHBORS, n - 1)),
    minDist: UMAP_MIN_DIST,
    random,
  }) as unknown as UmapLike;
}

/** Every context with a chunks table, for `--all`. Contexts live in the consuming app, so this reads the database. */
export async function listFittableContexts(db: any): Promise<string[]> {
  const rows: any[] = await db("information_schema.tables")
    .where({ table_schema: "public" })
    .andWhere("table_name", "like", "%\\_chunks")
    // Views and foreign tables also live in information_schema.tables; a fit
    // can only work against a real table.
    .andWhere("table_type", "BASE TABLE")
    .select("table_name");
  return rows.map((r) => String(r.table_name).replace(/_chunks$/, ""));
}

/**
 * Fits a context's projection (spec §3) and backfills chunk coordinates.
 * Id-only: everything it needs is in the database. `umapFactory` is injectable
 * so tests never run a real layout.
 */
export async function fitContextProjection({
  db, contextId, sample = FIT_SAMPLE, components = COMPONENTS, dryRun = false,
  umapFactory, log = () => undefined,
}: {
  db: any; contextId: string; sample?: number; components?: number; dryRun?: boolean;
  umapFactory?: (seed: number, n: number) => UmapLike; log?: (line: string) => void;
}): Promise<FitResult> {
  const chunks = getChunksTableName(contextId);
  const items = getTableName(contextId);
  const empty = (reason: string): FitResult => ({ fitted: false, reason, sampleSize: 0, components, residual: 0, written: 0, heldOut: 0, topics: 0 });

  if (!(await db.schema.hasTable(chunks))) return empty(`${contextId} has no chunks table`);
  // The sample joins the items table to skip archived items. Without this
  // check a stray `*_chunks` table (one left behind by a deleted context, say)
  // raises a raw `relation ... does not exist` out of the join.
  if (!(await db.schema.hasTable(items))) return empty(`${contextId} has no items table`);

  const sampleRows: any[] = await db(`${chunks} as chunks`)
    .join(`${items} as items`, "items.id", "chunks.source")
    .whereNotNull("chunks.embedding")
    .whereRaw("items.archived IS NOT TRUE")
    // Salted with the sanitised id, not the id as typed: `--all` only ever has
    // the sanitised form (it recovers it from the table name), and the read API
    // samples by it too. Any other spelling fits a different sample than the
    // one the map then draws.
    .orderByRaw("md5(chunks.id::text || ?)", [sanitizeName(contextId)])
    .limit(sample)
    .select("chunks.id as id", "chunks.embedding as embedding");

  // Pairs, not two lists: filtering vectors alone would leave `sampleRows`
  // longer, and every id after the first unparseable embedding would then
  // describe a different chunk than its coordinates.
  const sampled = sampleRows
    .map((r) => ({ id: String(r.id), vector: l2normalize(parseVector(r.embedding)) }))
    .filter((s) => s.vector.length > 0);
  const vectors = sampled.map((s) => s.vector);
  if (vectors.length < components + 1) {
    return empty(`${contextId} needs at least ${components + 1} embedded chunks for a ${components}-component request (has ${vectors.length})`);
  }
  const dims = (vectors[0] ?? new Float32Array()).length;
  if (vectors.some((v) => v.length !== dims)) return empty(`${contextId} has chunks of mixed dimensionality`);

  // Measured against real umap-js on synthetic 1536-dimension bases: 50 free
  // parameters fitted on 60 vectors memorise the sample, reporting 0.020 while
  // actually placing new points with 0.261 error. So the intermediate
  // dimensionality follows the data — one component per ten vectors, never more
  // than requested and never fewer than two. `components` stays the request;
  // what is stored is `basis.length`, the number actually used, because the
  // shape guard and the loader both read it.
  const budget = Math.min(components, Math.max(2, Math.floor(vectors.length / 10)));

  // Same reason as the sample salt above: one id spelling, one layout.
  const seed = seedFrom(sanitizeName(contextId));
  const mean = meanVector(vectors, dims);
  const basis = randomizedPCA(vectors, dims, Math.min(budget, dims, vectors.length - 1), seed, POWER_ITERATIONS);
  if (basis.length === 0) return empty(`${contextId} has no variance in its embeddings`);

  const reduced = vectors.map((v) => projectComponents(v, mean, basis));
  const spread = reduced.reduce((s, z) => s + Math.hypot(...Array.from(z)), 0) / reduced.length;
  if (!Number.isFinite(spread) || spread < 1e-8) return empty(`${contextId} has no variance in its embeddings`);

  log(`fitting ${contextId}: ${vectors.length} vectors, ${dims} dims → ${basis.length} components`);
  // At FIT_SAMPLE vectors the layout runs for minutes; without these two lines
  // it is indistinguishable from a hang.
  log(`${contextId}: laying out ${reduced.length} points in 3d (the slow phase)`);
  const umap = (umapFactory ?? defaultUmap)(seed, reduced.length);
  const raw = umap.fit(reduced.map((z) => Array.from(z)));
  // The layout's long axis can lie anywhere; the camera does not move. Rotating
  // onto the cloud's own axes is rigid - every distance survives - and puts the
  // widest spread across the screen instead of into the depth. Measured on a
  // real base of 1134 chunks the layout was a flattened ellipsoid lying
  // diagonally, seen nearly edge-on; its principal spreads are 0.42 / 0.25 /
  // 0.10, so there is a widest face and this points it at the camera.
  // Everything downstream (the linear map, the residual, the
  // clustering, the stored coordinates) is fitted on `layout`, so all of it
  // follows the rotation with no further change.
  const oriented = rotateLayout(raw, principalRotation(raw, seed));
  const { points: layout, scale } = normalizeLayout(oriented);
  // scale 0 means the 99th-percentile radius was 0: the layout collapsed to a
  // single place. The ridge fit of a constant target succeeds with residual 0,
  // so without this check a useless map stores as a perfect one.
  if (!Number.isFinite(scale) || scale <= 0) return empty(`${contextId} produced a degenerate layout (every point in one place)`);
  log(`${contextId}: layout done, fitting the linear map`);
  // The residual has to answer "how far off will the NEXT chunk land", so it is
  // scored on a slice the solve never saw. The sample arrives in md5-salted
  // order (see the query above), which makes a tail slice a random hold-out.
  // With fewer training rows than parameters there is nothing to hold out: the
  // number stays in-sample and `heldOut` 0 says so.
  const holdOut = Math.max(1, Math.floor(reduced.length * 0.2));
  const trainCount = reduced.length - holdOut;
  const heldOut = trainCount >= basis.length + 1 ? holdOut : 0;
  const scoring = heldOut > 0
    ? ridgeFit(reduced.slice(0, trainCount), layout.slice(0, trainCount), RIDGE_LAMBDA)
    : null;
  // The STORED map is fitted on everything: the hold-out buys an honest number,
  // not a smaller map.
  const { map, intercept } = ridgeFit(reduced, layout, RIDGE_LAMBDA);
  const residual = scoring
    ? fitResidual(reduced.slice(trainCount), layout.slice(trainCount), scoring.map, scoring.intercept)
    : fitResidual(reduced, layout, map, intercept);

  const projection: StoredProjection = {
    // Keyed by the sanitised id: `--all` can only recover the table prefix, so
    // this is the one form both entry points can agree on. Readers sanitise too.
    context: sanitizeName(contextId), dims, components: basis.length,
    mean: Array.from(mean), basis: basis.map((b) => Array.from(b)), map, intercept,
    method: PROJECTION_METHOD, version: PROJECTION_VERSION,
    sample_size: vectors.length, residual, fitted_at: new Date(),
  };
  if (![...projection.mean, ...projection.map.flat(), ...projection.intercept].every(Number.isFinite)) {
    return empty(`${contextId} produced a non-finite projection`);
  }

  if (dryRun) {
    log(`dry run: residual ${residual.toFixed(3)} ${residualScope(heldOut)}, would store a ${basis.length}×${dims} projection`);
    return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written: 0, heldOut, topics: 0 };
  }

  // The fit computed a true position for every sampled chunk, so storing the
  // linear map's estimate for those too would store an approximation of
  // something this function already knows exactly. That is the whole reason for
  // this contract. The map is still what places a chunk that arrives AFTER the
  // fit, which is all it was ever learned for.
  //
  // What this is NOT is the fix for the flattened cloud, though an earlier
  // version of this comment claimed exactly that and cited corr(px, py) = -0.80
  // as the evidence. Making this change moved that correlation from -0.795 to
  // -0.779, which is nothing. The cause was the camera, and the fix is the
  // rotation 45 lines above.
  const sampledLayout = new Map<string, [number, number, number]>();
  for (const [i, s] of sampled.entries()) {
    const p = layout[i];
    if (p) sampledLayout.set(s.id, [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
  }

  // Backfill FIRST, from the projection in hand — it does not need the row.
  // The row is what makes chunkCoordinates start answering, and context.ts
  // spreads those coordinates into an unwrapped chunk insert, so a row that
  // survives a failed backfill turns every later ingestion into this context
  // into an error. If the writes below are the ones that cannot work, the caller
  // sees it with nothing committed.
  const written = await backfillCoordinates({ db, contextId, projection, layout: sampledLayout, log });

  let topics = 0;
  // One transaction for the topics and the projection row: computeTopics
  // replaces the context's whole topic set, so a context whose topics were
  // replaced but whose projection write then failed would describe two
  // different layouts at once — the old coordinates under the new region names.
  await db.transaction(async (trx: any) => {
    log(`${contextId}: naming regions`);
    // Cluster where the points will actually be drawn. The layout is the real
    // structure and is what the backfill now stores for these chunks; applyMap
    // is its linear shadow, and clustering the shadow puts the centroids
    // somewhere the dots are not.
    topics = await computeTopics({
      db: trx, contextId, ids: sampled.map((s) => s.id),
      coordinates: layout.map((p) => [...p]),
      seed, fittedAt: projection.fitted_at,
    });
    // knex does not stringify, and node-pg encodes a JS array as a Postgres array
    // literal (`{0.1,0.2}`), which jsonb rejects with 22P02. The repo's convention
    // is to stringify at the boundary; StoredProjection stays number arrays in
    // memory because backfillCoordinates reads them.
    await trx("context_projections")
      .insert({
        ...projection,
        mean: JSON.stringify(projection.mean),
        basis: JSON.stringify(projection.basis),
        map: JSON.stringify(projection.map),
        intercept: JSON.stringify(projection.intercept),
      })
      .onConflict("context")
      .merge();
  });
  log(`${contextId}: ${topics} regions`);
  return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written, heldOut, topics };
}

/** How a reported residual was scored, for the script's summary and the dry run. */
export const residualScope = (heldOut: number): string =>
  (heldOut > 0 ? `(out of sample, ${heldOut} vectors held out)` : "(in sample: too few vectors to hold any out)");

/**
 * Streams every embedded chunk of the context and writes its coordinates.
 *
 * `layout` carries the true layout position of each chunk the fit sampled, and
 * is preferred wherever it has one; the linear map places the rest, which is
 * what it was learned for. It is optional because this is exported from the
 * package entry point: given none, every row goes through the map, exactly as
 * before.
 */
export async function backfillCoordinates({
  db, contextId, projection, layout, batch = BACKFILL_BATCH, log = () => undefined,
}: {
  db: any; contextId: string; projection: StoredProjection;
  layout?: Map<string, [number, number, number]>;
  batch?: number; log?: (line: string) => void;
}): Promise<number> {
  const chunks = getChunksTableName(contextId);
  const mean = Float32Array.from(projection.mean);
  const basis = projection.basis.map((b) => Float32Array.from(b));
  let written = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows: any[] = await db(chunks)
      .whereNotNull("embedding").where("id", ">", after)
      .orderBy("id").limit(batch).select("id", "embedding");
    if (rows.length === 0) break;
    const values: string[] = [];
    const bindings: any[] = [];
    for (const row of rows) {
      const raw = parseVector(row.embedding);
      // Ahead of the layout lookup on purpose: a chunk re-embedded by another
      // model since the fit has a stored position describing a cloud its vector
      // no longer belongs to, so it is skipped rather than written from it.
      if (raw.length !== projection.dims) continue;
      const known = layout?.get(String(row.id));
      const [x, y, z] = known ?? applyMap(
        projectComponents(l2normalize(raw), mean, basis), projection.map, projection.intercept,
      );
      values.push("(?::uuid, ?::real, ?::real, ?::real)");
      bindings.push(row.id, x, y, z);
    }
    if (values.length) {
      await db.raw(
        `UPDATE ?? AS c SET px = v.px, py = v.py, pz = v.pz
           FROM (VALUES ${values.join(",")}) AS v(id, px, py, pz) WHERE c.id = v.id`,
        [chunks, ...bindings],
      );
      written += values.length;
    }
    after = rows[rows.length - 1].id;
    log(`backfilled ${written}`);
  }
  return written;
}
