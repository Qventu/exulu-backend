import pLimit from "p-limit";

/**
 * Process-wide ceilings on provider calls made by the document processor.
 * Every in-process caller (knowledge-base jobs, parse_document, inline
 * attachments) shares them, so two long documents read at once cannot
 * multiply the load on the OCR / vision endpoints. Calls beyond the ceiling
 * queue; they are never refused. Per-document limiters (ocrConcurrency, the
 * VLM concurrency setting) sit OUTSIDE these and wrap a function that awaits
 * them, which cannot deadlock: a queued call holds only its per-document slot.
 *
 * Kept free of imports beyond p-limit so it loads on an unlicensed boot.
 */
export const PROCESS_WIDE_LIMIT = 8;
export const DEFAULT_OCR_CONCURRENCY = 3;

export const ocrLimiter = pLimit(PROCESS_WIDE_LIMIT);
export const visionLimiter = pLimit(PROCESS_WIDE_LIMIT);

/** Per-document OCR concurrency from `documentProcessor.ocr.concurrency`: default 3, clamped to 1..8. */
export function ocrConcurrency(config?: { ocr?: { concurrency?: number } }): number {
  const raw = config?.ocr?.concurrency;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_OCR_CONCURRENCY;
  return Math.min(PROCESS_WIDE_LIMIT, Math.max(1, Math.round(raw)));
}
