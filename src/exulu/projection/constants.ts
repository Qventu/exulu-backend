/** Vector map (3c-1) knobs. One place; nothing else hardcodes them. */
export const PROJECTION_VERSION = 1;
export const PROJECTION_METHOD = "umap+linear";
export const COMPONENTS = 50;
export const FIT_SAMPLE = 20000;
export const UMAP_NEIGHBORS = 15;
export const UMAP_MIN_DIST = 0.1;
export const POWER_ITERATIONS = 3;
/** Subspace-iteration passes for the 3-dimension layout rotation (principalRotation).
 *  Separate from POWER_ITERATIONS, which is tuned for the 1536-dimension reduction
 *  where a pass costs `rows · dims · k`; here dims and k are both 3, so the whole
 *  iteration is free and can run to convergence instead of stopping at a usable
 *  approximation. Measured on a cloud carrying the real base's covariance, the
 *  residual correlation between the first two rotated axes was 0.072 after 3 passes
 *  and 0.000 from 12 on - and a rotation that does not decorrelate has not done its
 *  job. 24 is twice the measured convergence point, for a differently shaped base. */
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
