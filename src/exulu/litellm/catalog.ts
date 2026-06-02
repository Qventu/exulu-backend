/**
 * LiteLLM catalog fetch with module-level cache.
 *
 * Used by the `litellmCatalog` GraphQL resolver (chat dropdown, agent model
 * selector) and by `addProviderFields` (hydrates agent.maxContextLength /
 * capabilities in LiteLLM mode). Cache is 30s — LiteLLM only reloads its
 * model_list on config.yaml changes + restart, so stale data here is bounded
 * by how recently the dev restarted.
 */

export type LiteLLMCatalogEntry = {
  model_name: string;
  upstream_model: string | null;
  tags: string[];
  type: string | null;
  brand: string | null;
  region: string | null;
  max_tokens: number | null;
  active: boolean;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  supports_vision: boolean;
  input_cost_per_million_tokens: number | null;
  output_cost_per_million_tokens: number | null;
  supports_function_calling: boolean;
  supports_pdf_input: boolean;
  supports_audio_input: boolean;
  // Image-generation capability declarations from model_info. Populated for
  // models with `type: image_generation`; null/empty for other types. The
  // boot-time YAML parser (parse-image-models.ts) is the fail-fast gate that
  // requires these for image models — by the time this catalog is queried,
  // LiteLLM has already loaded the same YAML and these are guaranteed
  // present for image entries.
  sizes: string[] | null;
  qualities: string[] | null;
  supports_edit: boolean;
  max_n: number | null;
};

const CACHE_TTL_MS = 30_000;
let _cache: { expiresAt: number; items: LiteLLMCatalogEntry[] } | undefined;

export const __resetLiteLLMCatalogCacheForTesting = () => {
  _cache = undefined;
};

/**
 * Fetch the LiteLLM catalog. Returns an empty array when LiteLLM is off, the
 * master key is missing, or the upstream fetch fails — callers can treat
 * "empty list" as the universal degraded state.
 */
export const fetchLiteLLMCatalog = async (): Promise<LiteLLMCatalogEntry[]> => {
  if (process.env.EXULU_USE_LITELLM !== "true") return [];

  if (_cache && _cache.expiresAt > Date.now()) {
    return _cache.items;
  }

  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) return [];

  try {
    const res = await fetch(`http://${host}:${port}/model/info`, {
      method: "GET",
      headers: { Authorization: `Bearer ${masterKey}` },
    });
    if (!res.ok) {
      console.error(
        `[EXULU] litellmCatalog: LiteLLM /model/info returned ${res.status}`,
      );
      return [];
    }
    const json: any = await res.json();

    const items: LiteLLMCatalogEntry[] = (
      Array.isArray(json?.data) ? json.data : []
    ).map((m: any) => ({
      // filter out trailing * from model_name
      model_name: m.model_name.replace(/\*$/, ''),
      upstream_model: m.litellm_params?.model ?? null,
      tags: Array.isArray(m.model_info?.tags) ? m.model_info.tags : [],
      brand: m.model_info?.brand ?? null,
      type: m.model_info?.type ?? null,
      region: m.model_info?.region ?? null,
      max_tokens: m.model_info?.max_tokens ?? null,
      max_input_tokens: m.model_info?.max_input_tokens ?? null,
      input_cost_per_million_tokens: m.model_info?.input_cost_per_token * 1000000,
      output_cost_per_million_tokens: m.model_info?.output_cost_per_token * 1000000,
      active: m.model_info?.active ?? true,
      max_output_tokens: m.model_info?.max_output_tokens ?? null,
      supports_vision: !!m.model_info?.supports_vision,
      supports_function_calling: !!m.model_info?.supports_function_calling,
      supports_pdf_input: !!m.model_info?.supports_pdf_input,
      supports_audio_input: !!m.model_info?.supports_audio_input,
      sizes: Array.isArray(m.model_info?.sizes) ? m.model_info.sizes : null,
      qualities: Array.isArray(m.model_info?.qualities) ? m.model_info.qualities : null,
      supports_edit: !!m.model_info?.supports_edit,
      max_n: typeof m.model_info?.max_n === "number" ? m.model_info.max_n : null,
    }));
    // filter out where model_name + upstream_model is not unique and combine
    // their tags into one element in the array
    const map = new Map();
    for (const item of items) {
      const key = `${item.model_name}-${item.upstream_model}`;
      if (map.has(key)) {
        map.get(key).tags.push(...item.tags);
      } else {
        map.set(key, item);
      }
    }

    const uniqueItems = Array.from(map.values());
    
    _cache = { expiresAt: Date.now() + CACHE_TTL_MS, items: uniqueItems };
    // filter out type: speech_to_text and type: text_to_speech
    return uniqueItems.filter((m) => m.type !== "speech_to_text" && m.type !== "text_to_speech");
  } catch (err) {
    console.error("[EXULU] litellmCatalog: failed to fetch /model/info:", err);
    return [];
  }
};

/**
 * Lookup a single LiteLLM model by name. Returns undefined if not in the
 * catalog. Useful for hydrating per-agent metadata where the agent.model
 * string identifies which LiteLLM model_name they reference.
 */
export const findLiteLLMModel = async (
  modelName: string,
): Promise<LiteLLMCatalogEntry | undefined> => {
  if (!modelName) return undefined;
  const items = await fetchLiteLLMCatalog();
  return items.find((m) => m.model_name === modelName);
};
