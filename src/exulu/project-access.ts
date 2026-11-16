export type ProjectRight = "read" | "write";

type Grant = { id: string | number; rights: string };

/**
 * Access rule for a project and its files. Unlike checkRecordAccess, a `write`
 * grant also satisfies a `read` check: someone who may edit a project's files
 * must be able to list them. `rbac.type === "public"` is what RBACResolver
 * returns when the RBAC licence is absent, so it passes like a public project.
 * Ids are compared as strings (RBAC subject ids are strings, user.id a number).
 */
export function hasProjectAccess(args: {
  project: { created_by?: number | string | null; rights_mode?: string | null };
  rbac: { type: string; users?: Grant[]; roles?: Grant[] };
  /**
   * `role` is a bare id on rows read from the users table, but authentication
   * (src/auth/auth.ts) replaces it with the hydrated role row; both are accepted.
   */
  user: {
    id: number | string;
    role?: string | number | { id?: string | number | null } | null;
    super_admin?: boolean;
    type?: string;
  };
  want: ProjectRight;
}): boolean {
  const { project, rbac, user, want } = args;

  if (user.super_admin) return true;
  if (project.rights_mode === "public" || rbac.type === "public") return true;
  if (project.created_by != null && String(project.created_by) === String(user.id)) return true;

  const satisfies = (rights: string) => rights === "write" || (rights === "read" && want === "read");

  const byUser = (rbac.users ?? []).some(
    (g) => String(g.id) === String(user.id) && satisfies(g.rights),
  );
  if (byUser) return true;

  const roleId = typeof user.role === "object" && user.role ? user.role.id : user.role;
  if (roleId == null) return false;
  return (rbac.roles ?? []).some((g) => String(g.id) === String(roleId) && satisfies(g.rights));
}
