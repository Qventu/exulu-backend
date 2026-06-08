import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProfileDir } from "./config";

/**
 * Filesystem access to a Hermes profile's skills — the directory where Hermes
 * stores both bundled skills and the ones it auto-distills from past
 * conversations (`${profileDir}/skills/<skillId>/SKILL.md`, since
 * HERMES_HOME == profileDir).
 *
 * Pure fs + parsing, no app/auth dependencies, so it stays unit-testable.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

export type HermesSkill = {
  /** Folder name — the id used in the edit/delete routes. */
  id: string;
  /** Display name from SKILL.md frontmatter, falling back to the folder name. */
  name: string;
  description?: string;
  version?: string;
  updatedAt?: string;
  /** Full SKILL.md contents (small markdown files). */
  content: string;
};

/** A skill id is a single path segment; reject anything that could traverse. */
export const isSafeSkillId = (id: string): boolean =>
  /^[a-zA-Z0-9._-]+$/.test(id) && id !== "." && id !== "..";

/** Parse the leading YAML frontmatter of a SKILL.md into flat key/values. */
export const parseFrontmatter = (content: string): Record<string, string> => {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return out;
};

const skillsRoot = (profileId: string): string =>
  join(getProfileDir(profileId), "skills");

/** List every skill folder (with a SKILL.md) in a profile. */
export const listProfileSkills = async (
  profileId: string,
): Promise<HermesSkill[]> => {
  const root = skillsRoot(profileId);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: HermesSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillPath = join(root, entry.name, "SKILL.md");
    const content = await readFile(skillPath, "utf8").catch(() => undefined);
    if (content === undefined) continue;
    const fm = parseFrontmatter(content);
    const st = await stat(skillPath).catch(() => undefined);
    skills.push({
      id: entry.name,
      name: fm.name || entry.name,
      description: fm.description,
      version: fm.version,
      updatedAt: st?.mtime.toISOString(),
      content,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
};

export const readProfileSkill = async (
  profileId: string,
  skillId: string,
): Promise<string | undefined> =>
  readFile(join(skillsRoot(profileId), skillId, "SKILL.md"), "utf8").catch(
    () => undefined,
  );

/** Overwrite an existing SKILL.md (throws if the skill folder is missing). */
export const writeProfileSkill = async (
  profileId: string,
  skillId: string,
  content: string,
): Promise<void> => {
  const skillPath = join(skillsRoot(profileId), skillId, "SKILL.md");
  await stat(skillPath); // throws if missing — we don't create new skills here
  await writeFile(skillPath, content, "utf8");
};

export const deleteProfileSkill = async (
  profileId: string,
  skillId: string,
): Promise<void> => {
  await rm(join(skillsRoot(profileId), skillId), { recursive: true, force: true });
};
