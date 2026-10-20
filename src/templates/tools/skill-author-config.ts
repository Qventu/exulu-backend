import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";

/** The display-only picker entry on an agent; the runtime expands it into the skill tools. */
export const SKILL_AUTHOR_TOOL_ID = "skill_author";

export type SkillAuthorConfig = {
  enabled: boolean;
  create: boolean;
  update: boolean;
  skipApproval: boolean;
};

const asBool = (v: unknown, fallback: boolean): boolean => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return fallback;
};

export const parseSkillAuthorConfig = (tools: ExuluAgentToolConfig[] | string | null | undefined): SkillAuthorConfig => {
  const off: SkillAuthorConfig = { enabled: false, create: false, update: false, skipApproval: false };
  let entries: unknown = tools;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return off;
    }
  }
  if (!Array.isArray(entries)) return off;
  const entry = (entries as ExuluAgentToolConfig[]).find((t) => t?.id === SKILL_AUTHOR_TOOL_ID);
  if (!entry) return off;
  const raw = (name: string): unknown => {
    const row = Array.isArray(entry.config) ? entry.config.find((c) => c?.name === name) : undefined;
    return row?.value ?? row?.variable ?? row?.default;
  };
  // An entry with no rows at all means "just enabled": both actions on.
  return {
    enabled: true,
    create: asBool(raw("create"), true),
    update: asBool(raw("update"), true),
    skipApproval: asBool(raw("skip_approval"), false),
  };
};

/**
 * The system-prompt block added when the tool is enabled. Deliberately strict
 * about when a skill is warranted: multi-step work that produced something
 * and will recur — not a question against a knowledge base, and never a
 * single correction, which belongs in memory.
 */
export const SKILL_AUTHOR_PROMPT = [
  "Skill authoring: you can turn a procedure into a reusable skill with skill_create, and improve an existing one with skill_update (skill_list and skill_read show what exists).",
  "Offer a skill only after the user has finished a complex, multi-step piece of work that is likely to recur — typically one that produced files, documents, code, a report or a structured analysis, or a multi-step retrieval they run regularly.",
  "Do not offer it for a single question against a knowledge base, a quick lookup, or a one-off correction; a correction or a preference belongs in memory, not in a skill.",
  "When you offer, say in one sentence what the skill would capture and ask. The user confirms the name, the description and who may see it on a card before anything is created; never ask about visibility yourself unless the user raised it, and never claim a skill exists or changed until the tool returns skill_created or skill_updated.",
  "Write a skill as a SKILL.md with frontmatter (name, description) and clear steps, plus reference files only where they add something the model would otherwise have to guess.",
].join(" ");
