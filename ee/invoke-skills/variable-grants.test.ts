import { selectGrantedVariables } from "./variable-grants";

test("only variables with allow_skill_access are returned", () => {
  const rows = [
    { id: "1", name: "JIRA_CLIENT_ID", value: "a", encrypted: false, allow_skill_access: true },
    { id: "2", name: "ANTHROPIC_API_KEY", value: "b", encrypted: false, allow_skill_access: false },
    { id: "3", name: "LEGACY", value: "c", encrypted: false, allow_skill_access: null as any },
  ];
  expect(selectGrantedVariables(rows as any)).toEqual({ JIRA_CLIENT_ID: "a" });
});

test("underscore-prefixed and '=' names stay excluded", () => {
  const rows = [
    { id: "1", name: "_HIDDEN", value: "a", encrypted: false, allow_skill_access: true },
    { id: "2", name: "BAD=NAME", value: "b", encrypted: false, allow_skill_access: true },
  ];
  expect(selectGrantedVariables(rows as any)).toEqual({});
});
