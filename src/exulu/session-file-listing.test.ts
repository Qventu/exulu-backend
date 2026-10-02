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
