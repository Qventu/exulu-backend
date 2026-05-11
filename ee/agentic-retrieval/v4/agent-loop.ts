import { generateText, stepCountIs, tool } from "ai";
import type { LanguageModel, Tool as AITool, ModelMessage } from "ai";
import { z } from "zod";
import { withRetry } from "@SRC/utils/with-retry";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import type { AgenticRetrievalOutput, ChunkResult } from "./types";
import { DEFAULT_MAX_STEPS, type AgenticRetrievalLog, type ContextRetrievalConfig } from ".";

const FINISH_TOOL_NAME = "finish_retrieval";

const finishRetrievalTool = tool({
  description:
    "Call this tool when you have retrieved sufficient information and no further searches are needed. " +
    "You MUST call this tool to signal that retrieval is complete — do not write a text conclusion.",
  inputSchema: z.object({
    reasoning: z.string().describe("One sentence explaining why retrieval is complete"),
  }),
  execute: async ({ reasoning }) => JSON.stringify({ finished: true, reasoning }),
});

function extractChunksFromToolResults(toolResults: any[]): ChunkResult[] {
  const chunks: ChunkResult[] = [];
  for (const result of toolResults ?? []) {
    // AI SDK v6 uses `output` (not `result`) for tool result values
    const rawOutput = result.output ?? result.result;
    let parsed: any;
    try {
      parsed = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item?.item_id && item?.context) {
          chunks.push({
            item_name: item.item_name,
            item_id: item.item_id,
            context: item.context?.id ?? item.context,
            chunk_id: item.chunk_id,
            chunk_index: item.chunk_index,
            chunk_content: item.chunk_content,
            metadata: item.metadata,
          });
        }
      }
    }
  }
  return chunks;
}

/**
 * Core agent loop: one generateText call per step.
 *
 * Unlike v2 (which split each step into a reasoning call + a separate tool
 * execution call), here a single call with toolChoice: "auto" lets the model
 * reason and call tools in one pass. The model sees tool results from the
 * previous step via the conversation history (messages array).
 *
 * The loop stops when:
 * - The model makes no tool calls (it's satisfied), OR
 * - The strategy's stepBudget is exhausted
 */
export async function* runAgentLoop(params: {
  config: ContextRetrievalConfig;
  userQuery: string;
  log: AgenticRetrievalLog;
  todos: {
    status: "planned" | "completed";
    description: string;
    current: boolean;
  }[];
  tools: Record<string, AITool>;
  model: LanguageModel;
  reranker?: ExuluReranker;
  sessionID?: string;
  onStepComplete?: (step: AgenticRetrievalOutput["steps"][0]) => void;
}): AsyncGenerator<AgenticRetrievalOutput> {
  const { userQuery, tools, model, reranker, sessionID, onStepComplete, config, log, todos } = params;

  const output: AgenticRetrievalOutput = {
    steps: [],
    reasoning: [],
    chunks: [],
    usage: [],
    totalTokens: 0,
  };

  const messages: ModelMessage[] = [{ role: "user", content: userQuery }];

  const stepBudget = config.maxSteps || DEFAULT_MAX_STEPS

  const SYSTEM_PROMPT = `
  You are a helpful assistant that can search the knowledge base and retrieve information.

  You are searching for information that is relevant to the following question:
  <user_query>
  ${userQuery}
  </user_query>

  You have the following instructions for this knowledge base:
  <instructions>
  ${config.instructions}
  </instructions>

  A first search strategy was drafted as a todo list:
  <todo_list>
  ${todos.map((todo, index) => `${index + 1}. ${todo.status} - ${todo.description}`).join("\n")}
  </todo_list>

  `;

  for (let step = 0; step < stepBudget; step++) {

    log.entries.push({
      label: "Agent loop step",
      timestamp: new Date().toISOString(),
      message: `[EXULU] v3 agent loop — step ${step + 1}/${stepBudget}`,
    });

    let result: Awaited<ReturnType<typeof generateText>>;

    const stepTools = { ...tools, [FINISH_TOOL_NAME]: finishRetrievalTool };
    
    try {
      result = await withRetry(() =>
        generateText({
          model,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages,
          tools: stepTools,
          toolChoice: "required",
          stopWhen: stepCountIs(1),
        }),
      );
    } catch (err) {
      console.error("[EXULU] v3 generateText failed:", err);
      throw err;
    }

    // Carry conversation forward: assistant message + tool results go into history
    // so the model sees them on the next iteration.
    messages.push(...(result.response.messages as ModelMessage[]));

    // Extract chunks from tool results
    let stepChunks: any[] = extractChunksFromToolResults(result.toolResults as any[]);

    // Deduplicate by chunk_id within this step (parallel tool calls can return the same chunk
    // if the agent searches the same context twice, or the same chunk is indexed in two contexts).
    const seenChunkIds = new Set<string>();
    stepChunks = stepChunks.filter((c) => {
      if (!c.chunk_id) return true;
      if (seenChunkIds.has(c.chunk_id)) return false;
      seenChunkIds.add(c.chunk_id);
      return true;
    });

    // Record step
    const stepRecord = {
      stepNumber: step + 1,
      text: result.text ?? "",
      toolCalls: (result.toolCalls as any[])?.map((tc) => ({
        name: tc.toolName,
        id: tc.toolCallId,
        input: tc.input,
      })) ?? [],
      chunks: stepChunks,
      tokens: result.usage?.totalTokens ?? 0,
    };

    log.entries.push({
      label: "Step completed",
      timestamp: new Date().toISOString(),
      message: JSON.stringify(stepRecord),
    });

    output.steps.push(stepRecord);
    output.reasoning.push({
      text: result.text ?? "",
      tools: (result.toolCalls as any[])?.map((tc) => ({
        name: tc.toolName,
        id: tc.toolCallId,
        input: tc.input,
        output: stepChunks,
      })) ?? [],
    });
    // Deduplicate against chunks already accumulated from prior steps
    const existingChunkIds = new Set(output.chunks.map((c) => c.chunk_id).filter(Boolean));
    output.chunks.push(...stepChunks.filter((c) => !c.chunk_id || !existingChunkIds.has(c.chunk_id)));
    output.usage.push(result.usage);

    onStepComplete?.(stepRecord);

    yield { ...output };

    // Stop if the model called finish_retrieval AND no forced continuation is needed
    const calledFinish = (result.toolCalls as any[])?.some(
      (tc) => tc.toolName === FINISH_TOOL_NAME,
    );
    if (calledFinish) {
      console.log(`[EXULU] v3 model called finish_retrieval after step ${step + 1}`);
      break;
    }
  }

  output.totalTokens = output.usage.reduce((sum, u) => sum + (u?.totalTokens ?? 0), 0);
}
