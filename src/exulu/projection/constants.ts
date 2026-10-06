/** Vector map (3c-1) knobs. One place; nothing else hardcodes them. */
export const PROJECTION_VERSION = 1;
export const PROJECTION_METHOD = "umap+linear";
export const COMPONENTS = 50;
export const FIT_SAMPLE = 20000;
export const UMAP_NEIGHBORS = 15;
export const UMAP_MIN_DIST = 0.1;
export const POWER_ITERATIONS = 3;
/**
 * Subspace-iteration passes for the 3-dimension layout rotation
 * (principalRotation). Deliberately not POWER_ITERATIONS.
 *
 * POWER_ITERATIONS = 3 is enough for what the reduction needs, which is the
 * dominant SPAN. This rotation needs something strictly harder: the individual
 * axes, in order, within that span. The two converge at very different rates -
 * a pass shrinks the misalignment between adjacent axes geometrically, by
 * roughly their variance ratio, so axes with similar spreads separate slowly
 * while the span they share settles almost immediately. Measured on a cloud
 * carrying the real base's covariance, 3 passes had the span to 1e-4 but the
 * ordering within it only to 1e-2.
 *
 * So the pass count is not a precision knob here, it is the difference between
 * an answer and an approximation, and the geometry is what argues for a high
 * count rather than any single measurement: each pass multiplies the residual
 * by ~0.3 on that base, so a handful of extra passes buy orders of magnitude.
 * Three passes leave a margin set entirely by the random starting basis
 * (observed between 1e-3 and 1e-1 across realisations - not a property to rely
 * on); by 24 the residual has reached the float32 floor of the basis itself,
 * ~1e-8, and stops improving.
 *
 * The cost argument is the other half: a pass here is `rows · 9` multiplies
 * against the reduction's `rows · 1536 · 50`, so convergence is free. Raising
 * POWER_ITERATIONS to 24 instead would have made the reduction eight times
 * slower for no benefit.
 */
export const ROTATION_ITERATIONS = 24;
export const RIDGE_LAMBDA = 1e-3;
export const BACKFILL_BATCH = 500;
export const POINTS_LIMIT_DEFAULT = 5000;
export const POINTS_LIMIT_MAX = 20000;
export const EDGE_LIMIT_DEFAULT = 8;
/** Hard ceiling for an edge request: the ranking query is a grouped full-text scan. */
export const EDGE_LIMIT_MAX = 50;
/** Lexemes an edge query is built from. Matches the measured-safe bound behind
 *  MAX_OR_TERMS in query-preprocessing: 12 OR terms ran in 1.0s on a 97k-chunk
 *  corpus where 56 took 6.3s. */
export const EDGE_QUERY_TERMS = 12;
export const PROJECTION_CACHE_TTL_MS = 60_000;
/** Topic regions (3c-2). k follows the data; these are its bounds. */
export const TOPIC_MIN = 3;
export const TOPIC_MAX = 12;
export const TOPIC_ITERATIONS = 25;
/** A lexeme must carry at least this many of a cluster's chunks to name it. */
export const TOPIC_MIN_DF = 2;
/** Stems shorter than this read as noise ("ab", "st"). */
export const TOPIC_MIN_LEXEME = 3;
/** Words in a label, joined with " & " — the shape the design shows. */
export const TOPIC_LABEL_WORDS = 2;
