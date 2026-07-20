// ee/agentic-retrieval/pipeline/micro-call.ts
//
// Shared wrapper for the pipeline's internal LLM micro-calls (routing,
// classification, memory checks, identifier extraction, HyDE). Centralizes the
// settings that keep these calls working on reasoning models.
import { generateText, NoOutputGeneratedError, Output } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { z } from "zod";
import { withRetry } from "@SRC/utils/with-retry";

/**
 * Reasoning models (Gemini 3+) count thinking tokens against maxOutputTokens.
 * The earlier 200–600 caps got fully consumed by thinking on such models —
 * finishReason "length" with zero visible text — so every micro-call failed
 * with NoOutputGeneratedError and its phase fell back to the degraded path.
 * 2000 leaves headroom even when thinking can only be minimized, not disabled.
 */
export const MICRO_CALL_MAX_OUTPUT_TOKENS = 2000;

/**
 * Thinking off for Gemini utility models: LiteLLM maps reasoning_effort
 * "disable" to thinkingBudget 0 (Gemini ≤2.5) or thinkingLevel "minimal"
 * (Gemini 3+, which cannot fully disable thinking). Gated on the model id
 * because LiteLLM rejects reasoning params for providers without a mapping
 * (e.g. vertex qwen MaaS) unless drop_params is set in the proxy config.
 */
export function microCallProviderOptions(
  model: LanguageModel,
): Record<string, Record<string, string>> | undefined {
  const modelId = typeof model === "string" ? model : model?.modelId;
  return typeof modelId === "string" && /gemini/i.test(modelId)
    ? { litellm: { reasoningEffort: "disable" } }
    : undefined;
}

export type MicroCallArgs<OUTPUT> = {
  model: LanguageModel;
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  /** Structured output schema; omit for free-text calls. */
  schema?: z.ZodType<OUTPUT>;
  /** Defaults to 0 — the pipeline's determinism requirement. */
  temperature?: number;
  maxOutputTokens?: number;
  /** Total attempts for transient failures (network, provider 429/5xx). */
  maxAttempts?: number;
  retryBaseDelayMs?: number;
};

export async function microCall<OUTPUT = undefined>(
  args: MicroCallArgs<OUTPUT>,
): Promise<{ output: OUTPUT; text: string }> {
  const {
    model,
    system,
    prompt,
    messages,
    schema,
    temperature = 0,
    maxOutputTokens = MICRO_CALL_MAX_OUTPUT_TOKENS,
    maxAttempts = 3,
    retryBaseDelayMs,
  } = args;

  return withRetry(
    async () => {
      const result = await generateText({
        model,
        temperature,
        system,
        prompt,
        messages,
        ...(schema ? { output: Output.object({ schema }) } : {}),
        maxOutputTokens,
        // withRetry owns retries. The SDK's internal retries on top of it
        // tripled request volume per attempt while the provider was already
        // rate-limiting.
        maxRetries: 0,
        providerOptions: microCallProviderOptions(model),
      } as Parameters<typeof generateText>[0]);
      // Read .output inside the retried closure — the SDK throws
      // NoOutputGeneratedError from this getter, so reading it later would
      // escape both the retry classification and the caller's per-call catch.
      return {
        output: (schema ? (result as { output: OUTPUT }).output : undefined) as OUTPUT,
        text: result.text,
      };
    },
    maxAttempts,
    {
      // Empty output is deterministic for identical params — retrying only
      // added latency before the degraded path. Fail fast instead.
      shouldRetry: (error) => !NoOutputGeneratedError.isInstance(error),
      ...(retryBaseDelayMs !== undefined ? { baseDelayMs: retryBaseDelayMs } : {}),
    },
  );
}
