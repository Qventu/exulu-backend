import { postgresClient } from "@SRC/postgres/client";
import type { Knex } from "knex";
import { getChunksTableName, getTableName } from "../context";
import type { ExuluContext } from "../context";
import { normalizeCanonicalKey } from "./normalize";
import {
  getChunkEntitiesTableName,
  getEntitiesTableName,
  type EntityFilter,
  type EntityInsights,
  type EntityMention,
  type EntityRow,
  type QueryEntityInsight,
  type RelatedEntity,
} from "./types";

// ───────────────────────── table lifecycle ─────────────────────────

export const entitiesTableExists = async (context: ExuluContext): Promise<boolean> => {
  const { db } = await postgresClient();
  return db.schema.hasTable(getEntitiesTableName(context.id));
};

export const chunkEntitiesTableExists = async (context: ExuluContext): Promise<boolean> => {
  const { db } = await postgresClient();
  return db.schema.hasTable(getChunkEntitiesTableName(context.id));
};

export const createEntitiesTable = async (context: ExuluContext): Promise<void> => {
  const { db } = await postgresClient();
  const entitiesTable = getEntitiesTableName(context.id);
  console.log("[EXULU] Creating table: " + entitiesTable);
  await db.schema.createTable(entitiesTable, (table) => {
    table.uuid("id").primary().defaultTo(db.fn.uuid());
    table.text("type").notNullable();
    table.text("canonical_key").notNullable();
    table.text("display_name");
    table.integer("mention_count").defaultTo(0);
    table.integer("doc_count").defaultTo(0);
    table.jsonb("metadata");
    table.timestamp("createdAt").defaultTo(db.fn.now());
    table.timestamp("updatedAt").defaultTo(db.fn.now());
    table.unique(["type", "canonical_key"], { indexName: `${entitiesTable}_type_key_uq` });
  });
};

export const createChunkEntitiesTable = async (context: ExuluContext): Promise<void> => {
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);
  const entitiesTable = getEntitiesTableName(context.id);
  const chunksTable = getChunksTableName(context.id);
  console.log("[EXULU] Creating table: " + junctionTable);
  await db.schema.createTable(junctionTable, (table) => {
    table.uuid("chunk_id").notNullable().references("id").inTable(chunksTable).onDelete("CASCADE");
    table
      .uuid("entity_id")
      .notNullable()
      .references("id")
      .inTable(entitiesTable)
      .onDelete("CASCADE");
    table.uuid("item_id").notNullable();
    table.text("mention_text");
    table.specificType("confidence", "real");
    table.primary(["chunk_id", "entity_id"], { constraintName: `${junctionTable}_pkey` });
    table.index(["entity_id"], `${junctionTable}_entity_idx`);
    table.index(["entity_id", "item_id"], `${junctionTable}_entity_item_idx`);
    table.index(["item_id"], `${junctionTable}_item_idx`);
  });
};

/**
 * Add the staleness-tracking columns to the items table if missing. Idempotent
 * (gated on column existence) so it can run on every boot for graph-enabled
 * contexts, covering both new and pre-existing item tables.
 */
export const ensureItemEntityColumns = async (context: ExuluContext): Promise<void> => {
  const { db } = await postgresClient();
  const itemsTable = getTableName(context.id);

  if (!(await db.schema.hasColumn(itemsTable, "entities_updated_at"))) {
    await db.schema.alterTable(itemsTable, (t) => {
      t.timestamp("entities_updated_at").defaultTo(null);
    });
  }
  if (!(await db.schema.hasColumn(itemsTable, "entity_types_signature"))) {
    await db.schema.alterTable(itemsTable, (t) => {
      t.text("entity_types_signature").defaultTo(null);
    });
  }
};

// ───────────────────────── ingestion ─────────────────────────

const uniq = <T>(arr: T[]): T[] => Array.from(new Set(arr));

/**
 * Capture the entity ids currently linked to an item. Call this BEFORE deleting
 * the item's chunks (the FK cascade would otherwise clear the junction first),
 * so the counters of entities that lose all their mentions can be recomputed.
 */
export const getEntityIdsForItem = async (
  context: ExuluContext,
  itemId: string,
): Promise<string[]> => {
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);
  const rows = await db(junctionTable).where({ item_id: itemId }).distinct("entity_id");
  return rows.map((r: any) => r.entity_id);
};

/**
 * The resolved entities linked to a single item (for the item detail page),
 * with the per-item mention count, ordered by type then name. Empty when the
 * entity layer isn't set up yet.
 */
export const getEntitiesForItem = async (
  context: ExuluContext,
  itemId: string,
): Promise<{ id: string; type: string; name: string; mentions: number }[]> => {
  if (!(await chunkEntitiesTableExists(context))) return [];
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);
  const entitiesTable = getEntitiesTableName(context.id);
  const rows = await db(`${junctionTable} as j`)
    .join(`${entitiesTable} as e`, "e.id", "j.entity_id")
    .where("j.item_id", itemId)
    .groupBy("e.id", "e.type", "e.display_name")
    .select(
      "e.id as id",
      "e.type as type",
      "e.display_name as name",
      db.raw("COUNT(*)::int as mentions"),
    )
    .orderBy([
      { column: "e.type", order: "asc" },
      { column: "e.display_name", order: "asc" },
    ]);
  return rows.map((r: any) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    mentions: Number(r.mentions) || 0,
  }));
};

/**
 * Persist extracted mentions for one item: upsert canonical entities, rebuild
 * the item's junction rows, recompute affected counters, and stamp the item's
 * staleness signature — all in a single transaction.
 */
export const ingestEntitiesForItem = async ({
  context,
  itemId,
  mentions,
  signature,
  previousEntityIds,
}: {
  context: ExuluContext;
  itemId: string;
  mentions: EntityMention[];
  signature: string;
  /** Entity ids linked to this item before re-ingest (captured pre chunk-delete). */
  previousEntityIds?: string[];
}): Promise<void> => {
  const { db } = await postgresClient();
  const entitiesTable = getEntitiesTableName(context.id);
  const junctionTable = getChunkEntitiesTableName(context.id);
  const chunksTable = getChunksTableName(context.id);
  const itemsTable = getTableName(context.id);

  await db.transaction(async (trx) => {
    // Old entity ids for counter recomputation: caller-supplied (normal ingest,
    // where cascade already cleared the junction) or read here (backfill path).
    const oldEntityIds =
      previousEntityIds ??
      (await trx(junctionTable).where({ item_id: itemId }).distinct("entity_id")).map(
        (r: any) => r.entity_id,
      );

    // Clear any junction rows still attached to this item (idempotent for backfill).
    await trx(junctionTable).where({ item_id: itemId }).delete();

    // Map chunk_index -> chunk_id for the item's current chunks.
    const chunkRows = await trx(chunksTable)
      .where({ source: itemId })
      .select("id", "chunk_index");
    const chunkIdByIndex = new Map<number, string>();
    for (const c of chunkRows) chunkIdByIndex.set(Number(c.chunk_index), c.id);

    let upsertedIds: string[] = [];

    if (mentions.length) {
      // Group into unique entities by (type, canonical_key).
      const entityByKey = new Map<string, { type: string; canonical_key: string; display_name: string }>();
      for (const m of mentions) {
        const canonical_key = normalizeCanonicalKey(m.canonical);
        if (!canonical_key) continue;
        const key = `${m.type}|${canonical_key}`;
        if (!entityByKey.has(key)) {
          entityByKey.set(key, { type: m.type, canonical_key, display_name: m.canonical });
        }
      }

      const idByKey = new Map<string, string>();
      if (entityByKey.size) {
        const inserted = await trx(entitiesTable)
          .insert(Array.from(entityByKey.values()))
          .onConflict(["type", "canonical_key"])
          .merge({ updatedAt: trx.fn.now() })
          .returning(["id", "type", "canonical_key"]);
        for (const row of inserted as any[]) {
          idByKey.set(`${row.type}|${row.canonical_key}`, row.id);
        }
      }
      upsertedIds = Array.from(idByKey.values());

      // Build junction rows, deduped by (chunk_id, entity_id).
      const seen = new Set<string>();
      const junctionRows: any[] = [];
      for (const m of mentions) {
        const canonical_key = normalizeCanonicalKey(m.canonical);
        const entityId = idByKey.get(`${m.type}|${canonical_key}`);
        const chunkId = chunkIdByIndex.get(Number(m.chunkIndex));
        if (!entityId || !chunkId) continue;
        const dedupeKey = `${chunkId}|${entityId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        junctionRows.push({
          chunk_id: chunkId,
          entity_id: entityId,
          item_id: itemId,
          mention_text: m.mention,
          confidence: m.confidence,
        });
      }

      if (junctionRows.length) {
        await trx(junctionTable).insert(junctionRows).onConflict(["chunk_id", "entity_id"]).ignore();
      }
    }

    // Recompute counters for all affected entities (old ∪ new).
    const affected = uniq([...oldEntityIds, ...upsertedIds]);
    if (affected.length) {
      await trx(entitiesTable).whereIn("id", affected).update({ mention_count: 0, doc_count: 0 });
      const placeholders = affected.map(() => "?").join(",");
      await trx.raw(
        `UPDATE ${entitiesTable} e
         SET mention_count = sub.mc, doc_count = sub.dc
         FROM (
           SELECT entity_id, COUNT(*)::int AS mc, COUNT(DISTINCT item_id)::int AS dc
           FROM ${junctionTable}
           WHERE entity_id IN (${placeholders})
           GROUP BY entity_id
         ) sub
         WHERE e.id = sub.entity_id`,
        affected,
      );
    }

    await trx(itemsTable)
      .where({ id: itemId })
      .update({
        entities_updated_at: new Date().toISOString(),
        entity_types_signature: signature,
      });
  });
};

/**
 * Detach ALL entities from a single item: drop the item's junction rows,
 * recompute the affected entities' counters, and delete any that are now
 * orphaned (no remaining mentions anywhere). Clears the item's entity
 * signature so a later extraction re-runs cleanly. Returns the number of
 * distinct entities that were detached from the item.
 */
export const detachEntitiesForItem = async (
  context: ExuluContext,
  itemId: string,
): Promise<number> => {
  if (!(await chunkEntitiesTableExists(context))) return 0;
  const { db } = await postgresClient();
  const entitiesTable = getEntitiesTableName(context.id);
  const junctionTable = getChunkEntitiesTableName(context.id);
  const itemsTable = getTableName(context.id);

  let detached = 0;
  await db.transaction(async (trx) => {
    const affected = (
      await trx(junctionTable).where({ item_id: itemId }).distinct("entity_id")
    ).map((r: any) => r.entity_id);
    detached = affected.length;
    if (!affected.length) return;

    await trx(junctionTable).where({ item_id: itemId }).delete();

    // Recompute counters for the affected entities from their remaining links.
    await trx(entitiesTable).whereIn("id", affected).update({ mention_count: 0, doc_count: 0 });
    const placeholders = affected.map(() => "?").join(",");
    await trx.raw(
      `UPDATE ${entitiesTable} e
       SET mention_count = sub.mc, doc_count = sub.dc
       FROM (
         SELECT entity_id, COUNT(*)::int AS mc, COUNT(DISTINCT item_id)::int AS dc
         FROM ${junctionTable}
         WHERE entity_id IN (${placeholders})
         GROUP BY entity_id
       ) sub
       WHERE e.id = sub.entity_id`,
      affected,
    );
    // Entities with no remaining mentions anywhere are orphans — remove them.
    await trx(entitiesTable).whereIn("id", affected).where({ mention_count: 0 }).delete();

    await trx(itemsTable)
      .where({ id: itemId })
      .update({ entities_updated_at: new Date().toISOString(), entity_types_signature: null });
  });
  return detached;
};

// ───────────────────────── retrieval helpers ─────────────────────────

/** Resolve query mentions to existing entity rows (only entities that exist). */
export const resolveQueryEntities = async (
  context: ExuluContext,
  mentions: EntityMention[],
): Promise<EntityRow[]> => {
  if (!mentions.length) return [];
  const { db } = await postgresClient();
  const entitiesTable = getEntitiesTableName(context.id);

  const pairs = uniq(
    mentions.map((m) => `${m.type}|${normalizeCanonicalKey(m.canonical)}`),
  ).map((k) => k.split("|"));

  if (!pairs.length) return [];
  const rows = await db(entitiesTable).whereIn(["type", "canonical_key"], pairs);
  return rows as EntityRow[];
};

/** Count, per candidate chunk, how many of the query entities it mentions. */
export const getSharedEntityCounts = async (
  context: ExuluContext,
  chunkIds: string[],
  entityIds: string[],
): Promise<Map<string, number>> => {
  const result = new Map<string, number>();
  if (!chunkIds.length || !entityIds.length) return result;
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);

  const rows = await db(junctionTable)
    .whereIn("chunk_id", chunkIds)
    .whereIn("entity_id", entityIds)
    .groupBy("chunk_id")
    .select("chunk_id")
    .count("* as cnt");

  for (const r of rows as any[]) result.set(r.chunk_id, Number(r.cnt));
  return result;
};

/** Map each chunk to the entities it mentions (id, name, type). */
export const getEntitiesForChunks = async (
  context: ExuluContext,
  chunkIds: string[],
): Promise<Map<string, { id: string; name: string; type: string }[]>> => {
  const result = new Map<string, { id: string; name: string; type: string }[]>();
  if (!chunkIds.length) return result;
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);
  const entitiesTable = getEntitiesTableName(context.id);

  const rows = await db(junctionTable + " as j")
    .whereIn("j.chunk_id", chunkIds)
    .join(entitiesTable + " as e", "e.id", "j.entity_id")
    .select("j.chunk_id as chunk_id", "e.id as id", "e.display_name as name", "e.type as type");

  for (const r of rows as any[]) {
    const list = result.get(r.chunk_id) || [];
    list.push({ id: r.id, name: r.name, type: r.type });
    result.set(r.chunk_id, list);
  }
  return result;
};

/** Derived co-occurrence: entities related to the given one, weighted (Jaccard). */
export const getRelatedEntities = async (
  context: ExuluContext,
  entity: { id: string; doc_count: number },
  k: number = 5,
): Promise<RelatedEntity[]> => {
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);
  const entitiesTable = getEntitiesTableName(context.id);

  const rows = await db(junctionTable + " as j1")
    .join(junctionTable + " as j2", function (this: Knex.JoinClause) {
      this.on("j1.item_id", "=", "j2.item_id").andOn("j2.entity_id", "!=", "j1.entity_id");
    })
    .join(entitiesTable + " as e2", "e2.id", "j2.entity_id")
    .where("j1.entity_id", entity.id)
    .groupBy("e2.id", "e2.display_name", "e2.type", "e2.doc_count")
    .select("e2.id as id", "e2.display_name as name", "e2.type as type", "e2.doc_count as doc_count")
    .countDistinct("j2.item_id as shared")
    .orderBy("shared", "desc")
    .limit(k);

  return (rows as any[]).map((r) => {
    const shared = Number(r.shared);
    const docsB = Number(r.doc_count) || 0;
    const docsA = entity.doc_count || 0;
    const union = docsA + docsB - shared;
    const weight = union > 0 ? Number((shared / union).toFixed(4)) : 0;
    return { id: r.id, name: r.name, type: r.type, weight };
  });
};

/**
 * Build the entity-intelligence payload for the returned result set. For each
 * query entity: how many returned chunks mention it, its maintained doc count,
 * and its top related entities.
 */
export const buildEntityInsights = async (
  context: ExuluContext,
  queryEntities: EntityRow[],
  resultChunkIds: string[],
  relatedLimit: number = 5,
): Promise<EntityInsights> => {
  if (!queryEntities.length) return { queryEntities: [] };
  const { db } = await postgresClient();
  const junctionTable = getChunkEntitiesTableName(context.id);

  // matchedInResults per query entity, in one query.
  const matched = new Map<string, number>();
  if (resultChunkIds.length) {
    const rows = await db(junctionTable)
      .whereIn("chunk_id", resultChunkIds)
      .whereIn(
        "entity_id",
        queryEntities.map((e) => e.id),
      )
      .groupBy("entity_id")
      .select("entity_id")
      .countDistinct("chunk_id as cnt");
    for (const r of rows as any[]) matched.set(r.entity_id, Number(r.cnt));
  }

  const insights: QueryEntityInsight[] = [];
  for (const e of queryEntities) {
    const relatedEntities = await getRelatedEntities(
      context,
      { id: e.id, doc_count: e.doc_count },
      relatedLimit,
    );
    insights.push({
      id: e.id,
      type: e.type,
      name: e.display_name,
      matchedInResults: matched.get(e.id) || 0,
      relatedDocCount: e.doc_count || 0,
      relatedEntities,
    });
  }

  return { queryEntities: insights };
};

/** Resolve an EntityFilter to a concrete list of entity ids. */
export const resolveEntityFilter = async (
  context: ExuluContext,
  filter: EntityFilter,
): Promise<string[]> => {
  const { db } = await postgresClient();
  const entitiesTable = getEntitiesTableName(context.id);
  let ids = [...(filter.entityIds || [])];

  if (filter.entities?.length) {
    const pairs = filter.entities.map((e) => [e.type, normalizeCanonicalKey(e.name)]);
    const rows = await db(entitiesTable).whereIn(["type", "canonical_key"], pairs).select("id");
    ids = [...ids, ...rows.map((r: any) => r.id)];
  }

  return uniq(ids);
};

/**
 * Restrict a chunks query to chunks mentioning the given entities. `mode: "all"`
 * requires every entity; `"any"` (default) requires at least one. Mutates and
 * returns the query.
 */
export const applyEntityFilter = (
  query: Knex.QueryBuilder,
  chunkAlias: string,
  context: ExuluContext,
  entityIds: string[],
  mode: "any" | "all",
): Knex.QueryBuilder => {
  const junctionTable = getChunkEntitiesTableName(context.id);
  if (!entityIds.length) {
    // No resolvable entities → no matches.
    return query.whereRaw("1 = 0");
  }

  if (mode === "all") {
    query.whereIn(`${chunkAlias}.id`, function (this: Knex.QueryBuilder) {
      this.from(junctionTable)
        .whereIn("entity_id", entityIds)
        .groupBy("chunk_id")
        .havingRaw("COUNT(DISTINCT entity_id) = ?", [entityIds.length])
        .select("chunk_id");
    });
  } else {
    query.whereIn(`${chunkAlias}.id`, function (this: Knex.QueryBuilder) {
      this.from(junctionTable).whereIn("entity_id", entityIds).distinct("chunk_id").select("chunk_id");
    });
  }
  return query;
};
