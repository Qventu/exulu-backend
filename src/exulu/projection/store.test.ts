import { chunkCoordinates, clearProjectionCache, dropProjection, loadProjection } from "./store";

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

/** Answers the read and records the delete, so one fake covers both readers. */
function fakeWriteDb(row: any, opts: { throwOnDelete?: boolean } = {}) {
  const reads: number[] = [];
  const deletes: any[] = [];
  const db: any = jest.fn((table: string) => ({
    where: (criteria: any) => ({
      first: async () => { reads.push(1); return row; },
      delete: async () => {
        if (opts.throwOnDelete) throw new Error(`relation "${table}" does not exist`);
        deletes.push({ table, criteria });
        return 1;
      },
    }),
  }));
  db.__reads = reads;
  db.__deletes = deletes;
  return db;
}

beforeEach(() => clearProjectionCache());

describe("loadProjection", () => {
  it("reads once and serves the cache until the ttl expires", async () => {
    const db = fakeDb(projection);
    expect((await loadProjection(db, "mem", 1000))?.dims).toBe(2);
    await loadProjection(db, "mem", 1000 + 59_000);
    expect(db.__reads).toHaveLength(1);
    // The window is [loadedAt, loadedAt + TTL), so the boundary itself is a
    // miss. Pinned exactly: a one-millisecond slip either way is a whole extra
    // minute of stale coordinates for everything embedded after a refit.
    await loadProjection(db, "mem", 1000 + 60_000);
    expect(db.__reads).toHaveLength(2);
    await loadProjection(db, "mem", 1000 + 121_000);
    expect(db.__reads).toHaveLength(3);
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
  // basis.length must match the row's own `components`, and a map is always 3
  // rows. Either one wrong still projects to plausible finite numbers, so this
  // is the only corruption class that fails silently rather than loudly.
  it("treats a wrongly shaped row as not fitted, and caches that too", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const db = fakeDb({ ...projection, basis: [[1, 0]] });
    expect(await loadProjection(db, "mem", 1000)).toBeNull();
    await loadProjection(db, "mem", 1000);
    expect(db.__reads).toHaveLength(1);
    clearProjectionCache();
    expect(await loadProjection(fakeDb({ ...projection, map: [[1, 0], [0, 1]] }), "mem", 1000)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[0]?.[0])).toContain("mem");
    spy.mockRestore();
  });
  // The outer lengths are not enough: a basis whose ROWS were truncated passes
  // every outer check, and projectComponents then reads the missing dimensions
  // as 0 - wrong-but-finite coordinates, exactly the class the guard exists to
  // catch.
  it("treats a row with a truncated inner row as not fitted", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: Record<string, unknown>[] = [
      { mean: [0] },                              // one dimension short
      { basis: [[1, 0], [0]] },                   // a basis row truncated
      { map: [[1, 0], [0], [0, 0]] },             // a map row truncated
      { intercept: [0, 0] },                      // an intercept of two
      { mean: null },                             // no mean at all
    ];
    for (const change of broken) {
      clearProjectionCache();
      expect(await loadProjection(fakeDb({ ...projection, ...change }), "mem", 1000)).toBeNull();
    }
    expect(spy).toHaveBeenCalledTimes(broken.length);
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

  // Spec §4 promises a line when there is no usable projection, and now that the
  // projection is deleted with the chunks (embedder-change), silence is the
  // failure mode: coordinates simply stop appearing. One line per context per
  // process, so the cost stays zero per embed.
  it("says so once per context when there is no usable projection", async () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const said = () => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("no usable projection"));
    const missing = fakeDb(undefined);
    expect(await loadProjection(missing, "mem", 1000)).toBeNull();
    // Past the ttl, so this is a second real read of the same absent row.
    expect(await loadProjection(missing, "mem", 1000 + 60_000)).toBeNull();
    expect(missing.__reads).toHaveLength(2);
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain("mem");
    // A version-stale row is the same silence, and another context is another
    // line.
    expect(await loadProjection(fakeDb({ ...projection, version: 0 }), "docs", 1000)).toBeNull();
    expect(said()).toHaveLength(2);
    expect(said()[1]).toContain("docs");
    spy.mockRestore();
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
  // The shape guard refuses a corrupt stored matrix before it is ever used, so
  // what still reaches the outer catch is the caller's own input. The guarantee
  // is the same either way: embedding never fails because of the map.
  it("returns nulls instead of throwing, whatever it is handed", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    // A hole in the vector list: reading `.length` off it is a TypeError.
    const out = await chunkCoordinates({ db: fakeDb(projection), contextId: "mem", vectors: [null as any, [1, 2]] });
    expect(out).toEqual([null, null]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  // Corrupt json is a shape problem like any other: readProjectionRow catches
  // the parse failure, loadProjection reports it, and it arrives here as a plain
  // "no projection".
  it("returns nulls when the stored json is corrupt", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await chunkCoordinates({ db: fakeDb({ ...projection, mean: "{" }), contextId: "mem", vectors: [[1, 2]] })).toEqual([null]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("dropProjection", () => {
  // An embedder swap at the same vector width re-embeds every chunk through a
  // different model, and the dimension check is all chunkCoordinates has: the
  // old basis would place the new vectors at finite, plausible, meaningless
  // coordinates while status still reported a healthy fit. So the row goes with
  // the chunks it was fitted on.
  it("deletes the row by the sanitised context id and drops the cached copy", async () => {
    const db = fakeWriteDb(projection);
    expect((await loadProjection(db, "My Docs", 1000))?.dims).toBe(2);
    await dropProjection(db, "My Docs");
    expect(db.__deletes).toContainEqual({ table: "context_projections", criteria: { context: "my_docs" } });
    // The next read has to go back to the database, or this replica keeps
    // placing chunks with the projection that was just deleted.
    await loadProjection(db, "My Docs", 1000);
    expect(db.__reads).toHaveLength(2);
  });

  // A fit writes the base's named regions under the same sanitised key
  // (topics.ts), and nothing else ever deletes them. Without this an embedder
  // swap left labels describing vectors that no longer exist on any base that
  // is never refitted - drawn over whatever the next fit lays out.
  it("deletes the context's topic rows along with the row that positioned them", async () => {
    const db = fakeWriteDb(projection);
    await dropProjection(db, "My Docs");
    expect(db.__deletes).toEqual([
      { table: "context_projections", criteria: { context: "my_docs" } },
      { table: "context_map_topics", criteria: { context: "my_docs" } },
    ]);
  });

  // It runs mid-rebuild, next to dropChunksTable: a context that was never
  // fitted, or a deployment whose core tables predate context_projections, must
  // not fail an embedder change.
  it("survives a missing table or row, and still clears the cache", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const db = fakeWriteDb(projection, { throwOnDelete: true });
    expect((await loadProjection(db, "mem", 1000))?.dims).toBe(2);
    await expect(dropProjection(db, "mem")).resolves.toBeUndefined();
    await loadProjection(db, "mem", 1000);
    expect(db.__reads).toHaveLength(2);
    spy.mockRestore();
  });
});
