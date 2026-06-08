import { parseFindOutput, safeRelPath } from "./container-fs";

describe("safeRelPath", () => {
  it("accepts simple nested paths", () => {
    expect(safeRelPath("report.md")).toBe("report.md");
    expect(safeRelPath("out/sub/report.md")).toBe("out/sub/report.md");
    expect(safeRelPath("a//b")).toBe("a/b"); // collapses empties
  });

  it("rejects absolute / traversal / hidden paths", () => {
    expect(safeRelPath("/etc/passwd")).toBeUndefined();
    expect(safeRelPath("../escape")).toBeUndefined();
    expect(safeRelPath("a/../../b")).toBeUndefined();
    expect(safeRelPath(".hermes/config.json")).toBeUndefined();
    expect(safeRelPath("sub/.secret")).toBeUndefined();
    expect(safeRelPath("")).toBeUndefined();
  });
});

describe("parseFindOutput", () => {
  it("parses size/mtime/path, strips /root, hides dot paths, sorts newest first", () => {
    const out = [
      `120\t1780000000\t/root/older.txt`,
      `2048\t1780600000.5\t/root/sub/report.md`,
      `5\t1780600100\t/root/.hermes/config.json`, // hidden -> dropped
      ``,
    ].join("\n");

    const files = parseFindOutput(out);
    expect(files.map((f) => f.path)).toEqual(["sub/report.md", "older.txt"]);
    const report = files.find((f) => f.path === "sub/report.md")!;
    expect(report.name).toBe("report.md");
    expect(report.size).toBe(2048);
    expect(report.contentType).toBe("text/markdown");
    expect(typeof report.lastModified).toBe("string");
  });

  it("returns empty for empty output", () => {
    expect(parseFindOutput("")).toEqual([]);
  });

  it("strips a custom root dir (the discovered cwd)", () => {
    const out = `10\t1780000000\t/Users/daniel.claessen/notes.md`;
    const files = parseFindOutput(out, "/Users/daniel.claessen");
    expect(files[0]!.path).toBe("notes.md");
  });
});
