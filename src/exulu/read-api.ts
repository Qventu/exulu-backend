import { getTableName, getChunksTableName } from "@SRC/exulu/table-names";
import { getEntitiesTableName, getChunkEntitiesTableName } from "@SRC/exulu/entities/types";
import { postgresClient } from "@SRC/postgres/client";

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
};
