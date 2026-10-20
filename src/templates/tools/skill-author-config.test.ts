import { parseSkillAuthorConfig, SKILL_AUTHOR_PROMPT, SKILL_AUTHOR_TOOL_ID } from "./skill-author-config";

describe("parseSkillAuthorConfig", () => {
  test("off without the entry, with garbage, or with a non-array", () => {
    expect(parseSkillAuthorConfig(undefined).enabled).toBe(false);
    expect(parseSkillAuthorConfig("{not json").enabled).toBe(false);
    expect(parseSkillAuthorConfig([{ id: "other", type: "function", name: "x", config: [] }] as any).enabled).toBe(false);
  });
  test("an entry without rows enables both actions with the card", () => {
    expect(parseSkillAuthorConfig([{ id: SKILL_AUTHOR_TOOL_ID, type: "function", name: "Skill author", config: [] }] as any)).toEqual({ enabled: true, create: true, update: true, skipApproval: false });
  });
  test("reads boolean rows from value, variable or default, also as strings", () => {
    const tools = [
      {
        id: SKILL_AUTHOR_TOOL_ID,
        type: "function",
        name: "Skill author",
        config: [
          { name: "create", variable: "false", type: "boolean" },
          { name: "update", value: true, type: "boolean" },
          { name: "skip_approval", default: "true", type: "boolean" },
        ],
      },
    ];
    expect(parseSkillAuthorConfig(JSON.stringify(tools))).toEqual({ enabled: true, create: false, update: true, skipApproval: true });
  });
  test("the prompt keeps skills to complex recurring work and sends corrections to memory", () => {
    expect(SKILL_AUTHOR_PROMPT).toMatch(/multi-step/);
    expect(SKILL_AUTHOR_PROMPT).toMatch(/belongs in memory/);
    expect(SKILL_AUTHOR_PROMPT).toMatch(/single question/);
  });
});
