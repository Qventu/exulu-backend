import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { creatorId } from "./creator-id";
import type { MemoryItemRow } from "./recall-collector";

type Grant = { access_type: string; user_id?: number | null; role_id?: string | null; team_id?: string | null };

/**
 * Who may change a memory (spec decision "Access on save"): the creator, a
 * super admin, or a holder of an explicit `write` grant on the item. `public`
 * means readable by everyone — never writable by everyone. This deliberately
 * differs from checkItemWriteAccess (generic KB tools), which treats public
 * items as writable.
 */
export async function canEditMemory(context: ExuluContext, row: MemoryItemRow, user: User | undefined, db: any): Promise<boolean> {
  if (!user?.id) return false;
  if (user.super_admin === true) return true;
  const creator = creatorId(row.created_by);
  if (creator !== null && creator === user.id) return true;
  const entity = convertContextToTableDefinition(context).name.singular;
  const grants: Grant[] = await db("rbac")
    .where({ entity, target_resource_id: row.id, rights: "write" })
    .select("access_type", "user_id", "role_id", "team_id");
  return grants.some(
    (g) =>
      (g.access_type === "User" && g.user_id === user.id) ||
      (g.access_type === "Role" && !!user.role?.id && g.role_id === user.role.id) ||
      (g.access_type === "Team" && !!(user as { team?: { id?: string } }).team?.id && g.team_id === (user as { team?: { id?: string } }).team!.id),
  );
}
