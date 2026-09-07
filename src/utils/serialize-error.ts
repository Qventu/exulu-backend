/**
 * JSON-safe representation of a thrown value.
 *
 * `JSON.stringify(new Error("x"))` yields `"{}"` because `message`, `name` and `stack`
 * are non-enumerable, so storing a raw Error in a jsonb column silently loses the
 * failure reason. Use this before persisting errors (e.g. `job_results.error`).
 */
export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: SerializedError;
  [extra: string]: unknown;
};

const MAX_CAUSE_DEPTH = 3;

export function serializeError(err: unknown, depth = 0): SerializedError {
  if (err instanceof Error) {
    const out: SerializedError = { name: err.name, message: err.message };
    if (err.stack) out.stack = err.stack;
    // Enumerable extras such as `code`, `statusCode`, `response` set by libraries.
    for (const [key, value] of Object.entries(err)) {
      if (key !== "cause") out[key] = value;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
      out.cause = serializeError(cause, depth + 1);
    }
    return out;
  }
  if (typeof err === "string") {
    return { message: err };
  }
  if (err !== null && typeof err === "object") {
    let message: string;
    try {
      message = JSON.stringify(err);
    } catch {
      message = "[unserializable error object]";
    }
    return { ...(err as Record<string, unknown>), message };
  }
  return { message: String(err) };
}
