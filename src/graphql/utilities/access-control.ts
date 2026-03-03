import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { User } from "@EXULU_TYPES/models/user";

export const applyAccessControl = (
  table: ExuluTableDefinition,
  query: any,
  user?: User,
  field_prefix?: string,
) => {
  const tableNamePlural = table.name.plural.toLowerCase();

  // If a user is super admin, they can see everything, except if
  // the table is agent_sessions, in which case we always enforce
  // the regular rbac rules set for the session (defaults to private).
  if (table.name.plural !== "agent_sessions" && user?.super_admin === true) {
    return query; // todo roadmap - scoping api users to specific resources
  }

  if (
    user &&
    !user?.super_admin &&
    (table.name.plural === "agents" ||
      table.name.plural === "workflow_templates" ||
      table.name.plural === "variables" ||
      table.name.plural === "users" ||
      table.name.plural === "test_cases" ||
      table.name.plural === "eval_sets" ||
      table.name.plural === "eval_runs") &&
    (!user?.role ||
      (!(
        table.name.plural === "agents" &&
        (user.role.agents === "read" || user.role.agents === "write")
      ) &&
        !(
          table.name.plural === "workflow_templates" &&
          (user.role.workflows === "read" || user.role.workflows === "write")
        ) &&
        !(
          table.name.plural === "variables" &&
          (user.role.variables === "read" || user.role.variables === "write")
        ) &&
        !(
          table.name.plural === "users" &&
          (user.role.users === "read" || user.role.users === "write")
        ) &&
        !(
          (table.name.plural === "test_cases" ||
            table.name.plural === "eval_sets" ||
            table.name.plural === "eval_runs") &&
          (user.role.evals === "read" || user.role.evals === "write")
        )))
  ) {
    console.error(
      "==== Access control error: no role found or no access to entity type. ====",
      user,
      table.name.plural,
    );
    // Return empty result on error
    throw new Error("Access control error: no role found or no access to entity type.");
  }

  const hasRBAC = table.RBAC === true;
  console.log("[EXULU] hasRBAC", hasRBAC);
  if (!hasRBAC) {
    return query;
  }

  if (user?.super_admin) {
    return query;
  }

  const prefix = field_prefix ? field_prefix + "." : "";

  console.log("[EXULU] applying access control with this prefix", prefix);
  try {
    // New RBAC system
    query = query.where(function (this: any) {
      // Public records
      this.where(`${prefix}rights_mode`, "public");
      if (user) {
        this.orWhere(`${prefix}created_by`, user.id);

        // Records shared with users via RBAC table
        this.orWhere(function (this: any) {
          this.where(`${prefix}rights_mode`, "users").whereExists(function (this: any) {
            this.select("*")
              .from("rbac")
              .whereRaw(
                "rbac.target_resource_id = " +
                  (prefix ? prefix.slice(0, -1) : tableNamePlural) +
                  ".id",
              )
              .where("rbac.entity", table.name.singular)
              .where("rbac.access_type", "User")
              .where("rbac.user_id", user.id);
          });
        });
      }

      // Records shared with roles via RBAC table (if user has a role)
      if (user?.role) {
        this.orWhere(function (this: any) {
          this.where(`${prefix}rights_mode`, "roles").whereExists(function (this: any) {
            this.select("*")
              .from("rbac")
              .whereRaw(
                "rbac.target_resource_id = " +
                  (prefix ? prefix.slice(0, -1) : tableNamePlural) +
                  ".id",
              )
              .where("rbac.entity", table.name.singular)
              .where("rbac.access_type", "Role")
              .where("rbac.role_id", user.role.id);
          });
        });
      }
    });
  } catch (error) {
    console.error("Access control error:", error);
    // Return empty result on error
    return query.where("1", "=", "0");
  }

  return query;
};
