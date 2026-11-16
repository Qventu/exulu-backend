import { postgresClient } from "@SRC/postgres/client";
import { RBACResolver } from "@EE/rbac-resolver.ts";
import { resolveSandboxProjectId } from "@EE/invoke-skills/project-sync";
import { hasProjectAccess } from "./project-access";

export type ResolvedSessionProject = {
  id: string;
  name: string;
  /**
   * Whether the SPEAKER of this turn (not the session owner) may write to the project.
   * Decides if save_to_project is registered. False for guests and speakers without an id.
   */
  speakerCanWrite: boolean;
};

/**
 * The project a session may SEE this turn, with its name for the prompt: the same
 * access-checked answer the sandbox uses (the session OWNER needs read access; a missing,
 * deleted or inaccessible project resolves to null). Resolve once per turn and hand the
 * result to the sandbox, the document tools and the prompt, never the raw session.project.
 * `speaker` is the user of this turn; the same row and RBAC fetched for the owner's check
 * answer the speaker's write right, so a project session costs no extra round trip.
 * No project id means no database round trip. Never throws.
 */
export async function resolveSessionProject(args: {
  projectId?: string | null;
  ownerId?: number | string | null;
  owner?: Parameters<typeof resolveSandboxProjectId>[0]["owner"];
  speaker?: Parameters<typeof hasProjectAccess>[0]["user"] | null;
}): Promise<ResolvedSessionProject | null> {
  if (!args.projectId || args.ownerId == null) return null;
  let row: { id: string; name?: string | null; created_by?: number | string | null; rights_mode?: string | null } | undefined | null;
  let rbac: Parameters<typeof hasProjectAccess>[0]["rbac"] | undefined;
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
        rbac = await RBACResolver(db, "project", p.id, p.rights_mode || "private");
        return rbac as never;
      },
      getUser: async (uid) => {
        const { db } = await postgresClient();
        return db.from("users").where({ id: uid }).first();
      },
    },
  );
  if (!id) return null;
  let speakerCanWrite = false;
  if (args.speaker?.id != null && row && rbac) {
    try {
      speakerCanWrite = hasProjectAccess({ project: row, rbac, user: args.speaker, want: "write" });
    } catch {
      speakerCanWrite = false;
    }
  }
  return { id, name: row?.name?.trim() || "(unnamed)", speakerCanWrite };
}
