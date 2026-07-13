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

export async function filterReadableSkills(db: any, skills: any[], user?: User): Promise<any[]> {
  const out: any[] = [];
  for (const s of skills) {
    if (await canAccessSkill(db, s, "read", user)) out.push(s);
  }
  return out;
}
