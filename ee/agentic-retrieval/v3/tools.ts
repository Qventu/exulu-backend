import { z } from "zod";
import { tool } from "ai";
import type { ExuluContext } from "@SRC/exulu/context";
import { getTableName, getChunksTableName } from "@SRC/exulu/context";
import { postgresClient } from "@SRC/postgres/client";
import { applyFilters } from "@SRC/graphql/resolvers/apply-filters";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import type { SearchFilters } from "@SRC/graphql/types";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import type { User } from "@EXULU_TYPES/models/user";
import type { ChunkResult } from "./types";

function buildContextEnum(contexts: ExuluContext[]) {
  return z
    .array(z.enum(contexts.map((c) => c.id) as [string, ...string[]]))
    .describe(
      contexts
        .map(
          (c) =>
            `<knowledge_base id="${c.id}" name="${c.name}">${c.description}</knowledge_base>`,
        )
        .join("\n"),
    );
}

function resolveContexts(
  ids: string[],
  all: ExuluContext[],
): ExuluContext[] {
  if (!ids?.length) return all;
  return ids.map((id) => {
    const ctx = all.find(
      (c) => c.id === id || c.id.toLowerCase().includes(id.toLowerCase()),
    );
    if (!ctx) throw new Error(`Knowledge base not found: ${id}`);
    return ctx;
  });
}

function mapSearchMethod(method: "hybrid" | "keyword" | "semantic"): "hybridSearch" | "tsvector" | "cosineDistance" {
  if (method === "hybrid") return "hybridSearch";
  if (method === "keyword") return "tsvector";
  return "cosineDistance";
}

export type RetrievalToolParams = {
  contexts: ExuluContext[];
  user?: User;
  role?: string;
  updateVirtualFiles: (files: Array<{ path: string; content: string }>) => Promise<void>;
};

/**
 * Creates all pre-built retrieval tools. These are passed to the agent loop
 * and filtered per strategy.
 */
export function createRetrievalTools(params: RetrievalToolParams) {
  const { contexts, user, role, updateVirtualFiles } = params;
  const ctxEnum = buildContextEnum(contexts);

  // ──────────────────────────────────────────────────────────
  // count_items_or_chunks
  // ──────────────────────────────────────────────────────────
  const count_items_or_chunks = tool({
    description:
      "Count items or chunks WITHOUT loading them into context. Use for 'how many', 'count', or 'total number of' queries.",
    inputSchema: z.object({
      knowledge_base_ids: ctxEnum,
      count_what: z
        .enum(["items", "chunks"])
        .describe("Whether to count items (documents) or chunks (pages/sections)"),
      name_contains: z
        .string()
        .optional()
        .describe("Only count items whose name contains this text (case-insensitive)"),
      content_query: z
        .string()
        .optional()
        .describe(
          "Only count chunks matching this search query (uses hybrid search). Only used when count_what is 'chunks'.",
        ),
    }),
    execute: async ({ knowledge_base_ids, count_what, name_contains, content_query }) => {
      const { db } = await postgresClient();
      const ctxList = resolveContexts(knowledge_base_ids, contexts);

      const counts = await Promise.all(
        ctxList.map(async (ctx) => {
          let count = 0;

          if (count_what === "items") {
            const tableName = getTableName(ctx.id);
            let q = db(tableName).count("id as count").whereNull("archived");
            if (name_contains) {
              q = q.whereRaw("LOWER(name) LIKE ?", [`%${name_contains.toLowerCase()}%`]);
            }
            const tableDefinition = convertContextToTableDefinition(ctx);
            q = applyAccessControl(tableDefinition, q, user, tableName);
            const result = await q.first();
            count = Number(result?.count ?? 0);
          } else {
            const chunksTable = getChunksTableName(ctx.id);
            if (content_query) {
              const searchResults = await ctx.search({
                query: content_query,
                method: "hybridSearch",
                limit: 10000,
                page: 1,
                itemFilters: [],
                chunkFilters: [],
                sort: { field: "updatedAt", direction: "desc" },
                user,
                role,
                trigger: "tool",
              });
              count = searchResults.chunks.length;
            } else {
              const result = await db(chunksTable).count("id as count").first();
              count = Number(result?.count ?? 0);
            }
          }

          return { context: ctx.id, context_name: ctx.name, count };
        }),
      );

      return JSON.stringify({
        total_count: counts.reduce((s, c) => s + c.count, 0),
        breakdown_by_context: counts,
      });
    },
  });

  // ──────────────────────────────────────────────────────────
  // search_items_by_name
  // ──────────────────────────────────────────────────────────
  const search_items_by_name = tool({
    description:
      "Search for items by their name or external ID. Use only when the user is asking for documents BY TITLE, not by content topic.",
    inputSchema: z.object({
      knowledge_base_ids: ctxEnum,
      item_name: z.string().describe("The name or partial name to search for"),
      limit: z
        .number()
        .default(100)
        .describe(
          "Max items per knowledge base (max 400). Applies independently to each knowledge base.",
        ),
    }),
    execute: async ({ item_name, limit, knowledge_base_ids }) => {
      const { db } = await postgresClient();
      const ctxList = resolveContexts(knowledge_base_ids, contexts);
      const safeLimit = Math.min(limit ?? 100, 400);
      const itemFilters: SearchFilters = item_name ? [{ name: { contains: item_name } }] : [];

      const results = await Promise.all(
        ctxList.map(async (ctx) => {
          const tableName = getTableName(ctx.id);
          const tableDefinition = convertContextToTableDefinition(ctx);

          let q = db(`${tableName} as items`).select([
            "items.id as item_id",
            "items.name as item_name",
            "items.external_id as item_external_id",
            db.raw('items."updatedAt" as item_updated_at'),
            db.raw('items."createdAt" as item_created_at'),
            ...ctx.fields.map((f) => `items.${f.name} as ${f.name}`),
          ]);
          q = q.limit(safeLimit);
          q = applyFilters(q, itemFilters, tableDefinition, "items");
          q = applyAccessControl(tableDefinition, q, user, "items");
          const items = await q;

          return Promise.all(
            items.map(async (item) => {
              const chunksTable = getChunksTableName(ctx.id);
              const chunks = await db(chunksTable)
                .select(["id", "source", "metadata"])
                .where("source", item.item_id)
                .limit(1);

              if (!chunks[0]) return null;
              return {
                item_name: item.item_name,
                item_id: item.item_id,
                context: ctx.id,
                chunk_id: chunks[0].id,
                chunk_index: 1,
                metadata: chunks[0].metadata,
              } satisfies ChunkResult;
            }),
          );
        }),
      );

      return JSON.stringify(results.flat().filter(Boolean));
    },
  });

  // ──────────────────────────────────────────────────────────
  // search_content
  // ──────────────────────────────────────────────────────────
  const search_content = tool({
    description: `Search across document content using hybrid, keyword, or semantic search.

Use includeContent: false when you only need to know WHICH documents match (listing, overview, navigation).
Use includeContent: true when you need the ACTUAL text to answer a question.

For listing queries: always start with includeContent: false, then use dynamic tools to fetch specific pages.`,
    inputSchema: z.object({
      query: z.string().describe("Search query about the content you're looking for"),
      knowledge_base_ids: ctxEnum,
      keywords: z.array(z.string()).optional().describe("Keywords extracted from the query"),
      searchMethod: z
        .enum(["hybrid", "keyword", "semantic"])
        .default("hybrid")
        .describe(
          "hybrid: best default (semantic + keyword). keyword: exact terms, product codes, IDs. semantic: conceptual/synonyms.",
        ),
      includeContent: z
        .boolean()
        .default(true)
        .describe(
          "false: returns metadata only (document names, scores) — use for listing/navigation. " +
            "true: returns full chunk text — use when you need content to answer a question.",
        ),
      item_ids: z.array(z.string()).optional().describe("Filter results to specific item IDs"),
      item_names: z
        .array(z.string())
        .optional()
        .describe("Filter results to items whose name contains one of these strings"),
      item_external_ids: z
        .array(z.string())
        .optional()
        .describe("Filter results to specific external IDs"),
      limit: z
        .number()
        .default(10)
        .describe("Max chunks with content (max 10). Without content, up to 200 are returned."),
    }),
    execute: async ({
      query,
      knowledge_base_ids,
      keywords,
      searchMethod,
      includeContent,
      item_ids,
      item_names,
      item_external_ids,
      limit,
    }) => {
      const ctxList = resolveContexts(knowledge_base_ids, contexts);
      const effectiveLimit = includeContent ? Math.min(limit ?? 10, 10) : Math.min((limit ?? 10) * 20, 400);

      const results = await Promise.all(
        ctxList.map(async (ctx) => {
          const itemFilters: SearchFilters = [];
          if (item_ids) itemFilters.push({ id: { in: item_ids } });
          if (item_names)
            itemFilters.push({ name: { or: item_names.map((n) => ({ contains: n })) } });
          if (item_external_ids) itemFilters.push({ external_id: { in: item_external_ids } });

          const effectiveQuery = query || keywords?.join(" ") || "";

          let method = mapSearchMethod(searchMethod ?? "hybrid")

          if (
            method === "hybridSearch" ||
            method === "cosineDistance"
          ) {
            if (!ctx.embedder) {
              console.error(`[EXULU] context "${ctx.id}" does not have an embedder, falling back to tsvector search`);
              method = "tsvector"
            }
          }

          try {
            const { chunks } = await ctx.search({
              query: effectiveQuery,
              keywords,
              method: method,
              limit: effectiveLimit,
              page: 1,
              itemFilters,
              chunkFilters: [],
              sort: { field: "updatedAt", direction: "desc" },
              user,
              role,
              trigger: "tool",
            });

            return chunks.map(
              (chunk): ChunkResult => ({
                item_name: chunk.item_name,
                item_id: chunk.item_id,
                context: chunk.context?.id ?? ctx.id,
                chunk_id: chunk.chunk_id,
                chunk_index: chunk.chunk_index,
                chunk_content: includeContent ? chunk.chunk_content : undefined,
                metadata: {
                  ...chunk.chunk_metadata,
                  cosine_distance: chunk.chunk_cosine_distance,
                  fts_rank: chunk.chunk_fts_rank,
                  hybrid_score: chunk.chunk_hybrid_score,
                },
              }),
            );
          } catch (err) {
            console.error(`[EXULU] search_content failed for context "${ctx.id}":`, err);
            return [];
          }
        }),
      );

      return JSON.stringify(results.flat());
    },
  });

  // ──────────────────────────────────────────────────────────
  // save_search_results
  // ──────────────────────────────────────────────────────────
  const save_search_results = tool({
    description: `Execute a search and save ALL results to the virtual filesystem WITHOUT loading them into context.

Use this when you expect many results (>20) and need to filter iteratively:
1. Call save_search_results to save up to 1000 results to /search_results.txt
2. Use bash grep/awk to identify relevant chunks by pattern
3. Use dynamic get_content tools to load only the specific chunks you need

The saved file format:
### RESULT N ###
ITEM_NAME: ...
ITEM_ID: ...
CHUNK_ID: ...
CHUNK_INDEX: ...
CONTEXT: ...
SCORE: ...
---CONTENT START---
(content or placeholder)
---CONTENT END---`,
    inputSchema: z.object({
      knowledge_base_ids: ctxEnum,
      query: z.string().describe("Search query"),
      searchMethod: z.enum(["hybrid", "keyword", "semantic"]).default("hybrid"),
      limit: z
        .number()
        .max(1000)
        .default(100)
        .describe("Max results to save (max 1000)"),
      includeContent: z
        .boolean()
        .default(true)
        .describe(
          "Whether to include chunk text in the saved file. False saves tokens — use true only if you need to grep content.",
        ),
    }),
    execute: async ({ query, knowledge_base_ids, searchMethod, limit, includeContent }) => {
      const ctxList = resolveContexts(knowledge_base_ids, contexts);

      const results = await Promise.all(
        ctxList.map(async (ctx) => {
          try {
            const { chunks } = await ctx.search({
              query,
              method: mapSearchMethod(searchMethod ?? "hybrid"),
              limit: Math.min(limit ?? 100, 1000),
              page: 1,
              itemFilters: [],
              chunkFilters: [],
              sort: { field: "updatedAt", direction: "desc" },
              user,
              role,
              trigger: "tool",
            });
            return chunks;
          } catch (err) {
            console.error(`[EXULU] save_search_results failed for context "${ctx.id}":`, err);
            return [];
          }
        }),
      );

      const chunks: VectorSearchChunkResult[] = results.flat();

      const fileContent = chunks
        .map(
          (chunk, i) =>
            `### RESULT ${i + 1} ###\n` +
            `ITEM_NAME: ${chunk.item_name}\n` +
            `ITEM_ID: ${chunk.item_id}\n` +
            `CHUNK_ID: ${chunk.chunk_id}\n` +
            `CHUNK_INDEX: ${chunk.chunk_index}\n` +
            `CONTEXT: ${chunk.context?.id ?? ""}\n` +
            `SCORE: ${chunk.chunk_hybrid_score ?? chunk.chunk_fts_rank ?? chunk.chunk_cosine_distance ?? 0}\n` +
            `---CONTENT START---\n` +
            `${includeContent && chunk.chunk_content ? chunk.chunk_content : "[use includeContent: true or get_content tool to load]"}\n` +
            `---CONTENT END---\n`,
        )
        .join("\n");

      await updateVirtualFiles([
        { path: "search_results.txt", content: fileContent },
        {
          path: "search_metadata.json",
          content: JSON.stringify({
            query,
            timestamp: new Date().toISOString(),
            results_count: chunks.length,
            contexts: ctxList.map((c) => c.id),
            method: searchMethod,
          }),
        },
      ]);

      return JSON.stringify({
        success: true,
        results_count: chunks.length,
        message: `Saved ${chunks.length} results to /search_results.txt`,
        grep_examples: [
          "grep -i 'keyword' search_results.txt | head -20",
          "grep 'ITEM_NAME:' search_results.txt",
          "grep -B 5 'pattern' search_results.txt | grep 'CHUNK_ID:'",
        ],
      });
    },
  });

  return {
    count_items_or_chunks,
    search_items_by_name,
    search_content,
    save_search_results,
  };
}
