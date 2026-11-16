import { loadFilePartBytes } from "./file-part-fetch";

const store = { endpoint: "https://minio.api.example.com", bucket: "algi" };
const bucketUrl = "https://minio.api.example.com/algi/items/ctx_1/manual.pdf?X-Amz-Signature=abc";

function bodyResponse(bytes: Buffer, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(new Uint8Array(bytes), { status: init.status ?? 200, headers: init.headers });
}

describe("loadFilePartBytes — never fetch arbitrary user-supplied URLs", () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it.each([
    ["foreign host", "https://evil.example.org/algi/x.pdf"],
    ["other bucket on the storage host", "https://minio.api.example.com/other/x.pdf"],
    ["internal address", "http://169.254.169.254/latest/meta-data/"],
    ["other scheme", "file:///etc/passwd"],
  ])("does not fetch a %s and returns the error text", async (_label, url) => {
    const result = await loadFilePartBytes(url, "x.pdf", { store, fetchUrl: url });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: "[Error: Could not load file x.pdf: only files from this workspace's storage can be attached.]",
    });
  });

  it("refuses everything but data: when no storage is configured", async () => {
    const result = await loadFilePartBytes(bucketUrl, "x.pdf", { store: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("fetches a URL on the configured bucket (original URL when not re-signed), without following redirects and with a timeout", async () => {
    fetchMock.mockResolvedValue(bodyResponse(Buffer.from("pdf-bytes")));
    const result = await loadFilePartBytes(bucketUrl, "manual.pdf", { store, fetchUrl: bucketUrl });
    expect(result).toEqual({ ok: true, bytes: Buffer.from("pdf-bytes") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(bucketUrl);
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fetches the re-signed URL when one is given", async () => {
    const fresh = "https://minio.api.example.com/algi/user_1/a.pdf?X-Amz-Signature=fresh";
    fetchMock.mockResolvedValue(bodyResponse(Buffer.from("ok")));
    await loadFilePartBytes("https://minio.api.example.com/algi/user_1/a.pdf?X-Amz-Signature=old", "a.pdf", {
      store,
      fetchUrl: fresh,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(fresh);
  });

  it("decodes data: URLs locally", async () => {
    const b64 = await loadFilePartBytes(`data:text/plain;base64,${Buffer.from("hello").toString("base64")}`, "a.txt", { store });
    expect(b64).toEqual({ ok: true, bytes: Buffer.from("hello") });
    const plain = await loadFilePartBytes("data:text/plain,hi%20there", "b.txt", { store });
    expect(plain).toEqual({ ok: true, bytes: Buffer.from("hi there") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }));
    const result = await loadFilePartBytes(bucketUrl, "manual.pdf", { store, fetchUrl: bucketUrl });
    expect(result).toEqual({ ok: false, error: "[Error: Could not load file manual.pdf: redirects are not followed.]" });
  });

  it("reports a refused redirect (fetch rejects under redirect: error) as an error text", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await loadFilePartBytes(bucketUrl, "manual.pdf", { store, fetchUrl: bucketUrl });
    expect(result).toEqual({ ok: false, error: "[Error: Could not load file manual.pdf: the download failed.]" });
  });

  it("refuses an oversize body by declared length", async () => {
    fetchMock.mockResolvedValue(bodyResponse(Buffer.alloc(10), { headers: { "content-length": "999999999" } }));
    const result = await loadFilePartBytes(bucketUrl, "big.pdf", { store, fetchUrl: bucketUrl, maxBytes: 1024 * 1024 });
    expect(result).toEqual({ ok: false, error: "[Error: Could not load file big.pdf: the file is larger than the 1MB attachment limit.]" });
  });

  it("refuses an oversize streamed body without a content-length", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(big.subarray(0, 1024 * 1024)));
        controller.enqueue(new Uint8Array(big.subarray(1024 * 1024)));
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    const result = await loadFilePartBytes(bucketUrl, "big.pdf", { store, fetchUrl: bucketUrl, maxBytes: 1024 * 1024 });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("larger than the 1MB attachment limit");
  });
});
