import {
  MAX_PROJECT_FILES,
  isProjectKey,
  parseProjectFilename,
  planPromote,
  projectFilePrefix,
} from "./project-files";

describe("projectFilePrefix", () => {
  test("without s3prefix", () => {
    expect(projectFilePrefix("p1")).toEqual({
      projectPrefix: "projects/p1/files/",
      fullProjectPrefix: "projects/p1/files/",
    });
  });
  test("with s3prefix", () => {
    expect(projectFilePrefix("p1", "imp")).toEqual({
      projectPrefix: "projects/p1/files/",
      fullProjectPrefix: "imp/projects/p1/files/",
    });
  });
});

describe("isProjectKey", () => {
  test("true for project keys", () => {
    expect(isProjectKey("imp/projects/x/files/a.pdf", "imp")).toBe(true);
    expect(isProjectKey("projects/x/files/a.pdf")).toBe(true);
  });
  test("false for others", () => {
    expect(isProjectKey("user_1/sessions/s/a.pdf")).toBe(false);
    expect(isProjectKey("global/a.pdf")).toBe(false);
  });
});

describe("parseProjectFilename", () => {
  test("session and project scope", () => {
    expect(parseProjectFilename("a.pdf")).toEqual({ scope: "session", name: "a.pdf" });
    expect(parseProjectFilename("project/a.pdf")).toEqual({ scope: "project", name: "a.pdf" });
  });
  test.each(["project/../a", "project//a", "project/", "project/sub/a.pdf"])("rejects %s", (f) => {
    expect(parseProjectFilename(f)).toHaveProperty("error");
  });
});

describe("planPromote", () => {
  const sp = "user_1/sessions/s/";
  const pp = "projects/p/files/";
  const base = { fullSessionPrefix: sp, fullProjectPrefix: pp, existingNames: [] as string[], overwrite: false };

  test("accepts a session key", () => {
    const r = planPromote({ ...base, keys: [`${sp}a.pdf`] });
    expect(r.accepted).toEqual([{ sourceKey: `${sp}a.pdf`, name: "a.pdf", destKey: `${pp}a.pdf` }]);
  });
  test("more than 20 keys rejects all", () => {
    const keys = Array.from({ length: 21 }, (_, i) => `${sp}f${i}`);
    const r = planPromote({ ...base, keys });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(21);
  });
  test("key outside session prefix rejected", () => {
    const r = planPromote({ ...base, keys: ["user_2/sessions/s/a.pdf"] });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });
  test("traversal rejected", () => {
    const r = planPromote({ ...base, keys: [`${sp}../x`] });
    expect(r.rejected).toHaveLength(1);
  });
  test("batch collision rejects both", () => {
    const r = planPromote({ ...base, keys: [`${sp}a.pdf`, `${sp}a.pdf`] });
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(2);
  });
  test("existing name clashes without overwrite", () => {
    const r = planPromote({ ...base, keys: [`${sp}a.pdf`], existingNames: ["a.pdf"] });
    expect(r.clashes).toEqual(["a.pdf"]);
    expect(r.accepted).toEqual([]);
  });
  test("existing name accepted with overwrite", () => {
    const r = planPromote({ ...base, keys: [`${sp}a.pdf`], existingNames: ["a.pdf"], overwrite: true });
    expect(r.accepted).toHaveLength(1);
    expect(r.clashes).toEqual([]);
  });
  test("exceeding the project cap rejects all", () => {
    const existingNames = Array.from({ length: MAX_PROJECT_FILES }, (_, i) => `e${i}`);
    const r = planPromote({ ...base, keys: [`${sp}new.pdf`], existingNames });
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0].reason).toContain("200");
  });
  test("an overwritten name does not count toward the 200 cap", () => {
    const existingNames = Array.from({ length: MAX_PROJECT_FILES }, (_, i) => `e${i}`);
    const r = planPromote({ ...base, keys: [`${sp}e3`], existingNames, overwrite: true });
    expect(r.accepted).toHaveLength(1);
  });
});
