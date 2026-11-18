import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readRegularFileInside } from "../safe-fs";
import { ACTIONS_FILE, ACTIONS_MAX_BYTES, parseActionsYaml, type SkillAction } from "./schema";

export type LoadedSkillActions = {
  bySkill: Record<string, { skillDir: string; actions: Record<string, SkillAction> }>;
  problems: Array<{ skill: string; error: string }>;
};

const isPlainName = (name: unknown): name is string =>
  typeof name === "string" &&
  name !== "" &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0") &&
  !name.includes("..");

/**
 * Reads and validates actions.yaml of each skill under <sessionDir>/skills/<name>/.
 * Never throws. A missing file is silent; an invalid, unsafe, unreadable or
 * oversized one yields a problem entry and no actions for that skill.
 */
export const loadSkillActions = async (
  sessionDir: string,
  skills: Array<{ name: string }>,
): Promise<LoadedSkillActions> => {
  const result: LoadedSkillActions = { bySkill: {}, problems: [] };
  for (const { name } of skills) {
    try {
      if (!isPlainName(name)) {
        result.problems.push({ skill: String(name), error: "invalid skill name" });
        continue;
      }
      const skillDir = join(sessionDir, "skills", name);
      const file = join(skillDir, ACTIONS_FILE);
      // safe-fs returns null for both "missing" and "unsafe", so tell them apart
      // first: lstat does not follow links, so a symlink counts as present.
      const present = await lstat(file).then(
        () => true,
        (err: NodeJS.ErrnoException) => (err?.code === "ENOENT" || err?.code === "ENOTDIR" ? false : true),
      );
      if (!present) continue;
      const bytes = await readRegularFileInside(sessionDir, file);
      if (bytes === null) {
        result.problems.push({
          skill: name,
          error: `${ACTIONS_FILE} could not be read safely (not a regular file inside the session)`,
        });
        continue;
      }
      if (bytes.length > ACTIONS_MAX_BYTES) {
        result.problems.push({ skill: name, error: `${ACTIONS_FILE} exceeds ${ACTIONS_MAX_BYTES} bytes` });
        continue;
      }
      const parsed = parseActionsYaml(bytes.toString("utf8"));
      if (!parsed.ok) {
        result.problems.push({ skill: name, error: parsed.error });
        continue;
      }
      result.bySkill[name] = { skillDir, actions: parsed.actions };
    } catch (err) {
      result.problems.push({
        skill: String((name as unknown) ?? ""),
        error: `${ACTIONS_FILE} could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return result;
};

export const describeActions = (loaded: LoadedSkillActions): string => {
  const lines: string[] = [];
  for (const [skill, { actions }] of Object.entries(loaded.bySkill)) {
    for (const [actionName, action] of Object.entries(actions)) {
      lines.push(`${skill} / ${actionName} — ${action.description}`);
      for (const [inputName, input] of Object.entries(action.inputs)) {
        let qualifiers = input.type;
        if (input.type === "item" || input.type === "items") qualifiers += `, context ${input.context}`;
        if (input.type === "text" && !input.required) qualifiers += ", optional";
        lines.push(`  ${inputName} (${qualifiers})${input.description ? ` — ${input.description}` : ""}`);
      }
    }
  }
  for (const p of loaded.problems) lines.push(`skill "${p.skill}": actions.yaml ignored — ${p.error}`);
  return lines.join("\n");
};
