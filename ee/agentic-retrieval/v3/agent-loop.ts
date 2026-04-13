import { generateText, stepCountIs, tool } from "ai";
import type { LanguageModel, Tool as AITool, ModelMessage } from "ai";
import { z } from "zod";
import { withRetry } from "@SRC/utils/with-retry";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import type { AgenticRetrievalOutput, ChunkResult, ClassificationResult } from "./types";
import type { StrategyConfig } from "./strategies";
import { createDynamicTools } from "./dynamic-tools";

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
  query: string;
  strategy: StrategyConfig;
  tools: Record<string, AITool>;
  model: LanguageModel;
  reranker?: ExuluReranker;
  contextGuidance?: string;
  customInstructions?: string;
  classification: ClassificationResult;
  onStepComplete?: (step: AgenticRetrievalOutput["steps"][0]) => void;
}): AsyncGenerator<AgenticRetrievalOutput> {
  const { query, strategy, tools, model, reranker, contextGuidance, customInstructions, onStepComplete } = params;

  const output: AgenticRetrievalOutput = {
    steps: [],
    reasoning: [],
    chunks: [],
    usage: [],
    totalTokens: 0,
  };

  const messages: ModelMessage[] = [{ role: "user", content: query }];
  let dynamicTools: Record<string, AITool> = {};
  let forceDepthExploration = false;
  let forceContextCoverage = false;

  // Track which suggested contexts have been searched to enforce coverage
  const suggestedContextIds = params.classification.suggestedContextIds ?? [];
  const searchedContextIds = new Set<string>();

  const baseSystemPrompt = [
    strategy.instructions,
    contextGuidance ? `\nCONTEXT GUIDANCE:\n${contextGuidance}` : "",
    customInstructions ? `\nCUSTOM INSTRUCTIONS (override context guidance above where they conflict):\n${customInstructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const SEARCH_TOOL_NAMES = new Set([
    "search_content",
    "save_search_results",
    "count_items_or_chunks",
    "search_items_by_name",
  ]);

  for (let step = 0; step < strategy.stepBudget; step++) {
    console.log(`[EXULU] v3 agent loop — step ${step + 1}/${strategy.stepBudget}`);

    // Build dynamic system prompt: add unsearched-context note after the first step
    const unsearchedNow = suggestedContextIds.filter((id) => !searchedContextIds.has(id));
    const contextCoverageNote =
      unsearchedNow.length > 0 && step > 0
        ? `\n\n⚠️ MANDATORY: The following suggested contexts have NOT been searched yet: [${unsearchedNow.join(", ")}]. You MUST include ALL of them in your next search call. Note: support/ticket contexts use document names like "Ticket #XXXX" — do NOT use item_names when searching them.`
        : "";
    const stepSystemPrompt = baseSystemPrompt + contextCoverageNote;

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      const stepTools = forceDepthExploration || forceContextCoverage
        ? { ...tools, ...dynamicTools } // finish_retrieval withheld — model must search/explore more
        : { ...tools, ...dynamicTools, [FINISH_TOOL_NAME]: finishRetrievalTool };

      result = await withRetry(() =>
        generateText({
          model,
          temperature: 0,
          system: stepSystemPrompt,
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

    // Check if any search_content call excluded content (triggers page-load dynamic tools)
    // AI SDK v6 uses `input` (not `args`) for tool call arguments
    const hadExcludedContent = (result.toolCalls as any[])?.some(
      (tc) =>
        (tc.toolName === "search_content" && tc.input?.includeContent === false) ||
        tc.toolName === "search_items_by_name",
    );

    // Rerank if reranker is available
    if (reranker && stepChunks.length > 0) {
      console.log(`[EXULU] v3 reranking ${stepChunks.length} chunks with ${reranker.name}`);
      stepChunks = await reranker.run(query, stepChunks as any);
    }

    // Create dynamic tools (browse adjacent pages, load specific pages)
    const newDynamic = await createDynamicTools(stepChunks as ChunkResult[], hadExcludedContent);
    Object.assign(dynamicTools, newDynamic);

    // If relevant content was found but fewer than 5 chunks, withhold finish_retrieval
    // on the next step to force depth exploration via dynamic tools.
    // Only applies when dynamic tools exist and there's budget remaining for both
    // a depth step and a finish step.
    forceDepthExploration =
      stepChunks.length > 0 &&
      stepChunks.length < 5 &&
      Object.keys(newDynamic).length > 0 &&
      step < strategy.stepBudget - 2;

    // Track which suggested contexts have been searched this step
    for (const tc of (result.toolCalls as any[]) ?? []) {
      if (SEARCH_TOOL_NAMES.has(tc.toolName)) {
        for (const id of (tc.input?.knowledge_base_ids ?? [])) {
          searchedContextIds.add(id);
        }
      }
    }

    // Withhold finish_retrieval on the next step if suggested contexts remain unsearched
    const unsearchedAfterStep = suggestedContextIds.filter((id) => !searchedContextIds.has(id));
    forceContextCoverage = unsearchedAfterStep.length > 0 && step < strategy.stepBudget - 1;
    if (forceContextCoverage) {
      console.log(
        `[EXULU] v3 forceContextCoverage — unsearched suggested: [${unsearchedAfterStep.join(", ")}]`,
      );
    }

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
      dynamicToolsCreated: Object.keys(newDynamic),
      tokens: result.usage?.totalTokens ?? 0,
    };

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
    output.chunks.push(...stepChunks);
    output.usage.push(result.usage);

    onStepComplete?.(stepRecord);

    yield { ...output };

    // Stop if the model called finish_retrieval AND no forced continuation is needed
    const calledFinish = (result.toolCalls as any[])?.some(
      (tc) => tc.toolName === FINISH_TOOL_NAME,
    );
    if (calledFinish && !forceContextCoverage) {
      console.log(`[EXULU] v3 model called finish_retrieval after step ${step + 1}`);
      break;
    } else if (calledFinish && forceContextCoverage) {
      console.log(
        `[EXULU] v3 model called finish_retrieval but overriding — unsearched suggested contexts remain`,
      );
    }
  }

  output.totalTokens = output.usage.reduce((sum, u) => sum + (u?.totalTokens ?? 0), 0);
}
