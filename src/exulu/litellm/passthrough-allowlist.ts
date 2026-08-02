/**
 * Paths the /litellm/:project passthrough forwards to the local LiteLLM proxy.
 * The OpenAI-compatible surface (/v1/*) plus /model/info — the model catalog,
 * which is already exposed to authenticated users via the litellmCatalog GraphQL
 * resolver and is needed by remote workers to fetch model capabilities. All other
 * admin paths fail closed so future LiteLLM admin endpoints don't leak.
 */
export const isLiteLLMPassthroughPathAllowed = (path: string): boolean =>
  path.startsWith("/v1/") || path === "/model/info";
