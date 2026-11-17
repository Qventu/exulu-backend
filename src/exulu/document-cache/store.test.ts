import { createHash } from "crypto";
import { readThroughDocument, countPageMarkers, type StoreIo, type Extracted } from "./store";
import { contentKey, pointerKey } from "./keys";
import type { ProgressFn } from "./progress";

jest.mock("@SRC/uppy", () => ({
  getS3ObjectBytesWithInfo: jest.fn(),
  getS3ObjectTextExact: jest.fn(),
  headS3ObjectExact: jest.fn(),
  putS3ObjectTextExact: jest.fn(),
}));

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const fp = { id: "fp1", label: "pdftotext@1" };
const T0 = new Date("2026-01-01T00:00:00Z");

const LM = new Date("2025-12-31T00:00:00Z");
function fakeIo(files: Record<string, Buffer>, etags: Record<string, string> = {}) {
  const texts = new Map<string, { text: string; lastModified: Date; metadata?: Record<string, string> }>();
  const info = (key: string) => ({ etag: etags[key] ?? `"e-${key}"`, lastModified: LM, size: files[key].length });
  const io = {
    head: jest.fn(async (key: string) => (key in files ? info(key) : null)),
    getBytes: jest.fn(async (key: string) => ({ bytes: files[key], ...info(key) })),
    getText: jest.fn(async (key: string) => {
      const t = texts.get(key);
      return t ? { text: t.text, lastModified: t.lastModified, metadata: t.metadata ?? {} } : null;
    }),
    putText: jest.fn(async (key: string, text: string, metadata: Record<string, string>) => {
      texts.set(key, { text, lastModified: T0, metadata });
    }),
  };
  return { io: io as StoreIo & typeof io, texts };
}

const base = (io: StoreIo, extract: jest.Mock, over: Record<string, unknown> = {}) => ({
  io,
  bucket: "bkt",
  sourceKey: "pre/user_1/a.pdf",
  s3prefix: "pre",
  fingerprint: fp,
  cacheDays: 365,
  now: () => T0,
  extract,
  ...over,
});
const ok = (text = "--- page 1 ---\nhello\n--- page 2 ---\nworld"): Extracted => ({ text, totalPages: 2, storable: true });

describe("readThroughDocument", () => {
  const bytes = Buffer.from("pdf-bytes");

  it("miss extracts once and writes text and pointer; second call is served without bytes or extract", async () => {
    const { io, texts } = fakeIo({ "pre/user_1/a.pdf": bytes });
    const extract = jest.fn(async () => ok());
    const first = await readThroughDocument(base(io, extract));
    expect(first).toEqual({ text: ok().text, totalPages: 2, fromStore: false });
    const textKey = contentKey(sha(bytes), fp.id, "pre");
    expect(texts.get(textKey)?.metadata).toEqual({ "exulu-extractor": "pdftotext@1", "exulu-pages": "2" });
    const ptr = JSON.parse(texts.get(pointerKey("bkt", "pre/user_1/a.pdf", "pre"))!.text);
    expect(ptr).toEqual({
      etag: '"e-pre/user_1/a.pdf"',
      lastModified: LM.toISOString(),
      size: bytes.length,
      sha256: sha(bytes),
    });

    io.getBytes.mockClear();
    const second = await readThroughDocument(base(io, extract));
    expect(second).toEqual({ text: ok().text, totalPages: 2, fromStore: true });
    expect(io.getBytes).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("a pointer with another etag fetches and hashes the bytes; same content is a hit without extract", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes }, { "pre/user_1/a.pdf": '"v1"' });
    const extract = jest.fn(async () => ok());
    await readThroughDocument(base(io, extract));
    io.head.mockResolvedValue({ etag: '"v2"', lastModified: LM, size: bytes.length });
    io.getBytes.mockResolvedValue({ bytes, etag: '"v2"', lastModified: LM, size: bytes.length });
    const again = await readThroughDocument(base(io, extract));
    expect(again.fromStore).toBe(true);
    expect(io.getBytes).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("the same bytes under a different sourceKey hit", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes, "pre/user_2/b.pdf": bytes });
    const extract = jest.fn(async () => ok());
    await readThroughDocument(base(io, extract));
    const other = await readThroughDocument(base(io, extract, { sourceKey: "pre/user_2/b.pdf" }));
    expect(other.fromStore).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("a different fingerprint misses", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    const extract = jest.fn(async () => ok());
    await readThroughDocument(base(io, extract));
    await readThroughDocument(base(io, extract, { fingerprint: { id: "fp2", label: "other" } }));
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("an entry older than cacheDays is extracted again and overwritten", async () => {
    const { io, texts } = fakeIo({ "pre/user_1/a.pdf": bytes });
    const extract = jest.fn().mockResolvedValueOnce(ok("old")).mockResolvedValueOnce(ok("new"));
    await readThroughDocument(base(io, extract));
    const later = () => new Date(T0.getTime() + 366 * 86_400_000);
    const res = await readThroughDocument(base(io, extract, { now: later }));
    expect(res).toMatchObject({ text: "new", fromStore: false });
    expect(texts.get(contentKey(sha(bytes), fp.id, "pre"))!.text).toBe("new");
    const within = () => new Date(T0.getTime() + 364 * 86_400_000);
    expect((await readThroughDocument(base(io, extract, { now: within }))).fromStore).toBe(true);
  });

  it("cacheDays 0 reads nothing from and writes nothing to the store", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    const extract = jest.fn(async () => ok());
    await readThroughDocument(base(io, extract, { cacheDays: 0 }));
    await readThroughDocument(base(io, extract, { cacheDays: 0 }));
    expect(io.head).not.toHaveBeenCalled();
    expect(io.getText).not.toHaveBeenCalled();
    expect(io.putText).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("storable false is returned but not stored", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    const extract = jest.fn(async () => ({ ...ok(), storable: false }));
    const first = await readThroughDocument(base(io, extract));
    expect(first.text).toBe(ok().text);
    expect(io.putText).not.toHaveBeenCalled();
    await readThroughDocument(base(io, extract));
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("a throwing extract stores nothing, clears the in-flight entry and the next call extracts", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    const extract = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(ok());
    await expect(readThroughDocument(base(io, extract))).rejects.toThrow("boom");
    expect(io.putText).not.toHaveBeenCalled();
    const res = await readThroughDocument(base(io, extract));
    expect(res.text).toBe(ok().text);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("two concurrent calls share one extraction and both receive progress", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const extract = jest.fn(async (_b: Buffer, onProgress?: ProgressFn) => {
      await gate;
      onProgress?.({ phase: "text", pagesDone: 1, pagesTotal: 2 });
      return ok();
    });
    const p1: ProgressFn = jest.fn();
    const p2: ProgressFn = jest.fn();
    const a = readThroughDocument(base(io, extract, { onProgress: p1 }));
    const b = readThroughDocument(base(io, extract, { onProgress: p2 }));
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(ra.text).toBe(ok().text);
    expect(rb.text).toBe(ok().text);
    expect(p1).toHaveBeenCalledWith({ phase: "text", pagesDone: 1, pagesTotal: 2 });
    expect(p2).toHaveBeenCalledWith({ phase: "text", pagesDone: 1, pagesTotal: 2 });
  });

  it("a rejecting putText still returns the result and warns once", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    io.putText.mockRejectedValue(new Error("s3 down"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await readThroughDocument(base(io, jest.fn(async () => ok())));
    expect(res.text).toBe(ok().text);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a failing store read degrades to a miss with a warning", async () => {
    const { io } = fakeIo({ "pre/user_1/a.pdf": bytes });
    io.getText.mockRejectedValue(new Error("throttled"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const extract = jest.fn(async () => ok());
    const res = await readThroughDocument(base(io, extract));
    expect(res.fromStore).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("pointer integrity", () => {
  const bytes = Buffer.from("pdf-bytes");
  const other = Buffer.from("other-bytes");
  const SRC = "pre/user_1/a.pdf";
  const meta = (b: Buffer, lm = LM, etag = '"same"') => ({ etag, lastModified: lm, size: b.length });

  it("a same-ETag overwrite with another lastModified is re-hashed and its new content served", async () => {
    const { io } = fakeIo({ [SRC]: bytes });
    io.head.mockResolvedValue(meta(bytes));
    io.getBytes.mockResolvedValue({ bytes, ...meta(bytes) });
    const extract = jest.fn(async (b: Buffer) => ok(b.toString()));
    expect((await readThroughDocument(base(io, extract))).text).toBe("pdf-bytes");
    const later = new Date(LM.getTime() + 5000);
    io.head.mockResolvedValue(meta(other, later));
    io.getBytes.mockResolvedValue({ bytes: other, ...meta(other, later) });
    const res = await readThroughDocument(base(io, extract));
    expect(res).toMatchObject({ text: "other-bytes", fromStore: false });
    expect(io.getBytes).toHaveBeenCalledTimes(2);
  });

  it("a different size alone also invalidates the pointer", async () => {
    const { io } = fakeIo({ [SRC]: bytes });
    io.head.mockResolvedValue(meta(bytes));
    io.getBytes.mockResolvedValue({ bytes, ...meta(bytes) });
    const extract = jest.fn(async (b: Buffer) => ok(b.toString()));
    await readThroughDocument(base(io, extract));
    io.head.mockResolvedValue({ ...meta(bytes), size: bytes.length + 1 });
    await readThroughDocument(base(io, extract));
    expect(io.getBytes).toHaveBeenCalledTimes(2);
  });

  it("a pointer in the old two-field shape is treated as absent", async () => {
    const { io, texts } = fakeIo({ [SRC]: bytes });
    const extract = jest.fn(async () => ok());
    await readThroughDocument(base(io, extract));
    texts.set(pointerKey("bkt", SRC, "pre"), {
      text: JSON.stringify({ etag: `"e-${SRC}"`, sha256: sha(bytes) }),
      lastModified: T0,
    });
    io.getBytes.mockClear();
    const res = await readThroughDocument(base(io, extract));
    expect(io.getBytes).toHaveBeenCalledTimes(1);
    expect(res.fromStore).toBe(true);
  });

  it("when HEAD and GET disagree the pointer is written from the GET's values", async () => {
    const { io, texts } = fakeIo({ [SRC]: bytes });
    io.head.mockResolvedValue(meta(other, new Date(LM.getTime() - 1000), '"headetag"'));
    io.getBytes.mockResolvedValue({ bytes, ...meta(bytes, LM, '"getetag"') });
    await readThroughDocument(base(io, jest.fn(async () => ok())));
    const ptr = JSON.parse(texts.get(pointerKey("bkt", SRC, "pre"))!.text);
    expect(ptr).toEqual({ etag: '"getetag"', lastModified: LM.toISOString(), size: bytes.length, sha256: sha(bytes) });
  });

  it("no pointer is written when the GET reports no ETag", async () => {
    const { io, texts } = fakeIo({ [SRC]: bytes });
    io.getBytes.mockResolvedValue({ bytes, etag: null, lastModified: LM, size: bytes.length });
    await readThroughDocument(base(io, jest.fn(async () => ok())));
    expect(texts.has(pointerKey("bkt", SRC, "pre"))).toBe(false);
  });
});

describe("page count in object metadata", () => {
  const bytes = Buffer.from("pdf-bytes");
  const SRC = "pre/user_1/a.pdf";

  it("a hit returns the stored count even when the text has no markers (one-page document)", async () => {
    const { io } = fakeIo({ [SRC]: bytes });
    const extract = jest.fn(async () => ({ text: "just one page", totalPages: 1, storable: true }));
    await readThroughDocument(base(io, extract));
    const hit = await readThroughDocument(base(io, extract));
    expect(hit).toEqual({ text: "just one page", totalPages: 1, fromStore: true });
  });

  it("a stored count wins over a marker-like line inside the text", async () => {
    const { io } = fakeIo({ [SRC]: bytes });
    const text = "--- page 1 ---\nquote:\n--- page 7 ---\nstill page one";
    const extract = jest.fn(async () => ({ text, totalPages: 1, storable: true }));
    await readThroughDocument(base(io, extract));
    expect((await readThroughDocument(base(io, extract))).totalPages).toBe(1);
  });

  it("an object without the metadata falls back to counting markers", async () => {
    const { io, texts } = fakeIo({ [SRC]: bytes });
    await readThroughDocument(base(io, jest.fn(async () => ok())));
    texts.get(contentKey(sha(bytes), fp.id, "pre"))!.metadata = { "exulu-extractor": "pdftotext@1" };
    const hit = await readThroughDocument(base(io, jest.fn()));
    expect(hit.totalPages).toBe(2);
  });
});

describe("countPageMarkers", () => {
  it("counts markers; none gives undefined", () => {
    expect(countPageMarkers("--- page 1 ---\na\n--- page 2 ---\nb")).toBe(2);
    expect(countPageMarkers("plain text")).toBeUndefined();
  });
});
