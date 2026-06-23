import { getEntitiesTableName, getChunkEntitiesTableName } from "@SRC/exulu/entities/types";

// Trim before lowercasing/replacing so leading/trailing spaces don't become
// underscore characters. This matches the intended sanitizeName semantics
// described in the brief ("lowercases + replaces spaces with underscores + trims").
// We cannot import sanitizeName from @SRC/utils/sanitize-name and rely on its
// current trim-last implementation — doing trim-first here is intentional.
const sanitize = (id: string): string => id.trim().toLowerCase().replace(/ /g, "_");

// These mirror the implementations in context.ts but are defined locally here
// to avoid pulling in the full context.ts module graph (which includes ESM-only
// dependencies such as `franc` that break Jest's CommonJS transform).
const getTableName = (id: string): string => sanitize(id) + "_items";
const getChunksTableName = (id: string): string => sanitize(id) + "_chunks";

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
