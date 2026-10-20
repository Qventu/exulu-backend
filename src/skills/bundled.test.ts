import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import JSZip from "jszip";

import { collectBundledSkills, renderGenerated } from "../../scripts/generate-bundled-skills";
import { parseSkillFrontmatter } from "./frontmatter";

jest.mock("./bundle-extractor.ts", () => ({ extractBundleToVersion: jest.fn(async () => ({ filesCount: 1 })) }));

import { extractBundleToVersion } from "./bundle-extractor.ts";
import { BUNDLED_SKILLS } from "./bundled.generated.ts";
import { bundledSkillHash, bundledSkillZip, seedBundledSkills } from "./bundled";

const SOURCE_ROOT = join(__dirname, "bundled");

describe("bundled.generated.ts", () => {
  test("is in sync with src/skills/bundled/** (run npm run generate:bundled-skills)", () => {
    const fromDisk = collectBundledSkills(SOURCE_ROOT);
    expect(JSON.parse(JSON.stringify(BUNDLED_SKILLS))).toEqual(fromDisk);
    expect(renderGenerated(fromDisk)).toContain("BUNDLED_SKILLS");
  });

  test("every bundled skill is a directory with a SKILL.md whose frontmatter names it", async () => {
    const dirs = readdirSync(SOURCE_ROOT).filter((n) => statSync(join(SOURCE_ROOT, n)).isDirectory());
    expect(BUNDLED_SKILLS.map((s) => s.name)).toEqual(dirs.sort());
    for (const skill of BUNDLED_SKILLS) {
      const zip = await bundledSkillZip(skill);
      const meta = await parseSkillFrontmatter(zip);
      expect(meta.name).toBe(skill.name);
      expect((meta.description ?? "").length).toBeGreaterThan(40);
      const entries = Object.keys((await JSZip.loadAsync(zip)).files);
      expect(entries).toContain("SKILL.md");
    }
  });

  test("the hash follows the content", () => {
    const a = { name: "x", files: { "SKILL.md": "YQ==" } };
    const b = { name: "x", files: { "SKILL.md": "Yg==" } };
    expect(bundledSkillHash(a)).not.toBe(bundledSkillHash(b));
    expect(bundledSkillHash(a)).toBe(bundledSkillHash({ ...a }));
  });
});

function makeDb(rowsByName: Record<string, any>) {
  const inserted: any[] = [];
  const updated: Array<{ id: string; patch: any }> = [];
  const db: any = (table: string) => {
    expect(table).toBe("skills");
    let whereArg: any = null;
    const q: any = {
      where: (arg: any) => { whereArg = arg; return q; },
      first: async () => (whereArg?.name ? rowsByName[whereArg.name] : undefined),
      insert: async (row: any) => { inserted.push(row); },
      update: async (patch: any) => { updated.push({ id: whereArg.id, patch }); },
    };
    return q;
  };
  return { db, inserted, updated };
}

const config: any = { fileUploads: { s3Bucket: "b" } };
const skill = { name: "demo", files: { "SKILL.md": Buffer.from("---\nname: demo\ndescription: A demo skill for the seeder test.\n---\n# demo\n").toString("base64") } };
const log = () => {};

describe("seedBundledSkills", () => {
  beforeEach(() => (extractBundleToVersion as jest.Mock).mockClear());

  test("creates a public skill the first time", async () => {
    const { db, inserted } = makeDb({});
    const out = await seedBundledSkills({ db, config, skills: [skill], log });
    expect(out.created).toEqual(["demo"]);
    expect(inserted[0]).toMatchObject({ name: "demo", rights_mode: "public", created_by: null, current_version: 1, description: "A demo skill for the seeder test." });
    expect(JSON.parse(inserted[0].history)[0]).toMatchObject({ version: 1, source: "bundled", hash: bundledSkillHash(skill) });
    expect(extractBundleToVersion).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
  });

  test("leaves an unchanged bundled skill alone", async () => {
    const row = { id: "r1", name: "demo", current_version: 2, history: [{ version: 2, source: "bundled", hash: bundledSkillHash(skill) }] };
    const { db, updated } = makeDb({ demo: row });
    const out = await seedBundledSkills({ db, config, skills: [skill], log });
    expect(out.unchanged).toEqual(["demo"]);
    expect(updated).toEqual([]);
    expect(extractBundleToVersion).not.toHaveBeenCalled();
  });

  test("publishes a new version when the bundled content changed", async () => {
    const row = { id: "r1", name: "demo", current_version: 2, history: [{ version: 2, source: "bundled", hash: "old" }] };
    const { db, updated } = makeDb({ demo: row });
    const out = await seedBundledSkills({ db, config, skills: [skill], log });
    expect(out.updated).toEqual(["demo"]);
    expect(updated[0]).toMatchObject({ id: "r1", patch: expect.objectContaining({ current_version: 3 }) });
    expect(JSON.parse(updated[0]!.patch.history)).toHaveLength(2);
    expect(extractBundleToVersion).toHaveBeenCalledWith(expect.objectContaining({ skillId: "r1", version: 3 }));
  });

  test("never touches a skill of the same name that someone else created", async () => {
    const row = { id: "r9", name: "demo", current_version: 1, history: [{ version: 1, label: "Published from agent" }] };
    const { db, updated, inserted } = makeDb({ demo: row });
    const out = await seedBundledSkills({ db, config, skills: [skill], log });
    expect(out.skipped).toEqual(["demo"]);
    expect(updated).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test("does nothing without file-upload storage", async () => {
    const { db, inserted } = makeDb({});
    const out = await seedBundledSkills({ db, config: {} as any, skills: [skill], log });
    expect(out).toEqual({ created: [], updated: [], unchanged: [], skipped: [] });
    expect(inserted).toEqual([]);
  });
});
