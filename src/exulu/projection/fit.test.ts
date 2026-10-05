jest.mock("@SRC/exulu/table-names", () => {
  // Mirrors the real module, which runs the id through sanitizeName; a context
  // id with capitals or a space must yield the table name production would use.
  const sanitize = (id: string) => id.toLowerCase().replace(/ /g, "_").trim();
  return {
    getTableName: (id: string) => `${sanitize(id)}_items`,
    getChunksTableName: (id: string) => `${sanitize(id)}_chunks`,
  };
});

// Passthrough spy: the solve itself is the real one, but the residual has to be
// scored from a solve that never saw the rows it is scored on, and the row
// counts of each call are the only place that is observable.
jest.mock("./math", () => {
  const actual = jest.requireActual("./math");
  return { ...actual, ridgeFit: jest.fn(actual.ridgeFit) };
});

import { fitContextProjection, listFittableContexts } from "./fit";
import { ridgeFit } from "./math";

const solveSizes = () => (ridgeFit as unknown as jest.Mock).mock.calls.map((c: any[]) => c[0].length);
beforeEach(() => (ridgeFit as unknown as jest.Mock).mockClear());

type Row = { id: string; embedding: number[] };
/** Rows come back from pg as the pgvector text form; the fake mirrors that. */
const toSql = (v: number[]) => `[${v.join(",")}]`;

/** The two-cluster sample most tests fit, for a test that only cares about the writes. */
const defaultRows = (): Row[] =>
  [...cluster(60, [1, 0, 0, 0, 0, 0], 0.2, 1, 0), ...cluster(60, [0, 1, 0, 0, 0, 0], 0.2, 2, 60)];

/**
 * Knex is called as `db("mem_chunks as chunks")` for the fit query and
 * `db("mem_chunks")` for the backfill, so the fake keys on the first word, and
 * it honours the keyset (`where("id", ">", …)`) so the backfill loop terminates.
 *
 * `db.transaction` hands its callback a chain-compatible stand-in, because the
 * topics and the projection row are written inside one. The topic-table writes
 * and the lexeme query land in `__topicWrites`, kept apart from `__writes` so
 * that stays what it has always been — the backfill and the projection row —
 * and the three `on*` hooks record the order the phases actually run in.
 *
 * `rows` gives parsed vectors; `embeddings` gives the raw pgvector strings with
 * generated ids, so a test can include one that does not parse. Neither given
 * means the default sample.
 */
function fakeDb(state: {
  rows?: Row[];
  embeddings?: string[];
  onBackfill?: () => void;
  onProjection?: () => void;
  onTopics?: () => void;
  /** The schema probe answers that `context_map_topics` is not there. */
  topicsAbsent?: boolean;
  /** Every `context_map_topics` statement raises undefined_table. */
  topicsReject?: boolean;
}) {
  const writes: any[] = [];
  const topicWrites: any[] = [];
  const calls: any[] = [];
  const sample: { id: string; embedding: string }[] = state.embeddings
    ? state.embeddings.map((embedding, i) => ({ id: `id-${i}`, embedding }))
    : (state.rows ?? defaultRows()).map((r) => ({ id: r.id, embedding: toSql(r.embedding) }));

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
      // Keyset by position rather than by string compare: the backfill orders by
      // id, and `id-10` sorts before `id-2` as text, which would hand the loop
      // rows it had already written. Sorted ids behave exactly as before.
      const after = chain.__after;
      const start = after === undefined ? 0 : sample.findIndex((r) => r.id === after) + 1;
      return Promise.resolve(sample.slice(start, start + (chain.__limit ?? sample.length))).then(resolve, reject);
    };
    return chain;
  });
  db.raw = async (_sql: string, _b?: any[]) => { state.onBackfill?.(); writes.push({ op: "raw" }); return { rowCount: 0 }; };
  db.schema = { hasTable: async () => true };

  // computeTopics writes the topic table twice (it replaces the context's set),
  // so the hook fires on the first of those operations: one phase, not two.
  let announced = false;
  const topicPhase = () => { if (!announced) { announced = true; state.onTopics?.(); } };
  db.transaction = async (fn: (trx: any) => Promise<void>) => {
    db.__transactions += 1;
    const trx: any = jest.fn((table: string) => {
      const chain: any = {};
      chain.where = () => chain;
      chain.delete = async () => {
        topicPhase(); topicWrites.push({ table, op: "delete" });
        if (state.topicsReject && table === "context_map_topics") throw missingTable();
      };
      chain.insert = (rows: any) => {
        if (table === "context_map_topics") {
          topicPhase(); topicWrites.push({ table, op: "insert", rows });
          if (state.topicsReject) throw missingTable();
        }
        else { if (table === "context_projections") state.onProjection?.(); writes.push({ table, op: "insert", rows, inTransaction: true }); }
        // Awaited directly by the topics insert, chained by the projection upsert.
        const out: any = { onConflict: () => ({ merge: async () => undefined }) };
        out.then = (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject);
        return out;
      };
      return chain;
    });
    // The only raw query inside the fit's transaction is the lexeme count, and
    // the sampled ids are its first binding.
    trx.raw = async (_sql: string, bindings: any[] = []) => {
      topicPhase();
      const ids = Array.isArray(bindings[0]) ? (bindings[0] as unknown[]).map(String) : [];
      db.__onTopicIds?.(ids);
      topicWrites.push({ op: "raw", ids });
      return { rows: [] };
    };
    trx.schema = state.topicsAbsent
      ? { hasTable: async (table: string) => table !== "context_map_topics" }
      : db.schema;
    return fn(trx);
  };

  db.__writes = writes;
  db.__topicWrites = topicWrites;
  db.__calls = calls;
  db.__transactions = 0;
  return db;
}

/** What pg raises for a relation that is not there (undefined_table). */
const missingTable = () =>
  Object.assign(new Error('relation "context_map_topics" does not exist'), { code: "42P01" });

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

/** A one-hot centre in `dims` dimensions. */
const axis = (dims: number, at: number) => Array.from({ length: dims }, (_, i) => (i === at ? 1 : 0));

describe("fitContextProjection", () => {
  const rows = [...cluster(60, [1, 0, 0, 0, 0, 0], 0.2, 1, 0), ...cluster(60, [0, 1, 0, 0, 0, 0], 0.2, 2, 60)];
  /** 60 vectors in 12 dimensions: wide enough that `dims` is not what caps the
   *  component count, small enough that the sample is. */
  const small = [...cluster(30, axis(12, 0), 0.2, 3, 0), ...cluster(30, axis(12, 1), 0.2, 4, 30)];

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

  // Measured against real umap-js on synthetic 1536-dimension bases: 50 free
  // parameters on 60 vectors reported 0.020 while actually placing new points
  // with 0.261 error. One component per ten vectors instead, never more than
  // asked for; the stored `components` has to be the value used, because the
  // shape guard and the loader both read it.
  it("scales the component count to the sample it loaded, and stores what it used", async () => {
    const db = fakeDb({ rows: small });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 50, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.sampleSize).toBe(60);
    expect(out.components).toBe(6);
    const stored = db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert");
    expect(stored.rows.components).toBe(6);
    expect(JSON.parse(stored.rows.basis)).toHaveLength(6);
    for (const row of JSON.parse(stored.rows.map)) expect(row).toHaveLength(6);
  });

  it("never scales the component count up", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.components).toBe(4);
  });

  it("scores the residual on rows the solve never saw", async () => {
    const db = fakeDb({ rows });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    // 20% of 120 held out: the scoring solve sees 96 rows, the stored map all 120.
    expect(solveSizes()).toEqual([96, 120]);
    expect(out.heldOut).toBe(24);
  });

  // With more parameters than training rows there is nothing to hold out, so the
  // number stays in-sample - and the script's summary has to say so rather than
  // present it as an out-of-sample score.
  it("falls back to an in-sample residual, flagged, when the sample is too small", async () => {
    const db = fakeDb({ rows: rows.slice(0, 3) });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 2, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.heldOut).toBe(0);
    expect(solveSizes()).toEqual([3]);
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

  it("writes topics after the backfill, inside the same transaction as the projection", async () => {
    const order: string[] = [];
    const db = fakeDb({ onBackfill: () => order.push("backfill"), onProjection: () => order.push("projection"), onTopics: () => order.push("topics") });
    const result = await fitContextProjection({ db, contextId: "mem", umapFactory });
    expect(result.fitted).toBe(true);
    expect(result.topics).toBeGreaterThan(0);
    expect(order).toEqual(["backfill", "topics", "projection"]);
    // Order alone would also hold for three separate statements: the topic set
    // and the projection row have to be committed together, or a context ends up
    // describing one layout by its coordinates and another by its region names.
    expect(db.__transactions).toBe(1);
    expect(db.__writes.find((w: any) => w.table === "context_projections").inTransaction).toBe(true);
    // What matters is that the region write replaced rather than appended, and
    // that it happened through the transaction. The exact statement sequence is
    // computeTopics' business and is pinned in its own suite: asserting it here
    // broke this test the moment that module asked Postgres one more question.
    const topicOps = db.__topicWrites.map((w: any) => w.op);
    expect(topicOps.filter((op: string) => op === "delete" || op === "insert")).toEqual(["delete", "insert"]);
    expect(topicOps).toContain("raw");
  });

  // `context_map_topics` is created by the boot migration, and the fit script
  // opens its own pool and runs none. Fitting against a database whose server
  // has not booted this build must still map the base: the backfill has already
  // written every coordinate, and a base without regions is a supported state.
  it("still commits the projection row when the topic table does not exist", async () => {
    const db = fakeDb({ rows, topicsAbsent: true });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.topics).toBe(0);
    const stored = db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert");
    expect(stored).toBeDefined();
    expect(stored.inTransaction).toBe(true);
    // Nothing was sent to the table that is not there: inside a transaction a
    // statement that raises aborts it, so the probe has to come first.
    expect(db.__topicWrites.filter((w: any) => w.table === "context_map_topics")).toEqual([]);
  });

  // The same outcome when the probe cannot see it coming — a connection with no
  // schema builder, or the table dropped between the probe and the write. This
  // fake's transaction does not abort on a failed statement, so what this pins
  // is the catch and the returned count; the test above is the one that pins the
  // probe, which is what makes the real transaction commit.
  it("still commits the projection row when the topic write raises undefined_table", async () => {
    const db = fakeDb({ rows, topicsReject: true });
    const out = await fitContextProjection({ db, contextId: "mem", sample: 1000, components: 4, umapFactory });
    expect(out.fitted).toBe(true);
    expect(out.topics).toBe(0);
    expect(db.__writes.find((w: any) => w.table === "context_projections" && w.op === "insert")).toBeDefined();
    // The write was genuinely attempted: without this the fixture would prove
    // nothing about the error path.
    expect(db.__topicWrites).toContainEqual({ table: "context_map_topics", op: "delete" });
  });

  it("stores no topics on a dry run", async () => {
    const order: string[] = [];
    const db = fakeDb({ onTopics: () => order.push("topics") });
    const result = await fitContextProjection({ db, contextId: "mem", dryRun: true, umapFactory });
    expect(result.fitted).toBe(true);
    expect(result.topics).toBe(0);
    expect(order).toEqual([]);
  });

  it("keeps sample ids aligned with their vectors when a row has no parseable embedding", async () => {
    // The middle row's embedding is unparseable, so it drops out of `vectors`.
    // If ids were taken from the raw rows, every later id would be off by one and
    // topics would be clustered against the wrong chunks.
    const db = fakeDb({
      embeddings: ["[1,0]", "not a vector", "[0,1]", "[1,1]", "[2,1]", "[1,2]", "[3,1]", "[1,3]", "[1,-1]", "[-1,2]", "[2,-1]", "[0.5,2]"],
    });
    const seen: string[] = [];
    db.__onTopicIds = (ids: string[]) => seen.push(...ids);
    await fitContextProjection({ db, contextId: "mem", components: 2, umapFactory });
    expect(seen).not.toContain("id-1");
    // The ids have to reach the clustering at all, and all eleven that parsed
    // have to reach it: an empty list would satisfy the line above on its own.
    expect(seen).toHaveLength(11);
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
