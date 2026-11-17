import {
  writeSessionFile,
  buildSaveSessionFile,
  SAVE_INVALID_NAME,
  SAVE_EMPTY,
  SAVE_TOO_LARGE,
  SAVE_FAILED,
} from "./session-file-write";
import { MAX_ADOPT_UPLOAD_BYTES } from "./session-file-adopt";

jest.mock("@SRC/uppy", () => ({ uploadFile: jest.fn(async () => "ok") }));

const bytes = (n: number) => new Uint8Array(n).fill(1);

function setup(putImpl?: () => Promise<void>) {
  const calls: Array<{ key: string; size: number; contentType: string }> = [];
  const put = jest.fn(async (key: string, data: Uint8Array | Buffer, contentType: string) => {
    calls.push({ key, size: data.length, contentType });
    if (putImpl) await putImpl();
  });
  const write = (name: string, data: Uint8Array | Buffer = bytes(3)) =>
    writeSessionFile({ ownerId: 7, sessionId: "s1", file: { name, data }, put });
  return { calls, put, write };
}

describe("writeSessionFile", () => {
  it("writes under user_<owner>/sessions/<session>/<name>", async () => {
    const { calls, write } = setup();
    expect(await write("a.pdf")).toEqual({ name: "a.pdf" });
    expect(calls[0].key).toBe("user_7/sessions/s1/a.pdf");
  });

  it("replaces path separators", async () => {
    const { calls, write } = setup();
    expect(await write("a/b\\c.pdf")).toEqual({ name: "a_b_c.pdf" });
    expect(calls[0].key).toBe("user_7/sessions/s1/a_b_c.pdf");
  });

  it("refuses '..' and blank names", async () => {
    const { put, write } = setup();
    expect(await write("../x.pdf")).toEqual({ error: SAVE_INVALID_NAME });
    expect(await write("   ")).toEqual({ error: SAVE_INVALID_NAME });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses empty data", async () => {
    const { put, write } = setup();
    expect(await write("a.pdf", bytes(0))).toEqual({ error: SAVE_EMPTY });
    expect(put).not.toHaveBeenCalled();
  });

  it("refuses more than 50 MB but writes exactly 50 MB", async () => {
    const { put, write } = setup();
    expect(await write("a.pdf", bytes(MAX_ADOPT_UPLOAD_BYTES + 1))).toEqual({ error: SAVE_TOO_LARGE });
    expect(put).not.toHaveBeenCalled();
    expect(await write("a.pdf", bytes(MAX_ADOPT_UPLOAD_BYTES))).toEqual({ name: "a.pdf" });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("reports a failed put without throwing", async () => {
    const { write } = setup(async () => {
      throw new Error("s3 down");
    });
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await write("a.pdf")).toEqual({ error: SAVE_FAILED });
    errSpy.mockRestore();
  });

  it("content type follows the extension", async () => {
    const { calls, write } = setup();
    await write("a.pdf");
    await write("a.unknownext");
    await write("noext");
    expect(calls.map((c) => c.contentType)).toEqual([
      "application/pdf",
      "application/octet-stream",
      "application/octet-stream",
    ]);
  });
});

describe("buildSaveSessionFile", () => {
  const s3 = { s3endpoint: "e", s3key: "k", s3secret: "s", s3Bucket: "b" };
  const base = {
    sessionID: "s1",
    user: { id: 5 },
    req: { headers: {} },
    exuluConfig: { fileUploads: s3 } as never,
    inRoutineRun: false,
  };

  it("returns a function when everything holds", () => {
    expect(typeof buildSaveSessionFile(base)).toBe("function");
  });

  it("is undefined without a sessionID", () => {
    expect(buildSaveSessionFile({ ...base, sessionID: undefined })).toBeUndefined();
  });

  it.each(["s3endpoint", "s3key", "s3secret", "s3Bucket"])("is undefined without %s", (field) => {
    const fileUploads = { ...s3, [field]: undefined };
    expect(buildSaveSessionFile({ ...base, exuluConfig: { fileUploads } as never })).toBeUndefined();
    expect(buildSaveSessionFile({ ...base, exuluConfig: undefined })).toBeUndefined();
  });

  it("is undefined without a user id", () => {
    expect(buildSaveSessionFile({ ...base, user: {} })).toBeUndefined();
    expect(buildSaveSessionFile({ ...base, user: undefined })).toBeUndefined();
  });

  it("is undefined on the public surface", () => {
    expect(buildSaveSessionFile({ ...base, req: { headers: { "x-public-surface": "1" } } })).toBeUndefined();
  });

  it("is undefined inside a routine run", () => {
    expect(buildSaveSessionFile({ ...base, inRoutineRun: true })).toBeUndefined();
  });

  it("writes with ownerId, falling back to user.id, via uploadFile with global true", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { uploadFile } = require("@SRC/uppy") as { uploadFile: jest.Mock };
    uploadFile.mockClear();
    const withOwner = buildSaveSessionFile({ ...base, ownerId: 9 })!;
    expect(await withOwner({ name: "a.pdf", data: bytes(2) })).toEqual({ name: "a.pdf" });
    expect(uploadFile.mock.calls[0][1]).toBe("user_9/sessions/s1/a.pdf");
    expect(uploadFile.mock.calls[0][3]).toEqual({ contentType: "application/pdf" });
    expect(uploadFile.mock.calls[0][6]).toBe(true);

    const fallback = buildSaveSessionFile(base)!;
    await fallback({ name: "b.pdf", data: bytes(2) });
    expect(uploadFile.mock.calls[1][1]).toBe("user_5/sessions/s1/b.pdf");
  });
});
