import { TypeValidationError } from "ai";
import { ContextCompactionRequiredError } from "./context-budget";

/**
 * HTTP status + body for an error thrown before a chat/run response starts streaming.
 *
 * Rethrowing from the route handler produced Express' default HTML error page in the
 * client. The body is plain text so the AI SDK transport surfaces it as `err.message`
 * (same contract the 413 compaction case already used).
 */
export function describeRequestError(err: unknown): { status: number; body: string } {
  if (err instanceof ContextCompactionRequiredError) {
    return { status: 413, body: err.message };
  }
  if (TypeValidationError.isInstance(err)) {
    // err.message embeds the full validated value (the whole history) — keep only the issue.
    const cause = (err as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return {
      status: 422,
      body: `The stored conversation could not be loaded: ${detail.slice(0, 400) || "type validation failed"}`,
    };
  }
  return { status: 500, body: err instanceof Error ? err.message : String(err) };
}
