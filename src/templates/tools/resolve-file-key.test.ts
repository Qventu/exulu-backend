import { resolveFileKey } from "./resolve-file-key";
import { sessionFilePrefix } from "@SRC/exulu/session-files";
import { projectFilePrefix } from "@SRC/exulu/project-files";

const base = { ownerId: 7, sessionId: "s1", s3prefix: "exulu" };

describe("resolveFileKey", () => {
  it("keeps a plain name byte-equal to today's session key", () => {
    expect(resolveFileKey({ ...base, filename: "a.pdf", projectId: null })).toEqual({
      key: `${sessionFilePrefix(7, "s1", "exulu")}a.pdf`,
      scope: "session",
    });
    // a project id must not change what a plain name means
    expect(resolveFileKey({ ...base, filename: "a.pdf", projectId: "p1" })).toEqual({
      key: `${sessionFilePrefix(7, "s1", "exulu")}a.pdf`,
      scope: "session",
    });
  });

  it("maps project/<name> to the project key", () => {
    expect(resolveFileKey({ ...base, filename: "project/a.pdf", projectId: "p1" })).toEqual({
      key: `${projectFilePrefix("p1", "exulu").fullProjectPrefix}a.pdf`,
      scope: "project",
    });
  });

  it("refuses project/ without a resolved project", () => {
    expect(resolveFileKey({ ...base, filename: "project/a.pdf", projectId: null })).toEqual({
      error: "This session has no project files.",
    });
  });

  it("refuses traversal and nested forms", () => {
    for (const f of ["project/../x.pdf", "project/a/b.pdf", "../a.pdf", "a/b.pdf", "a\\b.pdf", "", "  ", "project/"]) {
      expect(resolveFileKey({ ...base, filename: f, projectId: "p1" })).toHaveProperty("error");
    }
  });
});
