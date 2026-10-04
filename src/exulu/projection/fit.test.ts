jest.mock("@SRC/exulu/table-names", () => {
  // Mirrors the real module, which runs the id through sanitizeName; a context
  // id with capitals or a space must yield the table name production would use.
  const sanitize = (id: string) => id.toLowerCase().replace(/ /g, "_").trim();
  return {
    getTableName: (id: string) => `${sanitize(id)}_items`,
    getChunksTableName: (id: string) => `${sanitize(id)}_chunks`,
  };
});

import { fitContextProjection, listFittableContexts } from "./fit";

type Row = { id: string; embedding: number[] };
/** Rows come back from pg as the pgvector text form; the fake mirrors that. */
const toSql = (v: number[]) => `[${v.join(",")}]`;

/**
 * Knex is called as `db("mem_chunks as chunks")` for the fit query and
 * `db("mem_chunks")` for the backfill, so the fake keys on the first word, and
 * it honours the keyset (`where("id", ">", …)`) so the backfill loop terminates.
 */
function fakeDb(state: { rows: Row[] }) {
  const writes: any[] = [];
  const calls: any[] = [];
  const db: any = jest.fn((table: string) => {
    const key = table.split(" ")[0];
    const chain: any = { __table: key, __where: {} };
    for (const m of ["whereNotNull", "whereRaw", "join", "orderByRaw", "orderBy", "select", "andWhere"]) {
      chain[m] = (...args: any[]) => { calls.push([key, m, ...args]); return chain; };
    }
    chain.where = (...args: any[]) => {
      if (typeof args[0] === "object") Object.assign(chain.__where, args[0]);
      else if (args[1] === ">") chain.__after = args[2];
      return chain;
    };
    chain.limit = (n: number) => { chain.__limit = n; return chain; };
    chain.first = async () => undefined;
    chain.insert = (rows: any) => { writes.push({ table: key, op: "insert", rows }); return { onConflict: () => ({ merge: async () => undefined }) }; };
    chain.then = (resolve: any, reject: any) => {
      if (!key.endsWith("_chunks")) return Promise.resolve([]).then(resolve, reject);
      const after = chain.__after;
      const rows = state.rows
        .filter((r) => after === undefined || r.id > after)
        .slice(0, chain.__limit ?? state.rows.length)
        .map((r) => ({ id: r.id, embedding: toSql(r.embedding) }));
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  });
  db.raw = async (_sql: string, _b?: any[]) => { writes.push({ op: "raw" }); return { rowCount: 0 }; };
  db.schema = { hasTable: async () => true };
  db.__writes = writes;
  db.__calls = calls;
  return db;
}

/** Stand-in layout: the first two components, so the linear map can fit it exactly. */
const umapFactory = () => ({ fit: (rows: number[][]) => rows.map((r) => [r[0] ?? 0, r[1] ?? 0, 0]) });

function cluster(n: number, centre: number[], spread: number, seed: number, offset: number): Row[] {
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(offset + i).padStart(4, "0")}`,          // sortable ids, so the keyset works
    embedding: centre.map((c) => c + rand() * spread),
  }));
}

describe("fitContextProjection", () => {
  const rows = [...cluster(60, [1, 0, 0, 0, 0, 0], 0.2, 1, 0), ...cluster(60, [0, 1, 0, 0, 0, 0], 0.2, 2, 60)];

  it("fits, stores a projection and backfills coordinates", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.sampleSize).toBe(120);
    expect(out.components).toBe(4);
    expect(out.residual).toBeLessThan(0.2);
    const stored = db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert");
    expect(stored.rows).toMatchObject({ context: "mem", dims: 6, components: 4, method: "umap+linear", version: 1, sample_size: 120 });
    expect(JSON.parse(stored.rows.basis)).toHaveLength(4);
    expect(JSON.parse(stored.rows.map)).toHaveLength(3);
    expect(out.written).toBe(120);
  });

  // The row is what makes chunkCoordinates start answering, and context.ts
  // spreads those coordinates straight into an unwrapped chunk insert. Commit
  // the row only once the backfill has proved the columns take a write, or a
  // chunks table that genuinely lacks px/py/pz fails every later ingestion into
  // that context. The backfill works from the in-memory projection and does not
  // need the row.
  it("backfills before it commits the row", async () => {
    const db = fakeDb({ rows });
    await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(db.__writes.map((w: any) => w.op)).toEqual(["raw", "insert"]);
  });

  it("leaves no projection row behind when the backfill fails", async () => {
    const db = fakeDb({ rows });
    db.raw = async () => { throw new Error('column "px" of relation "mem_chunks" does not exist'); };
    await expect(fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory }))
      .rejects.toThrow(/px/);
    expect(db.__writes).toEqual([]);
  });

  it("refuses a base with too few vectors and writes nothing", async () => {
    const db = fakeDb({ rows: rows.slice(0, 3) });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out).toMatchObject({ fitted: false, reason: expect.stringMatching(/at least/i) });
    expect(db.__writes).toEqual([]);
  });

  it("refuses degenerate input (no variance) instead of writing NaN", async () => {
    const same = Array.from({ length: 20 }, (_, i) => ({ id: `s${String(i).padStart(4, "0")}`, embedding: [1, 1, 1, 1, 1, 1] }));
    const db = fakeDb({ rows: same });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(false);
    expect(out.reason).toMatch(/variance/i);
    expect(db.__writes).toEqual([]);
  });

  it("stores the jsonb matrices as strings, not as pg array literals", async () => {
    const db = fakeDb({ rows });
    await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    const stored = db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert");
    // node-pg would encode a raw JS array as `{0.1,0.2}`, which jsonb rejects
    // with 22P02, so every matrix column has to leave here already stringified.
    for (const field of ["mean", "basis", "map", "intercept"]) {
      expect(typeof stored.rows[field]).toBe("string");
      expect(stored.rows[field].startsWith("[")).toBe(true);
      expect(() => JSON.parse(stored.rows[field])).not.toThrow();
    }
    expect(JSON.parse(stored.rows.mean)).toHaveLength(6);
    expect(JSON.parse(stored.rows.intercept)).toHaveLength(3);
    // Everything else stays a native value for the driver to bind.
    expect(typeof stored.rows.dims).toBe("number");
    expect(stored.rows.fitted_at).toBeInstanceOf(Date);
  });

  it("stores the sanitised context id, the one form --all can recover", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "My Docs", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(true);
    const stored = db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert");
    expect(stored.rows.context).toBe("my_docs");
  });

  // Ruling 29. `--all` can only recover the sanitised id from a table name, so
  // both the sample salt and the layout seed have to be taken from that form —
  // otherwise `--context "My Docs"` and `--all` fit the same base differently,
  // and the resolver, which samples by the sanitised id, samples something else
  // again.
  it("salts the sample and seeds the layout with the sanitised context id", async () => {
    const seeds: number[] = [];
    const seeded = (seed: number) => { seeds.push(seed); return umapFactory(); };
    const spaced = fakeDb({ rows });
    await fitContextProjection({ db: spaced, contextId: "My Docs", sample: 1000, components: 4, umapFactory: seeded });
    const sanitised = fakeDb({ rows });
    await fitContextProjection({ db: sanitised, contextId: "my_docs", sample: 1000, components: 4, umapFactory: seeded });

    const salt = (db: any) => db.__calls.find((c: any[]) => c[1] === "orderByRaw")?.[3];
    expect(salt(spaced)).toEqual(["my_docs"]);
    expect(salt(sanitised)).toEqual(["my_docs"]);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toBe(seeds[1]);
  });

  it("refuses a chunks table with no items sibling and writes nothing", async () => {
    const db = fakeDb({ rows });
    db.schema = { hasTable: async (table: string) => table.endsWith("_chunks") };
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out).toMatchObject({ fitted: false, reason: expect.stringMatching(/items table/i) });
    expect(db.__writes).toEqual([]);
  });

  it("refuses a layout that collapses to a single place", async () => {
    const db = fakeDb({ rows });
    const collapsed = () => ({ fit: (input: number[][]) => input.map(() => [1, 1, 1]) });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory: collapsed });
    // A constant target fits exactly, so without the scale check this would
    // store as a residual-0 map that puts every chunk on the origin.
    expect(out).toMatchObject({ fitted: false, reason: expect.stringMatching(/degenerate layout/i) });
    expect(db.__writes).toEqual([]);
  });

  it("dry run computes the fit but writes nothing", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, dryRun: true, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.written).toBe(0);
    expect(db.__writes).toEqual([]);
  });
});

describe("listFittableContexts", () => {
  it("derives context ids from the chunk tables in the database", async () => {
    const filters: any[][] = [];
    const db: any = jest.fn(() => {
      const chain: any = {};
      chain.where = () => chain;
      chain.andWhere = (...args: any[]) => { filters.push(args); return chain; };
      chain.select = () => chain;
      chain.then = (res: any) => Promise.resolve([{ table_name: "mem_chunks" }, { table_name: "docs_chunks" }]).then(res);
      return chain;
    });
    expect(await listFittableContexts(db)).toEqual(["mem", "docs"]);
    // Views and foreign tables match the name pattern too, and cannot be fitted.
    expect(filters).toContainEqual(["table_type", "BASE TABLE"]);
  });
});
