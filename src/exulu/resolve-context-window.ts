import { findLiteLLMModel } from "./litellm/catalog";
import { DEFAULT_CONTEXT_WINDOW } from "./context-budget";

/**
 * Resolve the model's real max input context at runtime. Fixes the standing
 * bug where agent.maxContextLength is only hydrated in the GraphQL layer and
 * runtime consumers (truncateToolOutput) always saw the 128K default.
 */
export const resolveContextWindow = async ({
  modelId,
}: {
  modelId: string;
}): Promise<number> => {

  if (process.env.EXULU_USE_LITELLM !== "true") {
    throw new Error("Litellm not configured.")
  }

  const entry = await findLiteLLMModel(modelId);
  const fromCatalog = entry?.max_input_tokens ?? entry?.max_tokens;
  if (fromCatalog != null && fromCatalog > 0) return fromCatalog;

  console.warn(
    `[EXULU] Unknown context window for model "${modelId}" — assuming ${DEFAULT_CONTEXT_WINDOW}. ` +
      `Check the LiteLLM catalog / provider template metadata.`,
  );
  return DEFAULT_CONTEXT_WINDOW;
};
