import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { checkMemoryBase } from "@SRC/exulu/memory/memory-base";
import { memoryBaseStats, type MemoryBaseStats } from "./memory-base-stats";

export type MemoryBaseRow = {
  id: string; name: string; description: string | null;
  valid: boolean; missing: string[]; missingFromCode: boolean;
  agents: { id: string; name: string }[];
  stats: MemoryBaseStats | null;
};

type AgentRow = { id: string; name: string; memory: string | null };

/** Spec §2.3: valid bases (in use first), then valid unused, then invalid ones an agent uses, then ids missing from code. */
export async function listMemoryBases({ contexts, user, db }: { contexts: ExuluContext[]; user: User | undefined; db: any }): Promise<MemoryBaseRow[]> {
  const agents: AgentRow[] = await db("agents").select("id", "name", "memory");
  const byBase = new Map<string, { id: string; name: string }[]>();
  for (const a of agents) {
    if (!a.memory) continue;
    const list = byBase.get(a.memory) ?? [];
    list.push({ id: a.id, name: a.name });
    byBase.set(a.memory, list);
  }
  const rows: MemoryBaseRow[] = [];
  for (const context of contexts) {
    const check = checkMemoryBase(context);
    const used = byBase.get(context.id) ?? [];
    if (!check.ok && used.length === 0) continue;
    rows.push({
      id: context.id, name: context.name, description: context.description ?? null,
      valid: check.ok, missing: check.missing, missingFromCode: false, agents: used,
      stats: await memoryBaseStats({ context, user, db }),
    });
    byBase.delete(context.id);
  }
  for (const [id, used] of byBase) {
    rows.push({ id, name: id, description: null, valid: false, missing: ["information", "type"], missingFromCode: true, agents: used, stats: null });
  }
  const rank = (r: MemoryBaseRow) => (r.missingFromCode ? 3 : !r.valid ? 2 : r.agents.length > 0 ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
