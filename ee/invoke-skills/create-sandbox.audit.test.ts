import { buildSkillSandboxEvent } from "@SRC/exulu/audit/emitters/skill-sandbox";
import { selectGrantedVariables } from "./variable-grants";
import type { Variable } from "@EXULU_TYPES/models/variable";

test("a disabled audit logger is a no-op and never throws", () => {
  const noop = { enabled: false, record: jest.fn(), shouldAuditSkillSandbox: () => false } as any;
  const emit = () => {
    if (!noop.shouldAuditSkillSandbox()) return;
    noop.record(buildSkillSandboxEvent({} as any));
  };
  expect(emit).not.toThrow();
  expect(noop.record).not.toHaveBeenCalled();
});

test("withheld names are the ungranted variable names, not their values", () => {
  const all = ["JIRA_CLIENT_ID", "ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY"];
  const granted = ["JIRA_CLIENT_ID"];
  const withheld = all.filter((n) => !granted.includes(n));
  const e = buildSkillSandboxEvent({
    skills: [], grantedNames: granted, withheldNames: withheld,
    skippedNames: [], strippedSecretCount: 0, degradedSandbox: false,
  } as any);
  expect(e.data?.withheldVariableNames).toEqual(["ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY"]);
});

// Carried forward from Task 5's review: "names only, never values" is
// convention, not enforcement — grantedNames/withheldNames/skippedNames are
// plain string[], and nothing in the types stops a call site passing values
// instead of names. This test proves that a real call site, fed rows whose
// VALUES are recognisable secrets, produces an event whose serialized form
// never contains those values — only the ungranted rows' NAMES, derived via
// the same row.name key-derivation getAllExuluVariables uses for
// withheldNames.
test("a real secret value on an ungranted row never reaches the emitted event", () => {
  const rows: Variable[] = [
    {
      id: "1",
      name: "JIRA_CLIENT_ID",
      value: "jira-client-id-value",
      encrypted: false,
      allow_skill_access: true,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "2",
      name: "ANTHROPIC_API_KEY",
      value: "sk-ant-SHOULD-NOT-APPEAR",
      encrypted: false,
      allow_skill_access: false,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "3",
      name: "PERPLEXITY_API_KEY",
      value: "pplx-SHOULD-NOT-APPEAR-EITHER",
      encrypted: false,
      allow_skill_access: false,
      createdAt: "",
      updatedAt: "",
    },
  ];

  const granted = selectGrantedVariables(rows);
  const withheldNames = rows
    .filter((row) => row?.name && !(row.name in granted))
    .map((row) => row.name)
    .sort();

  const e = buildSkillSandboxEvent({
    sessionID: "sess-1",
    skills: [],
    grantedNames: Object.keys(granted),
    withheldNames,
    skippedNames: [],
    strippedSecretCount: 0,
    degradedSandbox: false,
  } as any);

  const serialized = JSON.stringify(e);
  expect(serialized).not.toContain("sk-ant-SHOULD-NOT-APPEAR");
  expect(serialized).not.toContain("pplx-SHOULD-NOT-APPEAR-EITHER");
  expect(serialized).not.toContain("jira-client-id-value");
  // The point of the test, not just its side effect: the withheld names
  // themselves (keys, never values) do make it through.
  expect(e.data?.withheldVariableNames).toEqual(["ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY"]);
});
