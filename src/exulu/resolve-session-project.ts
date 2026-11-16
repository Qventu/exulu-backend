import { postgresClient } from "@SRC/postgres/client";
import { RBACResolver } from "@EE/rbac-resolver.ts";
import { resolveSandboxProjectId } from "@EE/invoke-skills/project-sync";

export type ResolvedSessionProject = { id: string; name: string };

/**
 * The project a session may SEE this turn, with its name for the prompt: the same
 * access-checked answer the sandbox uses (the session OWNER needs read access; a missing,
 * deleted or inaccessible project resolves to null). Resolve once per turn and hand the
 * result to the sandbox, the document tools and the prompt, never the raw session.project.
 * No project id means no database round trip. Never throws.
 */
export async function resolveSessionProject(args: {
  projectId?: string | null;
  ownerId?: number | string | null;
  owner?: Parameters<typeof resolveSandboxProjectId>[0]["owner"];
}): Promise<ResolvedSessionProject | null> {
  if (!args.projectId || args.ownerId == null) return null;
  let row: { id: string; name?: string | null } | undefined | null;
  const id = await resolveSandboxProjectId(
    { projectId: args.projectId, ownerId: args.ownerId, owner: args.owner },
    {
      getProject: async (pid) => {
        const { db } = await postgresClient();
        row = await db.from("projects").where({ id: pid }).first();
        return row as never;
      },
      // The rbac table stores the SINGULAR entity name for projects.
      getRbac: async (p) => {
        const { db } = await postgresClient();
        return RBACResolver(db, "project", p.id, p.rights_mode || "private");
      },
      getUser: async (uid) => {
        const { db } = await postgresClient();
        return db.from("users").where({ id: uid }).first();
      },
    },
  );
  if (!id) return null;
  return { id, name: row?.name?.trim() || "(unnamed)" };
}
