import { mayResignStoredFileKey, parseStoredFileUrl, resolveFreshFileUrl } from "./stored-file-url";

const minio = { endpoint: "https://minio.api.example.com", bucket: "algi" };

describe("parseStoredFileUrl — recover bucket and key from a persisted (possibly expired) file URL", () => {
  it("parses a path-style presigned URL from the configured endpoint and bucket", () => {
    const url =
      "https://minio.api.example.com/algi/user_11/sessions/65da0131/image001.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20260825T105402Z&X-Amz-Expires=86400&X-Amz-Signature=abc";
    expect(parseStoredFileUrl(url, minio)).toEqual({ bucket: "algi", key: "user_11/sessions/65da0131/image001.png" });
  });

  it("decodes percent-encoded key segments", () => {
    const url = "https://minio.api.example.com/algi/user_11/sessions/x/IMG%20(1).jpg?X-Amz-Signature=abc";
    expect(parseStoredFileUrl(url, minio)?.key).toBe("user_11/sessions/x/IMG (1).jpg");
  });

  it("parses a virtual-host style AWS URL when no custom endpoint is configured", () => {
    const url = "https://algi.s3.eu-central-1.amazonaws.com/user_11/sessions/x/a.png?X-Amz-Signature=abc";
    expect(parseStoredFileUrl(url, { bucket: "algi" })).toEqual({ bucket: "algi", key: "user_11/sessions/x/a.png" });
  });

  it("ignores data URLs, other hosts and other buckets", () => {
    expect(parseStoredFileUrl("data:image/png;base64,iVBORw0KGgo=", minio)).toBeUndefined();
    expect(parseStoredFileUrl("https://cdn.example.org/algi/user_11/a.png", minio)).toBeUndefined();
    expect(parseStoredFileUrl("https://minio.api.example.com/other/user_11/a.png", minio)).toBeUndefined();
    expect(parseStoredFileUrl(undefined, minio)).toBeUndefined();
  });
});

describe("resolveFreshFileUrl — re-sign stored URLs so continued sessions can still fetch their files", () => {
  const stored = "https://minio.api.example.com/algi/user_11/sessions/x/a.png?X-Amz-Date=20260825T105402Z&X-Amz-Expires=86400";

  it("returns a freshly signed URL for the same object", async () => {
    const sign = jest.fn(async (bucket: string, key: string) => `https://minio.api.example.com/${bucket}/${key}?X-Amz-Date=NEW`);
    await expect(resolveFreshFileUrl(stored, { ...minio, sign, mayResign: () => true })).resolves.toBe(
      "https://minio.api.example.com/algi/user_11/sessions/x/a.png?X-Amz-Date=NEW",
    );
    expect(sign).toHaveBeenCalledWith("algi", "user_11/sessions/x/a.png");
  });

  it("leaves URLs it cannot attribute to the store untouched and never calls the signer", async () => {
    const sign = jest.fn();
    await expect(resolveFreshFileUrl("https://elsewhere.example/a.png", { ...minio, sign, mayResign: () => true })).resolves.toBe("https://elsewhere.example/a.png");
    expect(sign).not.toHaveBeenCalled();
  });

  it("falls back to the stored URL when signing fails", async () => {
    const sign = jest.fn(async () => { throw new Error("no credentials"); });
    await expect(resolveFreshFileUrl(stored, { ...minio, sign, mayResign: () => true })).resolves.toBe(stored);
  });
});

describe("resolveFreshFileUrl — only the session's own files are re-signed", () => {
  const url = (key: string) => `https://minio.api.example.com/algi/${key}?X-Amz-Date=20260825T105402Z&X-Amz-Signature=old`;
  const signer = () => jest.fn(async (bucket: string, key: string) => `https://minio.api.example.com/${bucket}/${key}?X-Amz-Date=NEW`);
  // Session owned by user 11; the speaker is user 11 unless said otherwise.
  const rule = (speaker: { id: number; type?: string } = { id: 11 }, s3prefix: string | null = "imp") =>
    (key: string) => mayResignStoredFileKey(key, { s3prefix, ownerId: 11, speaker });

  it("re-signs the speaker's own upload", async () => {
    const sign = signer();
    const out = await resolveFreshFileUrl(url("imp/user_11/a.png"), { ...minio, sign, mayResign: rule() });
    expect(out).toContain("X-Amz-Date=NEW");
    expect(sign).toHaveBeenCalledWith("algi", "imp/user_11/a.png");
  });

  it("re-signs the session owner's file when someone else speaks in a shared session", async () => {
    const sign = signer();
    const out = await resolveFreshFileUrl(url("imp/user_11/sessions/s/a.pdf"), { ...minio, sign, mayResign: rule({ id: 12 }) });
    expect(out).toContain("X-Amz-Date=NEW");
  });

  it("re-signs the speaker's upload in someone else's session, and user_api/ for an API speaker", async () => {
    expect(await resolveFreshFileUrl(url("imp/user_12/a.png"), { ...minio, sign: signer(), mayResign: rule({ id: 12 }) })).toContain("NEW");
    expect(await resolveFreshFileUrl(url("imp/user_api/a.png"), { ...minio, sign: signer(), mayResign: rule({ id: 26, type: "api" }) })).toContain("NEW");
    expect(await resolveFreshFileUrl(url("imp/user_api/a.png"), { ...minio, sign: signer(), mayResign: rule({ id: 12 }) })).not.toContain("NEW");
  });

  it("re-signs global/ files", async () => {
    expect(await resolveFreshFileUrl(url("imp/global/a.png"), { ...minio, sign: signer(), mayResign: rule() })).toContain("NEW");
  });

  it("leaves another user's file untouched and never signs it", async () => {
    const sign = signer();
    const stored = url("imp/user_99/secret.pdf");
    await expect(resolveFreshFileUrl(stored, { ...minio, sign, mayResign: rule() })).resolves.toBe(stored);
    expect(sign).not.toHaveBeenCalled();
  });

  it("leaves a project file untouched and never signs it", async () => {
    const sign = signer();
    const stored = url("imp/projects/0b5e/files/x.pdf");
    await expect(resolveFreshFileUrl(stored, { ...minio, sign, mayResign: rule() })).resolves.toBe(stored);
    expect(sign).not.toHaveBeenCalled();
  });

  it("leaves a foreign host untouched as before", async () => {
    const sign = signer();
    await expect(
      resolveFreshFileUrl("https://elsewhere.example/imp/user_11/a.png", { ...minio, sign, mayResign: rule() }),
    ).resolves.toBe("https://elsewhere.example/imp/user_11/a.png");
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("mayResignStoredFileKey", () => {
  const owner11 = { s3prefix: "imp", ownerId: 11, speaker: { id: 11 } };
  it("matches whole user segments, not id prefixes (user_1 is not user_11)", () => {
    expect(mayResignStoredFileKey("imp/user_1/a.png", { ...owner11 })).toBe(false);
    expect(mayResignStoredFileKey("imp/user_110/a.png", { ...owner11 })).toBe(false);
  });
  it("requires the configured general prefix", () => {
    expect(mayResignStoredFileKey("user_11/a.png", owner11)).toBe(false);
    expect(mayResignStoredFileKey("other/user_11/a.png", owner11)).toBe(false);
    expect(mayResignStoredFileKey("user_11/a.png", { ...owner11, s3prefix: null })).toBe(true);
  });
  it("refuses keys with a parent-directory segment", () => {
    expect(mayResignStoredFileKey("imp/user_11/../projects/p/files/x.pdf", owner11)).toBe(false);
  });
  it("without an owner or speaker only global/ remains", () => {
    expect(mayResignStoredFileKey("imp/global/a.png", { s3prefix: "imp" })).toBe(true);
    expect(mayResignStoredFileKey("imp/user_11/a.png", { s3prefix: "imp" })).toBe(false);
  });
});
