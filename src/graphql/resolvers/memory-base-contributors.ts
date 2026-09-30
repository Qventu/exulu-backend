import type { ExuluContext } from "@SRC/exulu/context";
import { getTableName } from "@SRC/exulu/table-names";
import { displayName } from "@SRC/exulu/memory/recall-collector";

export type MemoryBaseContributor = { id: number; name: string };

/**
 * The people who saved something into a memory base: distinct non-null
 * `created_by` over the base's non-archived rows, resolved to display names and
 * ordered by name. Used to populate the Creator filter and the "Created by"
 * line without the `users` right (usersPagination throws for roles that lack
 * it — the very personas the Memory area is gated for). Counts/ids only, never
 * memory content, so it is safe to return unscoped behind agents-read.
 * A base's items table may not exist yet — guard and fail soft to [].
 */
export async function memoryBaseContributors({ context, db }: { context: ExuluContext; db: any }): Promise<MemoryBaseContributor[]> {
  const tableName = getTableName(context.id);
  if (!(await db.schema.hasTable(tableName))) return [];

  try {
    const rows = await db(tableName).whereNot("archived", true).distinct("created_by").select("created_by");
    const ids = Array.from(new Set((rows ?? []).map((r: any) => r?.created_by).filter((id: unknown) => typeof id === "number")));
    if (ids.length === 0) return [];

    const users = await db("users").whereIn("id", ids).select("id", "firstname", "lastname", "email");
    return (users ?? [])
      .map((u: any) => ({ id: u.id, name: displayName(u) }))
      .sort((a: MemoryBaseContributor, b: MemoryBaseContributor) => a.name.localeCompare(b.name));
  } catch (error) {
    console.error(`[EXULU] memoryBaseContributors failed for context "${context.id}":`, error instanceof Error ? error.message : error);
    return [];
  }
}
