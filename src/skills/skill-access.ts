import { RBACResolver } from "@EE/rbac-resolver.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import type { User } from "@EXULU_TYPES/models/user";

export async function resolveSkillByName(db: any, name: string): Promise<any | null> {
  const row = await db("skills").where({ name }).first();
  return row ?? null;
}

export async function canAccessSkill(
  db: any,
  skill: any,
  action: "read" | "write",
  user?: User,
): Promise<boolean> {
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
