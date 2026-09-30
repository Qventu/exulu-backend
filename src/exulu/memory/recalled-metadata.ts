import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { resolveMemoryConfig } from "./config";
import type { RecallCollector, RecalledMemory } from "./recall-collector";

/** Message metadata fragment merged on the SDK `finish` part (spec §2.5). */
export function recalledMemoriesMetadata({ recall, agent, isGuest }: {
  recall: RecallCollector | undefined;
  agent: ExuluAgent;
  isGuest: boolean;
}): { recalledMemories: RecalledMemory[] } | Record<string, never> {
  const list = recall?.list() ?? [];
  if (list.length === 0) return {};
  if (isGuest && !resolveMemoryConfig(agent.memory_config).guests.showRecalled) return {};
  return { recalledMemories: list };
}
