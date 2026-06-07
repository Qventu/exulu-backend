const mockList = jest.fn();
const mockBytes = jest.fn();

jest.mock("../../uppy/index.ts", () => ({
  listS3ObjectsByPrefix: (...args: any[]) => mockList(...args),
  getS3ObjectBytes: (...args: any[]) => mockBytes(...args),
}));

import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exuluSkillsDir, syncProfileSkills } from "./skills-sync";

const ORIGINAL_ENV = { ...process.env };
let home: string;
const config: any = { fileUploads: {} };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hermes-sync-"));
  process.env.HERMES_HOME = home;
  mockList.mockReset();
  mockBytes.mockReset();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  await rm(home, { recursive: true, force: true });
});

describe("syncProfileSkills", () => {
  it("downloads each skill's S3 objects, preserving the <name>/SKILL.md layout", async () => {
    mockList.mockResolvedValue([
      { key: "skills/skill-a/v1/SKILL.md" },
      { key: "skills/skill-a/v1/scripts/run.py" },
    ]);
    mockBytes.mockImplementation(async (key: string) => Buffer.from(`bytes:${key}`));

    const dir = await syncProfileSkills(
      "agent-1",
      [{ id: "skill-a", name: "Skill A", current_version: 1 }],
      config,
    );

    expect(dir).toBe(exuluSkillsDir("agent-1"));
    expect(mockList).toHaveBeenCalledWith("skills/skill-a/v1/", config);
    const md = await readFile(join(dir!, "Skill A", "SKILL.md"), "utf8");
    expect(md).toContain("bytes:skills/skill-a/v1/SKILL.md");
    await expect(stat(join(dir!, "Skill A", "scripts", "run.py"))).resolves.toBeDefined();
  });

  it("is hash-gated: unchanged skills do not re-download", async () => {
    mockList.mockResolvedValue([{ key: "skills/skill-a/v1/SKILL.md" }]);
    mockBytes.mockResolvedValue(Buffer.from("x"));
    const skills = [{ id: "skill-a", name: "Skill A", current_version: 1 }];

    await syncProfileSkills("agent-1", skills, config);
    const callsAfterFirst = mockList.mock.calls.length;
    await syncProfileSkills("agent-1", skills, config);
    expect(mockList.mock.calls.length).toBe(callsAfterFirst); // no extra downloads
  });

  it("re-downloads when a skill version changes", async () => {
    mockList.mockResolvedValue([{ key: "skills/skill-a/v1/SKILL.md" }]);
    mockBytes.mockResolvedValue(Buffer.from("x"));
    await syncProfileSkills("agent-1", [{ id: "skill-a", name: "A", current_version: 1 }], config);
    const before = mockList.mock.calls.length;
    await syncProfileSkills("agent-1", [{ id: "skill-a", name: "A", current_version: 2 }], config);
    expect(mockList).toHaveBeenLastCalledWith("skills/skill-a/v2/", config);
    expect(mockList.mock.calls.length).toBeGreaterThan(before);
  });

  it("clears the dir and returns undefined when no skills are enabled", async () => {
    const dir = exuluSkillsDir("agent-1");
    await mkdir(join(dir, "Old Skill"), { recursive: true });
    await writeFile(join(dir, "Old Skill", "SKILL.md"), "stale", "utf8");

    const result = await syncProfileSkills("agent-1", [], config);
    expect(result).toBeUndefined();
    await expect(stat(dir)).rejects.toBeDefined(); // removed
    expect(mockList).not.toHaveBeenCalled();
  });
});
