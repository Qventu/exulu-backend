import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { getTableName } from "@SRC/exulu/table-names";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { displayName } from "@SRC/exulu/memory/recall-collector";

export type MemoryBaseStats = {
  total: number; public: number; private: number; contributors: number;
  lastSavedAt: string | null; lastSavedBy: { id: number; name: string } | null;
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);

const EMPTY: MemoryBaseStats = { total: 0, public: 0, private: 0, contributors: 0, lastSavedAt: null, lastSavedBy: null };

/**
 * Counts as visible to the viewer (RBAC applied); spec §3.3. A context's
 * items table may not exist yet (memory base never saved to) — guard and
 * fail soft to the zeroed shape, mirroring computeContextAggregates.
 */
export async function memoryBaseStats({ context, user, db }: { context: ExuluContext; user: User | undefined; db: any }): Promise<MemoryBaseStats> {
  const tableName = getTableName(context.id);
  if (!(await db.schema.hasTable(tableName))) return { ...EMPTY };

  try {
    const table = convertContextToTableDefinition(context);
    const scoped = () => applyAccessControl(table, db(tableName).whereNot("archived", true), user);

    // Sequential on purpose: five cheap counts, and it keeps the query builder usage trivially testable.
    const [totalRow] = await scoped().count("id as c");
    const [publicRow] = await scoped().where("rights_mode", "public").count("id as c");
    const [privateRow] = await scoped().where("rights_mode", "private").count("id as c");
    const [contribRow] = await scoped().countDistinct("created_by as c");
    const last = await scoped().orderBy("createdAt", "desc").select("createdAt", "created_by").first();

    let lastSavedBy: MemoryBaseStats["lastSavedBy"] = null;
    if (last && typeof last.created_by === "number") {
      const [u] = await db("users").whereIn("id", [last.created_by]).select("id", "firstname", "lastname", "email");
      if (u) lastSavedBy = { id: u.id, name: displayName(u) };
    }
    const lastSavedAt = last?.createdAt instanceof Date ? last.createdAt.toISOString() : typeof last?.createdAt === "string" ? last.createdAt : null;

    return {
      total: num(totalRow?.c), public: num(publicRow?.c), private: num(privateRow?.c),
      contributors: num(contribRow?.c), lastSavedAt, lastSavedBy,
    };
  } catch (error) {
    console.error(`[EXULU] memoryBaseStats failed for context "${context.id}":`, error instanceof Error ? error.message : error);
    return { ...EMPTY };
  }
}
