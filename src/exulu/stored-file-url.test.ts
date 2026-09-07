import { parseStoredFileUrl, resolveFreshFileUrl } from "./stored-file-url";

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
    await expect(resolveFreshFileUrl(stored, { ...minio, sign })).resolves.toBe(
      "https://minio.api.example.com/algi/user_11/sessions/x/a.png?X-Amz-Date=NEW",
    );
    expect(sign).toHaveBeenCalledWith("algi", "user_11/sessions/x/a.png");
  });

  it("leaves URLs it cannot attribute to the store untouched and never calls the signer", async () => {
    const sign = jest.fn();
    await expect(resolveFreshFileUrl("https://elsewhere.example/a.png", { ...minio, sign })).resolves.toBe("https://elsewhere.example/a.png");
    expect(sign).not.toHaveBeenCalled();
  });

  it("falls back to the stored URL when signing fails", async () => {
    const sign = jest.fn(async () => { throw new Error("no credentials"); });
    await expect(resolveFreshFileUrl(stored, { ...minio, sign })).resolves.toBe(stored);
  });
});
