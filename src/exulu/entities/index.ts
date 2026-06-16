import { postgresClient } from "@SRC/postgres/client";
import { getChunksTableName } from "../context";
import type { ExuluContext } from "../context";
import { entitiesEnabled, hydrateEntityTypes } from "./config";
import { extractEntitiesForItem } from "./extractor";
import { computeTypesSignature } from "./normalize";
import {
  chunkEntitiesTableExists,
  createChunkEntitiesTable,
  createEntitiesTable,
  ensureItemEntityColumns,
  entitiesTableExists,
  getEntityIdsForItem,
  ingestEntitiesForItem,
} from "./store";

export * from "./types";
export * from "./config";
export * from "./normalize";
export * from "./extractor";
export * from "./store";

/**
 * Ensure all entity-layer tables/columns exist for a graph-enabled context.
 * Safe to call repeatedly (each step is existence-gated). No-op when the layer
 * is disabled.
 */
export const ensureEntityTables = async (context: ExuluContext): Promise<void> => {
  if (!(await entitiesEnabled(context))) return;
  if (!(await entitiesTableExists(context))) await createEntitiesTable(context);
  if (!(await chunkEntitiesTableExists(context))) await createChunkEntitiesTable(context);
  await ensureItemEntityColumns(context);
};

/**
 * Capture the entity ids linked to an item before its chunks are re-embedded
 * (and the junction is cascade-cleared). Returns [] when the layer is disabled.
 */
export const captureEntitiesBeforeReembed = async (
  context: ExuluContext,
  itemId: string,
): Promise<string[]> => {
  try {
    if (!(await chunkEntitiesTableExists(context))) return [];
    return await getEntityIdsForItem(context, itemId);
  } catch (err) {
    console.error("[EXULU] captureEntitiesBeforeReembed failed (continuing):", (err as Error).message);
    return [];
  }
};

/**
 * Extract entities for an item's current chunks and persist them. Best-effort:
 * any failure is logged and swallowed so embedding ingestion is never blocked.
 */
export const extractAndIngestEntities = async ({
  context,
  itemId,
  previousEntityIds,
}: {
  context: ExuluContext;
  itemId: string;
  previousEntityIds?: string[];
}): Promise<void> => {
  try {
    const types = await hydrateEntityTypes(context);
    if (!types.length || !context.embedder) return;

    await ensureEntityTables(context);

    const { db } = await postgresClient();
    const chunkRows = await db(getChunksTableName(context.id))
      .where({ source: itemId })
      .select("chunk_index", "content")
      .orderBy("chunk_index", "asc");

    const chunks = chunkRows
      .map((c: any) => ({ index: Number(c.chunk_index), content: c.content as string }))
      .filter((c) => c.content);

    const mentions = await extractEntitiesForItem({ context, chunks, types });
    const signature = computeTypesSignature(types);

    await ingestEntitiesForItem({ context, itemId, mentions, signature, previousEntityIds });

    console.log(
      `[EXULU] Entity ingestion complete for item ${itemId} in context ${context.id}: ${mentions.length} mentions.`,
    );
  } catch (err) {
    console.error(
      `[EXULU] Entity ingestion failed for item ${itemId} in context ${context.id} (non-fatal):`,
      (err as Error).message,
    );
  }
};
