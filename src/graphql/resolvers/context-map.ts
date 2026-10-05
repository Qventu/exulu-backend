import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import {
  EDGE_LIMIT_DEFAULT, EDGE_LIMIT_MAX, EDGE_QUERY_TERMS,
  POINTS_LIMIT_DEFAULT, POINTS_LIMIT_MAX, PROJECTION_VERSION,
} from "@SRC/exulu/projection/constants";
import { readProjectionRow } from "@SRC/exulu/projection/store";
import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { chooseFullTextQuery, resolveSearchQueryTexts } from "@SRC/utils/query-preprocessing";
import { sanitizeName } from "@SRC/utils/sanitize-name";

export type MapMode = "DOCUMENTS" | "PASSAGES";
export type MapPoint = { id: string; itemId: string; x: number; y: number; z: number; label: string; group: string | null; chunks: number };
export type MapPoints = { points: MapPoint[]; total: number; sampled: boolean };
export type MapEdge = { source: string; target: string; score: number };
export type MapTopic = { id: string; label: string; count: number; x: number; y: number; z: number };

/** For counts: "no rows" is a true 0, and null means the same thing. */
const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
/**
 * For the nullable status fields: a null column is "not recorded", and
 * answering 0 would be a claim about the fit (a residual of 0 is a perfect map).
 */
const maybeNum = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Never throws: `new Date("whenever").toISOString()` is a RangeError. */
const iso = (d: unknown): string | null => {
  const date = d instanceof Date ? d : typeof d === "string" || typeof d === "number" ? new Date(d) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
/** chunks.source is a uuid column; anything else is 22P02, not "no edges". */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One clamp for both read APIs: a missing or unusable limit is the default. */
const clamp = (limit: number | null | undefined, fallback: number, max: number): number => {
  // The nullish test is explicit because Number(null) is a finite 0, which would
  // clamp to 1 instead of falling back.
  const asked = limit == null ? NaN : Number(limit);
  return Math.max(1, Math.min(Number.isFinite(asked) ? asked : fallback, max));
};
const languagesOf = (context: ExuluContext): string[] =>
  (context.configuration?.languages?.length ? context.configuration.languages : ["english"]) as string[];
/**
 * The physical column to colour the points by, or null when the request's
 * `groupField` cannot be honoured — in which case it is ignored, per spec §5,
 * rather than failing the query.
 *
 * This is the only place a request value reaches raw SQL, and four separate
 * things have to be true before it does:
 *  - the field is declared on the context (an undeclared name is not a column);
 *  - it is not `hidden`, this repo's write-only-secret contract (see
 *    field-allow-list.ts) — grouping by one would return the secret for every
 *    item the caller can read;
 *  - it is not a `file` field, whose column is `<name>_s3key` (createItemsTable):
 *    the declared name is not the column, and grouping by a storage key is
 *    meaningless anyway;
 *  - its sanitised name is a plain identifier. Columns are created as
 *    `sanitizeName(field.name)`, so a declared "Doc Type" lives in `doc_type`,
 *    and anything that still carries punctuation after sanitising is refused
 *    instead of being interpolated.
 * The declared and the sanitised spelling are both accepted as input, which also
 * makes the answer independent of whether anything has mutated `field.name`.
 */
const groupColumn = (context: ExuluContext, field?: string | null): string | null => {
  if (!field) return null;
  const wanted = sanitizeName(field);
  const declared = context.fields?.find((f: any) => {
    const name = String(f?.name ?? "");
    return name === field || sanitizeName(name) === wanted;
  });
  if (!declared || declared.hidden === true || declared.type === "file") return null;
  const column = sanitizeName(String(declared.name));
  return /^[a-z0-9_]+$/.test(column) ? column : null;
};

/**
 * A full-text predicate and its bindings: one disjunct per configured language
 * × searched column, each binding the same query string. Kept as one function
 * so the SQL and the binding list cannot drift apart.
 *
 * The language is interpolated as a SQL literal and only the text is bound —
 * the shape vector-search.ts already uses, because a bound `regconfig`
 * parameter is untested here and the languages come from the context
 * configuration, never from the request.
 */
const ftsPredicate = (
  languages: string[], fn: string, text: string, columns: string[],
): { sql: string; bindings: string[] } => ({
  sql: `(${languages.flatMap((lang) => columns.map((col) => `${col} @@ ${fn}('${lang}', ?)`)).join(" OR ")})`,
  bindings: languages.flatMap(() => columns.map(() => text)),
});

/**
 * Spec §5 is "items whose name or text matches", so a point search spans the
 * items table's own generated vector as well as the chunks'. That column covers
 * name, description and external id (see createItemsTable), and without it a
 * document found by its title matches nothing unless the title recurs in the
 * body. Edges search chunk text only: a neighbour is a passage, not a title.
 */
const SEARCH_COLUMNS = ["chunks.fts", "items.fts"];

/**
 * Whether an items table carries the generated `fts` column.
 *
 * This branch is the only reader of `items.fts` in the repo, and the boot
 * migration in init-exulu-db.ts adds no such column — so an items table created
 * before the generated column existed has none, and the disjunct failed the
 * whole `contextMapPoints` field with 42703 instead of returning a degraded
 * result. Probed once per table per process, and only when there is a search,
 * so an unsearched map pays nothing.
 */
const itemsFtsProbes = new Map<string, boolean>();
/** Testing seam: the answer is otherwise kept for the life of the process. */
export function clearMapColumnProbes(): void { itemsFtsProbes.clear(); }

const searchesItemNames = async (db: any, items: string): Promise<boolean> => {
  const cached = itemsFtsProbes.get(items);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    exists = !!(await db.schema.hasColumn(items, "fts"));
  } catch (e) {
    // A failed probe is "no column": the fallback returns fewer matches, the
    // disjunct returns none at all.
    console.error(`[EXULU] could not check ${items} for an fts column; assuming it has none`, e instanceof Error ? e.message : String(e));
  }
  itemsFtsProbes.set(items, exists);
  // Once per table, the first time it falls back - a map that silently stops
  // matching titles is otherwise indistinguishable from one with no matches.
  // The answer is cached for the life of the process, so adding the column to
  // an older table needs a restart before map search picks it up.
  if (!exists) console.log(`[EXULU] ${items} has no fts column; map search matches chunk text only until this process restarts`);
  return exists;
};

/** Points for the map (spec §5). Item-level access control, the same call vector search makes. */
export async function contextMapPoints({
  db, context, user, mode = "DOCUMENTS", groupField, search, limit = POINTS_LIMIT_DEFAULT,
}: {
  db: any; context: ExuluContext; user: User | undefined; mode?: MapMode;
  groupField?: string | null; search?: string | null; limit?: number | null;
}): Promise<MapPoints> {
  const chunks = getChunksTableName(context.id);
  const items = getTableName(context.id);
  if (!(await db.schema.hasTable(chunks))) return { points: [], total: 0, sampled: false };

  const table = convertContextToTableDefinition(context);
  // `limit` is a nullable Int in the schema, so an explicit null arrives here as
  // null (a parameter default only catches undefined) and used to clamp to one
  // single point.
  const capped = clamp(limit, POINTS_LIMIT_DEFAULT, POINTS_LIMIT_MAX);
  const group = groupColumn(context, groupField);
  const languages = languagesOf(context);
  // The fit's own sample salt (fit.ts). In PASSAGES mode the expression is
  // identical — md5(chunks.id::text || salt) — so a sampled map really does show
  // the chunks the projection was fitted on. In DOCUMENTS mode it salts
  // items.id instead, which only makes the item sample deterministic and stable
  // between calls; that sample has nothing to do with the fit's.
  const salt = sanitizeName(context.id);

  // Spec line 114: `search` narrows the map to matching items, so it decides
  // membership, not position. In DOCUMENTS mode the predicate must therefore
  // stay off the chunk rows AVG(chunks.px) averages — filtering them moved a
  // document whose body only partly matched to the centroid of its matching
  // chunks, i.e. a search dragged the cloud around. In PASSAGES mode each point
  // IS a chunk, so there filtering the chunk rows is exactly right.
  const trimmed = search?.trim() ? search.trim() : "";
  let predicate: { sql: string; bindings: string[] } | null = null;
  if (trimmed) {
    const texts = resolveSearchQueryTexts(trimmed);
    const chosen = chooseFullTextQuery({ strictMatches: false, strictText: trimmed, orText: texts.hybridOrQuery });
    const byName = await searchesItemNames(db, items);
    if (mode === "DOCUMENTS") {
      const inner = ftsPredicate(languages, chosen.fn, chosen.text, ["s.fts"]);
      // Correlated on the item, so it answers "does this document match?"
      // without constraining the row set being averaged. The table name is
      // sanitizeName(context.id) + "_chunks" (table-names.ts) and never carries
      // a request value.
      const parts = [
        ...(byName ? [ftsPredicate(languages, chosen.fn, chosen.text, ["items.fts"])] : []),
        {
          sql: `EXISTS (SELECT 1 FROM "${chunks}" AS s WHERE s.source = items.id AND ${inner.sql})`,
          bindings: inner.bindings,
        },
      ];
      predicate = { sql: `(${parts.map((p) => p.sql).join(" OR ")})`, bindings: parts.flatMap((p) => p.bindings) };
    } else {
      predicate = ftsPredicate(languages, chosen.fn, chosen.text, byName ? SEARCH_COLUMNS : ["chunks.fts"]);
    }
  }

  const base = () => {
    let q = db(`${chunks} as chunks`)
      .join(`${items} as items`, "items.id", "chunks.source")
      .whereNotNull("chunks.px")
      .whereRaw("items.archived IS NOT TRUE");
    if (predicate) q = q.whereRaw(predicate.sql, predicate.bindings);
    return applyAccessControl(table, q, user, "items");
  };

  const totalRow = mode === "DOCUMENTS"
    ? await base().countDistinct("items.id as c").first()
    : await base().count("chunks.id as c").first();
  const total = num(totalRow?.c);

  const rows: any[] = mode === "DOCUMENTS"
    ? await base()
        .groupBy("items.id", "items.name", ...(group ? [`items.${group}`] : []))  // knex quotes these itself
        .orderByRaw("md5(items.id::text || ?)", [salt])
        .limit(capped)
        .select([
          db.raw("items.id as id"), db.raw("items.id as \"itemId\""),
          db.raw("AVG(chunks.px) as x"), db.raw("AVG(chunks.py) as y"), db.raw("AVG(chunks.pz) as z"),
          db.raw("items.name as label"), db.raw(group ? `items."${group}" as "group"` : "NULL as \"group\""),
          db.raw("COUNT(chunks.id) as chunks"),
        ])
    : await base()
        .orderByRaw("md5(chunks.id::text || ?)", [salt])
        .limit(capped)
        .select([
          db.raw("chunks.id as id"), db.raw("chunks.source as \"itemId\""),
          db.raw("chunks.px as x"), db.raw("chunks.py as y"), db.raw("chunks.pz as z"),
          db.raw("LEFT(COALESCE(chunks.content, items.name), 120) as label"),
          db.raw(group ? `items."${group}" as "group"` : "NULL as \"group\""),
          db.raw("1 as chunks"),
        ]);

  return {
    points: rows.map((r) => ({
      id: String(r.id), itemId: String(r.itemId),
      x: num(r.x), y: num(r.y), z: num(r.z),
      label: String(r.label ?? ""), group: r.group == null ? null : String(r.group), chunks: num(r.chunks),
    })),
    total,
    sampled: total > capped,
  };
}

/**
 * A node's strongest lexical neighbours, from the generated tsvector index.
 *
 * The query is built from the node's OWN lexemes, not through
 * query-preprocessing: those helpers are made for short user queries, and a
 * 600-character passage blows past their MAX_OR_TERMS bound, which falls back
 * to the strict AND form — an "every lexeme of this passage" predicate that
 * nothing but a near-duplicate satisfies. Their doc comment expects a semantic
 * branch to carry long passages, and an edge query has none. So Postgres picks
 * the terms instead: most frequent in the passage first, then longest, capped
 * at EDGE_QUERY_TERMS.
 *
 * Those lexemes are joined with " or " and consumed by `websearch_to_tsquery`,
 * the same shape `buildFullTextOrQuery` already produces for the hybrid search.
 * The point is that `websearch_to_tsquery` cannot raise a tsquery syntax error:
 * a lexeme is not valid tsquery input, since the default parser emits url, email
 * and file tokens carrying `&`, `?` or `=`, and `to_tsquery` rejects those with
 * 42601. Re-tokenising such a lexeme can push the term count slightly past the
 * cap, which is harmless.
 */
export async function contextMapEdges({
  db, context, user, nodeId, mode = "DOCUMENTS", limit,
}: {
  db: any; context: ExuluContext; user: User | undefined; nodeId: string;
  mode?: MapMode; limit?: number | null;
}): Promise<MapEdge[]> {
  // Before anything else: a node id that is not a uuid cannot match a
  // `chunks.source`, and handing it to Postgres raises 22P02.
  if (!UUID.test(String(nodeId ?? ""))) return [];
  const chunks = getChunksTableName(context.id);
  const items = getTableName(context.id);
  if (!(await db.schema.hasTable(chunks))) return [];

  const table = convertContextToTableDefinition(context);
  // The seed read carries the same gate as the targets. Spec §6 promises that an
  // item the viewer may not read has its point and every edge touching it
  // absent; an unscoped seed would let any signed-in caller holding an item id
  // retrieve that item's lexical neighbourhood, and so confirm it exists.
  const seed = await applyAccessControl(
    table,
    db(`${chunks} as chunks`)
      .join(`${items} as items`, "items.id", "chunks.source")
      // Spec §5 gives a point the chunk id in PASSAGES mode and the item id in
      // DOCUMENTS mode, and the 3D view wires a point's id straight in — so both
      // have to seed. Grouped, so the access-control and archived predicates
      // still AND over the pair instead of OR-ing past them.
      .where((b: any) => b.where("chunks.source", nodeId).orWhere("chunks.id", nodeId))
      .whereRaw("items.archived IS NOT TRUE")
      // Deterministic for an item id: its first chunk.
      .orderBy("chunks.chunk_index")
      .limit(1)
      .select(db.raw("LEFT(chunks.content, 600) as text"), db.raw("chunks.source as \"itemId\"")),
    user,
    "items",
  ).first();
  const text = String(seed?.text ?? "").trim();
  // No visible seed, or an empty one: no lexemes to ask for, no edges.
  if (!text) return [];
  // The seed's OWN item, which for an item id is nodeId itself. With a chunk id
  // `chunks.source <> nodeId` excludes nothing, so the node's strongest
  // neighbour would come back as the document it is part of.
  const seedItem = String(seed?.itemId ?? nodeId);

  const languages = languagesOf(context);
  // The terms are lexed in the first configured language; the resulting tsquery
  // is then matched against every language's share of the generated column, the
  // way vector-search.ts applies one query string across languages.
  const primary = languages[0] ?? "english";
  const lexemes = await db.raw(
    `SELECT string_agg(lexeme, ' or ') AS query
       FROM (SELECT lexeme
               FROM unnest(to_tsvector('${primary}', ?))
              ORDER BY array_length(positions, 1) DESC, length(lexeme) DESC
              LIMIT ${EDGE_QUERY_TERMS}) t`,
    [text],
  );
  const terms = String(lexemes?.rows?.[0]?.query ?? "").trim();
  // Null or blank: the passage carried nothing distinctive (stop words only, or
  // a tsvector the configured dictionary emptied). No edges, no ranking query.
  if (!terms) return [];

  const predicate = ftsPredicate(languages, "websearch_to_tsquery", terms, ["chunks.fts"]);
  // Spec §5 identifies a point by the chunk id in PASSAGES mode and by the item
  // id in DOCUMENTS mode, and the view joins an edge's target straight onto a
  // point. So the neighbourhood is grouped and reported at the granularity the
  // caller is drawing: grouped by the item, a passage view gets back ids no
  // point on its cloud owns, and every line attaches to nothing.
  //
  // The exclusion below stays on the owner ITEM in both modes: sibling passages
  // of the same document share the node's lexemes almost by definition, and
  // would otherwise fill every line a passage node has.
  const passages = mode === "PASSAGES";
  let q = db(`${chunks} as chunks`)
    .join(`${items} as items`, "items.id", "chunks.source")
    .whereNot("chunks.source", seedItem)
    .whereRaw("items.archived IS NOT TRUE")
    .whereRaw(predicate.sql, predicate.bindings)
    .groupBy(passages ? "chunks.id" : "items.id")
    // Positional, because `score` would otherwise resolve to an input column of
    // that name if the context declares one, which makes it a grouping error.
    .orderByRaw("2 DESC")
    .limit(clamp(limit, EDGE_LIMIT_DEFAULT, EDGE_LIMIT_MAX))
    .select([
      db.raw(passages ? "chunks.id as id" : "items.id as id"),
      db.raw(
        `MAX(GREATEST(${languages.map((lang) => `ts_rank(chunks.fts, websearch_to_tsquery('${lang}', ?))`).join(", ")})) as score`,
        languages.map(() => terms),
      ),
    ]);
  q = applyAccessControl(table, q, user, "items");

  const rows: any[] = await q;
  return rows.map((r) => ({ source: nodeId, target: String(r.id), score: num(r.score) }));
}

/**
 * A context's named regions (3c-2 spec §3.1): one labelled centroid per region
 * of the fitted cloud, as the last fit named them.
 *
 * Keyed on the sanitised context id, the only form the fit can recover from a
 * table name, exactly as `context_projections` is.
 *
 * Filtered on the current projection version, so a row left behind by an older
 * layout reads as no topics at all rather than drawing yesterday's labels over
 * today's coordinates. (A fit replaces the whole set regardless of version, so
 * this only matters for a base nobody has refitted since the bump.)
 *
 * The counts and labels are the fit's own, over every chunk it sampled, and are
 * deliberately NOT access-scoped: a region describes the base, not the reader's
 * slice of it, exactly as contextProjectionStatus reports coverage. Nothing
 * here is content — no chunk text, no item name, no id a reader could look up.
 */
export async function contextMapTopics({ db, context }: { db: any; context: ExuluContext }): Promise<MapTopic[]> {
  try {
    // A deployment whose core tables predate context_map_topics has none.
    if (!(await db.schema.hasTable("context_map_topics"))) return [];
    const rows: any[] = await db("context_map_topics")
      .where({ context: sanitizeName(context.id), version: PROJECTION_VERSION })
      .orderBy("topic_index")
      .select("topic_index", "label", "count", "x", "y", "z");
    return rows.map((r) => ({
      id: String(r.topic_index),
      label: String(r.label ?? ""),
      // NUMERIC arrives as a string over the wire, and a region whose position
      // is a string is a region the client draws at NaN.
      count: num(r.count), x: num(r.x), y: num(r.y), z: num(r.z),
    }));
  } catch (e) {
    // A base without regions draws as a cloud without labels; it is never an
    // error worth failing the page for.
    console.error("[EXULU] could not read context map topics", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/**
 * Whether the base has a usable projection, and how much of it is mapped.
 * Reads `context_projections` directly rather than through Task 4's
 * loadProjection: this is what the UI polls right after a fit, and a
 * minute-long cached "not fitted" would be a lie exactly when it is watched.
 *
 * The row still goes through `readProjectionRow`, the loader's own shape check,
 * so "fitted" means one thing in both places (spec lines 119 and 127). What is
 * skipped is the cache, not the verdict.
 */
export async function contextProjectionStatus({ db, context }: { db: any; context: ExuluContext }) {
  const chunks = getChunksTableName(context.id);
  const hasChunks = await db.schema.hasTable(chunks);
  let counts: any;
  try {
    // Wrapped like the projection read below: a chunks table that predates the
    // px/py/pz columns raises 42703 here, and "nothing mapped yet" is the
    // honest answer rather than a failed field.
    if (hasChunks) counts = await db(chunks).select(db.raw("COUNT(*) as total"), db.raw("COUNT(px) as mapped")).first();
  } catch {
    counts = undefined;
  }
  let row: any;
  try {
    // The fit keys the row on the sanitised id (fit.ts), the only form its
    // `--all` entry point can recover from a table name.
    // The whole row on purpose: the shape check below reads the four matrix
    // columns, so narrowing this to the scalar columns would report every
    // fitted base as unfitted. Narrow it only by moving the shape check into
    // SQL (jsonb_array_length), never by trimming the select alone.
    row = await db("context_projections").where({ context: sanitizeName(context.id) }).first();
  } catch {
    row = undefined;
  }
  // A wrong-shape row is "not fitted" here exactly as it is for the loader: it
  // would otherwise report full confidence while coverage never grew.
  const fitted = !!row && Number(row.version) === PROJECTION_VERSION && !readProjectionRow(row).problem;
  return {
    fitted,
    method: fitted ? String(row.method) : null,
    fittedAt: fitted ? iso(row.fitted_at) : null,
    sampleSize: fitted ? maybeNum(row.sample_size) : null,
    dims: fitted ? maybeNum(row.dims) : null,
    components: fitted ? maybeNum(row.components) : null,
    residual: fitted ? maybeNum(row.residual) : null,
    mappedChunks: num(counts?.mapped),
    totalChunks: num(counts?.total),
  };
}
