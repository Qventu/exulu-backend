import { join } from "node:path";
import { ACTIONS_FILE, ACTIONS_MAX_BYTES, parseActionsYaml, type SkillAction } from "./schema";

export type LoadedSkillActions = {
  bySkill: Record<string, { skillDir: string; actions: Record<string, SkillAction> }>;
  problems: Array<{ skill: string; error: string }>;
};

/**
 * A skill's action declaration as parsed from the bytes the platform downloaded
 * from skill storage. "none" = the skill version ships no actions.yaml.
 */
export type ActionsDeclaration =
  | { kind: "none" }
  | { kind: "ok"; actions: Record<string, SkillAction> }
  | { kind: "problem"; error: string };

/**
 * One skill's pinned declaration, kept on the cached session sandbox. It is set
 * only when the skill's files are (re)downloaded and never re-read from the
 * session directory, so a file the agent writes at skills/<name>/actions.yaml
 * has no effect on which actions exist or what they read.
 */
export type PinnedSkillActions = {
  skillId: string;
  name: string;
  version: number;
  declaration: ActionsDeclaration;
};

/** Parses the downloaded actions.yaml bytes (undefined = the skill has none). Never throws. */
export const declarationFromBytes = (bytes: Buffer | undefined): ActionsDeclaration => {
  if (bytes === undefined) return { kind: "none" };
  try {
    if (bytes.length > ACTIONS_MAX_BYTES) {
      return { kind: "problem", error: `${ACTIONS_FILE} exceeds ${ACTIONS_MAX_BYTES} bytes` };
    }
    const parsed = parseActionsYaml(bytes.toString("utf8"));
    return parsed.ok ? { kind: "ok", actions: parsed.actions } : { kind: "problem", error: parsed.error };
  } catch (err) {
    return {
      kind: "problem",
      error: `${ACTIONS_FILE} could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
 * The actions of this turn's enabled skills, from the pinned declarations only
 * (never from disk). A skill contributes only when its pin matches its current
 * id, name and version; anything else (not downloaded on this sandbox, a sync
 * that failed, a renamed skill) contributes nothing.
 */
export const loadSkillActions = (
  sessionDir: string,
  skills: Array<{ id: string; name: string; current_version: number }>,
  pinned: ReadonlyMap<string, PinnedSkillActions>,
): LoadedSkillActions => {
  const result: LoadedSkillActions = { bySkill: {}, problems: [] };
  for (const skill of skills) {
    const pin = pinned.get(skill.id);
    if (!pin || pin.version !== skill.current_version || pin.name !== skill.name) continue;
    if (!isPlainName(skill.name)) {
      result.problems.push({ skill: String(skill.name), error: "invalid skill name" });
      continue;
    }
    const { declaration } = pin;
    if (declaration.kind === "none") continue;
    if (declaration.kind === "problem") {
      result.problems.push({ skill: skill.name, error: declaration.error });
      continue;
    }
    result.bySkill[skill.name] = { skillDir: join(sessionDir, "skills", skill.name), actions: declaration.actions };
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
