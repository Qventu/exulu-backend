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
  /** true only in client/worker mode with LITELLM_BASE_URL set (remote/passthrough mode). */
  remote: boolean;
}

/**
 * Whether THIS process is a LiteLLM *client* (worker) — it has no local proxy
 * and must reach an externally-managed one through the Exulu server's
 * passthrough. Set by the worker boot path via the supervisor's
 * enableLiteLLMClientMode(). The HTTP-server process leaves this false and
 * always talks to its own local proxy, so a shared .env that sets
 * LITELLM_BASE_URL for workers never routes the server's own interactive
 * traffic through the passthrough (which would re-authenticate as the worker's
 * service key and mis-attribute/mis-route every user's request).
 *
 * Lives here (the zero-app-import module) rather than in supervisor.ts so
 * resolveLiteLLMTarget() below can read it without an import cycle —
 * supervisor.ts imports this module, not the other way around.
 */
let _clientMode = false;

/** True when this process is in LiteLLM client/worker mode. */
export const isLiteLLMClientMode = (): boolean => _clientMode;

/**
 * Set client/worker mode. Called by the supervisor's enableLiteLLMClientMode()
 * (worker boot) and reset by its test-only reset. Not for direct production use.
 */
export const setLiteLLMClientMode = (value: boolean): void => {
  _clientMode = value;
};

/**
 * Resolves the correct LiteLLM target (base URL + auth headers) from the
 * environment. Two modes are supported:
 *
 * **Default / local mode** (`LITELLM_BASE_URL` is NOT set):
 *   - Base URL: `http://${LITELLM_HOST ?? "127.0.0.1"}:${LITELLM_PORT ?? "4000"}`
 *   - Auth: `Authorization: Bearer ${LITELLM_MASTER_KEY}` — header is omitted
 *     entirely when `LITELLM_MASTER_KEY` is not present in the environment.
 *
 * **Remote mode** (this process is in client/worker mode AND `LITELLM_BASE_URL`
 * is set to a non-empty string):
 *   - Gated on {@link isLiteLLMClientMode}: only worker processes (which have no
 *     local proxy) go remote. The HTTP-server process owns its own proxy and
 *     stays local even when `LITELLM_BASE_URL` is present in a shared `.env` —
 *     otherwise its interactive traffic would loop through its own passthrough,
 *     re-authenticate as the worker service key, and mis-route/mis-attribute
 *     every request.
 *   - `LITELLM_BASE_URL` is used verbatim as the URL prefix (callers append
 *     `/v1/...`); any trailing slashes are stripped. The intended target is the
 *     server's authenticated passthrough, e.g.
 *     `https://<server>/litellm/DEFAULT`.
 *   - Auth: `exulu-api-key: ${EXULU_API_KEY}` — `EXULU_API_KEY` **must** be
 *     set; the function throws if it is missing.
 *   - `LITELLM_MASTER_KEY` is NOT used in this mode and need not be present.
 *
 * > Note: {@link litellmBase} (master-key, local proxy) remains the entry
 * > point for server-side admin clients (tag management, activity polling,
 * > etc.) and is unaffected by this function.
 */
export function resolveLiteLLMTarget(): LiteLLMTarget {
  const rawBase = process.env.LITELLM_BASE_URL;
  if (isLiteLLMClientMode() && rawBase && rawBase.trim().length > 0) {
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
