/** Vector map (3c-1) knobs. One place; nothing else hardcodes them. */
export const PROJECTION_VERSION = 1;
export const PROJECTION_METHOD = "umap+linear";
export const COMPONENTS = 50;
export const FIT_SAMPLE = 20000;
export const UMAP_NEIGHBORS = 15;
export const UMAP_MIN_DIST = 0.1;
export const POWER_ITERATIONS = 3;
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
