jest.mock("@SRC/exulu/table-names", () => ({
  getTableName: (id: string) => `${id}_items`,
  getChunksTableName: (id: string) => `${id}_chunks`,
}));

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
  const db: any = jest.fn((table: string) => {
    const key = table.split(" ")[0];
    const chain: any = { __table: key, __where: {} };
    for (const m of ["whereNotNull", "whereRaw", "join", "orderByRaw", "orderBy", "select", "andWhere"]) {
      chain[m] = () => chain;
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
    expect(JSON.parse(JSON.stringify(stored.rows.basis))).toHaveLength(4);
    expect(stored.rows.map).toHaveLength(3);
    expect(out.written).toBe(120);
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
    const db: any = jest.fn(() => {
      const chain: any = {};
      chain.where = () => chain;
      chain.andWhere = () => chain;
      chain.select = () => chain;
      chain.then = (res: any) => Promise.resolve([{ table_name: "mem_chunks" }, { table_name: "docs_chunks" }]).then(res);
      return chain;
    });
    expect(await listFittableContexts(db)).toEqual(["mem", "docs"]);
  });
});
