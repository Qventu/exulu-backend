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

/**
 * Parses session item entries into a per-context map.
 *
 * Two supported formats:
 *   "<context_id>/<item_id>" → specific item; value is a non-empty string[]
 *   "<context_id>"           → full context (no item filter); value is null
 *
 * If both a full-context entry and specific-item entries exist for the same
 * context, full-context (null) wins.
 */
export function parseGlobalItemIds(globalIds: string[]): Map<string, string[] | null> {
  const map = new Map<string, string[] | null>();
  for (const gid of globalIds) {
    const slashIdx = gid.indexOf("/");
    if (slashIdx === -1) {
      // No slash → entire context selected
      if (gid) map.set(gid, null);
      continue;
    }
    const contextId = gid.slice(0, slashIdx);
    const itemId = gid.slice(slashIdx + 1);
    if (!contextId || !itemId) continue;
    // Full-context entry already wins — don't downgrade to specific items
    if (map.get(contextId) === null) continue;
    const existing = map.get(contextId) ?? [];
    existing.push(itemId);
    map.set(contextId, existing);
  }
  return map;
}

export type RetrievalToolParams = {
  contexts: ExuluContext[];
  user?: User;
  role?: string;
  updateVirtualFiles: (files: Array<{ path: string; content: string }>) => Promise<void>;
  /**
   * Preselected scope keyed by context ID. When set, every tool is scoped accordingly:
   *   null        → full context access (no item filter)
   *   string[]    → only these specific item IDs
   *   missing key → context was not selected; return empty results
   */
  preselectedItemsByContext?: Map<string, string[] | null>;
};

/**
 * Creates all pre-built retrieval tools. These are passed to the agent loop
 * and filtered per strategy.
 */
export function createRetrievalTools(params: RetrievalToolParams) {
  const { contexts, user, role, updateVirtualFiles, preselectedItemsByContext } = params;
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
          const contextItemIds = preselectedItemsByContext?.get(ctx.id);
          // undefined = context not in preselection map → skip
          if (preselectedItemsByContext && contextItemIds === undefined) {
            return { context: ctx.id, context_name: ctx.name, count: 0 };
          }
          // null = full context; string[] = specific items

          let count = 0;

          if (count_what === "items") {
            const tableName = getTableName(ctx.id);
            let q = db(tableName).count("id as count").whereNull("archived");
            if (name_contains) {
              q = q.whereRaw("LOWER(name) LIKE ?", [`%${name_contains.toLowerCase()}%`]);
            }
            if (Array.isArray(contextItemIds)) {
              q = q.whereIn("id", contextItemIds);
            }
            const tableDefinition = convertContextToTableDefinition(ctx);
            q = applyAccessControl(tableDefinition, q, user, tableName);
            const result = await q.first();
            count = Number(result?.count ?? 0);
          } else {
            const chunksTable = getChunksTableName(ctx.id);
            const baseItemFilters: SearchFilters = Array.isArray(contextItemIds)
              ? [{ id: { in: contextItemIds } }]
              : [];
            if (content_query) {
              const searchResults = await ctx.search({
                query: content_query,
                method: "hybridSearch",
                limit: 10000,
                page: 1,
                itemFilters: baseItemFilters,
                chunkFilters: [],
                sort: { field: "updatedAt", direction: "desc" },
                user,
                role,
                trigger: "tool",
              });
              count = searchResults.chunks.length;
            } else if (Array.isArray(contextItemIds)) {
              const result = await db(chunksTable).count("id as count").whereIn("source", contextItemIds).first();
              count = Number(result?.count ?? 0);
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
      "Search for items by their name or external ID. Use when:\n" +
      "• The user asks for a document BY TITLE or NAME\n" +
      "• The user asks whether a specific named document EXISTS (e.g. 'do you have the X manual?', 'is there a document for Y?')\n" +
      "• Any query that references a specific document, manual, or resource by its name rather than by topic\n" +
      "Do NOT use for topic-based content queries (e.g. 'what are the parameters for X?', 'how do I configure Y?').",
    inputSchema: z.object({
      knowledge_base_ids: ctxEnum,
      item_name: z.string().describe(
        "The name or partial name to search for. Uses substring matching, so shorter and more specific terms work better than full phrases. " +
        "Extract only the core identifying part — typically the product model, document title, or unique identifier. " +
        "Do NOT include surrounding descriptors like type words ('manual', 'guide', 'document') or manufacturer names unless they are likely part of the actual document title."
      ),
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

      const results = await Promise.all(
        ctxList.map(async (ctx) => {
          const contextItemIds = preselectedItemsByContext?.get(ctx.id);
          // undefined = context not in preselection map → skip
          if (preselectedItemsByContext && contextItemIds === undefined) return [];

          const itemFilters: SearchFilters = item_name ? [{ name: { contains: item_name } }] : [];
          if (Array.isArray(contextItemIds)) itemFilters.push({ id: { in: contextItemIds } });

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
    description: `Search ONE knowledge base for document content using hybrid, keyword, or semantic search.
Always make a separate call for each knowledge base you want to search — never bundle multiple in one call.

Use includeContent: false when you only need to know WHICH documents match (listing, overview, navigation).
Use includeContent: true when you need the ACTUAL text to answer a question.

For listing queries: always start with includeContent: false, then use dynamic tools to fetch specific pages.`,
    inputSchema: z.object({
      query: z.string().describe("Search query about the content you're looking for"),
      knowledge_base_id: z
        .enum(contexts.map((c) => c.id) as [string, ...string[]])
        .describe(
          contexts
            .map(
              (c) =>
                `<knowledge_base id="${c.id}" name="${c.name}">${c.description}</knowledge_base>`,
            )
            .join("\n"),
        ),
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
        .default(20)
        .describe("Max chunks with content (max 20). Without content, up to 200 are returned."),
    }),
    execute: async ({
      query,
      knowledge_base_id,
      keywords,
      searchMethod,
      includeContent,
      item_ids,
      item_names,
      item_external_ids,
      limit,
    }) => {
      const [ctx] = resolveContexts([knowledge_base_id], contexts) as [ExuluContext];
      const effectiveLimit = includeContent ? Math.min(limit ?? 20, 20) : Math.min((limit ?? 20) * 20, 400);

      const itemFilters: SearchFilters = [];

      if (preselectedItemsByContext) {
        const contextItemIds = preselectedItemsByContext.get(knowledge_base_id);
        if (contextItemIds === undefined) {
          // Context not in preselection map — nothing to search
          return JSON.stringify([]);
        }
        if (Array.isArray(contextItemIds)) {
          const intersection = item_ids?.length
            ? item_ids.filter((id) => contextItemIds.includes(id))
            : contextItemIds;
          if (!intersection.length) {
            // Agent specified item_ids entirely outside the preselected scope
            return JSON.stringify([]);
          }
          itemFilters.push({ id: { in: intersection } });
        }
        // null = full context → no item filter; agent's item_ids still respected if provided
        else if (item_ids?.length) {
          itemFilters.push({ id: { in: item_ids } });
        }
      } else if (item_ids?.length) {
        itemFilters.push({ id: { in: item_ids } });
      }

      if (item_names)
        itemFilters.push({ name: { or: item_names.map((n) => ({ contains: n })) } });
      if (item_external_ids) itemFilters.push({ external_id: { in: item_external_ids } });

      const effectiveQuery = query || keywords?.join(" ") || "";

      let method = mapSearchMethod(searchMethod ?? "hybrid");

      if (method === "hybridSearch" || method === "cosineDistance") {
        if (!ctx.embedder) {
          console.error(`[EXULU] context "${ctx.id}" does not have an embedder, falling back to tsvector search`);
          method = "tsvector";
        }
      }

      try {
        const { chunks } = await ctx.search({
          query: effectiveQuery,
          keywords,
          method,
          limit: effectiveLimit,
          page: 1,
          itemFilters,
          chunkFilters: [],
          sort: { field: "updatedAt", direction: "desc" },
          user,
          role,
          trigger: "tool",
        });

        return JSON.stringify(
          chunks.map(
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
          ),
        );
      } catch (err) {
        console.error(`[EXULU] search_content failed for context "${ctx.id}":`, err);
        return JSON.stringify([]);
      }
    },
  });

  // ──────────────────────────────────────────────────────────
  // save_search_results
  // ──────────────────────────────────────────────────────────
  const save_search_results = tool({
    description: `Execute a search on ONE knowledge base and save ALL results to the virtual filesystem WITHOUT loading them into context.
Always make a separate call for each knowledge base you want to search.

Use this when you expect many results (>20) and need to filter iteratively:
1. Call save_search_results (once per knowledge base) to save up to 1000 results to /search_results_{knowledge_base_id}.txt
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
      knowledge_base_id: z
        .enum(contexts.map((c) => c.id) as [string, ...string[]])
        .describe(
          contexts
            .map(
              (c) =>
                `<knowledge_base id="${c.id}" name="${c.name}">${c.description}</knowledge_base>`,
            )
            .join("\n"),
        ),
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
    execute: async ({ query, knowledge_base_id, searchMethod, limit, includeContent }) => {
      const [ctx] = resolveContexts([knowledge_base_id], contexts) as [ExuluContext];

      const contextItemIds = preselectedItemsByContext?.get(knowledge_base_id);
      // undefined = context not in preselection map → skip
      if (preselectedItemsByContext && contextItemIds === undefined) {
        return JSON.stringify({
          success: true,
          results_count: 0,
          message: `Context "${knowledge_base_id}" not in preselected scope — skipped.`,
        });
      }

      // null = full context (no filter); string[] = specific items
      const itemFilters: SearchFilters = Array.isArray(contextItemIds)
        ? [{ id: { in: contextItemIds } }]
        : [];

      let chunks: VectorSearchChunkResult[] = [];
      try {
        const result = await ctx.search({
          query,
          method: mapSearchMethod(searchMethod ?? "hybrid"),
          limit: Math.min(limit ?? 100, 1000),
          page: 1,
          itemFilters,
          chunkFilters: [],
          sort: { field: "updatedAt", direction: "desc" },
          user,
          role,
          trigger: "tool",
        });
        chunks = result.chunks;
      } catch (err) {
        console.error(`[EXULU] save_search_results failed for context "${ctx.id}":`, err);
      }

      const fileName = `search_results_${ctx.id}.txt`;
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
        { path: fileName, content: fileContent },
        {
          path: `search_metadata_${ctx.id}.json`,
          content: JSON.stringify({
            query,
            timestamp: new Date().toISOString(),
            results_count: chunks.length,
            context: ctx.id,
            method: searchMethod,
          }),
        },
      ]);

      return JSON.stringify({
        success: true,
        results_count: chunks.length,
        message: `Saved ${chunks.length} results to /${fileName}`,
        grep_examples: [
          `grep -i 'keyword' ${fileName} | head -20`,
          `grep 'ITEM_NAME:' ${fileName}`,
          `grep -B 5 'pattern' ${fileName} | grep 'CHUNK_ID:'`,
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
