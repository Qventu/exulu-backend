import { postgresClient } from "@SRC/postgres/client";
import type { ExuluProvider } from "./provider";
import { isLiteLLMEnabled } from "./litellm/supervisor";

/**
 * Lookup the ExuluProvider associated with an agent's currently-configured
 * Model row, without decrypting the auth variable or enforcing RBAC.
 *
 * Use this when you need provider-level metadata (capabilities, workflow queue,
 * etc.) for an agent but you do NOT need a language model. For "give me a
 * language model for this agent" use `resolveModel()` instead.
 *
 * Returns undefined in LiteLLM mode — the ExuluProvider catalog isn't
 * applicable when LiteLLM is the source of truth. Callers (mostly the workflow
 * sites in graphql/schemas/index.ts) already throw a clear error when this
 * returns undefined, which is the right behavior in LiteLLM mode too:
 * provider-specific workflows aren't supported.
 */
export async function resolveAgentProvider(
  agent: { id: string; model?: string | null },
  providers: ExuluProvider[],
): Promise<ExuluProvider | undefined> {
  if (isLiteLLMEnabled()) return undefined;
  if (!agent.model) return undefined;
  const { db } = await postgresClient();
  const modelRow = await db.from("models").where({ id: agent.model }).first();
  if (!modelRow?.provider) return undefined;
  return providers.find((p) => p.id === modelRow.provider);
}
