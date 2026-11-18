import { RBACResolver } from "@EE/rbac-resolver.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { sameEntityId } from "@SRC/exulu/project-access";
import type { User } from "@EXULU_TYPES/models/user";

export async function resolveSkillByName(db: any, name: string): Promise<any | null> {
  const row = await db("skills").where({ name }).first();
  return row ?? null;
}

/**
 * Who may write a PUBLIC skill (decision 2026-11-18): for skills, "public"
 * grants read and use, not write. Its creator, a super admin, an admin-mode
 * API key, or anyone with an explicit RBAC write grant (user, role or team)
 * — not every signed-in user, which is what checkRecordAccess's shared
 * "public satisfies any right" rule would answer. Skill-only: other record
 * types keep that rule. Also used by the GraphQL skill mutations' write
 * guard (src/graphql/mutations/index.ts), so REST, tools and GraphQL agree.
 * RBAC rows are read through RBACResolver, so without an rbac license there
 * are no grants and only creator / super admin / admin key remain.
 */
export async function canWritePublicSkill(db: any, skill: any, user?: User): Promise<boolean> {
  if (!user) return false;
  if (user.super_admin === true) return true;
  if (user.type === "api" && (!user.scope_mode || user.scope_mode === "admin")) return true;
  if (sameEntityId(skill.created_by, user.id)) return true;
  const rbac = await RBACResolver(db, "skill", skill.id, "public");
  const granted = (list: any[] | undefined, subject: unknown) =>
    subject != null && (list ?? []).some((g) => sameEntityId(g.id, subject) && g.rights === "write");
  const role: any = user.role;
  const team: any = user.team;
  return (
    granted(rbac.users, user.id) ||
    granted(rbac.roles, role?.id ?? role) ||
    granted(rbac.teams, team?.id ?? team)
  );
}

export async function canAccessSkill(
  db: any,
  skill: any,
  action: "read" | "write",
  user?: User,
): Promise<boolean> {
  // A public skill is readable by everyone (checkRecordAccess below) but
  // writable only by its owners. Decided here, before checkRecordAccess and
  // its per-(id, right, user) cache, so the shared rule is not changed.
  if (action === "write" && skill.rights_mode === "public") {
    return canWritePublicSkill(db, skill, user);
  }
  // Fast paths (public / creator / admin / api) don't need RBAC hydration, but
  // hydrating is cheap and keeps the users/roles/teams modes correct.
  const rbac = await RBACResolver(db, "skill", skill.id, skill.rights_mode || "private");
  return checkRecordAccess({ ...skill, RBAC: rbac }, action, user);
}

/**
 * Write guard for the routes that change an existing skill's files or version
 * (/skills/:skillId/sign, /file DELETE, /version, /rename, /init,
 * /init-from-upload, /upload-sign). Same rule as the registry publish route and the
 * skill_update tool: canAccessSkill(..., "write"). Answers 403 itself when the
 * caller may not write, so a route only has to `return` on false.
 */
export async function ensureSkillWrite(
  db: any,
  skill: any,
  user: User | undefined,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
): Promise<boolean> {
  if (await canAccessSkill(db, skill, "write", user)) return true;
  res.status(403).json({ detail: "You don't have write access to this skill." });
  return false;
}

/**
 * Read guard for the routes that list, download, read or diff an existing
 * skill's files (/skills/:skillId/files, /download, /file, /diff). Same rule
 * as the registry routes and skill_read: canAccessSkill(..., "read"). A
 * caller who may not read the skill gets exactly the answer an unknown id
 * gets (404 "Skill not found."), as the GraphQL skill queries and skill_read
 * do, so a private skill's id cannot be probed for existence. Call it after
 * the route's own 404 and before any S3 call or presigned URL.
 */
export async function ensureSkillRead(
  db: any,
  skill: any,
  user: User | undefined,
  res: { status: (code: number) => { json: (body: unknown) => unknown } },
): Promise<boolean> {
  if (await canAccessSkill(db, skill, "read", user)) return true;
  res.status(404).json({ detail: "Skill not found." });
  return false;
}

export async function filterReadableSkills(db: any, skills: any[], user?: User): Promise<any[]> {
  const out: any[] = [];
  for (const s of skills) {
    if (await canAccessSkill(db, s, "read", user)) out.push(s);
  }
  return out;
}
