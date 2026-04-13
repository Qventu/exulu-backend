import { generateText, stepCountIs } from "ai";
import type { LanguageModel, Tool as AITool, ModelMessage } from "ai";
import { withRetry } from "@SRC/utils/with-retry";
import { harvestChunks } from "./tools";
import type { AgenticRetrievalOutput, ChunkResult } from "./types";

const MAX_STEPS = 10;

/**
 * Observe → Infer → Act loop for V4 agentic retrieval.
 *
 * Unlike V3 (which pre-classifies, routes to strategies, and forces tool calls),
 * this loop simply:
 *  1. Calls the model with toolChoice "auto"
 *  2. Executes whatever tools the model picks
 *  3. Harvests any chunk-shaped rows from query results
 *  4. Repeats until the model produces a text response (no tool calls) or
 *     the MAX_STEPS budget is exhausted
 *
 * The model decides when it has enough information — no finish_retrieval tool needed.
 */
export async function* runAgentLoop(params: {
  query: string;
  systemPrompt: string;
  tools: Record<string, AITool>;
  model: LanguageModel;
  onStepComplete?: (step: AgenticRetrievalOutput["steps"][0]) => void;
}): AsyncGenerator<AgenticRetrievalOutput> {
  const { query, systemPrompt, tools, model, onStepComplete } = params;

  const output: AgenticRetrievalOutput = {
    steps: [],
    reasoning: [],
    chunks: [],
    usage: [],
    totalTokens: 0,
  };

  // Deduplicate chunks by chunk_id across all steps
  const seenChunkIds = new Set<string>();

  const messages: ModelMessage[] = [{ role: "user", content: query }];

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(`[EXULU] v4 agent loop — step ${step + 1}/${MAX_STEPS}`);

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await withRetry(() =>
        generateText({
          model,
          temperature: 0,
          system: systemPrompt,
          messages,
          tools,
          toolChoice: "auto",
          stopWhen: stepCountIs(1),
        }),
      );
    } catch (err) {
      console.error("[EXULU] v4 generateText failed:", err);
      throw err;
    }

    // Append assistant turn + tool results to conversation history
    messages.push(...(result.response.messages as ModelMessage[]));

    // Harvest chunks from any execute_query tool results
    const rawToolResults = (result.toolResults as any[]) ?? [];
    const stepChunks: ChunkResult[] = [];
    for (const chunk of harvestChunks(rawToolResults)) {
      if (!chunk.chunk_id || !seenChunkIds.has(chunk.chunk_id)) {
        if (chunk.chunk_id) seenChunkIds.add(chunk.chunk_id);
        stepChunks.push(chunk);
      }
    }

    // Record step
    const stepRecord: AgenticRetrievalOutput["steps"][0] = {
      stepNumber: step + 1,
      text: result.text ?? "",
      toolCalls:
        (result.toolCalls as any[])?.map((tc) => ({
          name: tc.toolName,
          id: tc.toolCallId,
          input: tc.input,
        })) ?? [],
      chunks: stepChunks,
      tokens: result.usage?.totalTokens ?? 0,
    };

    output.steps.push(stepRecord);
    output.reasoning.push({
      text: result.text ?? "",
      tools:
        (result.toolCalls as any[])?.map((tc) => ({
          name: tc.toolName,
          id: tc.toolCallId,
          input: tc.input,
          output: rawToolResults.find(
            (r: any) => (r.toolCallId ?? r.id) === tc.toolCallId,
          )?.output,
        })) ?? [],
    });
    output.chunks.push(...stepChunks);
    output.usage.push(result.usage);

    onStepComplete?.(stepRecord);

    yield { ...output };

    // Stop when the model wrote a text response without calling any tools
    const calledTools = (result.toolCalls as any[])?.length > 0;
    if (!calledTools) {
      console.log(`[EXULU] v4 — model finished after step ${step + 1} (no tool calls)`);
      break;
    }
  }

  output.totalTokens = output.usage.reduce((sum, u) => sum + (u?.totalTokens ?? 0), 0);
}
