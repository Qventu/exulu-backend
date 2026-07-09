// jest.mock calls are hoisted by ts-jest, so they run before imports.
jest.mock("../uppy/index.ts", () => ({
  uploadFile: jest.fn().mockResolvedValue(undefined),
}));

import JSZip from "jszip";
import { extractBundleToVersion } from "./bundle-extractor";
import { uploadFile } from "../uppy/index.ts";

const mockUploadFile = uploadFile as jest.MockedFunction<typeof uploadFile>;

/** Build a minimal valid zip with SKILL.md at root (wrapped in a folder). */
async function buildValidSkillZip(wrapperName = "my-skill"): Promise<Buffer> {
  const JSZipModule = (await import("jszip")).default;
  const zip = new JSZipModule();
  zip.file(`${wrapperName}/SKILL.md`, "---\nname: my-skill\ndescription: test\n---\n# body");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractBundleToVersion", () => {
  beforeEach(() => {
    mockUploadFile.mockClear();
  });

  it("writes SKILL.md to the versioned prefix (v2)", async () => {
    const bytes = await buildValidSkillZip();
    const skillId = "test-skill-id";
    const config = {} as any;

    const result = await extractBundleToVersion({ bytes, skillId, version: 2, config });

    expect(result.filesCount).toBe(1);

    // uploadFile must have been called with the v2 prefix
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const [, s3Key] = mockUploadFile.mock.calls[0]!;
    expect(s3Key).toBe(`skills/${skillId}/v2/SKILL.md`);
  });

  it("writes to the correct prefix for arbitrary version numbers", async () => {
    const JSZipModule = (await import("jszip")).default;
    const zip = new JSZipModule();
    zip.file("skill/SKILL.md", "# hi");
    zip.file("skill/tool.py", "pass");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const skillId = "abc-123";
    const config = {} as any;

    await extractBundleToVersion({ bytes, skillId, version: 5, config });

    const keys = mockUploadFile.mock.calls.map(([, k]) => k);
    expect(keys).toContain(`skills/${skillId}/v5/SKILL.md`);
    expect(keys).toContain(`skills/${skillId}/v5/tool.py`);
    expect(keys.every((k) => k.startsWith(`skills/${skillId}/v5/`))).toBe(true);
  });
});
