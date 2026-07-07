import { createSessionFileReadTool } from "./session-file-read-tool";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { User } from "@EXULU_TYPES/models/user";

jest.mock("@SRC/uppy", () => ({
  getPresignedUrl: jest.fn().mockResolvedValue("https://s3.example/presigned"),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getPresignedUrl } = require("@SRC/uppy") as { getPresignedUrl: jest.Mock };

const exuluConfig = {
  fileUploads: { s3Bucket: "bucket", s3prefix: "exulu" },
} as unknown as ExuluConfig;
const user = { id: 7 } as User;

const fileBody = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => fileBody } as never) as never;
});
afterEach(() => jest.clearAllMocks());

describe("createSessionFileReadTool", () => {
  it("returns undefined without a session or file-upload config", () => {
    expect(createSessionFileReadTool({ sessionID: undefined, user, exuluConfig })).toBeUndefined();
    expect(createSessionFileReadTool({ sessionID: "s1", user, exuluConfig: {} as ExuluConfig })).toBeUndefined();
  });

  it("reads a line range from the session file via a presigned URL", async () => {
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    const result = await (tool.tool!.execute as (i: unknown) => Promise<{ content: string; totalLines: number; offset: number; linesReturned: number }>)(
      { filename: "tool-output-web_search-abc12345.txt", offset: 10, limit: 3 },
    );
    expect(result.content).toBe("line 10\nline 11\nline 12");
    expect(result.totalLines).toBe(500);
    expect(result.offset).toBe(10);
    expect(result.linesReturned).toBe(3);
    expect(getPresignedUrl).toHaveBeenCalledWith(
      "bucket",
      "exulu/user_7/sessions/s1/tool-output-web_search-abc12345.txt",
      exuluConfig,
    );
  });

  it("defaults offset to 1 and limit to 250", async () => {
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    const result = await (tool.tool!.execute as (i: unknown) => Promise<{ content: string; linesReturned: number }>)({
      filename: "f.txt",
    });
    expect(result.content.startsWith("line 1\n")).toBe(true);
    expect(result.linesReturned).toBe(250);
  });

  it("rejects path traversal and returns an instructive error", async () => {
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    for (const filename of ["../secret", "a/b.txt", ""]) {
      const result = await (tool.tool!.execute as (i: unknown) => Promise<{ error?: string }>)({ filename });
      expect(result.error).toContain("Invalid filename");
    }
  });

  it("surfaces a read failure as an error object, not a throw", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 404 });
    const tool = createSessionFileReadTool({ sessionID: "s1", user, exuluConfig })!;
    const result = await (tool.tool!.execute as (i: unknown) => Promise<{ error?: string }>)({ filename: "gone.txt" });
    expect(result.error).toContain("404");
  });
});
