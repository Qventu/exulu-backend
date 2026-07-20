import { postgresClient } from "@SRC/postgres/client";
import { getTableName } from "@SRC/exulu/table-names";
import type { User } from "@EXULU_TYPES/models/user";

/**
 * Row-level WRITE gate for context items, replicating the GraphQL layer's
 * validateWriteAccess (src/graphql/mutations/index.ts) semantics. Context item
 * rows carry rights_mode + created_by; users/roles/teams grants live in the
 * shared `rbac` table keyed by entity = the items table name. checkRecordAccess
 * is NOT usable here — it expects an in-memory record.RBAC object that item
 * rows never have.
 */
export const checkItemWriteAccess = async (
  context: { id: string },
  record: any,
  user?: User,
): Promise<boolean> => {
  if (!user) {
    return false;
  }
  if (user.super_admin === true) {
    return true;
  }
  // Admin-mode API keys keep the legacy broad bypass (matches checkRecordAccess).
  if (user.type === "api" && (!user.scope_mode || user.scope_mode === "admin")) {
    return true;
  }
  if (record.rights_mode === "public") {
    return true;
  }
  if (record.rights_mode === "private") {
    // created_by is a text column while user.id is an integer — compare as strings.
    return record.created_by != null && String(record.created_by) === String(user.id);
  }

  // Validate rights_mode before accessing database
  const validRightsModes = ["users", "roles", "teams"];
  if (!validRightsModes.includes(record.rights_mode)) {
    return false;
  }

  const entity = getTableName(context.id);
  const { db } = await postgresClient();

  if (record.rights_mode === "users") {
    const grant = await db
      .from("rbac")
      .where({
        entity,
        target_resource_id: record.id,
        access_type: "User",
        user_id: user.id,
        rights: "write",
      })
      .first();
    return !!grant;
  }

  if (record.rights_mode === "roles") {
    const roleId = typeof user.role === "string" ? user.role : user.role?.id;
    if (!roleId) {
      return false;
    }
    const grant = await db
      .from("rbac")
      .where({
        entity,
        target_resource_id: record.id,
        access_type: "Role",
        role_id: roleId,
        rights: "write",
      })
      .first();
    return !!grant;
  }

  if (record.rights_mode === "teams") {
    const teamId = typeof user.team === "string" ? user.team : user.team?.id;
    if (!teamId) {
      return false;
    }
    const grant = await db
      .from("rbac")
      .where({
        entity,
        target_resource_id: record.id,
        access_type: "Team",
        team_id: teamId,
        rights: "write",
      })
      .first();
    return !!grant;
  }

  return false;
};
