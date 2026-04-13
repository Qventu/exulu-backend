import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ClassificationResult, ContextSample } from "./types";

/**
 * Classifies a query into one of four types and identifies which contexts are
 * most relevant. This is a single fast LLM call that runs before the main
 * agent loop, enabling strategy-based routing.
 */
export async function classifyQuery(
  query: string,
  contexts: ExuluContext[],
  samples: ContextSample[],
  model: LanguageModel,
): Promise<ClassificationResult> {
  const contextDescriptions = contexts
    .map((ctx) => {
      const sample = samples.find((s) => s.contextId === ctx.id);
      const fieldList = sample?.fields.join(", ") ?? "name, external_id";
      const exampleStr =
        sample?.exampleItems.length
          ? `\n    Example records: ${JSON.stringify(sample.exampleItems.slice(0, 2))}`
          : "";
      return `  - ${ctx.id}: ${ctx.name}\n    Description: ${ctx.description}\n    Fields: ${fieldList}${exampleStr}`;
    })
    .join("\n\n");

  const result = await generateText({
    model,
    temperature: 0,
    output: Output.object({
      schema: z.object({
        queryType: z
          .enum(["aggregate", "list", "targeted", "exploratory"])
          .describe(
            "aggregate: ONLY use when the user explicitly asks to COUNT how many documents/items/tickets exist in the knowledge base (e.g. 'how many documents about X?', 'total number of tickets'). NEVER use for: real-world statistics stored in a document, intent statements, how-to questions, error/fault descriptions, configuration questions, or any query that does not explicitly ask for a count of knowledge base entries. When in doubt, choose targeted. " +
              "list: user wants to enumerate matching items/documents (show me all, list documents about). " +
              "targeted: use for almost everything — specific fact, answer, configuration, how-to, error/fault, feature/behavior question. Also use for intent statements and short commands describing a desired state (phrases that state what the user wants to do or achieve, even without an explicit question word). Real-world statistics stored in documents also go here. When in doubt, choose targeted over aggregate or exploratory. " +
              "exploratory: only for broad conceptual questions needing multi-source synthesis (what is the process for Z, explain how X works, general overview of topic Y).",
          ),
        language: z
          .string()
          .describe("ISO 639-3 language code of the query (e.g. eng, deu, fra)"),
        suggestedContextIds: z
          .array(z.string())
          .describe(
            "IDs of knowledge bases most likely to contain the answer. Return empty array to search all contexts.",
          ),
      }),
    }),
    toolChoice: "none",
    system: `You are a query classifier for a multi-knowledge-base retrieval system.
Classify the query and identify which knowledge bases are most relevant.

Available knowledge bases:
${contextDescriptions}

Guidelines for queryType:
- Use "aggregate" ONLY when the query contains explicit counting language (e.g., "how many", "count", "total number", "wie viele"). Short statements, commands, or phrases without a question word are NEVER aggregate — classify them as targeted.
- When in doubt between aggregate and targeted: always choose targeted.

Guidelines for suggestedContextIds:
- Be conservative: only suggest contexts that are genuinely likely to contain the answer.
  Aim for 2–3 focused suggestions rather than listing everything.
- Use each knowledge base's name and description (shown above) to judge relevance.
- Return an empty array only if you truly cannot determine which contexts are relevant.`,
    prompt: `Query: ${query}`,
  });

  return result.output as ClassificationResult;
}
