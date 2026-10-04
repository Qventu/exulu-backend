import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluContext } from "@SRC/exulu/context";
import { EDGE_QUERY_TERMS, POINTS_LIMIT_DEFAULT, POINTS_LIMIT_MAX, PROJECTION_VERSION } from "@SRC/exulu/projection/constants";
import { getChunksTableName, getTableName } from "@SRC/exulu/table-names";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { chooseFullTextQuery, resolveSearchQueryTexts } from "@SRC/utils/query-preprocessing";
import { sanitizeName } from "@SRC/utils/sanitize-name";

export type MapMode = "DOCUMENTS" | "PASSAGES";
export type MapPoint = { id: string; itemId: string; x: number; y: number; z: number; label: string; group: string | null; chunks: number };
export type MapPoints = { points: MapPoint[]; total: number; sampled: boolean };
export type MapEdge = { source: string; target: string; score: number };

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" ? new Date(d).toISOString() : null);
const languagesOf = (context: ExuluContext): string[] =>
  (context.configuration?.languages?.length ? context.configuration.languages : ["english"]) as string[];
/** Only a declared field may be selected as the colouring value. */
const groupColumn = (context: ExuluContext, field?: string | null): string | null =>
  field && context.fields?.some((f: any) => f.name === field) ? field : null;

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
  // `limit` is a nullable Int in the schema, so an explicit null arrives as null
  // (a parameter default only catches undefined) and Math.min(null, MAX) is 0 —
  // one point, silently. Nothing finite means the caller did not ask, so use the
  // default; the nullish test is explicit because Number(null) is a finite 0.
  const asked = limit == null ? NaN : Number(limit);
  const capped = Math.max(1, Math.min(Number.isFinite(asked) ? asked : POINTS_LIMIT_DEFAULT, POINTS_LIMIT_MAX));
  const group = groupColumn(context, groupField);
  const languages = languagesOf(context);

  const base = () => {
    let q = db(`${chunks} as chunks`)
      .join(`${items} as items`, "items.id", "chunks.source")
      .whereNotNull("chunks.px")
      .whereRaw("items.archived IS NOT TRUE");
    if (search && search.trim()) {
      const texts = resolveSearchQueryTexts(search.trim());
      const chosen = chooseFullTextQuery({ strictMatches: false, strictText: search.trim(), orText: texts.hybridOrQuery });
      const predicate = ftsPredicate(languages, chosen.fn, chosen.text, SEARCH_COLUMNS);
      q = q.whereRaw(predicate.sql, predicate.bindings);
    }
    return applyAccessControl(table, q, user, "items");
  };

  const totalRow = mode === "DOCUMENTS"
    ? await base().countDistinct("items.id as c").first()
    : await base().count("chunks.id as c").first();
  const total = num(totalRow?.c);

  const rows: any[] = mode === "DOCUMENTS"
    ? await base()
        .groupBy("items.id", "items.name", ...(group ? [`items.${group}`] : []))
        .orderByRaw("md5(items.id::text || ?)", [context.id])
        .limit(capped)
        .select([
          db.raw("items.id as id"), db.raw("items.id as \"itemId\""),
          db.raw("AVG(chunks.px) as x"), db.raw("AVG(chunks.py) as y"), db.raw("AVG(chunks.pz) as z"),
          db.raw("items.name as label"), db.raw(group ? `items.${group} as "group"` : "NULL as \"group\""),
          db.raw("COUNT(chunks.id) as chunks"),
        ])
    : await base()
        .orderByRaw("md5(chunks.id::text || ?)", [context.id])
        .limit(capped)
        .select([
          db.raw("chunks.id as id"), db.raw("chunks.source as \"itemId\""),
          db.raw("chunks.px as x"), db.raw("chunks.py as y"), db.raw("chunks.pz as z"),
          db.raw("LEFT(COALESCE(chunks.content, items.name), 120) as label"),
          db.raw(group ? `items.${group} as "group"` : "NULL as \"group\""),
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
  db, context, user, nodeId, limit,
}: { db: any; context: ExuluContext; user: User | undefined; nodeId: string; limit: number }): Promise<MapEdge[]> {
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
      .where("chunks.source", nodeId)
      .whereRaw("items.archived IS NOT TRUE")
      .orderBy("chunks.chunk_index")
      .limit(1)
      .select(db.raw("LEFT(chunks.content, 600) as text")),
    user,
    "items",
  ).first();
  const text = String(seed?.text ?? "").trim();
  // No visible seed, or an empty one: no lexemes to ask for, no edges.
  if (!text) return [];

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
  let q = db(`${chunks} as chunks`)
    .join(`${items} as items`, "items.id", "chunks.source")
    .whereNot("chunks.source", nodeId)
    .whereRaw("items.archived IS NOT TRUE")
    .whereRaw(predicate.sql, predicate.bindings)
    .groupBy("items.id")
    .orderByRaw("score DESC")
    .limit(Math.max(1, limit))
    .select([
      db.raw("items.id as id"),
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
 * Whether the base has a usable projection, and how much of it is mapped.
 * Reads `context_projections` directly rather than through Task 4's
 * loadProjection: this is what the UI polls right after a fit, and a
 * minute-long cached "not fitted" would be a lie exactly when it is watched.
 */
export async function contextProjectionStatus({ db, context }: { db: any; context: ExuluContext }) {
  const chunks = getChunksTableName(context.id);
  const hasChunks = await db.schema.hasTable(chunks);
  const counts = hasChunks
    ? await db(chunks).select(db.raw("COUNT(*) as total"), db.raw("COUNT(px) as mapped")).first()
    : undefined;
  let row: any;
  try {
    // The fit keys the row on the sanitised id (fit.ts), the only form its
    // `--all` entry point can recover from a table name.
    row = await db("context_projections").where({ context: sanitizeName(context.id) }).first();
  } catch {
    row = undefined;
  }
  const fitted = !!row && Number(row.version) === PROJECTION_VERSION;
  return {
    fitted,
    method: fitted ? String(row.method) : null,
    fittedAt: fitted ? iso(row.fitted_at) : null,
    sampleSize: fitted ? num(row.sample_size) : null,
    dims: fitted ? num(row.dims) : null,
    components: fitted ? num(row.components) : null,
    residual: fitted ? num(row.residual) : null,
    mappedChunks: num(counts?.mapped),
    totalChunks: num(counts?.total),
  };
}
