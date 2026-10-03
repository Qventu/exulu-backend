/** Conflict detection knobs (spec §3). One place; nothing else hardcodes them. */
export const DUPLICATE_MIN_SIMILARITY = 0.88;
export const CANDIDATE_MIN_SIMILARITY = 0.7;
export const JUDGE_CALLS_PER_SCAN = 40;
export const GROUP_MAX_MEMBERS = 6;
export const SCAN_MAX_MEMORIES = 2000;
/** Pairs fetched per scan; beyond this a scan is truncated (report via `skipped`, rerun to continue). */
export const SCAN_MAX_PAIRS = 5000;
