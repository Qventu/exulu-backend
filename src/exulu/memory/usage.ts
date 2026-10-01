import type { RecallCollector } from "./recall-collector";

/**
 * Memory usage tracking (sub-project 3a, spec §2.2): one row per memory
 * recalled into an answer — ids and timestamps only, never content.
 * Idempotent through the unique (message_id, memory_id) index; a failed
 * write is logged and never reaches the answer.
 */
export type UsageRow = {
  memory_id: string; context: string; agent: string;
  session: string | null; message_id: string; user: number | null; guest: boolean;
};

export type UsageWriteInput = {
  db: any;
  recall: RecallCollector | undefined;
  contextId: string;
  agentId: string;
  session?: string | null;
  messageId: string;
  userId?: number | null;
};

export function usageRows(input: Omit<UsageWriteInput, "db">): UsageRow[] {
  const memories = input.recall?.list() ?? [];
  const user = typeof input.userId === "number" ? input.userId : null;
  return memories.map((m) => ({
    memory_id: m.id,
    context: input.contextId,
    agent: input.agentId,
    session: input.session ?? null,
    message_id: input.messageId,
    user,
    guest: user === null,
  }));
}

export async function recordMemoryUsage(input: UsageWriteInput): Promise<number> {
  const rows = usageRows(input);
  if (rows.length === 0) return 0;
  try {
    await input.db("memory_usages").insert(rows).onConflict(["message_id", "memory_id"]).ignore();
    return rows.length;
  } catch (e) {
    console.error("[EXULU] memory usage write failed", e);
    return 0;
  }
}
