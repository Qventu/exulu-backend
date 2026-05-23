import { postgresClient } from "@SRC/postgres/client";
import type { ExuluProvider } from "./provider";

/**
 * Lookup the ExuluProvider associated with an agent's currently-configured
 * Model row, without decrypting the auth variable or enforcing RBAC.
 *
 * Use this when you need provider-level metadata (capabilities, workflow queue,
 * etc.) for an agent but you do NOT need a language model. For "give me a
 * language model for this agent" use `resolveModel()` instead.
 */
export async function resolveAgentProvider(
  agent: { id: string; model?: string | null },
  providers: ExuluProvider[],
): Promise<ExuluProvider | undefined> {
  if (!agent.model) return undefined;
  const { db } = await postgresClient();
  const modelRow = await db.from("models").where({ id: agent.model }).first();
  if (!modelRow?.provider) return undefined;
  return providers.find((p) => p.id === modelRow.provider);
}
