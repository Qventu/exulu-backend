jest.mock("../../uppy/index", () => ({
  listS3ObjectsExact: jest.fn(),
  deleteS3ObjectsExact: jest.fn(),
}));

import { sweepExpiredDerived, startDerivedSweep } from "./sweep";

const NOW = new Date("2026-11-17T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const makeIo = (pages: { items: { key: string; lastModified: Date }[]; next?: string }[]) => {
  const order: string[] = [];
  const list = jest.fn(async (_prefix: string, token?: string) => {
    order.push(`list:${token ?? "first"}`);
    return pages[token ? Number(token) : 0];
  });
  const remove = jest.fn(async (keys: string[]) => {
    order.push(`remove:${keys.join(",")}`);
  });
  return { list, remove, order };
};

describe("sweepExpiredDerived", () => {
  it("deletes only expired objects and lists exactly under derived/", async () => {
    const io = makeIo([
      {
        items: [
          { key: "derived/content/a/1.md", lastModified: daysAgo(400) },
          { key: "derived/content/b/1.md", lastModified: daysAgo(10) },
        ],
      },
    ]);
    const res = await sweepExpiredDerived({ ...io, cacheDays: 365, now: () => NOW });
    expect(io.list).toHaveBeenCalledWith("derived/", undefined);
    expect(io.remove).toHaveBeenCalledWith(["derived/content/a/1.md"]);
    expect(res).toEqual({ deleted: 1 });
  });

  it("honours the general prefix", async () => {
    const io = makeIo([{ items: [{ key: "tenant/derived/pointers/x.json", lastModified: daysAgo(500) }] }]);
    await sweepExpiredDerived({ ...io, s3prefix: "/tenant/", cacheDays: 365, now: () => NOW });
    expect(io.list).toHaveBeenCalledWith("tenant/derived/", undefined);
    expect(io.remove).toHaveBeenCalledWith(["tenant/derived/pointers/x.json"]);
  });

  it("never deletes a foreign key a listing returns", async () => {
    const io = makeIo([
      {
        items: [
          { key: "user_1/file.pdf", lastModified: daysAgo(900) },
          { key: "derived-evil/x", lastModified: daysAgo(900) },
          { key: "other/derived/x.md", lastModified: daysAgo(900) },
          { key: "derived/content/a/1.md", lastModified: daysAgo(900) },
        ],
      },
    ]);
    const res = await sweepExpiredDerived({ ...io, cacheDays: 1, now: () => NOW });
    expect(io.remove).toHaveBeenCalledTimes(1);
    expect(io.remove).toHaveBeenCalledWith(["derived/content/a/1.md"]);
    expect(res.deleted).toBe(1);
  });

  it("pages sequentially, deleting per page", async () => {
    const io = makeIo([
      { items: [{ key: "derived/a", lastModified: daysAgo(400) }], next: "1" },
      { items: [{ key: "derived/b", lastModified: daysAgo(400) }] },
    ]);
    const res = await sweepExpiredDerived({ ...io, cacheDays: 365, now: () => NOW });
    expect(io.order).toEqual(["list:first", "remove:derived/a", "list:1", "remove:derived/b"]);
    expect(res.deleted).toBe(2);
  });

  it("cacheDays 0 deletes everything under derived/", async () => {
    const io = makeIo([
      {
        items: [
          { key: "derived/a", lastModified: daysAgo(0) },
          { key: "derived/b", lastModified: NOW },
        ],
      },
    ]);
    const res = await sweepExpiredDerived({ ...io, cacheDays: 0, now: () => NOW });
    expect(io.remove).toHaveBeenCalledWith(["derived/a", "derived/b"]);
    expect(res.deleted).toBe(2);
  });

  it("logs a failing remove and continues with the next page", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const io = makeIo([
      { items: [{ key: "derived/a", lastModified: daysAgo(400) }], next: "1" },
      { items: [{ key: "derived/b", lastModified: daysAgo(400) }] },
    ]);
    io.remove.mockRejectedValueOnce(new Error("boom"));
    const res = await sweepExpiredDerived({ ...io, cacheDays: 365, now: () => NOW });
    expect(io.remove).toHaveBeenCalledTimes(2);
    expect(res.deleted).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("startDerivedSweep", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const uppy = () => require("../../uppy/index");
  const cfg = { fileUploads: { s3Bucket: "b", s3prefix: "p" } } as never;

  it("runs after a minute, then daily, never overlapping, and stops", async () => {
    const u = uppy();
    let release!: () => void;
    u.listS3ObjectsExact.mockReset();
    u.deleteS3ObjectsExact.mockReset();
    u.listS3ObjectsExact.mockImplementation(
      () => new Promise((r) => (release = () => r({ items: [] }))),
    );
    const stop = startDerivedSweep(cfg);
    await jest.advanceTimersByTimeAsync(59_000);
    expect(u.listS3ObjectsExact).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(u.listS3ObjectsExact).toHaveBeenCalledTimes(1);
    expect(u.listS3ObjectsExact.mock.calls[0][0]).toBe("p/derived/");
    // a slow run is still in flight when the next tick is due: skipped
    await jest.advanceTimersByTimeAsync(24 * 3600_000);
    expect(u.listS3ObjectsExact).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(24 * 3600_000);
    expect(u.listS3ObjectsExact).toHaveBeenCalledTimes(2);
    release();
    stop();
    await jest.advanceTimersByTimeAsync(48 * 3600_000);
    expect(u.listS3ObjectsExact).toHaveBeenCalledTimes(2);
  });

  it("swallows errors", async () => {
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    const u = uppy();
    u.listS3ObjectsExact.mockReset();
    u.listS3ObjectsExact.mockRejectedValue(new Error("s3 down"));
    const stop = startDerivedSweep(cfg);
    await jest.advanceTimersByTimeAsync(61_000);
    expect(err).toHaveBeenCalled();
    stop();
    err.mockRestore();
  });
});
