import { parseSkillFrontmatter } from "./frontmatter";

describe("parseSkillFrontmatter", () => {
  it("reads name/description from a zip buffer's SKILL.md", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("my-skill/SKILL.md", "---\nname: my-skill\ndescription: hi\n---\n# body");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    expect(await parseSkillFrontmatter(bytes)).toEqual({ name: "my-skill", description: "hi" });
  });
  it("returns empty object when no SKILL.md", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("notes.txt", "hello");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    expect(await parseSkillFrontmatter(bytes)).toEqual({});
  });
});
