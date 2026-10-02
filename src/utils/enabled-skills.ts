import { postgresClient } from "@SRC/postgres/client";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { ExuluSkill } from "@EXULU_TYPES/skill";

export const getEnabledSkills = async (
  agent: ExuluAgent,
  disabledSkills: string[] = [],
): Promise<ExuluSkill[]> => {
  const refs = (agent.skills?.filter(Boolean) ?? []).filter(
    (skill) => !disabledSkills.includes(skill.id),
  );
  if (refs.length === 0) return [];

  // agent.skills is a JSONB snapshot of {id, name} pinned at attach time — it
  // never carries current_version, so casting it straight to ExuluSkill[]
  // (the old behaviour) left every skill's current_version undefined.
  // downloadSkill() (ee/invoke-skills/create-sandbox.ts) falls back to v1 for
  // that case, so every skill on every agent was always served at v1
  // regardless of how many versions had since been saved. Re-fetching by id
  // here also drops refs whose id no longer has a matching skills row (e.g.
  // a stale duplicate left behind by a past re-create) instead of silently
  // letting it collide with a same-named live skill in the sandbox's
  // by-name download folder.
  const { db } = await postgresClient();
  const rows: ExuluSkill[] = await db.from("skills").whereIn(
    "id",
    refs.map((skill) => skill.id),
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));

  console.log("[EXULU] available skills", refs.length, "resolved", rows.length);
  console.log("[EXULU] disabled skills", disabledSkills?.length);

  return refs.map((ref) => rowById.get(ref.id)).filter((row): row is ExuluSkill => row != null);
};
