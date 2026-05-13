import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import type { ExuluSkill } from "@EXULU_TYPES/skill";

export const getEnabledSkills = async (
  agent: ExuluAgent,
  disabledSkills: string[] = [],
) => {
  let enabledSkills: ExuluSkill[] = [];
  if (agent.skills) {
    enabledSkills = agent.skills.filter(Boolean) as ExuluSkill[];
  }

  console.log("[EXULU] available skills", enabledSkills?.length);

  // Message specific skills, the user can overwrite to disable specific skills
  // for individual messages.
  console.log("[EXULU] disabled skills", disabledSkills?.length);
  enabledSkills = enabledSkills.filter((skill) => !disabledSkills.includes(skill.id));
  return enabledSkills;
};
