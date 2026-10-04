import { chunkCoordinates, clearProjectionCache, loadProjection } from "./store";

const projection = {
  context: "mem", dims: 2, components: 2,
  mean: [0, 0], basis: [[1, 0], [0, 1]], map: [[1, 0], [0, 1], [0, 0]], intercept: [0, 0, 0],
  method: "umap+linear", version: 1, sample_size: 10, residual: 0.1, fitted_at: new Date(),
};

function fakeDb(row: any, opts: { throwOnSelect?: boolean } = {}) {
  const calls: number[] = [];
  const db: any = jest.fn(() => ({
    where: () => ({
      first: async () => { calls.push(1); if (opts.throwOnSelect) throw new Error("boom"); return row; },
    }),
  }));
  db.__reads = calls;
  return db;
}

/** Like `fakeDb`, but it only answers for one exact `context` value. */
function fakeDbKeyedOn(expected: string, row: any) {
  const calls: number[] = [];
  const db: any = jest.fn(() => ({
    where: (criteria: any) => ({
      first: async () => { calls.push(1); return criteria?.context === expected ? row : undefined; },
    }),
  }));
  db.__reads = calls;
  return db;
}

beforeEach(() => clearProjectionCache());

describe("loadProjection", () => {
  it("reads once and serves the cache until the ttl expires", async () => {
    const db = fakeDb(projection);
    expect((await loadProjection(db, "mem", 1000))?.dims).toBe(2);
    await loadProjection(db, "mem", 1000 + 59_000);
    expect(db.__reads).toHaveLength(1);
    await loadProjection(db, "mem", 1000 + 61_000);
    expect(db.__reads).toHaveLength(2);
  });
  it("treats a version mismatch as not fitted, and caches that too", async () => {
    const db = fakeDb({ ...projection, version: 0 });
    expect(await loadProjection(db, "mem", 1000)).toBeNull();
    await loadProjection(db, "mem", 1000);
    expect(db.__reads).toHaveLength(1);
  });
  it("never throws", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await loadProjection(fakeDb(undefined, { throwOnSelect: true }), "mem", 1000)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  // The fit script keys the row on sanitizeName(contextId), so a reader handed
  // the display form of the id has to sanitise before it looks up or caches.
  it("looks the row up by the sanitised context id, and caches under it", async () => {
    const db = fakeDbKeyedOn("my_docs", { ...projection, context: "my_docs" });
    expect((await loadProjection(db, "My Docs", 1000))?.dims).toBe(2);
    expect((await loadProjection(db, "my_docs", 1000))?.dims).toBe(2);
    expect(db.__reads).toHaveLength(1);
  });
});

describe("chunkCoordinates", () => {
  it("projects every vector", async () => {
    const out = await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [[3, 4], [0, 0]] });
    expect(out[0]).not.toBeNull();
    expect(Math.abs(out[0]!.x - 0.6)).toBeLessThan(1e-5);
    expect(Math.abs(out[0]!.y - 0.8)).toBeLessThan(1e-5);
    expect(out[0]!.z).toBe(0);
    expect(out[1]).toEqual({ x: 0, y: 0, z: 0 });
  });
  it("returns nulls without a projection, on a dimension mismatch, and on an empty input", async () => {
    expect(await chunkCoordinates({ db: fakeDb(undefined), contextId: "mem", vectors: [[1, 2]] })).toEqual([null]);
    // The line above cached "mem has no projection" (the version-mismatch test
    // pins that negative caching), so the mismatch case below needs a fresh
    // cache to get as far as the dimension check at all.
    clearProjectionCache();
    const spy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [[1, 2, 3]] })).toEqual([null]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [] })).toEqual([]);
  });
  // A chunk whose embedding never arrived carries `vectors[i] ?? []`, i.e. a
  // zero-length vector. Spec §6: no embedding means no coordinates - that is
  // the expected shape of the data, not a projection mismatch worth warning on.
  it("skips a chunk with no embedding, without warning", async () => {
    const spy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [[]] })).toEqual([null]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
