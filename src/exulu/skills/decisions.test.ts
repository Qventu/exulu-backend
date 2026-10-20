import { collectSkillDecisions, isSkillToolPartType, parseSkillDecision } from "./decisions";

describe("parseSkillDecision", () => {
  test("accepts a create decision with a valid rights mode and optional rbac", () => {
    const d = parseSkillDecision(JSON.stringify({ v: 1, kind: "create", name: " Report ", description: "x", rights_mode: "users", rbac: { users: [{ id: 3, rights: "read" }] }, enableOnAgent: true }));
    expect(d).toEqual({ v: 1, kind: "create", name: "Report", description: "x", rights_mode: "users", rbac: { users: [{ id: 3, rights: "read" }] }, enableOnAgent: true });
  });
  test("rejects a create decision without a name or with an unknown rights mode", () => {
    expect(parseSkillDecision(JSON.stringify({ v: 1, kind: "create", name: "", rights_mode: "private" }))).toBeUndefined();
    expect(parseSkillDecision(JSON.stringify({ v: 1, kind: "create", name: "a", rights_mode: "friends" }))).toBeUndefined();
  });
  test("accepts an update decision with optional label and description", () => {
    expect(parseSkillDecision(JSON.stringify({ v: 1, kind: "update", label: "v2" }))).toEqual({ v: 1, kind: "update", label: "v2" });
    expect(parseSkillDecision(JSON.stringify({ v: 1, kind: "update" }))).toEqual({ v: 1, kind: "update" });
  });
  test("ignores garbage, wrong versions and unknown kinds", () => {
    expect(parseSkillDecision("not json")).toBeUndefined();
    expect(parseSkillDecision(JSON.stringify({ v: 2, kind: "create", name: "a", rights_mode: "private" }))).toBeUndefined();
    expect(parseSkillDecision(JSON.stringify({ v: 1, kind: "delete" }))).toBeUndefined();
    expect(parseSkillDecision(undefined)).toBeUndefined();
  });
});

describe("collectSkillDecisions", () => {
  test("keeps approved skill parts only, keyed by toolCallId", () => {
    const messages: any[] = [
      {
        role: "assistant",
        parts: [
          { type: "tool-skill_create", toolCallId: "c1", approval: { approved: true, reason: JSON.stringify({ v: 1, kind: "create", name: "a", description: "", rights_mode: "private" }) } },
          { type: "tool-skill_update", toolCallId: "u1", approval: { approved: false, reason: "declined" } },
          { type: "tool-memory_remember", toolCallId: "m1", approval: { approved: true, reason: JSON.stringify({ v: 1, kind: "create", name: "x", rights_mode: "private" }) } },
        ],
      },
      { role: "user", parts: [{ type: "tool-skill_create", toolCallId: "c2", approval: { approved: true, reason: "{}" } }] },
    ];
    const out = collectSkillDecisions(messages);
    expect([...out.keys()]).toEqual(["c1"]);
    expect(out.get("c1")?.kind).toBe("create");
  });
  test("isSkillToolPartType", () => {
    expect(isSkillToolPartType("tool-skill_create")).toBe(true);
    expect(isSkillToolPartType("tool-skill_list")).toBe(false);
    expect(isSkillToolPartType("skill_create")).toBe(false);
  });
});
