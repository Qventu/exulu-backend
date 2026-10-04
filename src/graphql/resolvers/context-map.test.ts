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

import { EDGE_QUERY_TERMS } from "@SRC/exulu/projection/constants";
import { contextMapEdges, contextMapPoints, contextProjectionStatus } from "./context-map";

/** Keys on the first word, because the resolvers call `db("mem_chunks as chunks")`. */
function fakeDb(answers: Record<string, any[]>, opts: { hasTable?: (t: string) => boolean } = {}) {
  const log: any[] = [];
  const db: any = jest.fn((table: string) => {
    const key = table.split(" ")[0];
    const chain: any = { __table: key, __scoped: false };
    for (const m of ["join", "where", "whereIn", "whereNot", "whereNotNull", "whereRaw", "groupBy", "orderBy", "orderByRaw", "limit", "select", "count", "countDistinct", "andWhere", "pluck"]) {
      chain[m] = (...args: any[]) => { log.push([key, m, ...args.filter((a) => typeof a !== "function")]); return chain; };
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

// applyAccessControl is one module-level jest.fn shared by every test here, so
// any assertion about how it was called is meaningless until the counters are
// reset between tests.
beforeEach(() => jest.clearAllMocks());

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
    expect((require("@SRC/graphql/utilities/access-control") as any).applyAccessControl).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), user, "items",
    );
  });

  it("flags a sampled result when the base is larger than the limit", async () => {
    const db = fakeDb({ mem_chunks: [], "mem_chunks#first": [{ c: "900" }] });
    const out = await contextMapPoints({ db, context, user, mode: "DOCUMENTS", limit: 10 });
    expect(out).toMatchObject({ total: 900, sampled: true });
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
  it("is empty when the node has no text", async () => {
    expect(await contextMapEdges({ db: fakeDb({ "mem_chunks#first": [] }), context, user, nodeId: NODE, limit: 5 })).toEqual([]);
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
  it("reports a fitted projection with coverage", async () => {
    const db = fakeDb({
      "context_projections#first": [{ context: "mem", dims: 1536, components: 50, method: "umap+linear", version: 1, sample_size: 900, residual: 0.08, fitted_at: new Date("2026-10-04T10:00:00Z") }],
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
  // Ruling 11: the fit writes `context: sanitizeName(contextId)` (fit.ts), so a
  // display-form id like "My Docs" has to be sanitised before the lookup or the
  // status of every spaced context reads as "never fitted".
  it("looks the projection row up by the sanitised context id", async () => {
    const db = fakeDb({ "context_projections#first": [{ version: 1, method: "umap+linear" }] });
    const out = await contextProjectionStatus({ db, context: { ...context, id: "My Docs" } });
    expect(out.fitted).toBe(true);
    expect(db.__log).toEqual(expect.arrayContaining([["context_projections", "where", { context: "my_docs" }]]));
  });
});
