import { z } from "zod";
import { tool } from "ai";
import type { Tool as AITool } from "ai";
import { postgresClient } from "@SRC/postgres/client";
import { getChunksTableName } from "@SRC/exulu/context";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name.ts";
import type { ChunkResult } from "./types";

/**
 * Creates per-chunk navigation tools from the results of a search step.
 *
 * Two types of dynamic tools are created:
 * - get_more_content_from_{item}: Browse adjacent chunks of a multi-chunk item
 * - get_{item}_page_{n}_content: Load the full text of a specific page/chunk
 *   (created when includeContent was false in the original search)
 */
export async function createDynamicTools(
  chunks: ChunkResult[],
  hadExcludedContent: boolean,
): Promise<Record<string, AITool>> {
  const { db } = await postgresClient();
  const tools: Record<string, AITool> = {};
  const seenItems = new Set<string>();

  for (const chunk of chunks) {
    if (!chunk.item_id || !chunk.context) continue;

    // ── get_more_content_from_{item} ──────────────────────────
    const browseToolName = sanitizeToolName(`get_more_content_from_${chunk.item_name}`);
    if (!seenItems.has(chunk.item_id) && !tools[browseToolName]) {
      seenItems.add(chunk.item_id);
      const chunksTable = getChunksTableName(chunk.context);

      try {
        const countResult = await db(chunksTable)
          .count("id as count")
          .where("source", chunk.item_id)
          .first();
        const total = Number(countResult?.count ?? 0);

        if (total > 1) {
          const capturedChunk = chunk;
          tools[browseToolName] = tool({
            description: `"${chunk.item_name}" has ${total} pages/chunks. Use this to read a range of pages from it.`,
            inputSchema: z.object({
              from_index: z.number().min(1).default(1).describe("Starting chunk index (1-based)"),
              to_index: z
                .number()
                .max(total)
                .describe(`Ending chunk index (max ${total})`),
            }),
            execute: async ({ from_index, to_index }) => {
              const { db: db2 } = await postgresClient();
              const rows = await db2(chunksTable)
                .select("*")
                .where("source", capturedChunk.item_id)
                .whereBetween("chunk_index", [from_index, to_index])
                .orderBy("chunk_index", "asc");

              return JSON.stringify(
                rows.map((r) => ({
                  chunk_content: r.content,
                  chunk_index: r.chunk_index,
                  chunk_id: r.id,
                  item_id: capturedChunk.item_id,
                  item_name: capturedChunk.item_name,
                  context: capturedChunk.context,
                })),
              );
            },
          });
        }
      } catch {
        // Skip if table not accessible
      }
    }

    // ── get_{item}_page_{n}_content ───────────────────────────
    if (hadExcludedContent && chunk.chunk_id) {
      const pageToolName = sanitizeToolName(
        `get_${chunk.item_name}_page_${chunk.chunk_index}_content`,
      );
      if (!tools[pageToolName]) {
        const capturedChunk = chunk;
        tools[pageToolName] = tool({
          description: `Load the full text of page ${chunk.chunk_index} from "${chunk.item_name}"`,
          inputSchema: z.object({
            reasoning: z.string().describe("Why you need this specific page's content"),
          }),
          execute: async () => {
            const { db: db2 } = await postgresClient();
            const chunksTable = getChunksTableName(capturedChunk.context!);
            const rows = await db2(chunksTable)
              .select("*")
              .where("id", capturedChunk.chunk_id!)
              .limit(1);

            if (!rows[0]) return JSON.stringify({ error: "Chunk not found" });

            return JSON.stringify({
              chunk_content: rows[0].content,
              chunk_index: rows[0].chunk_index,
              chunk_id: rows[0].id,
              item_id: capturedChunk.item_id,
              item_name: capturedChunk.item_name,
              context: capturedChunk.context ?? "",
            });
          },
        });
      }
    }
  }

  return tools;
}
