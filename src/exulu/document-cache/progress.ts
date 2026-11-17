/**
 * Progress of reading one document into the store; delivered to every caller waiting on it.
 * "text" is reserved (not emitted today; the frontend handles it).
 */
export type ProgressFn = (p: {
  phase: "text" | "ocr" | "vision" | "storing";
  pagesDone: number;
  pagesTotal: number;
}) => void;

/**
 * Interim tool result shown in the chat while a document is read. Never model-facing:
 * the SDK marks every yielded value but the last as preliminary, and the convert
 * wrapper passes these through untouched (no guard, no audit).
 */
export type ReadingStatus = {
  status: "reading";
  filename: string;
  // "cached" and "text" are reserved: the backend does not emit them today, but the frontend
  // handles them and removing them from the contract would break it.
  phase: "cached" | "text" | "ocr" | "vision" | "storing";
  pagesDone: number;
  pagesTotal: number;
};

export function isInterimToolStatus(value: unknown): value is ReadingStatus {
  return (
    typeof value === "object" && value !== null && (value as { status?: unknown }).status === "reading"
  );
}

/**
 * At most one call per `ms`; the first call of each phase and a final one
 * (pagesDone === pagesTotal) always pass.
 */
export function throttleProgress(fn: ProgressFn, ms = 1000, now: () => number = Date.now): ProgressFn {
  let last: number | undefined;
  let lastPhase: string | undefined;
  return (p) => {
    const isFinal = p.pagesTotal > 0 && p.pagesDone === p.pagesTotal;
    const t = now();
    if (last !== undefined && p.phase === lastPhase && !isFinal && t - last < ms) return;
    last = t;
    lastPhase = p.phase;
    fn(p);
  };
}
