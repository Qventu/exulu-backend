import { UMAP } from "umap-js";

import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
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
  const text = String(value ?? "");
  if (!text.startsWith("[")) return [];
  return text.slice(1, -1).split(",").map(Number);
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

  const sampleRows: any[] = await db(`${chunks} as chunks`)
    .join(`${items} as items`, "items.id", "chunks.source")
    .whereNotNull("chunks.embedding")
    .whereRaw("items.archived IS NOT TRUE")
    .orderByRaw("md5(chunks.id::text || ?)", [contextId])
    .limit(sample)
    .select("chunks.id as id", "chunks.embedding as embedding");

  const vectors = sampleRows.map((r) => l2normalize(parseVector(r.embedding))).filter((v) => v.length > 0);
  if (vectors.length < components + 1) {
    return empty(`${contextId} needs at least ${components + 1} embedded chunks to fit ${components} components (has ${vectors.length})`);
  }
  const dims = (vectors[0] ?? new Float32Array()).length;
  if (vectors.some((v) => v.length !== dims)) return empty(`${contextId} has chunks of mixed dimensionality`);

  const seed = seedFrom(contextId);
  const mean = meanVector(vectors, dims);
  const basis = randomizedPCA(vectors, dims, Math.min(components, dims, vectors.length - 1), seed, POWER_ITERATIONS);
  if (basis.length === 0) return empty(`${contextId} has no variance in its embeddings`);

  const reduced = vectors.map((v) => projectComponents(v, mean, basis));
  const spread = reduced.reduce((s, z) => s + Math.hypot(...Array.from(z)), 0) / reduced.length;
  if (!Number.isFinite(spread) || spread < 1e-8) return empty(`${contextId} has no variance in its embeddings`);

  log(`fitting ${contextId}: ${vectors.length} vectors, ${dims} dims → ${basis.length} components`);
  const umap = (umapFactory ?? defaultUmap)(seed, reduced.length);
  const raw = umap.fit(reduced.map((z) => Array.from(z)));
  const { points: layout } = normalizeLayout(raw);
  const { map, intercept } = ridgeFit(reduced, layout, RIDGE_LAMBDA);
  const residual = fitResidual(reduced, layout, map, intercept, 1);

  const projection: StoredProjection = {
    context: contextId, dims, components: basis.length,
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

  await db("context_projections").insert(projection).onConflict("context").merge();
  const written = await backfillCoordinates({ db, contextId, projection, log });
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
