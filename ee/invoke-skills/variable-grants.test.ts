import { selectGrantedVariables, selectRowsToDecrypt, deriveWithheldNames } from "./variable-grants";

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

test("only granted rows are handed to the decrypter", () => {
  const rows = [
    { id: "1", name: "GRANTED", value: "cipher-a", encrypted: true, allow_skill_access: true },
    { id: "2", name: "UNGRANTED", value: "cipher-b", encrypted: true, allow_skill_access: false },
    { id: "3", name: "LEGACY", value: "cipher-c", encrypted: true, allow_skill_access: null as any },
    { id: "4", name: "", value: "cipher-d", encrypted: true, allow_skill_access: true },
  ];
  expect(selectRowsToDecrypt(rows as any).map((r) => r.name)).toEqual(["GRANTED"]);
});

test("a row whose decryption failed is reported as withheld, not silently dropped", () => {
  // Simulates the real loop: GRANTED_OK decrypts, GRANTED_BROKEN throws and
  // never reaches `granted`. Both were granted; only one is usable.
  const rows = [
    { id: "1", name: "GRANTED_OK", value: "plain", encrypted: false, allow_skill_access: true },
    { id: "2", name: "GRANTED_BROKEN", value: "cipher", encrypted: true, allow_skill_access: true },
    { id: "3", name: "UNGRANTED", value: "plain", encrypted: false, allow_skill_access: false },
  ];
  const decrypted = [rows[0]]; // GRANTED_BROKEN was skipped by the catch
  const granted = selectGrantedVariables(decrypted as any);
  expect(deriveWithheldNames(rows as any, granted)).toEqual(["GRANTED_BROKEN", "UNGRANTED"]);
});

test("withheld names are derived from the unfiltered list and deduplicated", () => {
  const rows = [
    { id: "1", name: "DUPE", value: "a", encrypted: false, allow_skill_access: false },
    { id: "2", name: "DUPE", value: "b", encrypted: false, allow_skill_access: false },
    { id: "3", name: "_HIDDEN", value: "c", encrypted: false, allow_skill_access: true },
  ];
  // `_HIDDEN` was granted but rejected by the name-shape filter, so it is
  // withheld too — exactly the diagnosis an operator needs.
  expect(deriveWithheldNames(rows as any, {})).toEqual(["DUPE", "_HIDDEN"]);
});
