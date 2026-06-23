import { getTableName, getChunksTableName } from "@SRC/exulu/table-names";
import { getEntitiesTableName, getChunkEntitiesTableName } from "@SRC/exulu/entities/types";
import { postgresClient } from "@SRC/postgres/client";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import type { User } from "@EXULU_TYPES/models/user";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";

export interface AuthorizedReadOpts {
  itemIds?: string[];
  externalIds?: string[];
  chunkIndexRange?: { from?: number; to?: number };
}

/**
 * RBAC-safe direct chunk read for known items. Joins <ctx>_chunks -> <ctx>_items
 * and applies applyAccessControl on the "items" alias, so only rows the user may
 * see are returned. A targeted read MUST be constrained (itemIds or externalIds).
 */
export const authorizedRead = async (
  context: { id: string; fields?: unknown[]; entities?: unknown },
  user: User,
  role: string,
  opts: AuthorizedReadOpts = {},
) => {
  if (!opts.itemIds?.length && !opts.externalIds?.length) {
    throw new Error("authorizedRead requires itemIds or externalIds to constrain the read.");
  }
  const { db } = await postgresClient();
  const table = convertContextToTableDefinition(context as any);
  const itemsTable = getTableName(context.id);
  const chunksTable = getChunksTableName(context.id);

  // Fold a bare role id into user.role.id so access-control's "roles" branch works.
  const acUser: User =
    role && (!user.role || user.role.id !== role)
      ? ({ ...user, role: { ...(user.role ?? ({} as any)), id: role } } as User)
      : user;

  let q = db(chunksTable + " as chunks").select([
    "chunks.id as chunk_id",
    "chunks.source as chunk_source",
    "chunks.content as chunk_content",
    "chunks.chunk_index",
    "chunks.metadata as chunk_metadata",
    db.raw('chunks."createdAt" as chunk_created_at'),
    db.raw('chunks."updatedAt" as chunk_updated_at'),
    "items.id as item_id",
    "items.name as item_name",
    "items.external_id as item_external_id",
    db.raw('items."createdAt" as item_created_at'),
    db.raw('items."updatedAt" as item_updated_at'),
  ]);
  q = q.leftJoin(itemsTable + " as items", "chunks.source", "items.id");
  if (opts.itemIds?.length) q = q.whereIn("items.id", opts.itemIds);
  if (opts.externalIds?.length) q = q.whereIn("items.external_id", opts.externalIds);
  if (opts.chunkIndexRange) {
    const { from, to } = opts.chunkIndexRange;
    if (typeof from === "number") q = q.where("chunks.chunk_index", ">=", from);
    if (typeof to === "number") q = q.where("chunks.chunk_index", "<=", to);
  }
  // CRITICAL: RBAC on the items alias — never removed.
  q = applyAccessControl(table, q, acUser, "items");
  q = q.orderBy("chunks.source").orderBy("chunks.chunk_index");
  return (await q) as VectorSearchChunkResult[];
};

/**
 * True only when the context declares an entities config AND its _chunk_entities
 * table physically exists. Used to runtime-gate entity tools so a published
 * package version without the entity layer can't break callers.
 */
export const entitiesAvailable = async (context: {
  id: string;
  entities?: unknown;
}): Promise<boolean> => {
  if (!context.entities) return false;
  const { db } = await postgresClient();
  const table = getChunkEntitiesTableName(context.id);
  const res: { rows: { exists: boolean }[] } = await db.raw(
    "SELECT to_regclass(?) IS NOT NULL AS exists",
    [table],
  );
  return res.rows?.[0]?.exists === true;
};

/**
 * Supported, RBAC-safe read API for retrieval clients (e.g. the agentic harness).
 * Relevance + visibility still go through ExuluContext.search(); this namespace
 * adds the read shapes search() cannot express, always over authorized rows.
 */
export const ExuluReadApi = {
  getTableName,
  getChunksTableName,
  getEntitiesTableName,
  getChunkEntitiesTableName,
  entitiesAvailable,
  authorizedRead,
};
