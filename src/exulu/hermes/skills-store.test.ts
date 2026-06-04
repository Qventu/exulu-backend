import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteProfileSkill,
  isSafeSkillId,
  listProfileSkills,
  parseFrontmatter,
  readProfileSkill,
  writeProfileSkill,
} from "./skills-store";

const ORIGINAL_ENV = { ...process.env };
let home: string;

const skillDir = (profileId: string, id: string) =>
  join(home, "profiles", profileId, "skills", id);

const writeSkill = async (profileId: string, id: string, content: string) => {
  await mkdir(skillDir(profileId, id), { recursive: true });
  await writeFile(join(skillDir(profileId, id), "SKILL.md"), content, "utf8");
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hermes-skills-"));
  process.env.HERMES_HOME = home;
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await rm(home, { recursive: true, force: true });
});

describe("isSafeSkillId", () => {
  it("accepts simple ids, rejects traversal", () => {
    expect(isSafeSkillId("my-skill_1")).toBe(true);
    expect(isSafeSkillId("..")).toBe(false);
    expect(isSafeSkillId("a/b")).toBe(false);
    expect(isSafeSkillId("../etc")).toBe(false);
  });
});

describe("parseFrontmatter", () => {
  it("extracts flat key/values from YAML frontmatter", () => {
    const md = `---\nname: Summarize\ndescription: "Condense text"\nversion: 2\n---\n\nbody`;
    expect(parseFrontmatter(md)).toEqual({
      name: "Summarize",
      description: "Condense text",
      version: "2",
    });
  });
  it("returns empty for no frontmatter", () => {
    expect(parseFrontmatter("just text")).toEqual({});
  });
});

describe("listProfileSkills", () => {
  it("returns empty when the profile has no skills dir", async () => {
    expect(await listProfileSkills("agent-x")).toEqual([]);
  });

  it("lists skills with frontmatter, sorted by name, skipping dotfiles", async () => {
    await writeSkill("agent-1", "zeta", `---\nname: Zeta\ndescription: z\n---\nbody`);
    await writeSkill("agent-1", "alpha", `---\nname: Alpha\nversion: 1\n---\nbody`);
    // a dir without SKILL.md is ignored
    await mkdir(skillDir("agent-1", "no-md"), { recursive: true });

    const skills = await listProfileSkills("agent-1");
    expect(skills.map((s) => s.name)).toEqual(["Alpha", "Zeta"]);
    expect(skills[0]).toMatchObject({ id: "alpha", name: "Alpha", version: "1" });
    expect(skills[1]).toMatchObject({ id: "zeta", description: "z" });
    expect(typeof skills[0]!.updatedAt).toBe("string");
  });
});

describe("read/write/delete", () => {
  it("reads a skill's content", async () => {
    await writeSkill("agent-1", "s1", "hello");
    expect(await readProfileSkill("agent-1", "s1")).toBe("hello");
    expect(await readProfileSkill("agent-1", "missing")).toBeUndefined();
  });

  it("overwrites an existing skill, refuses a missing one", async () => {
    await writeSkill("agent-1", "s1", "old");
    await writeProfileSkill("agent-1", "s1", "new");
    expect(await readFile(join(skillDir("agent-1", "s1"), "SKILL.md"), "utf8")).toBe("new");
    await expect(writeProfileSkill("agent-1", "ghost", "x")).rejects.toBeDefined();
  });

  it("deletes a skill folder", async () => {
    await writeSkill("agent-1", "s1", "x");
    await deleteProfileSkill("agent-1", "s1");
    expect(await readProfileSkill("agent-1", "s1")).toBeUndefined();
    // deleting a missing skill is a no-op
    await expect(deleteProfileSkill("agent-1", "s1")).resolves.toBeUndefined();
  });
});
