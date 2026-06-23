import { getTableName, getChunksTableName } from "@SRC/exulu/table-names";
import { getEntitiesTableName, getChunkEntitiesTableName } from "@SRC/exulu/entities/types";

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
};
