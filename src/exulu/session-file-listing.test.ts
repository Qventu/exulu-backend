import { describeSessionFiles } from "./session-file-listing";

const now = new Date("2026-09-11T10:00:00Z");
const min = (n: number) => new Date(now.getTime() - n * 60_000);

describe("describeSessionFiles — tell the model which documents exist before it searches elsewhere", () => {
  it("lists files newest first with size and age, and marks files added after the last answer", () => {
    const text = describeSessionFiles(
      [
        { name: "Angebot_26108736.pdf", size: 240_000, lastModified: min(180) },
        { name: "1200_LV-Auszug_MOD-Hydraulik_A025_T25.pdf", size: 119_626, lastModified: min(3) },
      ],
      { now, lastTurnAt: min(10) },
    );
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toBe("- 1200_LV-Auszug_MOD-Hydraulik_A025_T25.pdf (117 KB, 3 minutes ago) [NEW since your last answer]");
    expect(lines[1]).toBe("- Angebot_26108736.pdf (234 KB, 3 hours ago)");
    // A hint, not a priority rule: the user may want a knowledge-base search first.
    expect(text).not.toMatch(/before searching/i);
    expect(text).toMatch(/refers to one of these files|refers to .*document|attachment/i);
  });

  it("returns an empty string when there are no files", () => {
    expect(describeSessionFiles([], { now })).toBe("");
  });

  it("skips dependency trees and directory markers and caps the list", () => {
    const files = [
      { name: "venv/lib/python3.11/site-packages/docx/api.py", size: 10, lastModified: min(1) },
      { name: "out/", size: 0, lastModified: min(1) },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, size: 10, lastModified: min(i + 2) })),
    ];
    const text = describeSessionFiles(files, { now, max: 25 });
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(25);
    expect(text).not.toMatch(/site-packages/);
    expect(text).toMatch(/5 more file/);
  });
});

import { describeProjectFiles, sessionFilesScopeSentence, loadSessionFileListing } from "./session-file-listing";

describe("describeProjectFiles", () => {
  it("has the project header, the same cap and the NEW marker", () => {
    const files = Array.from({ length: 26 }, (_, i) => ({ name: `p${i}.pdf`, size: 2048, lastModified: min(i + 1) }));
    const text = describeProjectFiles(files, "Alpha", { now, lastTurnAt: min(1.5) });
    expect(text.split("\n")[0]).toBe("Project files (shared with everyone on project Alpha):");
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(25);
    expect(lines[0]).toBe("- p0.pdf (2 KB, 1 minute ago) [NEW since your last answer]");
    expect(lines[1]).not.toMatch(/NEW/);
    expect(text).toMatch(/\+1 more/);
    expect(text).toMatch(/project\/<name>/);
  });
  it("is empty without files", () => {
    expect(describeProjectFiles([], "Alpha", { now })).toBe("");
  });
});

describe("scope paragraph", () => {
  it("is byte-identical to the historical text without a project (snapshot)", () => {
    expect(sessionFilesScopeSentence(null)).toBe(
      "These files are scoped to\n        this single session; they are NOT visible in other sessions, projects, or knowledge bases.",
    );
  });
  it("names the project, the two scopes and the read-only rule with one", () => {
    const t = sessionFilesScopeSentence("Alpha");
    const order = ["private to this session", "shared with everyone on project Alpha", "`project/`", "read-only", "save_to_project", "sidebar"];
    let at = -1;
    for (const s of order) {
      const i = t.indexOf(s);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    expect(t).not.toMatch(/NOT visible in other sessions, projects/);
  });
});

jest.mock("@SRC/uppy", () => ({ listS3ObjectsByPrefix: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listS3ObjectsByPrefix } = require("@SRC/uppy") as { listS3ObjectsByPrefix: jest.Mock };
const cfg = { fileUploads: { s3Bucket: "b", s3prefix: "exulu" } } as never;

describe("loadSessionFileListing with a project", () => {
  beforeEach(() => listS3ObjectsByPrefix.mockReset());
  it("without a project lists once, exactly as before (snapshot)", async () => {
    listS3ObjectsByPrefix.mockResolvedValue([
      { key: "exulu/user_7/sessions/s1/a.pdf", size: 10, lastModified: new Date(Date.now() - 3 * 3600_000) },
    ]);
    const out = await loadSessionFileListing({ sessionID: "s1", ownerId: 7, exuluConfig: cfg });
    expect(listS3ObjectsByPrefix).toHaveBeenCalledTimes(1);
    expect(out).toBe(
      "Files currently in this session (newest first):\n- a.pdf (10 B, 3 hours ago)\n" +
        "These files are available to you. When the user refers to one of these files, to \"the document\" " +
        "or \"the attachment\", or asks something only such a file can answer, read it with parse_document, " +
        "view_document_page or read_session_file. Otherwise proceed as usual, e.g. with the knowledge bases.",
    );
  });
  it("adds the project block from the project prefix; a failing project listing is omitted", async () => {
    listS3ObjectsByPrefix.mockImplementation(async (p: string) =>
      p.startsWith("projects/")
        ? [{ key: "exulu/projects/p1/files/spec.pdf", size: 10, lastModified: new Date() }]
        : [],
    );
    const out = await loadSessionFileListing({ sessionID: "s1", ownerId: 7, exuluConfig: cfg, project: { id: "p1", name: "Alpha" } });
    expect(out).toMatch(/Project files \(shared with everyone on project Alpha\)/);
    expect(out).toMatch(/- spec\.pdf/);

    listS3ObjectsByPrefix.mockImplementation(async (p: string) => {
      if (p.startsWith("projects/")) throw new Error("boom");
      return [{ key: "exulu/user_7/sessions/s1/a.pdf", size: 10, lastModified: new Date() }];
    });
    const out2 = await loadSessionFileListing({ sessionID: "s1", ownerId: 7, exuluConfig: cfg, project: { id: "p1", name: "Alpha" } });
    expect(out2).toMatch(/a\.pdf/);
    expect(out2).not.toMatch(/Project files/);
  });
});
