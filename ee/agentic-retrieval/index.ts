import { z } from "zod";
import {
  stepCountIs,
  tool,
  type LanguageModel,
  type Tool as AITool,
  Output,
  generateText,
} from "ai";
import { type ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import { ExuluTool } from "@SRC/exulu/tool";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name.ts";
import type { User } from "@EXULU_TYPES/models/user";
import { postgresClient } from "@SRC/postgres/client";
import { zodToJsonSchema } from "zod-to-json-schema";
import { preprocessQuery } from "@SRC/utils/query-preprocessing";
import { getChunksTableName, getTableName } from "@SRC/exulu/context";
import type { SearchFilters } from "@SRC/graphql/types";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { applyFilters } from "@SRC/graphql/resolvers/apply-filters";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { withRetry } from "@SRC/utils/with-retry";
import { checkLicense } from "@EE/entitlements";
/**
 * Agentic Retrieval Tool
 *
 * This module provides a single intelligent retrieval agent that uses multiple tools
 * to efficiently retrieve relevant information from ALL available Exulu knowledge bases.
 *
 * The agent can:
 * - List and understand available contexts
 * - Search chunks across contexts using different methods (vector, keyword, hybrid)
 * - Pre-filter items by metadata
 * - Expand chunks to get surrounding context
 * - Decide when to return just metadata vs full content
 */

/**
 * Tool result interface for proper citation formatting
 */
interface ToolResult {
  item_name: string;
  item_id: string;
  context: string;
  chunk_id?: string;
  chunk_index?: number;
  chunk_content?: string;
  metadata?: any;
}

interface AgenticRetrievalOutput {
  reasoning: {
    text: string;
    tools: {
      name: string;
      id: string;
      input: any;
      output: VectorSearchChunkResult[];
    }[];
    chunks: any[];
  }[];
  chunks: any[];
  usage: any[];
  totalTokens: number;
}

const baseInstructions = `
You are an intelligent information retrieval assistant with access to multiple knowledge bases. You MUST do all your reasoning and
    outputs in the same language as the user query.

Your goal is to efficiently retrieve the most relevant information to answer user queries. You don't answer the question yourself, you only
retrieve the information and return it, another tool will answer the question based on the information you retrieve.

CRITICAL: STRUCTURED REASONING PROCESS
You MUST follow this structured thinking process for EVERY step. Keep outputs VERY SHORT and in the same language as the user query - ideally one line each:

1. BEFORE EACH TOOL CALL - Output your search strategy in ONE CONCISE LINE:
   Format: 🔍 [What you'll search]: [Tool(s)] [Method/Filters] → [Expected outcome]

   Examples:
   - "🔍 Searching for WPA-2 config in DPO-1 docs: search_items_products (name:DPO-1) → search_chunks_products (hybrid) → Expecting setup instructions"
   - "🔍 Listing tourism items: search_items_hamburg (name contains 'tourism') → Document list"
   - "🔍 Broad search for elevator data: search_chunks_* (hybrid, all contexts) → Statistical data"

2. AFTER RECEIVING RESULTS - Reflect in ONE CONCISE LINE:
   Format: 💭 [Count] results | [Relevance] | [Next action]

   Examples:
   - "💭 5 chunks found | Highly relevant WPA-2 instructions | Sufficient - returning results"
   - "💭 12 items with 'tourism' | Complete list | Done"
   - "💭 0 results in context_1 | Not found | Trying remaining contexts"

IMPORTANT:
- ONE LINE per reasoning block - be extremely concise
- Use the same language as the user query
- Focus only on: what, tool/method, outcome

Choose your strategy based on the query type:

FOR LISTING QUERIES (e.g., "list all documents about X" or "what items mention Y"):

You have two options, you can use the search_items_by_name_[context_id] tool to find the items by name, if it is likely that
the name includes a specific keyword, for example when looking for documentation regarding a specific product. Or you can use
the search_[context_id] tool with the parameter "includeContent: false" to search inside the actual content of all or specific
items, if you are looking for any items that might be relevant or contain information relevant to the query, but do not need 
the actual content in your response.

IMPORTANT: For listing queries, NEVER set includeContent: true unless you need the actual text content to answer the question

FOR TARGETED QUERIES ABOUT SPECIFIC ITEMS (e.g., "how do I configure WPA-2 on my DPO-1? router" or "search in Document ABC"):
TWO-STEP PATTERN:
1. STEP 1 - Find the items: 
As described above, you have two options, you can use the search_items_by_name_[context_id] tool to find the items by name, if it is likely that
the name includes a specific keyword, for example when looking for documentation regarding a specific product. Or you can use
the search_[context_id] tool with the parameter "includeContent: false" to search inside the actual content of all or specific
items, if you are looking for any items that might be relevant or contain information relevant to the query, but do not need 
the actual content in your response.
2. STEP 2 - If step 1 returned any items, search for relevant information within those items: Use search_[context_id] with 
hybrid search method. Example: search_[context_id] with hybrid search method and parameters item_name: 'DPO-1'
   This searches only within the specific items you found. If no items were found in step 1 you should still
   do the search_[context_id] but without pre-filtering them.

Note that the query input for the search_[context_id] tools should not be used to search for things like "Page 2",
 "Section 3", "Chapter 4", etc. but rather be used to search for specific information or answers within the
content of the items.

ONLY say "no information found" if you have:
✓ Searched ALL available contexts (not just likely ones)
✓ Tried hybrid, keyword, AND semantic search in each context
✓ Tried variations of the search terms
✓ Confirmed zero results across all attempts

IMPORTANT OPTIMIZATION RULES:

⚠️ CRITICAL: Always set includeContent: false when:
- User asks for a list, overview, or count of documents/items
- User wants to know "which documents" or "what items" without needing their content
- You only need item names/metadata to answer the query
- You can ALWAYS fetch the actual content later if needed with includeContent: true

✓ Only set includeContent: true (or use default) when:
- User needs specific information, details, or answers from the content
- User asks "how to", "what does it say about", "explain", etc.
- You need the actual text to answer the question

Search Method Selection (for search_* tools):
- Use 'hybrid' method by default for best relevance (combines semantic understanding + keyword matching)
- Use 'keyword' method for exact term matching (technical terms, product names, IDs, specific phrases)
- Use 'semantic' method for conceptual queries where synonyms and paraphrasing matter most

Filtering and Limits:
- Limit results appropriately (don't retrieve more than needed)
`;

// Generator function
function createCustomAgenticRetrievalToolLoopAgent({
  tools,
  model,
  customInstructions,
}: {
  language?: string;
  tools: Record<string, AITool>;
  model: LanguageModel;
  customInstructions?: string;
}): {
  generate: (args: {
    query: string;
    onFinish: (output: AgenticRetrievalOutput) => void;
  }) => AsyncGenerator<AgenticRetrievalOutput>;
} {
  return {
    generate: async function* ({
      reranker,
      query,
      onFinish,
    }: {
      reranker?: ExuluReranker;
      query: string;
      onFinish: (output: any) => void;
    }): AsyncGenerator<any> {
      let finished = false;
      let maxSteps = 2;
      let currentStep = 0;
      const output: AgenticRetrievalOutput = {
        reasoning: [],
        chunks: [],
        usage: [],
        totalTokens: 0,
      };

      // Every uneven step (1, 3, 5 etc...) we force the model
      // to reason about what steps might be needed next. We use
      // the generateObject function to get an output of those steps
      // that looks like this:
      // {
      //    reasoning: string;
      //    finished: boolean;
      // }
      // With "finished" being true if the agent decides no further
      // steps are needed.
      // For the even steps (2, 4, 6 etc...) we use generateText and
      // set toolChoice: 'required' to force a tool call.

      let dynamicTools: Record<string, AITool> = {};

      while (!finished && currentStep < maxSteps) {
        currentStep++;

        console.log("[EXULU] Agentic retrieval step", currentStep);

        const systemPrompt = `
                            ${baseInstructions}

                            AVAILABLE TOOLS:
                            ${Object.keys({ ...tools, ...dynamicTools })
                              .map(
                                (tool) => `
                                <tool_${tool}>
                                    <name>${tool}</name>
                                    <description>${tools[tool]?.description}</description>
                                    ${
                                      tools[tool]?.inputSchema
                                        ? `
                                        <inputSchema>${JSON.stringify(
                                          zodToJsonSchema(tools[tool]?.inputSchema as z.ZodObject<any>), null, 2
                                        )}</inputSchema>
                                    `
                                        : ""
                                    }
                                </tool_${tool}>
                            `,
                              )
                              .join("\n\n")}

                            ${
                              customInstructions
                                ? `
                            CUSTOM INSTRUCTIONS: ${customInstructions}`
                                : ""
                            }
                            `;
        // First generateText call with retry logic
        let reasoningOutput: Awaited<ReturnType<typeof generateText>>;
        try {
          reasoningOutput = await withRetry(async () => {
            console.log("[EXULU] Generating reasoning for step", currentStep);
            return await generateText({
              model: model,
              output: Output.object({
                schema: z.object({
                  reasoning: z
                    .string()
                    .describe(
                      "The reasoning for the next step and why the agent needs to take this step. It MUST start with 'I must call tool XYZ', and MUST include the inputs for that tool.",
                    ),
                  finished: z
                    .boolean()
                    .describe(
                      "Whether the agent has finished meaning no further steps are needed, this should only be true if the agent believes no further tool calls are needed to get the relevant information for the query.",
                    ),
                }),
              }),
              toolChoice: "none",
              system: systemPrompt,
              prompt: `
                    Original query: ${query}
                    
                    Previous step reasoning and output:

                    ${output.reasoning
                      .map(
                        (reasoning, index) => `
                    <step_${index + 1}>
                        <reasoning>
                        ${reasoning.text}
                        </reasoning>

                        ${
                          reasoning.chunks
                            ? `<retrieved_chunks>
                            ${reasoning.chunks
                              .map(
                                (chunk) => `
                            ${chunk.item_name} - ${chunk.item_id} - ${chunk.context} - ${chunk.chunk_id} - ${chunk.chunk_index}
                            `,
                              )
                              .join("\n")}
                        </retrieved_chunks>`
                            : ""
                        }
                        
                        ${
                          reasoning.tools
                            ? `
                        <used_tools>
                            ${reasoning.tools
                              .map(
                                (tool) => `
                            ${tool.name} - ${tool.id} - ${tool.input}
                            `,
                              )
                              .join("\n")}
                        </used_tools>
                        `
                            : ""
                        }

                    </step_${index + 1}>
                    `,
                      )
                      .join("\n")}
                    `,
              stopWhen: [stepCountIs(1)],
            });
          });
          console.log("[EXULU] Reasoning generated for step", currentStep);
        } catch (error) {
          console.error("[EXULU] Failed to generate reasoning after 3 retries:", error);
          throw error;
        }

        const { reasoning: briefing, finished } = reasoningOutput?.output || {};

        const { usage: reasoningUsage } = reasoningOutput || {};

        output.usage.push(reasoningUsage);

        if (finished) {
          console.log("[EXULU] Agentic retrieval finished for step", currentStep);
          break;
        }

        // Second generateText call with retry logic
        let toolOutput: Awaited<ReturnType<typeof generateText>>;
        try {
          toolOutput = await withRetry(async () => {
            console.log("[EXULU] Generating tool output for step", currentStep);
            return await generateText({
              model: model,
              tools: { ...tools, ...dynamicTools },
              toolChoice: "required",
              prompt: `${briefing}`,
              stopWhen: [stepCountIs(1)],
            });
          });
          console.log("[EXULU] Tool output generated for step", currentStep);
        } catch (error) {
          console.error("[EXULU] Failed to generate tool output after 3 retries:", error);
          throw error;
        }

        const toolResults = toolOutput.toolResults;
        const toolCalls = toolOutput.toolCalls;

        let chunks: any[] = [];
        console.log("[EXULU] Processing tool results for step", currentStep);
        if (Array.isArray(toolResults)) {
          chunks = toolResults
            .map((result) => {
              let chunks: any[] = [];
              if (typeof result.output === "string") {
                chunks = JSON.parse(result.output);
              } else {
                chunks = result.output as any[];
              }
              console.log("[EXULU] Chunks", chunks);
              return chunks.map((chunk) => ({
                ...chunk,
                context: {
                  name: chunk.context ? chunk.context.replaceAll("_", " ") : "",
                  id: chunk.context,
                },
              }));
            })
            .flat();
        }
        if (chunks) {
          if (reranker) {
            console.log(
              "[EXULU] Reranking chunks for step, using reranker",
              reranker.name + "(" + reranker.id + ")",
              "for step",
              currentStep,
              " for " + chunks?.length + " chunks",
            );
            chunks = await reranker.run(query, chunks);
            console.log(
              "[EXULU] Reranked chunks for step",
              currentStep,
              "using reranker",
              reranker.name + "(" + reranker.id + ")",
              " resulting in ",
              chunks?.length + " chunks",
            );
          }

          output.chunks.push(...chunks);
        }

        console.log("[EXULU] Pushing reasoning for step", currentStep);

        const exludedContent = toolCalls?.some(
          (toolCall) =>
            toolCall.input?.includeContent === false ||
            toolCall.toolName.startsWith("search_items_by_name"),
        );
        // Create chunk specific tools

        for (const chunk of chunks) {
          const getMoreToolName = sanitizeToolName("get_more_content_from_" + chunk.item_name);
          const { db } = await postgresClient();

          if (!dynamicTools[getMoreToolName]) {
            const chunksTable = getChunksTableName(chunk.context.id);
            const countChunksQuery = await db
              .from(chunksTable)
              .where({ source: chunk.item_id })
              .count("id");
            const chunksCount = Number(countChunksQuery[0].count) || 0;

            if (chunksCount > 1) {
              dynamicTools[getMoreToolName] = tool({
                description: `The item ${chunk.item_name} has a total of${chunksCount} chunks, this tool allows you to get more content from this item across all its pages / chunks.`,
                inputSchema: z.object({
                  from_index: z
                    .number()
                    .default(1)
                    .describe("The index of the chunk to start from."),
                  to_index: z
                    .number()
                    .max(chunksCount)
                    .describe("The index of the chunk to end at, max is " + chunksCount),
                }),
                execute: async ({ from_index, to_index }) => {
                  const chunks = await db(chunksTable)
                    .select("*")
                    .where("source", chunk.item_id)
                    .whereBetween("chunk_index", [from_index, to_index])
                    .orderBy("chunk_index", "asc");
                  return JSON.stringify(
                    chunks.map((resultChunk) => ({
                      chunk_content: resultChunk.content,
                      chunk_index: resultChunk.chunk_index,
                      chunk_id: resultChunk.id,
                      chunk_source: resultChunk.source,
                      chunk_metadata: resultChunk.metadata,
                      item_id: chunk.item_id,
                      item_name: chunk.item_name,
                      context: chunk.context?.id,
                    })),
                    null,
                    2,
                  );
                },
              });
            }
          }

          if (exludedContent) {
            const getContentToolName = sanitizeToolName(
              "get_" + chunk.item_name + "_page_" + chunk.chunk_index + "_content",
            );
            dynamicTools[getContentToolName] = tool({
              description: `Get the content of the page ${chunk.chunk_index} for the item ${chunk.item_name}`,
              inputSchema: z.object({
                reasoning: z
                  .string()
                  .describe("The reasoning for why you need to get the content of the page."),
              }),
              execute: async ({ reasoning }) => {
                const { db } = await postgresClient();
                const chunksTable = getChunksTableName(chunk.context.id);
                const resultChunks = await db(chunksTable)
                  .select("*")
                  .where("id", chunk.chunk_id)
                  .limit(1);
                if (!resultChunks || !resultChunks[0]) {
                  return null;
                }

                return JSON.stringify(
                  [
                    {
                      reasoning: reasoning,
                      chunk_content: resultChunks[0].content,
                      chunk_index: resultChunks[0].chunk_index,
                      chunk_id: resultChunks[0].id,
                      chunk_source: resultChunks[0].source,
                      chunk_metadata: resultChunks[0].metadata,
                      chunk_created_at: resultChunks[0].chunk_created_at,
                      item_id: chunk.item_id,
                      item_name: chunk.item_name,
                      context: chunk.context?.id,
                    },
                  ],
                  null,
                  2,
                );
              },
            });
          }
        }

        output.reasoning.push({
          text: briefing,
          chunks: chunks || [],
          tools:
            toolCalls?.length > 0
              ? toolCalls.map((toolCall) => ({
                  name: toolCall.toolName,
                  id: toolCall.toolCallId,
                  input: toolCall.input,
                  output: chunks,
                }))
              : [],
        });

        const { usage: toolUsage } = toolOutput || {};
        console.log("[EXULU] Pushing tool usage for step", currentStep);
        output.usage.push(toolUsage);

        console.log(`[EXULU] Agentic retrieval step ${currentStep} completed`);
        console.log("[EXULU] Agentic retrieval step output", output);

        yield output;
      }
      const totalTokens = output.usage.reduce((acc, usage) => acc + (usage.totalTokens || 0), 0);
      output.totalTokens = totalTokens;

      console.log("[EXULU] Agentic retrieval finished", output);

      // yield output;
      onFinish(output);
    },
  };
}

/**
 * Creates an agentic retrieval tool that uses ToolLoopAgent to reason about
 * and retrieve relevant information across ALL available knowledge bases
 */
const createAgenticRetrievalAgent = ({
  contexts,
  user,
  role,
  model,
  instructions: custom,
  projectRetrievalTool,
  language = "eng",
}: {
  contexts: ExuluContext[];
  user?: User;
  role?: string;
  model: LanguageModel; // LanguageModel from Vercel AI SDK
  instructions?: string;
  projectRetrievalTool?: ExuluTool;
  language?: string;
}): {
  generate: (args: {
    query: string;
    reranker?: ExuluReranker;
    onFinish: (output: AgenticRetrievalOutput) => void;
  }) => AsyncGenerator<AgenticRetrievalOutput>;
} => {
  // Create the system instructions for the agent

  const searchItemsByNameTool = {
    search_items_by_name: tool({
      description: `
        Search for relevant items by name across the available knowledge bases.`,
      inputSchema: z.object({
        knowledge_base_ids: z.array(z.enum(contexts.map((ctx) => ctx.id) as [string, ...string[]]))
          .describe(`
                    The available knowledge bases are:
                    ${contexts
                      .map(
                        (ctx) => `
                        <knowledge_base>
                            <id>${ctx.id}</id>
                            <name>${ctx.name}</name>
                            <description>${ctx.description}</description>
                        </knowledge_base>
                    `,
                      )
                      .join("\n")}
                `),
        item_name: z.string().describe("The name of the item to search for."),
        limit: z
          .number()
          .default(100)
          .describe(
            "Maximum number of items to return (max 400), if searching through multiple knowledge bases, the limit is applied for each knowledge base individually.",
          ),
      }),
      execute: async ({ item_name, limit, knowledge_base_ids }) => {
        if (!knowledge_base_ids?.length) {
          // Default to all
          knowledge_base_ids = contexts.map((ctx) => ctx.id);
        }

        let itemFilters: SearchFilters = [];
        if (item_name) {
          itemFilters.push({ name: { contains: item_name } });
        }

        const { db } = await postgresClient();

        const results = await Promise.all(
          knowledge_base_ids.map(async (knowledge_base_id) => {
            const ctx = contexts.find(
              (ctx) =>
                ctx.id === knowledge_base_id ||
                ctx.id.toLowerCase().includes(knowledge_base_id.toLowerCase()),
            );
            if (!ctx) {
              console.error(
                "[EXULU] Knowledge base ID that was provided to search items by name not found.",
                knowledge_base_id,
              );
              throw new Error(
                "Knowledge base ID that was provided to search items by name not found.",
              );
            }
            let itemsQuery = db(getTableName(ctx.id) + " as items").select([
              "items.id as item_id",
              "items.name as item_name",
              "items.external_id as item_external_id",
              db.raw('items."updatedAt" as item_updated_at'),
              db.raw('items."createdAt" as item_created_at'),
              ...ctx.fields.map((field) => `items.${field.name} as ${field.name}`),
            ]);

            if (!limit) {
              limit = 100;
            }
            limit = Math.min(limit, 400);
            itemsQuery = itemsQuery.limit(limit);

            const tableDefinition = convertContextToTableDefinition(ctx);
            itemsQuery = applyFilters(itemsQuery, itemFilters || [], tableDefinition, "items");
            itemsQuery = applyAccessControl(tableDefinition, itemsQuery, user, "items");

            const items = await itemsQuery;

            return items?.map((item) => ({
              ...item,
              context: ctx.id,
            }));
          }),
        );

        const items = results.flat();

        const formattedResults: (ToolResult | null)[] = await Promise.all(
          items.map(async (item) => {
            if (!item.item_id || !item.context) {
              console.error("[EXULU] Item id and context are required to get chunks.", item);
              throw new Error("Item id is required to get chunks.");
            }

            const chunksTable = getChunksTableName(item.context);
            const chunks: any[] = await db
              .from(chunksTable)
              .select(["id", "source", "metadata"])
              .where("source", item.item_id)
              .limit(1);

            if (!chunks || !chunks[0]) {
              return null;
            }

            return {
              item_name: item.item_name,
              item_id: item.item_id,
              context: item.context || "",
              chunk_id: chunks[0].id,
              chunk_index: 1,
              chunk_content: undefined,
              metadata: chunks[0].metadata,
            };
          }),
        );

        return JSON.stringify(
          formattedResults.filter((result) => result !== null),
          null,
          2,
        );
      },
    }),
  };

  const searchTools = {
    search_content: tool({
      description: `
            Search for relevant information within the actual content of the items across available knowledge bases.

            This tool provides a number of strategies:
            - Keyword search: search for exact terms, technical names, IDs, or specific phrases
            - Semantic search: search for conceptual queries where synonyms and paraphrasing matter
            - Hybrid search: best for most queries - combines semantic understanding with exact term matching

            You can use the includeContent parameter to control whether to return
            the full chunk content or just metadata.

            Use with includeContent: true (default) when you need to:
            - Find specific information or answers within documents
            - Get actual text content that answers a query
            - Extract details, explanations, or instructions from content

            Use with includeContent: false when you need to:
            - List which documents/items contain certain topics
            - Count or overview items that match a content query
            - Find item names/metadata without loading full content
            - You can always fetch content later if needed
            
            `,
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            "The search query to find relevant chunks, this must always be related to the content you are looking for, not something like 'Page 2'.",
          ),
        knowledge_base_ids: z.array(z.enum(contexts.map((ctx) => ctx.id) as [string, ...string[]]))
          .describe(`
                    The available knowledge bases are:
                    ${contexts
                      .map(
                        (ctx) => `
                        <knowledge_base>
                            <id>${ctx.id}</id>
                            <name>${ctx.name}</name>
                            <description>${ctx.description}</description>
                        </knowledge_base>
                    `,
                      )
                      .join("\n")}
                `),
        keywords: z
          .array(z.string())
          .optional()
          .describe(
            "Keywords to search for. Usually extracted from the query, allowing for more precise search results.",
          ),
        searchMethod: z
          .enum(["keyword", "semantic", "hybrid"])
          .default("hybrid")
          .describe(
            "Search method: 'hybrid' (best for most queries - combines semantic understanding with exact term matching), 'keyword' (best for exact terms, technical names, IDs, or specific phrases), 'semantic' (best for conceptual queries where synonyms and paraphrasing matter)",
          ),
        includeContent: z
          .boolean()
          .default(true)
          .describe(
            "Whether to include the full chunk content in results. " +
              "Set to FALSE when you only need to know WHICH documents/items are relevant (lists, overviews, counts). " +
              "Set to TRUE when you need the ACTUAL content to answer the question (information, details, explanations). " +
              "You can always fetch content later, so prefer FALSE for efficiency when listing documents.",
          ),

        item_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Use if you wish to retrieve content from specific items (documents) based on the item ID.",
          ),
        item_names: z
          .array(z.string())
          .optional()
          .describe(
            "Use if you wish to retrieve content from specific items (documents) based on the item name. Can be a partial match.",
          ),
        item_external_ids: z
          .array(z.string())
          .optional()
          .describe(
            "Use if you wish to retrieve content from specific items (documents) based on the item external ID. Can be a partial match.",
          ),
        limit: z.number().default(10).describe("Maximum number of chunks to return (max 10)"),
      }),
      execute: async ({
        query,
        searchMethod,
        limit,
        includeContent,
        item_ids,
        item_names,
        item_external_ids,
        keywords,
        knowledge_base_ids,
      }) => {
        if (!knowledge_base_ids?.length) {
          // Default to all
          knowledge_base_ids = contexts.map((ctx) => ctx.id);
        }

        const results: VectorSearchChunkResult[][] = await Promise.all(
          knowledge_base_ids.map(async (knowledge_base_id) => {
            const ctx = contexts.find(
              (ctx) =>
                ctx.id === knowledge_base_id ||
                ctx.id.toLowerCase().includes(knowledge_base_id.toLowerCase()),
            );

            if (!ctx) {
              console.error(
                "[EXULU] Knowledge base ID that was provided to search content not found.",
                knowledge_base_id,
              );
              throw new Error("Knowledge base ID that was provided to search content not found.");
            }

            let itemFilters: SearchFilters = [];
            if (item_ids) {
              itemFilters.push({ id: { in: item_ids } });
            }
            if (item_names) {
              itemFilters.push({ name: { or: item_names.map((name) => ({ contains: name })) } });
            }
            if (item_external_ids) {
              itemFilters.push({ external_id: { in: item_external_ids } });
            }

            if (!query && keywords) {
              query = keywords.join(" ");
            }

            const results = await ctx.search({
              query: query,
              keywords: keywords,
              method:
                searchMethod === "hybrid"
                  ? "hybridSearch"
                  : searchMethod === "keyword"
                    ? "tsvector"
                    : "cosineDistance",
              limit: includeContent ? Math.min(limit, 10) : Math.min(limit * 20, 400),
              page: 1,
              itemFilters: itemFilters || [],
              chunkFilters: [],
              sort: { field: "updatedAt", direction: "desc" },
              user,
              role,
              trigger: "tool",
            });

            return results.chunks.map((chunk) => chunk);
          }),
        );

        const resultsFlat: VectorSearchChunkResult[] = results.flat();

        // Format results with citation info
        const formattedResults: ToolResult[] = resultsFlat.map((chunk) => ({
          item_name: chunk.item_name,
          item_id: chunk.item_id,
          context: chunk.context?.id || "",
          chunk_id: chunk.chunk_id,
          chunk_index: chunk.chunk_index,
          chunk_content: includeContent ? chunk.chunk_content : undefined,
          metadata: {
            ...chunk.chunk_metadata,
            cosine_distance: chunk.chunk_cosine_distance,
            fts_rank: chunk.chunk_fts_rank,
            hybrid_score: chunk.chunk_hybrid_score,
          },
        }));
        return JSON.stringify(formattedResults, null, 2);
      },
    }),
  };

  console.log("[EXULU] Search tools:", Object.keys(searchTools));

  // Create the agent with all tools

  const agent = createCustomAgenticRetrievalToolLoopAgent({
    language,
    model,
    customInstructions: custom,
    tools: {
      ...searchTools,
      ...searchItemsByNameTool,
      ...(projectRetrievalTool ? { [projectRetrievalTool.id]: projectRetrievalTool.tool } : {}),
    },
  });

  return agent;
};

/**
 * Generator function that can be used as the execute function for an ExuluTool
 * This streams progress updates as the agent works
 */
async function* executeAgenticRetrieval({
  contexts,
  reranker,
  query,
  user,
  role,
  model,
  instructions,
  projectRetrievalTool,
}: {
  contexts: ExuluContext[];
  reranker?: ExuluReranker;
  query: string;
  projectRetrievalTool?: ExuluTool;
  user?: User;
  role?: string;
  model: LanguageModel;
  instructions?: string;
}) {
  const { language } = preprocessQuery(query, {
    detectLanguage: true,
  });

  console.log("[EXULU] Language detected:", language);

  // Create the agent
  console.log(
    "[EXULU] Creating agentic retrieval agent",
    "available contexts:",
    contexts.map((ctx) => ctx.id),
  );
  const agent = createAgenticRetrievalAgent({
    contexts,
    user,
    role,
    model,
    instructions,
    projectRetrievalTool,
    language,
  });

  console.log("[EXULU] Starting agentic retrieval");

  try {
    // Create a promise that resolves when onFinish is called
    let finishResolver: (value: any) => void;
    let finishRejector: (error: Error) => void;

    const finishPromise = new Promise<any>((resolve, reject) => {
      finishResolver = resolve;
      finishRejector = reject;
    });

    // Set a timeout that will reject if onFinish is never called
    const timeoutId = setTimeout(() => {
      finishRejector(new Error("Agentic retrieval timed out after 240 seconds"));
    }, 240000);

    const result = agent.generate({
      reranker,
      query,
      onFinish: (output) => {
        clearTimeout(timeoutId);
        finishResolver(output);
      },
    });

    // Yield all intermediate outputs from the generator
    for await (const output of result) {
      yield output;
    }

    // Wait for onFinish to be called (or timeout)
    const finalOutput = await finishPromise;

    console.log("[EXULU] Agentic retrieval output", finalOutput);

    return finalOutput;
  } catch (error) {
    console.error("[EXULU] Agentic retrieval error:", error);
    yield JSON.stringify({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
}

/**
 * Creates an ExuluTool instance for agentic retrieval across all contexts
 * This should be added to an agent's tool set
 */
export const createAgenticRetrievalTool = ({
  contexts,
  rerankers,
  user,
  role,
  model,
  projectRetrievalTool,
}: {
  contexts: ExuluContext[];
  rerankers: ExuluReranker[];
  user?: User;
  role?: string;
  model: any;
  projectRetrievalTool?: ExuluTool;
}): ExuluTool | undefined => {

  const license = checkLicense()
  if (!license["agentic-retrieval"]) {
    console.warn(`[EXULU] You are not licensed to use agentic retrieval.`);
    return undefined;
  }

  const contextNames = contexts.map((ctx) => ctx.id).join(", ");

  return new ExuluTool({
    id: "agentic_context_search",
    name: "Agentic Context Search",
    description: `Intelligent context search tool that uses AI to reason through and retrieve relevant information from available knowledge bases (${contextNames}). This tool can understand complex queries, search across multiple contexts, filter items by name, id, external id, and expand context as needed.`,
    category: "contexts",
    type: "context",
    // Config to enable / disable individual contexts
    config: [
      {
        name: "instructions",
        description: `Custom instructions to use when searching the knowledge bases. This is appended to the default system instructions.`,
        type: "string",
        default: "",
      },
      {
        name: "reranker",
        description: "The reranker to use for the retrieval process.",
        type: "string",
        default: "none",
      },
      ...contexts.map((ctx) => ({
        name: ctx.id,
        description: `Enable search in the ${ctx.name} context. ${ctx.description}`,
        type: "boolean" as "boolean" | "string" | "number" | "variable",
        default: true,
      })),
    ],
    inputSchema: z.object({
      query: z.string().describe("The question or query to answer using the knowledge bases"),
      userInstructions: z
        .string()
        .optional()
        .describe("Instructions provided by the user to customize the retrieval process."),
    }),
    execute: async function* ({
      query,
      userInstructions,
      toolVariablesConfig,
    }: {
      query: string;
      userInstructions?: string;
      instructions?: string;
      [key: string]: any;
    }) {
      let configInstructions = "";
      let configuredReranker: ExuluReranker | undefined;
      if (toolVariablesConfig) {
        configInstructions = toolVariablesConfig.instructions;

        contexts = contexts.filter(
          (ctx) =>
            toolVariablesConfig[ctx.id] === true ||
            toolVariablesConfig[ctx.id] === "true" ||
            toolVariablesConfig[ctx.id] === 1,
        );

        if (toolVariablesConfig.reranker) {
          configuredReranker = rerankers.find(
            (reranker) => reranker.id === toolVariablesConfig.reranker,
          );
          if (!configuredReranker) {
            throw new Error(
              "Reranker not found: " +
                toolVariablesConfig.reranker +
                ", check with a developer if the reranker was removed from the system.",
            );
          }
        }
      }

      console.log("[EXULU] Executing agentic retrieval tool with data", {
        // Log only first level properties
        // Keys of all toolVariablesConfig vars
        configs: Object.keys(toolVariablesConfig),
        query,
        instructions: configInstructions,
        reranker: configuredReranker?.id || undefined,
        contexts: contexts.map((ctx) => ctx.id),
      });

      console.log("[EXULU] Executing agentic retrieval tool");

      // Yield each chunk from the generator
      for await (const chunk of executeAgenticRetrieval({
        contexts,
        reranker: configuredReranker,
        query,
        user,
        role,
        model,
        instructions: `${configInstructions ? `CUSTOM INSTRUCTIONS PROVIDED BY THE ADMIN: ${configInstructions}` : ""} ${userInstructions ? `INSTRUCTIONS PROVIDED BY THE USER: ${userInstructions}` : ""}`,
        projectRetrievalTool,
      })) {
        yield { result: JSON.stringify(chunk, null, 2) };
      }
    },
  });
};
