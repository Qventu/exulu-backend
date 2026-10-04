import { UMAP } from "umap-js";

import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import {
  BACKFILL_BATCH, COMPONENTS, FIT_SAMPLE, POWER_ITERATIONS, PROJECTION_METHOD,
  PROJECTION_VERSION, RIDGE_LAMBDA, UMAP_MIN_DIST, UMAP_NEIGHBORS,
} from "./constants";
import {
  applyMap, fitResidual, l2normalize, meanVector, normalizeLayout, projectComponents,
  randomizedPCA, ridgeFit, rng,
} from "./math";

export type StoredProjection = {
  context: string; dims: number; components: number;
  mean: number[]; basis: number[][]; map: number[][]; intercept: number[];
  method: string; version: number; sample_size: number; residual: number; fitted_at: Date;
};
export type FitResult = {
  fitted: boolean; reason?: string; sampleSize: number; components: number; residual: number; written: number;
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
  const empty = (reason: string): FitResult => ({ fitted: false, reason, sampleSize: 0, components, residual: 0, written: 0 });

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

  const vectors = sampleRows.map((r) => l2normalize(parseVector(r.embedding))).filter((v) => v.length > 0);
  if (vectors.length < components + 1) {
    return empty(`${contextId} needs at least ${components + 1} embedded chunks to fit ${components} components (has ${vectors.length})`);
  }
  const dims = (vectors[0] ?? new Float32Array()).length;
  if (vectors.some((v) => v.length !== dims)) return empty(`${contextId} has chunks of mixed dimensionality`);

  // Same reason as the sample salt above: one id spelling, one layout.
  const seed = seedFrom(sanitizeName(contextId));
  const mean = meanVector(vectors, dims);
  const basis = randomizedPCA(vectors, dims, Math.min(components, dims, vectors.length - 1), seed, POWER_ITERATIONS);
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
  const { points: layout, scale } = normalizeLayout(raw);
  // scale 0 means the 99th-percentile radius was 0: the layout collapsed to a
  // single place. The ridge fit of a constant target succeeds with residual 0,
  // so without this check a useless map stores as a perfect one.
  if (!Number.isFinite(scale) || scale <= 0) return empty(`${contextId} produced a degenerate layout (every point in one place)`);
  log(`${contextId}: layout done, fitting the linear map`);
  const { map, intercept } = ridgeFit(reduced, layout, RIDGE_LAMBDA);
  const residual = fitResidual(reduced, layout, map, intercept, 1);

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
    log(`dry run: residual ${residual.toFixed(3)}, would store a ${basis.length}×${dims} projection`);
    return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written: 0 };
  }

  // Backfill FIRST, from the projection in hand — it does not need the row.
  // The row is what makes chunkCoordinates start answering, and context.ts
  // spreads those coordinates into an unwrapped chunk insert, so a row that
  // survives a failed backfill turns every later ingestion into this context
  // into an error. If the write below is the one that cannot work, the caller
  // sees it with nothing committed.
  const written = await backfillCoordinates({ db, contextId, projection, log });
  // knex does not stringify, and node-pg encodes a JS array as a Postgres array
  // literal (`{0.1,0.2}`), which jsonb rejects with 22P02. The repo's convention
  // is to stringify at the boundary; StoredProjection stays number arrays in
  // memory because backfillCoordinates reads them.
  await db("context_projections")
    .insert({
      ...projection,
      mean: JSON.stringify(projection.mean),
      basis: JSON.stringify(projection.basis),
      map: JSON.stringify(projection.map),
      intercept: JSON.stringify(projection.intercept),
    })
    .onConflict("context")
    .merge();
  return { fitted: true, sampleSize: vectors.length, components: basis.length, residual, written };
}

/** Streams every embedded chunk of the context and writes its coordinates. */
export async function backfillCoordinates({
  db, contextId, projection, batch = BACKFILL_BATCH, log = () => undefined,
}: {
  db: any; contextId: string; projection: StoredProjection; batch?: number; log?: (line: string) => void;
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
      if (raw.length !== projection.dims) continue;
      const [x, y, z] = applyMap(projectComponents(l2normalize(raw), mean, basis), projection.map, projection.intercept);
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
