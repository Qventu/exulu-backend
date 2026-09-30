/**
 * The dimension actually stored on a chunks table's `embedding` column.
 *
 * Read from the database rather than inferred from the configured model:
 * that model may since have been removed from config.litellm.yaml, and we
 * still need to classify the change correctly.
 *
 * format_type() is used instead of raw atttypmod so the value is
 * self-describing ("vector(1536)") and the parsing is testable.
 */
import { postgresClient } from "@SRC/postgres/client";
import { getChunksTableName } from "@SRC/exulu/context";

export const parseVectorDimensionality = (formatted: string | null): number | null => {
  if (!formatted) return null;
  const match = /^vector\(\s*(\d+)\s*\)$/.exec(formatted.trim());
  return match ? Number(match[1]) : null;
};

export const currentChunksDimensionality = async (
  contextId: string,
): Promise<number | null> => {
  try {
    const { db } = await postgresClient();
    const result = await db.raw(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = ?
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped`,
      [getChunksTableName(contextId)],
    );
    return parseVectorDimensionality(result?.rows?.[0]?.type ?? null);
  } catch (err) {
    console.warn(
      `[EXULU] Could not read the chunk vector dimensionality for "${contextId}":`,
      (err as Error).message,
    );
    return null;
  }
};
