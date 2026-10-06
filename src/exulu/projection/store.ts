import { sanitizeName } from "@SRC/utils/sanitize-name";
import { PROJECTION_CACHE_TTL_MS, PROJECTION_VERSION } from "./constants";
import type { StoredProjection } from "./fit";
import { applyMap, l2normalize, projectComponents } from "./math";

type Loaded = { projection: StoredProjection | null; loadedAt: number };
const cache = new Map<string, Loaded>();
/** Contexts already reported as unfitted in this process (see announceUnfitted). */
const announced = new Set<string>();

/**
 * Drops this process's cached projections, and with them the "already said so"
 * markers below. The embedder-change mutation reaches it through
 * `dropProjection`, which runs in the serving process; the fit script runs in
 * its own and has nothing to clear. Also the testing seam.
 */
export function clearProjectionCache(): void { cache.clear(); announced.clear(); }

/**
 * One line per context per process when there is no usable projection (spec §4).
 * The row is deleted along with the chunks on an embedder change, so without
 * this the failure mode is silence: coordinates simply stop appearing. Guarded
 * by a module-level Set, so the cost stays zero per embed.
 */
function announceUnfitted(key: string, contextId: string, reason: string): void {
  if (announced.has(key)) return;
  announced.add(key);
  console.log(`[EXULU] ${contextId} has no usable projection (${reason}); its chunks are embedded without coordinates until it is fitted`);
}

const parse = (value: unknown): any => (typeof value === "string" ? JSON.parse(value) : value);

/** A stored row read as a projection, or the reason it is unusable. */
export type ProjectionRowRead =
  | { projection: StoredProjection; problem?: undefined }
  | { projection?: undefined; problem: string };

/**
 * Reads a `context_projections` row, refusing one whose shape cannot be used.
 *
 * Both readers go through this, so "fitted" means the same thing to the embed
 * path (`loadProjection`) and to `contextProjectionStatus`: without it a corrupt
 * row reported a healthy fit from status while coverage never grew and the
 * loader refused the same row on every cache miss.
 *
 * A truncated basis or a two-row map still projects to plausible finite
 * numbers, so a shape mismatch is the one corruption class that would fail
 * silently instead of loudly.
 *
 * Never throws: status calls it on every poll, and unreadable json is a shape
 * problem like any other.
 */
export function readProjectionRow(row: any): ProjectionRowRead {
  let candidate: StoredProjection;
  try {
    candidate = {
      ...row,
      mean: parse(row?.mean), basis: parse(row?.basis), map: parse(row?.map), intercept: parse(row?.intercept),
      dims: Number(row?.dims), components: Number(row?.components),
    } as StoredProjection;
  } catch (e) {
    return { problem: `unreadable json (${e instanceof Error ? e.message : String(e)})` };
  }
  const { dims, components } = candidate;
  // -1, not 0: a missing matrix must not accidentally match a zero width.
  const width = (value: unknown): number => (Array.isArray(value) ? value.length : -1);
  const problems: string[] = [];
  // Inner widths as well as outer ones: a basis whose rows were truncated has
  // the right number of rows, and projectComponents then reads the missing
  // dimensions as 0 - wrong-but-finite coordinates, which is the whole class
  // this guard exists to catch.
  if (width(candidate.mean) !== dims) problems.push(`mean ${width(candidate.mean)} of ${dims}`);
  if (width(candidate.basis) !== components) problems.push(`basis ${width(candidate.basis)} of ${components}`);
  else if (candidate.basis.some((row) => width(row) !== dims)) problems.push(`a basis row is not ${dims} wide`);
  if (width(candidate.map) !== 3) problems.push(`map ${width(candidate.map)} of 3`);
  else if (candidate.map.some((row) => width(row) !== components)) problems.push(`a map row is not ${components} wide`);
  if (width(candidate.intercept) !== 3) problems.push(`intercept ${width(candidate.intercept)} of 3`);
  return problems.length > 0 ? { problem: problems.join(", ") } : { projection: candidate };
}

/**
 * Forgets a context's fitted layout: the stored projection row, the named
 * regions fitted alongside it, and this process's cached copy of the row.
 *
 * Called wherever a context's chunks are dropped or cleared. A re-embed through
 * a different model lands in a different space, and `chunkCoordinates` only
 * compares vector width — so a surviving row would place the new vectors at
 * finite, plausible, geometrically meaningless coordinates while
 * `contextProjectionStatus` still reported a healthy fit. A refit is required
 * either way, including when the width itself changed.
 *
 * The topic rows go with it, in the same guarded block, because the two describe
 * one layout: a fit writes them under the same sanitised key (topics.ts) and
 * nothing else ever deletes them, so leaving them behind means labels for
 * vectors that no longer exist — drawn over whatever the next fit lays out, or
 * over nothing at all on a base nobody refits.
 *
 * Never throws: it runs mid-rebuild, and a context that was never fitted (or a
 * deployment whose core tables predate either table) must not fail an embedder
 * change.
 */
export async function dropProjection(db: any, contextId: string): Promise<void> {
  try {
    const context = sanitizeName(contextId);
    await db("context_projections").where({ context }).delete();
    // Not filtered by version: every region this context has ever had describes
    // a layout that is now gone, whichever build fitted it.
    await db("context_map_topics").where({ context }).delete();
  } catch (e) {
    // One message for both deletes, because the block is one unit of meaning:
    // whichever of the two failed, the context now has a layout it should not.
    console.error("[EXULU] could not delete the context projection or its topic rows", e instanceof Error ? e.message : String(e));
  }
  // Outside the try: a delete that failed still has to leave this process
  // without a cached projection, because the chunks it described are gone.
  clearProjectionCache();
}

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
    if (!row) announceUnfitted(key, contextId, "never fitted");
    else if (Number(row.version) !== PROJECTION_VERSION) {
      announceUnfitted(key, contextId, `stored version ${String(row.version)}, this build reads ${PROJECTION_VERSION}`);
    } else {
      const read = readProjectionRow(row);
      if (read.projection) projection = read.projection;
      else console.error(`[EXULU] the stored projection for ${contextId} has an unusable shape (${read.problem}); treating it as not fitted`);
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
