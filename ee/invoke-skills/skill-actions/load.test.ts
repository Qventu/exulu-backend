import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSkillActions, describeActions } from "./load";

const VALID = `version: 1
actions:
  export:
    description: Writes the workbook.
    run: python export.py
    inputs:
      deal:
        type: item
        context: deals
        description: The deal
      notes:
        type: text
        required: false
      rows:
        type: items
        context: rows
`;

describe("loadSkillActions", () => {
  let root: string;
  let sessionDir: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-actions-"));
    sessionDir = path.join(root, "session");
    outside = path.join(root, "outside.yaml");
    await fs.mkdir(path.join(sessionDir, "skills"), { recursive: true });
    await fs.writeFile(outside, VALID);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const skillDir = (n: string) => path.join(sessionDir, "skills", n);

  it("loads valid skills, reports invalid and unsafe ones, ignores missing", async () => {
    await fs.mkdir(skillDir("a"), { recursive: true });
    await fs.writeFile(path.join(skillDir("a"), "actions.yaml"), VALID);
    await fs.mkdir(skillDir("b"), { recursive: true });
    await fs.writeFile(path.join(skillDir("b"), "actions.yaml"), "version: 2\n");
    await fs.mkdir(skillDir("c"), { recursive: true });
    await fs.mkdir(skillDir("d"), { recursive: true });
    await fs.symlink(outside, path.join(skillDir("d"), "actions.yaml"));

    const loaded = await loadSkillActions(sessionDir, [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }]);
    expect(Object.keys(loaded.bySkill)).toEqual(["a"]);
    expect(loaded.bySkill.a!.skillDir).toBe(skillDir("a"));
    expect(loaded.problems.map((p) => p.skill).sort()).toEqual(["b", "d"]);
    const text = describeActions(loaded);
    expect(text).toContain("a / export — Writes the workbook.");
    expect(text).toContain("  deal (item, context deals) — The deal");
    expect(text).toContain("  notes (text, optional)");
    expect(text).not.toContain("notes (text, optional) —");
    expect(text).toContain("  rows (items, context rows)");
    expect(text).toContain('skill "b": actions.yaml ignored —');
  });

  it("rejects hostile names without reading", async () => {
    const loaded = await loadSkillActions(sessionDir, [{ name: "../x" }, { name: "a/b" }, { name: ".." }, { name: "" }]);
    expect(loaded.bySkill).toEqual({});
    expect(loaded.problems).toHaveLength(4);
  });

  it("flags an oversized file", async () => {
    await fs.mkdir(skillDir("big"), { recursive: true });
    await fs.writeFile(path.join(skillDir("big"), "actions.yaml"), "#" + "x".repeat(70 * 1024));
    const loaded = await loadSkillActions(sessionDir, [{ name: "big" }]);
    expect(loaded.problems.map((p) => p.skill)).toEqual(["big"]);
  });

  it("describeActions is empty when nothing is declared", () => {
    expect(describeActions({ bySkill: {}, problems: [] })).toBe("");
  });
});
