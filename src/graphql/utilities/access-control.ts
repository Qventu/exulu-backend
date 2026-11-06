import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { User } from "@EXULU_TYPES/models/user";

/**
 * Mirrors the "agents" branch of applyAccessControl's role check, for
 * resolvers that don't run a query through applyAccessControl directly
 * (e.g. memoryBaseStats, which aggregates counts rather than selecting rows).
 * Super admins always pass; otherwise the caller's role must have read or
 * write rights on the agents table, since a memory base is configured on an
 * agent.
 */
export const hasAgentsReadAccess = (user?: User): boolean =>
  user?.super_admin === true || user?.role?.agents === "read" || user?.role?.agents === "write";

/**
 * Write-access variant: super admins or agents:write only (not agents:read).
 */
export const hasAgentsWriteAccess = (user?: User): boolean =>
  user?.super_admin === true || user?.role?.agents === "write";

export const applyAccessControl = (
  table: ExuluTableDefinition,
  query: any,
  user?: User,
  field_prefix?: string,
) => {
  const tableNamePlural = table.name.plural.toLowerCase();

  // An agents-scoped API key is a PUBLIC credential — the storefront chat widget
  // ships it in the page source of every shop page. It exists so a browser can run
  // one specific agent; it is not an identity that may read stored conversations.
  //
  // This has to sit above everything else, including the super-admin bypass, because
  // neither of the usual guards catches it: `agent_messages` carries no RBAC at all
  // (so the query would be returned unfiltered), and on `agent_sessions` the key is
  // the `created_by` of every row the widget opens, which short-circuits the RBAC
  // check in checkRecordAccess.
  //
  // Reads only. CreateOne does not run through applyAccessControl, so the widget can
  // still open a session — it just can never read one back.
  //
  // Narrowed to nothing rather than thrown: applyAccessControl is also called from
  // markSessionSeenForViewer, where a caller without access previously got a graceful
  // "not visible". This file ships to every Exulu deployment, so an unknown caller
  // should degrade to an empty result, not to a 500. Empty fails just as closed.
  if (
    user?.type === "api" &&
    (user as { scope_mode?: string }).scope_mode === "agents" &&
    (tableNamePlural === "agent_sessions" || tableNamePlural === "agent_messages")
  ) {
    console.error(
      "==== Access control: agents-scoped API key refused on conversation table. ====",
      user?.id,
      table.name.plural,
    );
    return query.whereRaw("1 = 0");
  }

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

      // Records shared with teams via RBAC table (if user has a team)
      if (user?.team) {
        const userTeamId = user.team.id;
        this.orWhere(function (this: any) {
          this.where(`${prefix}rights_mode`, "teams").whereExists(function (this: any) {
            this.select("*")
              .from("rbac")
              .whereRaw(
                "rbac.target_resource_id = " +
                  (prefix ? prefix.slice(0, -1) : tableNamePlural) +
                  ".id",
              )
              .where("rbac.entity", table.name.singular)
              .where("rbac.access_type", "Team")
              .where("rbac.team_id", userTeamId);
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
