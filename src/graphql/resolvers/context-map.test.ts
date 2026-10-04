jest.mock("@SRC/graphql/utilities/access-control", () => ({
  applyAccessControl: jest.fn((_t: unknown, q: any, _u: unknown, prefix?: string) => { q.__scoped = prefix ?? true; return q; }),
}));
jest.mock("@SRC/exulu/table-names", () => ({
  getTableName: (id: string) => `${id}_items`,
  getChunksTableName: (id: string) => `${id}_chunks`,
}));
jest.mock("@SRC/graphql/utilities/convert-context-to-table-definition", () => ({
  convertContextToTableDefinition: (c: any) => ({ name: { singular: c.id, plural: `${c.id}s` } }),
}));

import { EDGE_LIMIT_DEFAULT, EDGE_LIMIT_MAX, EDGE_QUERY_TERMS } from "@SRC/exulu/projection/constants";
import { contextMapEdges, contextMapPoints, contextProjectionStatus } from "./context-map";

/** Keys on the first word, because the resolvers call `db("mem_chunks as chunks")`. */
function fakeDb(answers: Record<string, any[]>, opts: { hasTable?: (t: string) => boolean } = {}) {
  const log: any[] = [];
  const db: any = jest.fn((table: string) => {
    const key = table.split(" ")[0];
    const chain: any = { __table: key, __scoped: false };
    for (const m of ["join", "where", "orWhere", "whereIn", "whereNot", "whereNotNull", "whereRaw", "groupBy", "orderBy", "orderByRaw", "limit", "select", "count", "countDistinct", "andWhere", "pluck"]) {
      chain[m] = (...args: any[]) => {
        // A grouped predicate - `.where(b => b.where(…).orWhere(…))` - builds on
        // the builder it is handed, so running it here puts its disjuncts in the
        // log. Without this the whole group is invisible to every assertion.
        for (const a of args) if (typeof a === "function") a(chain);
        log.push([key, m, ...args.filter((a) => typeof a !== "function")]);
        return chain;
      };
    }
    chain.first = async () => (answers[`${key}#first`] ?? [])[0];
    chain.then = (res: any, rej: any) => Promise.resolve(answers[key] ?? []).then(res, rej);
    return chain;
  });
  // `raw` serves two jobs: a select/predicate fragment (inspected through the
  // log) and a standalone statement the resolver awaits for its rows — which is
  // how the edges query asks Postgres for the node's own lexemes.
  db.raw = (sql: string, bindings?: any) => {
    log.push(["raw", sql, bindings]);
    return {
      sql, bindings, toString: () => sql,
      then: (res: any, rej: any) => Promise.resolve({ rows: answers["raw"] ?? [] }).then(res, rej),
    };
  };
  db.schema = { hasTable: async (t: string) => (opts.hasTable ? opts.hasTable(t) : true) };
  db.__log = log;
  return db;
}

const context = {
  id: "mem", name: "Memory", configuration: { languages: ["english"] },
  fields: [{ name: "type", type: "enum" }, { name: "information", type: "text" }],
} as any;
const user = { id: 4 } as any;
/** chunks.source is a uuid column, so a node id has to be one. */
const NODE = "11111111-2222-4333-8444-555555555555";
/** A chunk id and the item it belongs to: a PASSAGES point is identified by the former. */
const CHUNK = "99999999-8888-4777-8666-555555555555";
const OWNER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

// applyAccessControl is one module-level jest.fn shared by every test here, so
// any assertion about how it was called is meaningless until the counters are
// reset between tests.
beforeEach(() => jest.clearAllMocks());
const accessControl = () => (require("@SRC/graphql/utilities/access-control") as any).applyAccessControl;
/** The same base with two configured languages. */
const bilingual = { ...context, configuration: { languages: ["english", "german"] } } as any;

describe("contextMapPoints", () => {
  it("returns one point per item in DOCUMENTS mode, scoped to the viewer's items", async () => {
    const db = fakeDb({
      mem_chunks: [
        { id: "i1", itemId: "i1", x: "0.5", y: "-0.25", z: "0", label: "Encoder", group: "FACT", chunks: "3" },
      ],
      "mem_chunks#first": [{ c: "1" }],
    });
    const out = await contextMapPoints({ db, context, user, mode: "DOCUMENTS", groupField: "type", limit: 10 });
    expect(out).toEqual({
      points: [{ id: "i1", itemId: "i1", x: 0.5, y: -0.25, z: 0, label: "Encoder", group: "FACT", chunks: 3 }],
      total: 1, sampled: false,
    });
    expect(db.__log.some((l: any[]) => l[1] === "whereNotNull" && String(l[2]).includes("px"))).toBe(true);
    expect(accessControl()).toHaveBeenCalledWith(expect.anything(), expect.anything(), user, "items");
    // Once for the total, once for the rows. Without the count, dropping the
    // gate from one of the two paths would still satisfy "was called".
    expect(accessControl()).toHaveBeenCalledTimes(2);
  });

  it("flags a sampled result when the base is larger than the limit", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "900" }] });
    const out = await contextMapPoints({ db, context, user, mode: "DOCUMENTS", limit: 10 });
    expect(out).toMatchObject({ total: 900, sampled: true });
  });

  it("flags a sampled result in PASSAGES mode too, against the capped limit", async () => {
    const over = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "900" }] });
    expect(await contextMapPoints({ db: over, context, user, mode: "PASSAGES", limit: 10 })).toMatchObject({ total: 900, sampled: true });
    const under = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "5" }] });
    expect(await contextMapPoints({ db: under, context, user, mode: "PASSAGES", limit: 10 })).toMatchObject({ total: 5, sampled: false });
  });

  // (14) Multi-language bases are the reason the predicate is a disjunction at
  // all, and one language exercises neither the OR join nor the GREATEST join.
  it("ORs the search predicate across every configured language", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
    await contextMapPoints({ db, context: bilingual, user, mode: "DOCUMENTS", search: "encoder", limit: 10 });
    const match = db.__log.find((l: any[]) => l[1] === "whereRaw" && String(l[2]).includes("@@"));
    const sql = String(match?.[2]);
    expect(sql).toContain("chunks.fts @@ websearch_to_tsquery('english', ?)");
    expect(sql).toContain("items.fts @@ websearch_to_tsquery('english', ?)");
    expect(sql).toContain("chunks.fts @@ websearch_to_tsquery('german', ?)");
    expect(sql).toContain("items.fts @@ websearch_to_tsquery('german', ?)");
    // Two languages × two columns, one binding each, all the same text.
    expect(match?.[3]).toHaveLength(4);
    expect(new Set(match?.[3] as string[]).size).toBe(1);
  });

  it("ignores an unknown groupField and clamps the limit", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
    await contextMapPoints({ db, context, user, mode: "PASSAGES", groupField: "nope", limit: 99999 });
    expect(db.__log.some((l: any[]) => l[1] === "limit" && l[2] === 20000)).toBe(true);
    expect(db.__log.some((l: any[]) => JSON.stringify(l).includes("nope"))).toBe(false);
  });

  // Ruling 25: `limit` is a nullable Int in the schema, so an explicit null used
  // to reach Math.max(1, Math.min(null, MAX)) and return a single point.
  it("falls back to the default cap for a null limit", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
    await contextMapPoints({ db, context, user, mode: "DOCUMENTS", limit: null });
    expect(db.__log.some((l: any[]) => l[1] === "limit" && l[2] === 5000)).toBe(true);
  });

  // The grouping field is the one place a request value reaches raw SQL, so each
  // rejection below is a query that would otherwise run - or fail - with it.
  describe("groupField", () => {
    const ctxWith = (fields: any[]) => ({ ...context, fields }) as any;
    /** Every emitted `… as "group"` expression. */
    const groupSql = (db: any) =>
      db.__log.filter((l: any[]) => l[0] === "raw" && String(l[1]).includes('as "group"')).map((l: any[]) => String(l[1]));
    const run = async (fields: any[], groupField: string) => {
      const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
      await contextMapPoints({ db, context: ctxWith(fields), user, mode: "DOCUMENTS", groupField, limit: 10 });
      return db;
    };

    // `hidden` is this repo's write-only-secret contract (see field-allow-list.ts).
    // Grouping by one would hand the value back for every item the caller reads.
    it("drops a hidden field", async () => {
      const db = await run([{ name: "api_secret", type: "text", hidden: true }], "api_secret");
      expect(JSON.stringify(db.__log)).not.toContain("api_secret");
      expect(groupSql(db).every((sql: string) => sql.includes('NULL as "group"'))).toBe(true);
    });

    // Item columns are sanitizeName(field.name), so a declared "Doc Type" lives
    // in `doc_type`; emitting `items.Doc Type` was a syntax error that failed the
    // whole query where the spec says an unusable grouping field is ignored.
    it("resolves a declared name to its sanitised, quoted column", async () => {
      const db = await run([{ name: "Doc Type", type: "enum" }], "Doc Type");
      expect(groupSql(db).some((sql: string) => sql.includes('items."doc_type" as "group"'))).toBe(true);
      expect(db.__log.some((l: any[]) => l[1] === "groupBy" && l.includes("items.doc_type"))).toBe(true);
    });

    it("drops a declared name that does not sanitise to a safe identifier", async () => {
      const db = await run([{ name: "Doc-Type", type: "enum" }], "Doc-Type");
      expect(JSON.stringify(db.__log)).not.toContain("Doc-Type");
      expect(JSON.stringify(db.__log)).not.toContain("doc-type");
      expect(groupSql(db).every((sql: string) => sql.includes('NULL as "group"'))).toBe(true);
    });

    // A file field's column is `<name>_s3key`: grouping by a storage key is
    // meaningless, and the declared name is not the column at all.
    it("drops a file field", async () => {
      const db = await run([{ name: "attachment", type: "file" }], "attachment");
      expect(JSON.stringify(db.__log)).not.toContain("attachment");
      expect(groupSql(db).every((sql: string) => sql.includes('NULL as "group"'))).toBe(true);
    });
  });

  it("is empty when the chunks table is missing", async () => {
    const db = fakeDb({}, { hasTable: () => false });
    expect(await contextMapPoints({ db, context, user, mode: "DOCUMENTS", limit: 10 })).toEqual({ points: [], total: 0, sampled: false });
  });

  // Ruling 17: the language is interpolated as a SQL literal and only the query
  // text is bound, the pattern vector-search.ts already uses. A bound regconfig
  // parameter is an untested shape in this repo, and the languages come from the
  // context configuration, never from the request.
  it("interpolates the language as a literal and binds only the search text", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
    await contextMapPoints({ db, context, user, mode: "PASSAGES", search: "encoder speed", limit: 10 });
    const match = db.__log.find((l: any[]) => l[1] === "whereRaw" && String(l[2]).includes("chunks.fts @@"));
    expect(String(match?.[2])).toContain("('english', ?)");
    // One binding per language × searched column (chunks.fts and items.fts).
    expect(match?.[3]).toHaveLength(2);
  });

  // Spec §5: "items whose name or text matches". The items table carries its own
  // generated vector over name, description and external id, and searching only
  // chunks.fts means a document found by its title finds nothing unless the
  // title happens to recur in the body.
  it("matches the item's name as well as the chunk text", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "0" }] });
    await contextMapPoints({ db, context, user, mode: "DOCUMENTS", search: "encoder", limit: 10 });
    const match = db.__log.find((l: any[]) => l[1] === "whereRaw" && String(l[2]).includes("@@"));
    expect(String(match?.[2])).toContain("chunks.fts @@ websearch_to_tsquery('english', ?)");
    expect(String(match?.[2])).toContain("items.fts @@ websearch_to_tsquery('english', ?)");
    expect(String(match?.[2])).toContain(" OR ");
    // The same preprocessed text, bound once per disjunct.
    expect(match?.[3]).toHaveLength(2);
    expect(match?.[3]?.[0]).toBe(match?.[3]?.[1]);
    expect(String(match?.[3]?.[0])).toContain("encoder");
  });
});

describe("contextMapEdges", () => {
  /** The seed passage, and the lexeme aggregate Postgres hands back for it. */
  const SEED = "encoder speed display";
  const LEXEMES = "encod or speed or display";
  /** A seed chunk plus the lexemes Postgres hands back for it. */
  const edgeDb = (rows: any[], query: unknown = LEXEMES) => fakeDb({
    mem_chunks: rows,
    "mem_chunks#first": [{ text: SEED }],
    raw: [{ query }],
  });

  it("ranks other items lexically and never returns the node itself", async () => {
    const db = edgeDb([{ id: "i2", score: "0.42" }, { id: "i3", score: "0.2" }]);
    const out = await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 });
    expect(out).toEqual([{ source: NODE, target: "i2", score: 0.42 }, { source: NODE, target: "i3", score: 0.2 }]);
    expect(db.__log.some((l: any[]) => l[1] === "whereNot")).toBe(true);
    expect((require("@SRC/graphql/utilities/access-control") as any).applyAccessControl).toHaveBeenCalled();
    // Ruling 17 again, for the match predicate and the ts_rank expression.
    expect(JSON.stringify(db.__log)).toContain("('english', ?)");
  });
  // Spec §5 defines a point's id as the chunk id in PASSAGES mode, and the 3D
  // view wires a point's id straight in. Seeding on chunks.source alone returned
  // [] for every passage node, with no error and nothing to debug from.
  it("seeds from an item id, and excludes that item from the targets", async () => {
    const db = fakeDb({
      mem_chunks: [{ id: "i2", score: "0.42" }],
      "mem_chunks#first": [{ text: SEED, itemId: NODE }],
      raw: [{ query: LEXEMES }],
    });
    expect(await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 }))
      .toEqual([{ source: NODE, target: "i2", score: 0.42 }]);
    expect(db.__log).toEqual(expect.arrayContaining([
      ["mem_chunks", "where", "chunks.source", NODE],
      ["mem_chunks", "orWhere", "chunks.id", NODE],
      ["mem_chunks", "whereNot", "chunks.source", NODE],
    ]));
  });

  it("seeds from a chunk id, and excludes the item that chunk belongs to", async () => {
    const db = fakeDb({
      mem_chunks: [{ id: "i2", score: "0.42" }],
      "mem_chunks#first": [{ text: SEED, itemId: OWNER }],
      raw: [{ query: LEXEMES }],
    });
    // The caller's id is still what each edge reports as its source, whatever
    // kind of id it was.
    expect(await contextMapEdges({ db, context, user, nodeId: CHUNK, limit: 5 }))
      .toEqual([{ source: CHUNK, target: "i2", score: 0.42 }]);
    expect(db.__log).toEqual(expect.arrayContaining([
      ["mem_chunks", "where", "chunks.source", CHUNK],
      ["mem_chunks", "orWhere", "chunks.id", CHUNK],
      // The seed's OWN item: `chunks.source <> <a chunk id>` excludes nothing,
      // so the node's strongest neighbour would be the document it is part of.
      ["mem_chunks", "whereNot", "chunks.source", OWNER],
    ]));
    expect(db.__log).not.toEqual(expect.arrayContaining([["mem_chunks", "whereNot", "chunks.source", CHUNK]]));
  });

  it("is empty when the node has no text, without asking for its lexemes", async () => {
    // The fake would answer the lexeme round trip happily, so the guard is only
    // pinned by proving the round trip never happens.
    const db = fakeDb({ "mem_chunks#first": [{ text: "   " }], raw: [{ query: "encod or speed" }] });
    expect(await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 })).toEqual([]);
    expect(db.__log.some((l: any[]) => l[0] === "raw" && String(l[1]).includes("unnest(to_tsvector("))).toBe(false);
    expect(db.__log.some((l: any[]) => l[1] === "whereNot")).toBe(false);
  });

  // Ruling 24. The preprocessing helpers are built for short user queries: fed a
  // 600-character passage they exceed MAX_OR_TERMS and fall back to the strict
  // AND form, which only ever matches a near-duplicate. So the node's own
  // tsvector picks the terms, ordered by in-passage frequency then length.
  it("asks Postgres for the node's own lexemes, capped and ordered by frequency", async () => {
    const db = edgeDb([]);
    await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 });
    const lexemes = db.__log.find((l: any[]) => l[0] === "raw" && String(l[1]).includes("unnest(to_tsvector("));
    expect(lexemes).toBeDefined();
    expect(String(lexemes?.[1])).toContain("string_agg(lexeme, ' or ')");
    expect(String(lexemes?.[1])).toContain("ORDER BY array_length(positions, 1) DESC, length(lexeme) DESC");
    expect(String(lexemes?.[1])).toContain(`LIMIT ${EDGE_QUERY_TERMS}`);
    expect(String(lexemes?.[1])).toContain("to_tsvector('english', ?)");
    expect(lexemes?.[2]).toEqual([SEED]);
  });

  it("is empty, without ranking anything, when the node has no distinctive lexemes", async () => {
    for (const query of [null, "   "]) {
      const db = edgeDb([{ id: "i2", score: "0.9" }], query);
      expect(await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 })).toEqual([]);
      expect(db.__log.some((l: any[]) => l[1] === "whereNot")).toBe(false);
      expect(JSON.stringify(db.__log)).not.toContain("ts_rank");
    }
  });

  // Spec §6: an item the viewer may not read has "its point and every edge
  // touching it" absent. The targets were scoped from the start; the seed read
  // was not, so any signed-in caller holding an item id could retrieve that
  // item's lexical neighbourhood and confirm the item exists.
  it("scopes the seed read to the viewer's items, archived ones excluded", async () => {
    const db = edgeDb([{ id: "i2", score: "0.42" }]);
    await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 });
    const access = (require("@SRC/graphql/utilities/access-control") as any).applyAccessControl;
    // Twice: once for the seed read, once for the ranking query.
    expect(access).toHaveBeenCalledTimes(2);
    expect(access).toHaveBeenCalledWith(expect.anything(), expect.anything(), user, "items");
    expect(db.__log.filter((l: any[]) => l[1] === "whereRaw" && String(l[2]).includes("items.archived IS NOT TRUE"))).toHaveLength(2);
    expect(db.__log.filter((l: any[]) => l[1] === "join" && String(l[2]).includes("mem_items as items"))).toHaveLength(2);
  });

  it("is empty when the seed item is not visible to the viewer", async () => {
    // The scoped seed read finds nothing: no text, so no lexemes and no ranking.
    const db = fakeDb({ "mem_chunks#first": [], raw: [{ query: "encod" }] });
    expect(await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 })).toEqual([]);
    expect(db.__log.some((l: any[]) => l[1] === "whereNot")).toBe(false);
    // The gate ran on the seed read itself, which is the only query issued.
    expect(accessControl()).toHaveBeenCalledTimes(1);
    expect(accessControl()).toHaveBeenCalledWith(expect.anything(), expect.anything(), user, "items");
  });

  // (14) Two languages: the predicate ORs, the rank GREATESTs, and the lexemes
  // are lexed in the first configured language only.
  it("ORs the match and GREATESTs the rank across every configured language", async () => {
    const db = edgeDb([{ id: "i2", score: "0.42" }]);
    await contextMapEdges({ db, context: bilingual, user, nodeId: NODE, limit: 5 });
    const match = db.__log.find((l: any[]) => l[1] === "whereRaw" && String(l[2]).includes("chunks.fts @@"));
    expect(String(match?.[2])).toContain("chunks.fts @@ websearch_to_tsquery('english', ?)");
    expect(String(match?.[2])).toContain("chunks.fts @@ websearch_to_tsquery('german', ?)");
    expect(String(match?.[2])).not.toContain("items.fts");
    expect(match?.[3]).toEqual([LEXEMES, LEXEMES]);
    const rank = db.__log.find((l: any[]) => l[0] === "raw" && String(l[1]).includes("ts_rank"));
    expect(String(rank?.[1])).toContain("ts_rank(chunks.fts, websearch_to_tsquery('english', ?)), ts_rank(chunks.fts, websearch_to_tsquery('german', ?))");
    expect(rank?.[2]).toEqual([LEXEMES, LEXEMES]);
    const lexemes = db.__log.find((l: any[]) => l[0] === "raw" && String(l[1]).includes("unnest(to_tsvector("));
    expect(String(lexemes?.[1])).toContain("to_tsvector('english', ?)");
    expect(String(lexemes?.[1])).not.toContain("german");
  });

  // chunks.source is a uuid column: a malformed id reaches Postgres as 22P02
  // (invalid input syntax for type uuid), i.e. a failed field rather than "no
  // edges".
  it("is empty for a node id that is not a uuid, before touching the database", async () => {
    const db = edgeDb([{ id: "i2", score: "0.9" }]);
    expect(await contextMapEdges({ db, context, user, nodeId: "i1", limit: 5 })).toEqual([]);
    expect(await contextMapEdges({ db, context, user, nodeId: "", limit: 5 })).toEqual([]);
    expect(db.__log).toEqual([]);
  });

  // An unbounded limit is a grouped full-text scan the client sizes itself.
  it("clamps the limit and defaults a missing one", async () => {
    const big = edgeDb([]);
    await contextMapEdges({ db: big, context, user, nodeId: NODE, limit: 10_000_000 });
    expect(big.__log.some((l: any[]) => l[1] === "limit" && l[2] === EDGE_LIMIT_MAX)).toBe(true);
    const none = edgeDb([]);
    await contextMapEdges({ db: none, context, user, nodeId: NODE, limit: null as any });
    expect(none.__log.some((l: any[]) => l[1] === "limit" && l[2] === EDGE_LIMIT_DEFAULT)).toBe(true);
  });

  // `ORDER BY score DESC` resolves to an input column when one exists, so a
  // context declaring a field named `score` turned the query into a grouping
  // error. The positional form always means the select list's second item.
  it("orders by the score's position, not by its name", async () => {
    const db = edgeDb([]);
    await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 });
    const order = db.__log.filter((l: any[]) => l[1] === "orderByRaw").map((l: any[]) => String(l[2]));
    expect(order).toContain("2 DESC");
    expect(JSON.stringify(order)).not.toContain("score DESC");
  });

  // Ruling 27: websearch_to_tsquery consumes the aggregate, because it cannot
  // raise a tsquery syntax error at all - a lexeme carrying punctuation (a url
  // or a file path token) is re-tokenised rather than rejected, where to_tsquery
  // would fail with 42601. It also matches buildFullTextOrQuery's existing
  // ' or '-joined shape.
  it("matches and ranks with websearch_to_tsquery over the aggregated lexemes", async () => {
    const db = edgeDb([{ id: "i2", score: "0.42" }]);
    await contextMapEdges({ db, context, user, nodeId: NODE, limit: 5 });
    const match = db.__log.find((l: any[]) => l[1] === "whereRaw" && String(l[2]).includes("chunks.fts @@"));
    expect(String(match?.[2])).toContain("websearch_to_tsquery('english', ?)");
    const rank = db.__log.find((l: any[]) => l[0] === "raw" && String(l[1]).includes("ts_rank"));
    expect(String(rank?.[1])).toContain("MAX(GREATEST(ts_rank(chunks.fts, websearch_to_tsquery('english', ?)))) as score");
    // What is bound is the lexeme aggregate, never the seed passage: binding the
    // passage itself is precisely the dead query this call site started as, and
    // it would still satisfy an assertion about the function name alone.
    expect(match?.[3]).toEqual([LEXEMES]);
    expect(rank?.[2]).toEqual([LEXEMES]);
    expect(JSON.stringify([match, rank])).not.toContain(SEED);
  });
});

describe("contextProjectionStatus", () => {
  /**
   * The matrix columns of a well-shaped row. Status agrees with loadProjection
   * on what "fitted" means (Ruling: spec lines 119/127), so a row has to carry a
   * usable shape before any of the fields below are reported at all.
   */
  const shaped = (dims: number, components: number) => ({
    dims,
    components,
    mean: Array.from({ length: dims }, () => 0),
    basis: Array.from({ length: components }, () => Array.from({ length: dims }, () => 0)),
    map: [0, 1, 2].map(() => Array.from({ length: components }, () => 0)),
    intercept: [0, 0, 0],
  });

  it("reports a fitted projection with coverage", async () => {
    const db = fakeDb({
      "context_projections#first": [{ ...shaped(1536, 50), context: "mem", method: "umap+linear", version: 1, sample_size: 900, residual: 0.08, fitted_at: new Date("2026-10-04T10:00:00Z") }],
      "mem_chunks#first": [{ total: "120", mapped: "118" }],
    });
    expect(await contextProjectionStatus({ db, context })).toEqual({
      fitted: true, method: "umap+linear", fittedAt: "2026-10-04T10:00:00.000Z",
      sampleSize: 900, dims: 1536, components: 50, residual: 0.08, mappedChunks: 118, totalChunks: 120,
    });
  });
  it("reports not fitted for a missing row, a stale version, or no chunks table", async () => {
    expect((await contextProjectionStatus({ db: fakeDb({ "mem_chunks#first": [{ total: "0", mapped: "0" }] }), context }))!.fitted).toBe(false);
    const stale = fakeDb({ "context_projections#first": [{ version: 0 }], "mem_chunks#first": [{ total: "1", mapped: "0" }] });
    expect((await contextProjectionStatus({ db: stale, context }))!.fitted).toBe(false);
    const none = fakeDb({}, { hasTable: () => false });
    expect(await contextProjectionStatus({ db: none, context })).toMatchObject({ fitted: false, totalChunks: 0 });
  });
  // The four nullable fields are nullable for a reason: a row written before a
  // column existed has nulls in it, and reporting residual 0 / sample size 0 is
  // a claim about the fit rather than an admission that it is not recorded. The
  // two counts keep coercing to 0 — "no chunks" is a true count.
  it("reports a null for a nullable field that is null, and 0 for the counts", async () => {
    const db = fakeDb({
      "context_projections#first": [{ ...shaped(1536, 50), version: 1, method: "umap+linear", sample_size: null, residual: null, fitted_at: null }],
      "mem_chunks#first": [{ total: null, mapped: null }],
    });
    expect(await contextProjectionStatus({ db, context })).toEqual({
      fitted: true, method: "umap+linear", fittedAt: null,
      sampleSize: null, dims: 1536, components: 50, residual: null,
      mappedChunks: 0, totalChunks: 0,
    });
  });

  // Spec lines 119 and 127: a wrong-shape row is "not fitted". loadProjection
  // already refuses one, so without the same check here a corrupt row reported
  // fitted: true and full confidence while coverage never grew and the loader
  // logged on every cache miss.
  it("reports not fitted for a row whose shape the loader would refuse", async () => {
    const broken = [
      { ...shaped(4, 3), basis: [[0, 0, 0, 0]] },              // basis truncated
      { ...shaped(4, 3), map: [[0, 0, 0], [0, 0, 0]] },         // two-row map
      { ...shaped(4, 3), components: null },                    // no declared width
      { ...shaped(4, 3), basis: "{" },                          // unreadable json
      { version: 1, method: "umap+linear" },                    // no matrices at all
    ];
    for (const row of broken) {
      const db = fakeDb({
        "context_projections#first": [{ version: 1, method: "umap+linear", ...row }],
        "mem_chunks#first": [{ total: "10", mapped: "10" }],
      });
      const out = await contextProjectionStatus({ db, context });
      expect(out).toMatchObject({ fitted: false, method: null, residual: null, components: null });
      // The coverage counts are facts about the chunks table, not claims about
      // the fit, so they keep being reported.
      expect(out.totalChunks).toBe(10);
    }
  });

  // new Date("whenever").toISOString() throws a RangeError, inside the one
  // function whose entire job is to report status.
  it("reports a null fittedAt for an unparseable timestamp instead of throwing", async () => {
    const db = fakeDb({
      "context_projections#first": [{ ...shaped(2, 2), version: 1, method: "umap+linear", fitted_at: "whenever" }],
      "mem_chunks#first": [{ total: "1", mapped: "1" }],
    });
    await expect(contextProjectionStatus({ db, context })).resolves.toMatchObject({ fitted: true, fittedAt: null });
  });

  // Ruling 18, pinned by behaviour rather than by a docstring: swapping in the
  // cached loadProjection satisfies every other assertion here, and then reports
  // a minute-stale "not fitted" exactly while the UI polls after a fit.
  it("re-reads the projection row on every call, never a cached one", async () => {
    const db = fakeDb({
      "context_projections#first": [{ ...shaped(2, 2), version: 1, method: "umap+linear" }],
      "mem_chunks#first": [{ total: "1", mapped: "1" }],
    });
    expect((await contextProjectionStatus({ db, context })).fitted).toBe(true);
    expect((await contextProjectionStatus({ db, context })).fitted).toBe(true);
    expect(db.__log.filter((l: any[]) => l[0] === "context_projections" && l[1] === "where")).toHaveLength(2);
  });

  // Ruling 11: the fit writes `context: sanitizeName(contextId)` (fit.ts), so a
  // display-form id like "My Docs" has to be sanitised before the lookup or the
  // status of every spaced context reads as "never fitted".
  it("looks the projection row up by the sanitised context id", async () => {
    const db = fakeDb({ "context_projections#first": [{ ...shaped(2, 2), version: 1, method: "umap+linear" }] });
    const out = await contextProjectionStatus({ db, context: { ...context, id: "My Docs" } });
    expect(out.fitted).toBe(true);
    expect(db.__log).toEqual(expect.arrayContaining([["context_projections", "where", { context: "my_docs" }]]));
  });
});
