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

test("the acting agent is recorded, so an event can be joined to its cause", () => {
  const e = buildSkillSandboxEvent(ctx as any);
  expect(e.context?.agentId).toBe("ag-1");
  expect(e.context?.agentName).toBe("Wartung");
});

test("the event body is exactly the declared name and count fields", () => {
  // The old assertion here was `not.toMatch(/value/i)`, which fails the day a
  // FIELD NAME contains "value" and never tested a credential value at all.
  // What actually matters is that nothing beyond the declared name/count
  // fields can ride along — an extra field is how a value would leak.
  const e = buildSkillSandboxEvent(ctx as any);
  expect(Object.keys(e.data ?? {}).sort()).toEqual([
    "degradedSandbox",
    "grantedVariableNames",
    "skills",
    "skippedVariableNames",
    "strippedSecretCount",
    "withheldVariableNames",
  ]);
  for (const names of [
    e.data?.grantedVariableNames,
    e.data?.withheldVariableNames,
    e.data?.skippedVariableNames,
  ]) {
    expect(Array.isArray(names)).toBe(true);
  }
});

test("no credential-value-shaped string reaches the serialized event", () => {
  // Targets the values themselves: the prefixes real credentials carry. Fed a
  // ctx whose name arrays are the genuine article, the event must contain
  // names and nothing that looks like what those names hold.
  const e = buildSkillSandboxEvent(ctx as any);
  const serialized = JSON.stringify(e);
  for (const valueShape of [
    "sk-ant-",
    "sk-proj-",
    "pplx-",
    "postgres://",
    "AKIA",
    "-----BEGIN",
    "GOCSPX-",
    "eyJ", // base64 JWT / service-account JSON header
  ]) {
    expect(serialized).not.toContain(valueShape);
  }
  expect(serialized).toContain("JIRA_CLIENT_ID");
  expect(serialized).toContain("ANTHROPIC_API_KEY");
});
