import { findLiteLLMModel } from "./litellm/catalog";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget";
import type { ExuluProvider } from "./provider";

/**
 * Resolve the model's real max input context at runtime. Fixes the standing
 * bug where agent.maxContextLength is only hydrated in the GraphQL layer and
 * runtime consumers (truncateToolOutput) always saw the 128K default.
 *
 * LiteLLM mode: catalog max_input_tokens ?? max_tokens.
 * Catalog mode: ExuluProvider.maxContextLength (property access is guarded —
 * in LiteLLM mode `resolved.exuluProvider` is a sentinel Proxy that throws).
 */
export const resolveContextWindow = async ({
  modelId,
  exuluProvider,
}: {
  modelId: string;
  exuluProvider?: ExuluProvider;
}): Promise<number> => {
  if (process.env.EXULU_USE_LITELLM === "true") {
    const entry = await findLiteLLMModel(modelId);
    const fromCatalog = entry?.max_input_tokens ?? entry?.max_tokens;
    if (fromCatalog != null && fromCatalog > 0) return fromCatalog;
  } else if (exuluProvider) {
    try {
      const fromProvider = exuluProvider.maxContextLength;
      if (fromProvider != null && fromProvider > 0) return fromProvider;
    } catch {
      // LITELLM_PROVIDER_SENTINEL throws on any property access — degrade.
    }
  }
  console.warn(
    `[EXULU] Unknown context window for model "${modelId}" — assuming ${DEFAULT_CONTEXT_WINDOW}. ` +
      `Check the LiteLLM catalog / provider template metadata.`,
  );
  return DEFAULT_CONTEXT_WINDOW;
};
