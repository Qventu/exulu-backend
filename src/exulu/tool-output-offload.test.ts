import { guardToolOutput, guardExtractedFileText, type TruncatedToolOutput } from "./tool-output-offload";
import type { ExuluConfig } from "./app";
import type { User } from "@EXULU_TYPES/models/user";

jest.mock("@SRC/uppy", () => ({
  uploadFile: jest.fn().mockResolvedValue("bucket/prefix/user_1/sessions/s1/whatever.txt"),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadFile } = require("@SRC/uppy") as { uploadFile: jest.Mock };

const exuluConfig = { fileUploads: { s3Bucket: "b", s3key: "k", s3secret: "s", s3endpoint: "e" } } as unknown as ExuluConfig;
const user = { id: 1 } as User;
const baseCtx = { toolName: "web_search", contextWindow: 128_000, sessionID: "s1", user, exuluConfig };

afterEach(() => jest.clearAllMocks());

describe("guardToolOutput", () => {
  it("passes small outputs through untouched (string and object)", async () => {
    await expect(guardToolOutput("small", baseCtx)).resolves.toBe("small");
    const obj = { result: "ok" };
    await expect(guardToolOutput(obj, baseCtx)).resolves.toBe(obj);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it("offloads an oversized output to a session file and returns preview + notice", async () => {
    // 128K window → cap 12,800 tokens → 51,200 chars. Make it bigger.
    const big = "x".repeat(80_000);
    const guarded = (await guardToolOutput(big, baseCtx)) as TruncatedToolOutput;
    expect(guarded.truncated).toBe(true);
    expect(guarded.sessionFile).toMatch(/^tool-output-web_search-[a-f0-9]{8}\.txt$/);
    expect(guarded.notice).toContain("read_session_file");
    expect(guarded.notice).toContain(guarded.sessionFile!);
    expect(guarded.preview.length).toBeLessThanOrEqual(4_000);
    expect(uploadFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/^sessions\/s1\/tool-output-web_search-[a-f0-9]{8}\.txt$/),
      exuluConfig,
      { contentType: "text/plain" },
      1,
    );
  });

  it("serializes non-string outputs before measuring and storing", async () => {
    const big = { rows: "y".repeat(80_000) };
    const guarded = (await guardToolOutput(big, baseCtx)) as TruncatedToolOutput;
    expect(guarded.truncated).toBe(true);
    const stored = (uploadFile.mock.calls[0]![0] as Buffer).toString("utf-8");
    expect(stored).toBe(JSON.stringify(big));
  });

  it("degrades to discard-notice when storage is unavailable or fails", async () => {
    const big = "x".repeat(80_000);
    // No sessionID → no storage attempted.
    const noSession = (await guardToolOutput(big, { ...baseCtx, sessionID: undefined })) as TruncatedToolOutput;
    expect(noSession.sessionFile).toBeUndefined();
    expect(noSession.notice).toContain("discarded");
    // Upload throws → same degraded result, no crash.
    uploadFile.mockRejectedValueOnce(new Error("s3 down"));
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = (await guardToolOutput(big, baseCtx)) as TruncatedToolOutput;
      expect(failed.sessionFile).toBeUndefined();
      expect(failed.truncated).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("passes null/undefined through", async () => {
    await expect(guardToolOutput(null, baseCtx)).resolves.toBeNull();
    await expect(guardToolOutput(undefined, baseCtx)).resolves.toBeUndefined();
  });

  it("passes circular (unserializable) objects through unchanged", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const circular: any = {};
    circular.self = circular;
    const result = await guardToolOutput(circular, baseCtx);
    expect(result).toBe(circular); // same reference, no crash
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe("guardExtractedFileText", () => {
  it("returns the original text when under the cap", async () => {
    await expect(guardExtractedFileText("a.odt", "short doc", baseCtx)).resolves.toBe("short doc");
  });

  it("offloads oversized document text and returns preview + pointer notice", async () => {
    const big = "z".repeat(80_000);
    const result = await guardExtractedFileText("bericht.odt", big, baseCtx);
    expect(result.length).toBeLessThan(big.length);
    expect(result).toContain("read_session_file");
    expect(result).toContain("bericht.odt");
    expect(uploadFile).toHaveBeenCalled();
  });
});
