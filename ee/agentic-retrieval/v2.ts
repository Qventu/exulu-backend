import { z } from "zod";
import {
  stepCountIs,
  tool,
  type LanguageModel,
  type Tool as AITool,
  Output,
  generateText,
} from "ai";
import { createBashTool } from "bash-tool";
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
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Agentic Retrieval Tool V2
 *
 * Enhanced version with:
 * - Virtual bash environment for iterative filtering (bash-tool)
 * - COUNT and aggregation queries
 * - save_search_results for token-efficient large result handling
 *
 * The agent can:
 * - Search and save results to virtual filesystem for grep-based filtering
 * - Count items/chunks with advanced filters
 * - Iteratively refine results without loading into context
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

/**
 * Retrieval Trajectory - Full log of the retrieval process for analysis
 */
interface RetrievalTrajectory {
  timestamp: string;
  initial_query: string;
  detected_language: string;
  available_contexts: string[];
  enabled_contexts: string[];
  reranker_used?: string;
  custom_instructions?: string;

  steps: {
    step_number: number;
    timestamp: string;

    // Reasoning phase
    reasoning: {
      text: string;
      finished: boolean;
      tokens_used: number;
      duration_ms: number;
    };

    // Tool execution phase
    tool_execution?: {
      tools_called: {
        tool_name: string;
        tool_id: string;
        input: any;
        output_summary: string; // Truncated output for readability
        output_length: number; // Full output length in characters
        success: boolean;
        error?: string;
        duration_ms: number;
      }[];
      chunks_retrieved: number;
      chunks_after_reranking?: number;
      total_tokens_used: number;
    };

    // Dynamic tools created in this step
    dynamic_tools_created: string[];
  }[];

  // Final results
  final_results: {
    total_chunks: number;
    total_steps: number;
    total_tokens: number;
    total_duration_ms: number;
    success: boolean;
    error?: string;
  };

  // Performance metrics
  performance: {
    tokens_per_step: number[];
    avg_tokens_per_step: number;
    chunks_per_step: number[];
    tool_usage_frequency: Record<string, number>;
  };
}

/**
 * Trajectory Logger - Manages logging of retrieval trajectories
 */
class TrajectoryLogger {
  private trajectory: RetrievalTrajectory;
  private startTime: number;
  private logDir: string;

  constructor(query: string, language: string, contexts: string[], config: any) {
    this.startTime = Date.now();
    this.trajectory = {
      timestamp: new Date().toISOString(),
      initial_query: query,
      detected_language: language,
      available_contexts: contexts,
      enabled_contexts: config.enabledContexts || contexts,
      reranker_used: config.reranker,
      custom_instructions: config.instructions,
      steps: [],
      final_results: {
        total_chunks: 0,
        total_steps: 0,
        total_tokens: 0,
        total_duration_ms: 0,
        success: false,
      },
      performance: {
        tokens_per_step: [],
        avg_tokens_per_step: 0,
        chunks_per_step: [],
        tool_usage_frequency: {},
      },
    };

    // Log directory: ee/agentic-retrieval/logs/YYYY-MM-DD/
    this.logDir = path.join('./');
  }

  logStep(
    stepNumber: number,
    reasoning: { text: string; finished: boolean; tokens: number; durationMs: number },
    toolExecution?: {
      toolCalls: any[];
      toolResults: any[];
      chunks: any[];
      chunksAfterReranking?: number;
      tokens: number;
    },
    dynamicToolsCreated: string[] = []
  ) {
    const stepLog: RetrievalTrajectory['steps'][0] = {
      step_number: stepNumber,
      timestamp: new Date().toISOString(),
      reasoning: {
        text: reasoning.text,
        finished: reasoning.finished,
        tokens_used: reasoning.tokens,
        duration_ms: reasoning.durationMs,
      },
      dynamic_tools_created: dynamicToolsCreated,
    };

    if (toolExecution) {
      const toolsExecuted = toolExecution.toolCalls.map((call, idx) => {
        const result = toolExecution.toolResults[idx];
        let outputStr = '';
        try {
          outputStr = typeof result?.output === 'string'
            ? result.output
            : JSON.stringify(result?.output || {});
        } catch (e) {
          outputStr = '[Error serializing output]';
        }

        return {
          tool_name: call.toolName,
          tool_id: call.toolCallId,
          input: call.input,
          output_summary: outputStr.substring(0, 500) + (outputStr.length > 500 ? '...' : ''),
          output_length: outputStr.length,
          success: !result?.error,
          error: result?.error,
          duration_ms: 0, // Would need to track individually
        };
      });

      stepLog.tool_execution = {
        tools_called: toolsExecuted,
        chunks_retrieved: toolExecution.chunks.length,
        chunks_after_reranking: toolExecution.chunksAfterReranking,
        total_tokens_used: toolExecution.tokens,
      };

      // Update tool usage frequency
      toolsExecuted.forEach(tool => {
        this.trajectory.performance.tool_usage_frequency[tool.tool_name] =
          (this.trajectory.performance.tool_usage_frequency[tool.tool_name] || 0) + 1;
      });

      this.trajectory.performance.chunks_per_step.push(toolExecution.chunks.length);
    }

    this.trajectory.performance.tokens_per_step.push(reasoning.tokens + (toolExecution?.tokens || 0));
    this.trajectory.steps.push(stepLog);
  }

  async finalize(output: AgenticRetrievalOutput, success: boolean, error?: Error) {
    const duration = Date.now() - this.startTime;

    this.trajectory.final_results = {
      total_chunks: output.chunks.length,
      total_steps: this.trajectory.steps.length,
      total_tokens: output.totalTokens,
      total_duration_ms: duration,
      success: success,
      error: error?.message,
    };

    this.trajectory.performance.avg_tokens_per_step =
      this.trajectory.performance.tokens_per_step.reduce((a, b) => a + b, 0) /
      Math.max(this.trajectory.performance.tokens_per_step.length, 1);

    // Write to file
    await this.writeToFile();

    console.log(`[EXULU] V2 - Trajectory logged: trajectory.json`);
    console.log(`[EXULU] V2 - Log file: ${this.getLogFilePath()}`);
  }

  private getLogFilePath(): string {
    return "trajectory.json";
  }

  private async writeToFile() {
    try {
      // Ensure log directory exists
      await fs.mkdir(this.logDir, { recursive: true });

      const logFilePath = this.getLogFilePath();

      // Write trajectory as pretty JSON
      await fs.writeFile(
        logFilePath,
        JSON.stringify(this.trajectory, null, 2),
        'utf-8'
      );

    } catch (error) {
      console.error('[EXULU] V2 - Failed to write trajectory log:', error);
      // Don't throw - logging failure shouldn't break retrieval
    }
  }
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

2. AFTER RECEIVING RESULTS - Reflect in ONE CONCISE LINE:
   Format: 💭 [Count] results | [Relevance] | [Next action]

IMPORTANT:
- ONE LINE per reasoning block - be extremely concise
- Use the same language as the user query
- Focus only on: what, tool/method, outcome

NEW CAPABILITIES IN V2:

FOR COUNTING QUERIES (e.g., "how many documents...", "count items that...", "total number of..."):
Use the count_items_or_chunks tool. You can count:
- Total items in a context
- Total chunks in a context
- Items matching specific criteria (name contains, created after date, etc.)
- Chunks containing specific content

FOR LARGE RESULT SETS (e.g., "find all documents about X", "show me everything related to Y"):
When you expect many results (>20) and need to filter iteratively:
1. Use save_search_results tool to save results to virtual filesystem (doesn't load into context)
2. Tool returns success message confirming results were saved to /search_results.txt
3. Use bash tools (grep, awk, head, tail) to filter and explore results
4. Only load specific chunks after identifying them via grep
This saves tokens and allows iterative refinement.

Example workflow for large results:
- save_search_results → "Saved 100 results to /search_results.txt"
- bash: "grep -i 'safety procedures' search_results.txt | head -20" → Shows matching lines
- bash: "grep -B 3 'emergency' search_results.txt | grep 'CHUNK_ID:'" → Extract specific chunk IDs
- get_content tool → Load only that specific chunk

FOR TARGETED QUERIES (e.g., "how do I configure WPA-2 on my DPO-1 router"):
Use the standard search workflow:
1. Find relevant items (search_items_by_name or search_content with includeContent: false)
2. Search within those items (search_content with hybrid method)

Choose your strategy based on the query type:

FOR LISTING QUERIES (e.g., "list all documents about X", "what items mention Y", "show me documents regarding Z"):

CRITICAL DECISION - When to use which tool:

⚠️ Use search_items_by_name ONLY when:
- User asks for documents BY TITLE/NAME (e.g., "find document named...", "show me file titled...")
- Looking for specific filename patterns (e.g., "all items with 'report' in the name")
- Query is explicitly about document TITLES, not their content

✅ Use search_content with includeContent: false for CONTENT-BASED listing queries:
- "List all documents about [topic]" → Searches document CONTENT for the topic
- "What documents mention [subject]" → Searches CONTENT for mentions of the subject
- "Show me documents regarding [thing]" → Searches CONTENT for discussions of the thing
- Any query asking about document TOPICS, SUBJECTS, or CONCEPTS → Search CONTENT

KEY PRINCIPLE:
- search_items_by_name = "Does the FILENAME contain this word?"
- search_content = "Does the DOCUMENT DISCUSS this topic?"

DEFAULT RULE: When in doubt, use search_content with includeContent: false for listing queries.
This searches the actual content and returns matching item names/metadata without loading full text.

IMPORTANT: For listing queries, NEVER set includeContent: true unless you need the actual text content to answer

FOR TARGETED QUERIES (e.g., "how do I configure X", "what does the manual say about Y"):
TWO-STEP PATTERN:
1. Find relevant documents: Use search_content with includeContent: false
2. Get specific information: Use search_content with includeContent: true to retrieve the answer

ONLY say "no information found" if you have:
✓ Searched ALL available contexts
✓ Tried hybrid, keyword, AND semantic search
✓ Tried variations of the search terms
✓ Confirmed zero results across all attempts

Search Method Selection:
- Use 'hybrid' method by default (combines semantic + keyword matching)
- Use 'keyword' method for exact terms (technical terms, product names, IDs)
- Use 'semantic' method for conceptual queries (synonyms and paraphrasing)

Filtering and Limits:
- Limit results appropriately (don't retrieve more than needed)
- Use count tools when user asks "how many" instead of retrieving all items
`;

// Copy the generator function from index.ts (keeping it the same)
function createCustomAgenticRetrievalToolLoopAgent({
  tools,
  model,
  customInstructions,
  trajectoryLogger,
}: {
  language?: string;
  tools: Record<string, AITool>;
  model: LanguageModel;
  customInstructions?: string;
  trajectoryLogger?: TrajectoryLogger;
}): {
  generate: (args: {
    query: string;
    reranker?: ExuluReranker;
    onFinish: (output: AgenticRetrievalOutput) => void;
    trajectoryLogger?: TrajectoryLogger;
  }) => AsyncGenerator<AgenticRetrievalOutput>;
} {
  return {
    generate: async function* ({
      reranker, 
      query,
      onFinish,
      trajectoryLogger: trajectoryLoggerParam,
    }: {
      reranker?: ExuluReranker;
      query: string;
      onFinish: (output: any) => void;
      trajectoryLogger?: TrajectoryLogger;
    }): AsyncGenerator<any> {
      // Use the trajectory logger passed as parameter
      const trajectoryLogger = trajectoryLoggerParam || trajectoryLogger;
      let finished = false;
      let maxSteps = 2;
      let currentStep = 0;
      const output: AgenticRetrievalOutput = {
        reasoning: [],
        chunks: [],
        usage: [],
        totalTokens: 0,
      };

      let dynamicTools: Record<string, AITool> = {};
      let executionError: Error | undefined;

      while (!finished && currentStep < maxSteps) {
        currentStep++;

        console.log("[EXULU] Agentic retrieval v2 step", currentStep);

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

        // First generateText call - reasoning
        let reasoningOutput: Awaited<ReturnType<typeof generateText>>;
        const reasoningStartTime = Date.now();
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
          executionError = error as Error;
          throw error;
        }
        const reasoningDuration = Date.now() - reasoningStartTime;

        const { reasoning: briefing, finished } = reasoningOutput?.output || {};

        const { usage: reasoningUsage } = reasoningOutput || {};

        output.usage.push(reasoningUsage);

        if (finished) {
          console.log("[EXULU] Agentic retrieval finished for step", currentStep);

          // Log this final reasoning step
          if (trajectoryLogger) {
            trajectoryLogger.logStep(
              currentStep,
              {
                text: briefing || "Finished - no further steps needed",
                finished: true,
                tokens: reasoningUsage?.totalTokens || 0,
                durationMs: reasoningDuration,
              }
            );
          }

          break;
        }

        // Second generateText call - tool execution
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
                try {
                  chunks = JSON.parse(result.output);
                } catch (e) {
                  // If parse fails, this might be bash output or count result
                  console.log("[EXULU] Tool output is not JSON, skipping chunk processing");
                  return [];
                }
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

        if (chunks && chunks.length > 0 && reranker) {
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

        if (chunks && chunks.length > 0) {
          output.chunks.push(...chunks);
        }

        console.log("[EXULU] Pushing reasoning for step", currentStep);

        const exludedContent = toolCalls?.some(
          (toolCall) =>
            toolCall.input?.includeContent === false ||
            toolCall.toolName.startsWith("search_items_by_name"),
        );

        // Track dynamic tools created in this step
        const dynamicToolsCreatedThisStep: string[] = [];

        // Create chunk specific tools for context expansion
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
              dynamicToolsCreatedThisStep.push(getMoreToolName);
              dynamicTools[getMoreToolName] = tool({
                description: `The item ${chunk.item_name} has a total of ${chunksCount} chunks, this tool allows you to get more content from this item across all its pages / chunks.`,
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
            dynamicToolsCreatedThisStep.push(getContentToolName);
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

        // Log this step to trajectory
        if (trajectoryLogger) {
          trajectoryLogger.logStep(
            currentStep,
            {
              text: briefing || "",
              finished: false,
              tokens: reasoningUsage?.totalTokens || 0,
              durationMs: reasoningDuration,
            },
            {
              toolCalls: toolCalls || [],
              toolResults: toolResults || [],
              chunks: chunks,
              chunksAfterReranking: reranker && chunks.length > 0 ? chunks.length : undefined,
              tokens: toolUsage?.totalTokens || 0,
            },
            dynamicToolsCreatedThisStep
          );
        }

        console.log(`[EXULU] Agentic retrieval step ${currentStep} completed`);
        console.log("[EXULU] Agentic retrieval step output", output);

        yield output;
      }

      const totalTokens = output.usage.reduce((acc, usage) => acc + (usage.totalTokens || 0), 0);
      output.totalTokens = totalTokens;

      console.log("[EXULU] Agentic retrieval finished", output);

      // Finalize trajectory log
      if (trajectoryLogger) {
        await trajectoryLogger.finalize(output, !executionError, executionError);
      }

      onFinish(output);
    },
  };
}

/**
 * Creates an enhanced agentic retrieval agent with bash support and advanced capabilities
 */
const createAgenticRetrievalAgent = async ({
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
  model: LanguageModel;
  instructions?: string;
  projectRetrievalTool?: ExuluTool;
  language?: string;
}): Promise<{
  generate: (args: {
    query: string;
    reranker?: ExuluReranker;
    trajectoryLogger?: TrajectoryLogger;
    onFinish: (output: AgenticRetrievalOutput) => void;
  }) => AsyncGenerator<AgenticRetrievalOutput>;
  updateVirtualFiles: (files: Record<string, string>) => Promise<void>;
}> => {
  // Initialize virtual bash environment
  const { tools: bashTools, updateFiles } = await createBashTool({
    files: {}, // Start with empty virtual filesystem
  });

  console.log("[EXULU] Created bash tools:", Object.keys(bashTools));

  // NEW TOOL 1: save_search_results - saves results to virtual filesystem for iterative filtering
  const saveSearchResultsTool = tool({
    description: `
      Execute a search and save results to the virtual filesystem instead of returning them directly.
      This is useful when you expect many results (>20) and want to iteratively filter them
      without consuming tokens by loading all content into context.

      After saving, you can use bash tools (grep, awk, head, tail) to find specific patterns.
      The file will be available in the virtual filesystem at /search_results.txt

      The results are formatted with clear separators so you can easily grep for:
      - ITEM_NAME: to find documents by name
      - CHUNK_ID: to extract specific chunk IDs
      - SCORE: to see relevance scores
      - Content between ---CONTENT START--- and ---CONTENT END---

      Example usage after saving:
      - grep -i "safety" search_results.txt | head -20
      - grep "ITEM_NAME: Manual" search_results.txt -A 15
      - grep "CHUNK_ID:" search_results.txt | head -10
    `,
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
      query: z.string().describe("The search query to find relevant chunks"),
      searchMethod: z
        .enum(["keyword", "semantic", "hybrid"])
        .default("hybrid")
        .describe("Search method to use"),
      limit: z.number().max(1000).default(100).describe("Maximum number of results to retrieve and save (max 1000)"),
      includeContent: z.boolean().default(true).describe("Whether to include full chunk content in saved results. Set to false if you only need metadata and plan to load specific chunks later."),
    }),
    execute: async ({ query, knowledge_base_ids, searchMethod, limit, includeContent }) => {
      if (!knowledge_base_ids?.length) {
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
            throw new Error("Knowledge base ID not found: " + knowledge_base_id);
          }

          const searchResults = await ctx.search({
            query: query,
            method:
              searchMethod === "hybrid"
                ? "hybridSearch"
                : searchMethod === "keyword"
                  ? "tsvector"
                  : "cosineDistance",
            limit: Math.min(limit, 1000),
            page: 1,
            itemFilters: [],
            chunkFilters: [],
            sort: { field: "updatedAt", direction: "desc" },
            user,
            role,
            trigger: "tool",
          });

          return searchResults.chunks;
        })
      );

      const chunks = results.flat();

      // Format results in a greppable format with clear separators
      const formattedContent = chunks.map((chunk, idx) =>
        `### RESULT ${idx + 1} ###\n` +
        `ITEM_NAME: ${chunk.item_name}\n` +
        `ITEM_ID: ${chunk.item_id}\n` +
        `CHUNK_ID: ${chunk.chunk_id}\n` +
        `CHUNK_INDEX: ${chunk.chunk_index}\n` +
        `CONTEXT: ${chunk.context?.id}\n` +
        `SCORE: ${chunk.chunk_hybrid_score || chunk.chunk_fts_rank || chunk.chunk_cosine_distance || 0}\n` +
        `---CONTENT START---\n` +
        `${includeContent && chunk.chunk_content ? chunk.chunk_content : '[Content not included - use includeContent: true to load, or use get_content tool for specific chunks]'}\n` +
        `---CONTENT END---\n\n`
      ).join('');

      // Update virtual filesystem with search results
      await updateFiles({
        'search_results.txt': formattedContent,
        'search_metadata.json': JSON.stringify({
          query,
          timestamp: new Date().toISOString(),
          results_count: chunks.length,
          contexts: knowledge_base_ids,
          method: searchMethod,
        }, null, 2)
      });

      return JSON.stringify({
        success: true,
        results_count: chunks.length,
        message: `Saved ${chunks.length} results to virtual filesystem at /search_results.txt. You can now use bash tools to grep/filter the results without loading them into context.`,
        available_commands: [
          'bash: cat search_results.txt | head -50',
          'bash: grep -i "your pattern" search_results.txt',
          'bash: grep "ITEM_NAME: specific_name" search_results.txt -A 10',
          'bash: grep "CHUNK_ID:" search_results.txt | head -10',
        ],
        next_steps: "Use bash tools to grep/filter the results. Once you identify relevant chunks, you can load their full content using the get_content tools.",
      }, null, 2);
    },
  });

  // NEW TOOL 2: count_items_or_chunks - COUNT queries without loading data
  const countTool = tool({
    description: `
      Count items or chunks matching specific criteria WITHOUT loading them into context.
      Use this when the user asks "how many...", "count...", or "number of...".

      You can count:
      - Total items in one or more contexts
      - Total chunks in one or more contexts
      - Items where name contains specific text
      - Chunks containing specific content (uses search to find matches, then counts)

      This is much more efficient than retrieving all results just to count them.
    `,
    inputSchema: z.object({
      knowledge_base_ids: z.array(z.enum(contexts.map((ctx) => ctx.id) as [string, ...string[]]))
        .describe(`
          The available knowledge bases to count from:
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
      count_what: z.enum(['items', 'chunks']).describe("Whether to count items or chunks"),
      name_contains: z.string().optional().describe("Only count items where name contains this text (case-insensitive)"),
      content_query: z.string().optional().describe("Only count chunks that match this search query (uses hybrid search to find relevant chunks, then counts them)"),
    }),
    execute: async ({ knowledge_base_ids, count_what, name_contains, content_query }) => {
      if (!knowledge_base_ids?.length) {
        knowledge_base_ids = contexts.map((ctx) => ctx.id);
      }

      const { db } = await postgresClient();

      const counts = await Promise.all(
        knowledge_base_ids.map(async (knowledge_base_id) => {
          const ctx = contexts.find((c) => c.id === knowledge_base_id);
          if (!ctx) {
            throw new Error("Knowledge base ID not found: " + knowledge_base_id);
          }

          let count = 0;

          if (count_what === 'items') {
            const tableName = getTableName(ctx.id);
            let query = db(tableName).count('id as count');

            if (name_contains) {
              query = query.whereRaw('LOWER(name) LIKE ?', [`%${name_contains.toLowerCase()}%`]);
            }

            // Apply access control
            const tableDefinition = convertContextToTableDefinition(ctx);
            query = applyAccessControl(tableDefinition, query, user, tableName);

            const result = await query.first();
            count = Number(result?.count || 0);
          } else {
            // count_what === 'chunks'
            const chunksTableName = getChunksTableName(ctx.id);

            if (content_query) {
              // Use search to find matching chunks, then count
              const searchResults = await ctx.search({
                query: content_query,
                method: 'hybridSearch',
                limit: 10000, // Large limit to get all matches
                page: 1,
                itemFilters: [],
                chunkFilters: [],
                user,
                role,
                trigger: "tool",
              });
              count = searchResults.chunks.length;
            } else {
              // Count all chunks
              let query = db(chunksTableName).count('id as count');
              const result = await query.first();
              count = Number(result?.count || 0);
            }
          }

          return {
            context: knowledge_base_id,
            context_name: ctx.name,
            count: count,
          };
        })
      );

      const totalCount = counts.reduce((sum, c) => sum + c.count, 0);

      return JSON.stringify({
        success: true,
        total_count: totalCount,
        breakdown_by_context: counts,
        query_details: {
          counted: count_what,
          name_filter: name_contains || 'none',
          content_filter: content_query || 'none',
          contexts_searched: knowledge_base_ids.length,
        },
      }, null, 2);
    },
  });

  // Copy existing search tools from index.ts
  const searchItemsByNameTool = {
    search_items_by_name: tool({
      description: `Search for relevant items by name across the available knowledge bases.`,
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
              throw new Error(
                "Knowledge base ID that was provided to search items by name not found: " + knowledge_base_id,
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
              throw new Error("Item id and context are required to get chunks.");
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
              throw new Error("Knowledge base ID that was provided to search content not found: " + knowledge_base_id);
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

  console.log("[EXULU] Creating v2 agent with tools:", {
    search: Object.keys(searchTools),
    searchByName: Object.keys(searchItemsByNameTool),
    new: ['save_search_results', 'count_items_or_chunks'],
    bash: Object.keys(bashTools).slice(0, 5) + '...',
  });

  // Note: trajectoryLogger will be passed when calling agent.generate()

  const agent = createCustomAgenticRetrievalToolLoopAgent({
    language,
    model,
    customInstructions: custom,
    tools: {
      ...searchTools,
      ...searchItemsByNameTool,
      save_search_results: saveSearchResultsTool,
      count_items_or_chunks: countTool,
      ...bashTools, // Add all bash tools (grep, awk, sed, head, tail, cat, etc.)
      ...(projectRetrievalTool ? { [projectRetrievalTool.id]: projectRetrievalTool.tool } : {}),
    },
  });

  return {
    ...agent,
    updateVirtualFiles: updateFiles,
  };
};

/**
 * Generator function for executing agentic retrieval - same as index.ts but uses v2 agent
 */
async function* executeAgenticRetrievalV2({
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

  console.log("[EXULU] V2 - Language detected:", language);

  // Create trajectory logger
  const trajectoryLogger = new TrajectoryLogger(
    query,
    language,
    contexts.map(c => c.id),
    
    {
      enabledContexts: contexts.map(c => c.id),
      reranker: reranker?.id,
      instructions: instructions,
    }
  );

  const agent = await createAgenticRetrievalAgent({
    contexts,
    user,
    role,
    model,
    instructions,
    projectRetrievalTool,
    language,
  });

  console.log("[EXULU] V2 - Starting agentic retrieval");

  try {
    let finishResolver: (value: any) => void;
    let finishRejector: (error: Error) => void;

    const finishPromise = new Promise<any>((resolve, reject) => {
      finishResolver = resolve;
      finishRejector = reject;
    });

    const timeoutId = setTimeout(() => {
      finishRejector(new Error("Agentic retrieval timed out after 240 seconds"));
    }, 240000);

    const result = agent.generate({
      reranker,
      query,
      trajectoryLogger: trajectoryLogger,
      onFinish: (output) => {
        clearTimeout(timeoutId);
        finishResolver(output);
      },
    });

    for await (const output of result) {
      yield output;
    }

    const finalOutput = await finishPromise;

    console.log("[EXULU] V2 - Agentic retrieval output", finalOutput);

    return finalOutput;
  } catch (error) {
    console.error("[EXULU] V2 - Agentic retrieval error:", error);
    yield JSON.stringify({
      status: "error",
      message: error instanceof Error ? error.message : "Unknown error occurred",
    });
  }
}

/**
 * Creates V2 ExuluTool instance for agentic retrieval
 */
export const createAgenticRetrievalToolV2 = ({
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
  const license = checkLicense();
  if (!license["agentic-retrieval"]) {
    console.warn(`[EXULU] You are not licensed to use agentic retrieval.`);
    return undefined;
  }
  const contextNames = contexts.map((ctx) => ctx.id).join(", ");

  return new ExuluTool({
    id: "agentic_context_search",
    name: "Agentic Context Search",
    description: `Enhanced intelligent context search with virtual bash environment, COUNT queries, and token-efficient large result handling. Searches across: ${contextNames}`,
    category: "contexts",
    type: "context",
    config: [
      {
        name: "instructions",
        description: `Custom instructions for searching the knowledge bases.`,
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

      console.log("[EXULU] V2 - Executing agentic retrieval tool with data", {
        configs: Object.keys(toolVariablesConfig),
        query,
        instructions: configInstructions,
        reranker: configuredReranker?.id || undefined,
        contexts: contexts.map((ctx) => ctx.id),
      });

      for await (const chunk of executeAgenticRetrievalV2({
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
