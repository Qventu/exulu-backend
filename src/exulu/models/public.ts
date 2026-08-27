import type { LanguageModel } from "ai";
import { resolveModel } from "@SRC/exulu/resolve-model";
import { postgresClient } from "@SRC/postgres/client";
import { microCallProviderOptions } from "@EE/agentic-retrieval/pipeline/micro-call";

/**
 * Model access for consuming projects.
 *
 * Exists because ExuluApp exposes no model route and resolveModel is internal,
 * so a consumer's only alternative was building its own provider against
 * PROXY_BASE_URL — which produces untagged calls that per-team LiteLLM budgets
 * cannot attribute.
 */
export const ExuluModels = {
  /**
   * A LanguageModel bound to the tenant's LiteLLM proxy.
   *
   * Pass `userId` wherever one is known — it is what carries the caller's
   * identity tags into LiteLLM, and therefore what makes the spend visible to
   * that user's team budget. Resolution still succeeds without it; the calls
   * are simply unattributed.
   */
  resolve: async ({
    modelId,
    userId,
  }: {
    modelId: string;
    userId?: number;
  }): Promise<LanguageModel> => {
    let user: any;
    if (userId != null) {
      const { db } = await postgresClient();
      // Raw row on purpose: resolveModel reads role/team/project off it
      // directly, matching the idiom in src/exulu/recall/service.ts:553.
      user = await db("users").where({ id: userId }).first();
    }
    const { languageModel } = await resolveModel({ modelId, user: user || undefined });
    return languageModel;
  },

  /**
   * Provider options for a constrained structured-output call.
   *
   * Gemini 3+ counts thinking tokens against maxOutputTokens, so a call with a
   * token cap returns an empty 200 unless reasoning is disabled. Returns
   * undefined for non-Gemini models.
   */
  providerOptions: (model: LanguageModel | string) => microCallProviderOptions(model),
};
