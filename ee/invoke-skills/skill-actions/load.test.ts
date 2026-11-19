import { join } from "node:path";
import { declarationFromBytes, describeActions, loadSkillActions, type PinnedSkillActions } from "./load";

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

const sessionDir = "/tmp/exulu-sessions/s1";
const skill = (name: string, version = 1) => ({ id: `id-${name}`, name, current_version: version });
const pin = (name: string, bytes: string | undefined, version = 1): [string, PinnedSkillActions] => [
  `id-${name}`,
  {
    skillId: `id-${name}`,
    name,
    version,
    declaration: declarationFromBytes(bytes === undefined ? undefined : Buffer.from(bytes)),
  },
];

describe("declarationFromBytes", () => {
  it("no file is none, a valid one is ok, an invalid or oversized one is a problem", () => {
    expect(declarationFromBytes(undefined)).toEqual({ kind: "none" });
    expect(declarationFromBytes(Buffer.from(VALID)).kind).toBe("ok");
    expect(declarationFromBytes(Buffer.from("version: 2\n")).kind).toBe("problem");
    const big = declarationFromBytes(Buffer.from("#" + "x".repeat(70 * 1024)));
    expect(big).toEqual({ kind: "problem", error: expect.stringContaining("exceeds") });
  });
});

describe("loadSkillActions", () => {
  it("loads valid pins, reports invalid ones, ignores skills without a file", () => {
    const pinned = new Map([pin("a", VALID), pin("b", "version: 2\n"), pin("c", undefined)]);
    const loaded = loadSkillActions(sessionDir, [skill("a"), skill("b"), skill("c")], pinned);
    expect(Object.keys(loaded.bySkill)).toEqual(["a"]);
    expect(loaded.bySkill.a!.skillDir).toBe(join(sessionDir, "skills", "a"));
    expect(loaded.problems.map((p) => p.skill)).toEqual(["b"]);
    const text = describeActions(loaded);
    expect(text).toContain("a / export — Writes the workbook.");
    expect(text).toContain("  deal (item, context deals) — The deal");
    expect(text).toContain("  notes (text, optional)");
    expect(text).not.toContain("notes (text, optional) —");
    expect(text).toContain("  rows (items, context rows)");
    expect(text).toContain('skill "b": actions.yaml ignored —');
  });

  it("a skill with a path-like name and no actions.yaml contributes nothing and no problem", () => {
    const names = ["../x", "a/b", "a\\b", ".."];
    const pinned = new Map(names.map((n) => pin(n, undefined)));
    const loaded = loadSkillActions(sessionDir, names.map((n) => skill(n)), pinned);
    expect(loaded).toEqual({ bySkill: {}, problems: [] });
  });

  it("a skill with a path-like name that ships actions.yaml gets a problem, never actions", () => {
    const pinned = new Map([pin("a/b", VALID)]);
    const loaded = loadSkillActions(sessionDir, [skill("a/b")], pinned);
    expect(loaded.bySkill).toEqual({});
    expect(loaded.problems.map((p) => p.skill)).toEqual(["a/b"]);
  });

  it("only enabled skills with a pin of their current name and version contribute", () => {
    const pinned = new Map([pin("a", VALID, 1), pin("b", VALID), pin("old", VALID)]);
    const loaded = loadSkillActions(
      sessionDir,
      [skill("a", 2), skill("b"), { id: "id-old", name: "renamed", current_version: 1 }, skill("never-pinned")],
      pinned,
    );
    expect(Object.keys(loaded.bySkill)).toEqual(["b"]);
    expect(loaded.problems).toEqual([]);
  });

  it("describeActions is empty when nothing is declared", () => {
    expect(describeActions({ bySkill: {}, problems: [] })).toBe("");
  });
});
