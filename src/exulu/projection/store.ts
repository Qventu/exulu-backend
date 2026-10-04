import { sanitizeName } from "@SRC/utils/sanitize-name";
import { PROJECTION_CACHE_TTL_MS, PROJECTION_VERSION } from "./constants";
import type { StoredProjection } from "./fit";
import { applyMap, l2normalize, projectComponents } from "./math";

type Loaded = { projection: StoredProjection | null; loadedAt: number };
const cache = new Map<string, Loaded>();

/** Testing seam and a hook for the fit script to drop stale state in-process. */
export function clearProjectionCache(): void { cache.clear(); }

const parse = (value: unknown): any => (typeof value === "string" ? JSON.parse(value) : value);

/** The context's projection, or null when it is missing, stale or unreadable. Never throws. */
export async function loadProjection(db: any, contextId: string, now = Date.now()): Promise<StoredProjection | null> {
  // The fit writes `context: sanitizeName(contextId)` (it is the only form the
  // `--all` entry point can recover from a table name), so readers sanitise
  // too - for the lookup and for the cache key, or "My Docs" and "my_docs"
  // would each hold a separate entry for the same row. The call sits inside the
  // try because a nullish id would throw out of a function that promises not to.
  let key: string | undefined;
  let projection: StoredProjection | null = null;
  try {
    key = sanitizeName(contextId);
    const hit = cache.get(key);
    if (hit && now - hit.loadedAt < PROJECTION_CACHE_TTL_MS) return hit.projection;
    const row = await db("context_projections").where({ context: key }).first();
    if (row && Number(row.version) === PROJECTION_VERSION) {
      const candidate = {
        ...row,
        mean: parse(row.mean), basis: parse(row.basis), map: parse(row.map), intercept: parse(row.intercept),
        dims: Number(row.dims), components: Number(row.components),
      } as StoredProjection;
      // A truncated basis or a two-row map still projects to plausible finite
      // numbers, so a shape mismatch is the one corruption class that would
      // fail silently instead of loudly. Treat it as "not fitted".
      const shaped = Array.isArray(candidate.basis) && candidate.basis.length === candidate.components
        && Array.isArray(candidate.map) && candidate.map.length === 3;
      if (shaped) projection = candidate;
      else {
        console.error(`[EXULU] the stored projection for ${contextId} has the wrong shape (basis ${Array.isArray(candidate.basis) ? candidate.basis.length : "?"} of ${candidate.components}, map ${Array.isArray(candidate.map) ? candidate.map.length : "?"} of 3); treating it as not fitted`);
      }
    }
  } catch (e) {
    console.error("[EXULU] could not read the context projection", e instanceof Error ? e.message : String(e));
  }
  // No key means sanitizeName itself threw, so there is nothing to cache under.
  if (key !== undefined) cache.set(key, { projection, loadedAt: now });
  return projection;
}

/**
 * Positions for the chunk vectors of one item (spec §4). Null entries mean "no
 * coordinates" — a missing projection, a dimension mismatch, or any failure.
 * Never throws: embedding must not depend on the map.
 */
export async function chunkCoordinates({
  db, contextId, vectors,
}: { db: any; contextId: string; vectors: ArrayLike<number>[] }): Promise<({ x: number; y: number; z: number } | null)[]> {
  if (vectors.length === 0) return [];
  try {
    const projection = await loadProjection(db, contextId);
    if (!projection) return vectors.map(() => null);
    const mean = Float32Array.from(projection.mean);
    const basis = projection.basis.map((b) => Float32Array.from(b));
    let warned = false;
    return vectors.map((v) => {
      // An embedding that never arrived is `[]` at the call site (spec §6: no
      // embedding, no coordinates). That is data, not a mismatch, so it stays
      // silent; only a real wrong-width vector earns the warning below.
      if (v.length === 0) return null;
      if (v.length !== projection.dims) {
        if (!warned) {
          warned = true;
          console.warn(`[EXULU] projection for ${contextId} expects ${projection.dims} dimensions, got ${v.length}; coordinates skipped`);
        }
        return null;
      }
      const [x, y, z] = applyMap(projectComponents(l2normalize(v), mean, basis), projection.map, projection.intercept);
      return { x, y, z };
    });
  } catch (e) {
    console.error("[EXULU] could not compute chunk coordinates", e instanceof Error ? e.message : String(e));
    return vectors.map(() => null);
  }
}
