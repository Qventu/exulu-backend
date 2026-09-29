import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import type { ExuluContext } from "@SRC/exulu/context";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { getTableName } from "@SRC/exulu/table-names";

export type RecallSource = "prefetch" | "knowledge_search";

export type MemoryItemRow = {
  id: string; name?: string | null; information?: string | null; description?: string | null;
  type?: string | null; rights_mode?: string | null; created_by?: number | null;
  createdAt?: string | Date | null; updatedAt?: string | Date | null;
};

export type RecalledMemory = {
  id: string; contextId: string; title: string; information: string; type?: string;
  rights_mode: ExuluRightsMode; createdBy: { id: number; name: string } | null;
  createdAt: string; updatedAt: string; source: RecallSource;
};

type UserRow = { id: number; firstname?: string | null; lastname?: string | null; email?: string | null };

export const displayName = (u: UserRow): string => {
  const full = [u.firstname, u.lastname].filter((s) => s && s.trim()).join(" ").trim();
  if (full) return full;
  if (u.email && u.email.trim()) return u.email.trim();
  return `User ${u.id}`;
};

const iso = (v: string | Date | null | undefined): string =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";

export const MEMORY_ITEM_FIELDS = ["id", "name", "information", "description", "type", "rights_mode", "created_by", "createdAt", "updatedAt"];

/**
 * Request-scoped collector of memories the model was given this turn
 * (spec §3.1). Item rows come through the caller's RBAC-scoped loader, so a
 * chunk the user may not see never produces an entry.
 */
export class RecallCollector {
  private readonly items = new Map<string, RecalledMemory>();
  private readonly creators = new Map<number, string>();

  constructor(private readonly deps: {
    contextId: string;
    loadItems: (ids: string[]) => Promise<MemoryItemRow[]>;
    loadUsers: (ids: number[]) => Promise<UserRow[]>;
  }) {}

  async addFromChunks(chunks: VectorSearchChunkResult[], source: RecallSource): Promise<void> {
    const ids = [...new Set(chunks.map((c) => c.item_id).filter((id): id is string => !!id && !this.items.has(id)))];
    if (ids.length === 0) return;
    const rows = await this.deps.loadItems(ids);
    await this.addRows(rows, source);
  }

  async addRows(rows: MemoryItemRow[], source: RecallSource): Promise<void> {
    const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((id): id is number => typeof id === "number" && !this.creators.has(id)))];
    if (creatorIds.length > 0) {
      for (const u of await this.deps.loadUsers(creatorIds)) this.creators.set(u.id, displayName(u));
    }
    for (const r of rows) {
      if (this.items.has(r.id)) continue;
      const createdBy = typeof r.created_by === "number" && this.creators.has(r.created_by)
        ? { id: r.created_by, name: this.creators.get(r.created_by)! }
        : null;
      this.items.set(r.id, {
        id: r.id, contextId: this.deps.contextId,
        title: (r.name ?? "").toString(), information: (r.information ?? r.description ?? "").toString(),
        ...(r.type ? { type: String(r.type) } : {}),
        rights_mode: (r.rights_mode ?? "private") as ExuluRightsMode,
        createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt), source,
      });
    }
  }

  list(): RecalledMemory[] { return [...this.items.values()]; }
}

/**
 * Loads memory item rows by id with the caller's RBAC applied (public rows,
 * own rows, shared rows). No user → public rows only, which is the guest rule.
 */
export async function loadVisibleMemoryRows(context: ExuluContext, ids: string[], user: User | undefined, db: any): Promise<MemoryItemRow[]> {
  if (ids.length === 0) return [];
  const table = convertContextToTableDefinition(context);
  const query = db(getTableName(context.id)).whereIn("id", ids).whereNot("archived", true).select(MEMORY_ITEM_FIELDS);
  return applyAccessControl(table, query, user);
}

/** Binds the collector to a context with the user's RBAC and a users lookup. */
export function createRecallCollector(context: ExuluContext, user: User | undefined, db: any): RecallCollector {
  return new RecallCollector({
    contextId: context.id,
    loadItems: (ids) => loadVisibleMemoryRows(context, ids, user, db),
    loadUsers: (ids) => db("users").whereIn("id", ids).select("id", "firstname", "lastname", "email"),
  });
}

const cite = (s: string) => s.replace(/[{}",]/g, " ").replace(/\s+/g, " ").trim();

/** Model-visible block (spec §3.1). Citation objects match the frontend regex. */
export function buildMemoryPromptBlock(memories: RecalledMemory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((m) => {
    const who = m.createdBy ? `saved by ${m.createdBy.name}` : "saved earlier";
    const when = m.createdAt ? ` on ${m.createdAt.slice(0, 10)}` : "";
    return `- {item_name: "${cite(m.title)}", item_id: "${m.id}", context: "${m.contextId}"} ${m.information} (${who}${when}, ${m.rights_mode})`;
  });
  return [
    "Memories: facts people saved earlier for this assistant. Use them where relevant and cite each memory you rely on",
    "with its citation object exactly as given, e.g. {item_name: <title>, item_id: <id>, context: <contextId>",
    ...lines,
  ].join("\n");
}
