/** RBAC subject ids are strings, user ids numbers: compare as strings, never equal when either is missing. */
export const sameEntityId = (a: unknown, b: unknown): boolean =>
  a != null && b != null && a !== "" && b !== "" && String(a) === String(b);

export type ProjectRight = "read" | "write";

type Grant = { id: string | number; rights: string };

/** A bare id (raw users row) or the hydrated row authentication puts there (src/auth/auth.ts). */
type IdOrRow = string | number | { id?: string | number | null } | null;

const idOf = (v: IdOrRow | undefined): string | number | null | undefined =>
  typeof v === "object" && v ? v.id : v;

/**
 * Access rule for a project and its files. Which grants count follows
 * checkRecordAccess: user grants only in `users` mode, role grants only in
 * `roles` mode, team grants only in `teams` mode, so a project switched back to
 * `private` keeps no access through rbac rows left behind from an earlier mode.
 * Unlike checkRecordAccess, a `write` grant also satisfies a `read` check:
 * someone who may edit a project's files must be able to list them.
 * `rbac.type === "public"` is what RBACResolver returns when the RBAC licence is
 * absent, so it passes like a public project. Admin-mode API keys pass, as they
 * do in checkRecordAccess; agents-scoped keys do not (their allowlist names
 * agents, not projects). Ids are compared as strings (RBAC subject ids are
 * strings, user.id a number).
 */
export function hasProjectAccess(args: {
  project: { created_by?: number | string | null; rights_mode?: string | null };
  rbac: { type: string; users?: Grant[]; roles?: Grant[]; teams?: Grant[] };
  /**
   * `role` and `team` are bare ids on rows read from the users table, but
   * authentication (src/auth/auth.ts) replaces them with the hydrated rows;
   * both are accepted.
   */
  user: {
    id: number | string;
    role?: IdOrRow;
    team?: IdOrRow;
    super_admin?: boolean;
    type?: string;
    scope_mode?: string | null;
  };
  want: ProjectRight;
}): boolean {
  const { project, rbac, user, want } = args;

  if (user.super_admin) return true;
  if (user.type === "api" && (!user.scope_mode || user.scope_mode === "admin")) return true;
  if (project.rights_mode === "public" || rbac.type === "public") return true;
  if (project.created_by != null && String(project.created_by) === String(user.id)) return true;

  const satisfies = (rights: string) => rights === "write" || (rights === "read" && want === "read");
  const granted = (grants: Grant[] | undefined, subject: string | number | null | undefined) =>
    subject != null && (grants ?? []).some((g) => String(g.id) === String(subject) && satisfies(g.rights));

  switch (rbac.type) {
    case "users":
      return granted(rbac.users, user.id);
    case "roles":
      return granted(rbac.roles, idOf(user.role));
    case "teams":
      return granted(rbac.teams, idOf(user.team));
    default:
      return false;
  }
}
