import { buildSkillSandboxEvent } from "./skill-sandbox";

const ctx = {
  sessionID: "sess-1",
  agent: { id: "ag-1", name: "Wartung" },
  user: { id: 7, email: "a@open.de", role: { id: "r1" } },
  skills: [{ id: "sk-1", name: "Wartungs Report PDF", version: 3 }],
  grantedNames: ["JIRA_CLIENT_ID"],
  withheldNames: ["ANTHROPIC_API_KEY"],
  strippedSecretCount: 12,
  skippedNames: [],
  degradedSandbox: false,
};

test("records names and counts, never values", () => {
  const e = buildSkillSandboxEvent(ctx as any);
  expect(e.type).toBe("skill.sandbox.created");
  expect(e.status).toBe("ok");
  expect(e.context?.sessionId).toBe("sess-1");
  expect(e.data?.grantedVariableNames).toEqual(["JIRA_CLIENT_ID"]);
  expect(e.data?.withheldVariableNames).toEqual(["ANTHROPIC_API_KEY"]);
  expect(e.data?.strippedSecretCount).toBe(12);
  expect(e.data?.degradedSandbox).toBe(false);
});

test("the serialized event contains no credential value", () => {
  const e = buildSkillSandboxEvent({ ...ctx, grantedNames: ["JIRA_CLIENT_ID"] } as any);
  expect(JSON.stringify(e)).not.toContain("sk-ant");
  expect(JSON.stringify(e)).not.toMatch(/value/i);
});
