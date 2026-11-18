import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACTION_INPUT_TYPES, ACTIONS_FILE, parseActionsYaml } from "@EE/invoke-skills/skill-actions/schema";
import { SKILL_AUTHORING_GUIDE } from "./authoring-guide";

test.each([
  ...ACTION_INPUT_TYPES,
  "version",
  "actions",
  "run",
  "inputs",
  "timeout_seconds",
  "EXULU_INPUTS_DIR",
  "EXULU_SKILL_DIR",
  "[exulu-artifacts]",
  "run_skill_action",
  "args.json",
  ACTIONS_FILE,
  "get_<context>_item",
])("the guide names %s", (term) => {
  expect(SKILL_AUTHORING_GUIDE).toContain(term);
});

test("the example in the guide parses", () => {
  const yaml = SKILL_AUTHORING_GUIDE.match(/```yaml\n([\s\S]*?)```/)![1]!;
  const parsed = parseActionsYaml(yaml);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    const inputs = Object.values(parsed.actions).flatMap((a) => Object.values(a.inputs).map((i) => i.type));
    expect(new Set(inputs)).toEqual(new Set(ACTION_INPUT_TYPES));
  }
});

test("the numbers the guide states match run_skill_action", () => {
  const source = readFileSync(join(__dirname, "../../ee/invoke-skills/skill-actions/tool.ts"), "utf8");
  const constant = (name: string) => Number(new RegExp(`const ${name} = ([\\d_]+);`).exec(source)![1]!.replace(/_/g, ""));
  expect(SKILL_AUTHORING_GUIDE).toContain(`at most ${constant("TEXT_MAX_CHARS")} characters`);
  expect(SKILL_AUTHORING_GUIDE).toContain(`default limit ${constant("ITEMS_DEFAULT_LIMIT")}, maximum ${constant("ITEMS_MAX_LIMIT")}`);
});
