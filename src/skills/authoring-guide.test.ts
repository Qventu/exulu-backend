import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACTION_INPUT_TYPES, ACTIONS_FILE, parseActionsYaml } from "@EE/invoke-skills/skill-actions/schema";
import { readableContextFields } from "@SRC/templates/tools/context-read-tools";
import { ARTIFACTS_BLOCK_HEADER } from "@EE/invoke-skills/artifact-filter";
import { ACTIONS_EDIT_NO_EFFECT, SKILL_AUTHORING_GUIDE } from "./authoring-guide";

jest.mock("@SRC/postgres/client", () => ({ postgresClient: jest.fn() }));
jest.mock("@SRC/utils/check-record-access", () => ({ checkRecordAccess: jest.fn() }));

test.each([
  ...ACTION_INPUT_TYPES,
  "version",
  "actions",
  "run",
  "inputs",
  "timeout_seconds",
  "EXULU_INPUTS_DIR",
  "EXULU_SKILL_DIR",
  ARTIFACTS_BLOCK_HEADER,
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

test("the guide states archived items, field defaults and every filter operator", () => {
  const source = readFileSync(join(__dirname, "../templates/tools/context-read-tools.ts"), "utf8");
  const operators = /const SUPPORTED_OPERATORS = \[([^\]]*)\]/.exec(source)![1]!.match(/"(\w+)"/g)!.map((o) => o.replace(/"/g, ""));
  expect(operators.length).toBeGreaterThan(0);
  expect(SKILL_AUTHORING_GUIDE).toContain(`operators ${operators.join(", ")}`);
  expect(SKILL_AUTHORING_GUIDE).toContain("Archived items are included");
  expect(SKILL_AUTHORING_GUIDE).toContain("archived: { eq: false }");
  expect(SKILL_AUTHORING_GUIDE).toContain("storage key");
  const yaml = SKILL_AUTHORING_GUIDE.match(/```yaml\n([\s\S]*?)```/)![1]!;
  expect(yaml).toContain("archived");
  expect(parseActionsYaml(yaml).ok).toBe(true);
});

test("the items default-field sentence matches the code's find defaults", () => {
  const fields = readableContextFields({
    id: "c",
    name: "c",
    fields: [{ name: "price", type: "number" }, { name: "doc", type: "file" }],
  } as any);
  const sentence = /an `items` input returns only ([^;.]*)/.exec(SKILL_AUTHORING_GUIDE)![1]!;
  const defaults = fields.filter((f) => f.findDefault).map((f) => f.name);
  expect(defaults).toEqual(expect.arrayContaining(["id", "updatedAt", "name", "description", "tags", "external_id"]));
  for (const name of defaults.filter((n) => n !== "price")) expect(sentence).toContain(name);
  expect(sentence).toContain("non-file fields");
  for (const excluded of ["createdAt", "rights_mode", "archived", "doc"]) {
    expect(defaults).not.toContain(excluded);
    expect(sentence).not.toContain(excluded);
  }
  // `item` without fields returns every readable field, which includes what items leaves out
  expect(fields.map((f) => f.name)).toEqual(expect.arrayContaining(["createdAt", "rights_mode", "archived", "doc"]));
  const item = /an `item` input without it returns every readable field, including ([^;]*);/.exec(SKILL_AUTHORING_GUIDE)![1]!;
  for (const name of ["createdAt", "rights_mode", "archived", "file fields"]) expect(item).toContain(name);
});

test("the operator restrictions are pinned to the source", () => {
  const source = readFileSync(join(__dirname, "../templates/tools/context-read-tools.ts"), "utf8");
  expect(source).toContain('CONTAINS_UNSUPPORTED_TYPES = new Set(["number", "boolean", "date", "uuid"])');
  expect(source).toContain('RANGE_UNSUPPORTED_TYPES = new Set(["json", "uuid"])');
  const fn = /const operatorsForField = [\s\S]*?\n  \}\);/.exec(source)![0];
  expect(fn).toContain('operator === "contains"');
  expect(fn).toContain('operator === "gte" || operator === "lte"');
  expect(fn.match(/operator ===/g)).toHaveLength(3); // no further restricted operator
  expect(SKILL_AUTHORING_GUIDE).toContain("`contains` is refused on number, boolean, date and uuid fields, `gte` and `lte` on json and uuid fields");
});

test("the guide says actions come from the saved version, and the registration never reads them from disk", () => {
  expect(SKILL_AUTHORING_GUIDE).toContain(ACTIONS_EDIT_NO_EFFECT);
  expect(SKILL_AUTHORING_GUIDE).toContain(`takes \`${ACTIONS_FILE}\` from the saved skill version`);
  expect(SKILL_AUTHORING_GUIDE).toContain("it is picked up on the next turn");
  // Backed by: the loader has no file-system access and the registration passes the pinned map.
  const load = readFileSync(join(__dirname, "../../ee/invoke-skills/skill-actions/load.ts"), "utf8");
  expect(load).not.toMatch(/from "node:fs|from "fs|safe-fs/);
  const convert = readFileSync(join(__dirname, "../templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts"), "utf8");
  expect(convert).toMatch(/loadSkillActions\([\s\S]{0,200}sharedSessionSandbox\.skillActions,?\s*\)/);
});
