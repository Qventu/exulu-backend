/**
 * Shared LiteLLM connection helpers. Single source of truth for the locally-
 * spawned proxy URL + master key. Imported by every backend module that talks
 * to LiteLLM admin endpoints (admin-client.ts, activity-client.ts) so the env
 * read is never duplicated and the auth contract never drifts.
 *
 * The master key NEVER leaves the backend — it is attached as a Bearer token
 * on the outbound fetch only. Any handler that exposes LiteLLM data to the
 * frontend MUST proxy through one of the typed clients in this directory.
 */

/** Thrown when a LiteLLM admin call fails so callers can log-and-continue. */
export class LiteLLMAdminError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "LiteLLMAdminError";
  }
}

/**
 * Resolves the LiteLLM proxy base URL + master key from env. Throws
 * LiteLLMAdminError if the master key is missing — callers in route handlers
 * should catch and translate to a 502.
 */
export function litellmBase(): { url: string; masterKey: string } {
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    throw new LiteLLMAdminError("LITELLM_MASTER_KEY is not configured.");
  }
  return { url: `http://${host}:${port}`, masterKey };
}

/** Auth headers merged into every LiteLLM request. */
export interface LiteLLMTarget {
  /** URL prefix; caller appends "/v1/..."; no trailing slash. */
  baseUrl: string;
  /** Headers to merge into every LiteLLM request. */
  authHeaders: Record<string, string>;
  /** true when LITELLM_BASE_URL is set (remote/passthrough mode). */
  remote: boolean;
}

/**
 * Resolves the LiteLLM target based on the environment:
 * - Remote mode  (LITELLM_BASE_URL set): uses the URL verbatim + exulu-api-key header.
 * - Local mode   (default): derives URL from LITELLM_HOST/PORT + master key Bearer header.
 *
 * NOTE: litellmBase() is left unchanged for the server-only admin clients.
 */
export function resolveLiteLLMTarget(): LiteLLMTarget {
  const rawBase = process.env.LITELLM_BASE_URL;
  if (rawBase && rawBase.trim().length > 0) {
    const apiKey = process.env.EXULU_API_KEY;
    if (!apiKey) {
      throw new Error("EXULU_API_KEY is required when LITELLM_BASE_URL is set (remote LiteLLM client mode).");
    }
    return {
      baseUrl: rawBase.trim().replace(/\/+$/, ""),
      authHeaders: { "exulu-api-key": apiKey },
      remote: true,
    };
  }
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  return {
    baseUrl: `http://${host}:${port}`,
    authHeaders: masterKey ? { Authorization: `Bearer ${masterKey}` } : {},
    remote: false,
  };
}
