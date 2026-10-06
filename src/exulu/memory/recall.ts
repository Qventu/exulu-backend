import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import { resolveMemoryConfig } from "./config";
import { buildMemoryPromptBlock, createRecallCollector, type RecallCollector } from "./recall-collector";
import { buildRecallQuery } from "./recall-query";

export type RecallResult = {
  collector: RecallCollector | undefined;
  memoryItems: VectorSearchChunkResult[] | undefined;
  promptBlock: string;
};

const EMPTY: RecallResult = { collector: undefined, memoryItems: undefined, promptBlock: "" };

/**
 * Memory pre-fetch shared by generateSync and generateStream (spec §3.1):
 * user-scoped hybrid search over the agent's memory context, limited by
 * memory_config, feeding the recall collector and the model-visible block.
 */
export async function recallMemories({ agent, contexts, query, user, db, previousUserTurns }: {
  agent: ExuluAgent | undefined;
  contexts: ExuluContext[] | undefined;
  query: string | undefined;
  user: User | undefined;
  db: any;
  previousUserTurns?: string[];
}): Promise<RecallResult> {
  if (!agent?.memory || !query) return { ...EMPTY };
  const context = contexts?.find((c) => c.id === agent.memory);
  if (!context) {
    console.warn(`[EXULU] memory: context "${agent.memory}" configured on agent "${agent.id}" was not found; memory off for this turn.`);
    return { ...EMPTY };
  }
  const config = resolveMemoryConfig(agent.memory_config);
  const collector = createRecallCollector(context, user, db);
  if (!config.retrieval.enabled) return { collector, memoryItems: undefined, promptBlock: "" };

  let result: Awaited<ReturnType<ExuluContext["search"]>> | undefined;
  try {
    result = await context.search({
      query: buildRecallQuery(query, previousUserTurns ?? []),
      itemFilters: [],
      chunkFilters: [],
      method: "hybridSearch",
      sort: { field: "updatedAt", direction: "desc" },
      trigger: "agent",
      limit: config.retrieval.limit,
      page: 1,
      user,
      role: user?.role?.id,
    });
  } catch (e) {
    console.warn(`[EXULU] memory: recall failed for context "${context.id}"`, e instanceof Error ? e.message : e);
    return { collector, memoryItems: undefined, promptBlock: "" };
  }
  const chunks = result?.chunks ?? [];
  if (chunks.length === 0) return { collector, memoryItems: undefined, promptBlock: "" };
  await collector.addFromChunks(chunks, "prefetch");
  return { collector, memoryItems: chunks, promptBlock: buildMemoryPromptBlock(collector.list()) };
}
