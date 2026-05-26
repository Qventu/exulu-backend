import {
  convertToModelMessages,
  generateText,
  tool,
  type LanguageModel,
  type UIMessage,
} from "ai";
import { z } from "zod";

const SUGGESTIONS_SYSTEM_PROMPT =
  "You generate short follow-up message suggestions for the user. " +
  "You are NOT continuing the conversation as the assistant — you are predicting " +
  "what the user might want to say next. " +
  "Suggest up to 3 short follow-up questions or messages the user might want to " +
  "send next. Each suggestion must be written from the user's perspective (first " +
  "person) and be 12 words or fewer. " +
  "You MUST submit your answer by calling the `submit_suggestions` tool exactly once. " +
  "Do not emit any plain text — only the tool call.";

const submitSuggestionsTool = tool({
  description:
    "Submit the final list of follow-up message suggestions for the user. " +
    "Must be called exactly once. Each suggestion is written from the user's " +
    "perspective (first person) and is 12 words or fewer.",
  inputSchema: z.object({
    suggestions: z.array(z.string()).max(3),
  }),
});

const MAX_CHARS_PER_MESSAGE = 10_000;

/**
 * Reduce messages to just their text content, capped per message. Suggestion
 * generation only needs the gist of the exchange — file parts, tool-call parts,
 * and reasoning blocks are dropped to keep the suggestion call cheap.
 */
const trimMessagesForSuggestions = (messages: UIMessage[]): UIMessage[] => {
  const out: UIMessage[] = [];
  for (const m of messages) {
    const textBlobs: string[] = [];
    for (const p of m.parts ?? []) {
      if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
        textBlobs.push(p.text);
      }
    }
    if (textBlobs.length === 0) continue;

    let combined = textBlobs.join("\n\n");
    if (combined.length > MAX_CHARS_PER_MESSAGE) {
      combined = combined.slice(0, MAX_CHARS_PER_MESSAGE);
    }

    out.push({
      ...m,
      parts: [{ type: "text", text: combined }],
    });
  }
  return out;
};

/**
 * Generates up to 3 short follow-up message suggestions from the user's perspective
 * based on the last user+assistant exchange. Stateless: does not load or write any
 * session data.
 *
 * Uses a forced tool call (instead of `Output.object` / `generateObject`) because
 * LiteLLM-via-Anthropic does not support OpenAI-style `response_format: json_schema`.
 * Tool calling is the universal cross-provider JSON-enforcement mechanism — for
 * Anthropic specifically, it IS the structured-output API.
 */
export const generateSuggestions = async ({
  languageModel,
  messages,
  agentInstructions,
}: {
  languageModel: LanguageModel;
  messages: UIMessage[];
  agentInstructions?: string;
}): Promise<{
  suggestions: string[];
  usage: { inputTokens: number; outputTokens: number };
}> => {
  const system = agentInstructions
    ? `${agentInstructions}\n\n---\n\n${SUGGESTIONS_SYSTEM_PROMPT}`
    : SUGGESTIONS_SYSTEM_PROMPT;

  const trimmed = trimMessagesForSuggestions(messages);

  const { toolCalls, totalUsage } = await generateText({
    temperature: 0,
    model: languageModel,
    system,
    messages: await convertToModelMessages(trimmed, {
      ignoreIncompleteToolCalls: true,
    }),
    tools: { submit_suggestions: submitSuggestionsTool },
    toolChoice: { type: "tool", toolName: "submit_suggestions" },
    maxRetries: 3,
  });

  const call = toolCalls.find((c) => c.toolName === "submit_suggestions");
  const input = call?.input as { suggestions?: string[] } | undefined;
  const suggestions = Array.isArray(input?.suggestions)
    ? input.suggestions.slice(0, 3).map(String)
    : [];

  return {
    suggestions,
    usage: {
      inputTokens: totalUsage?.inputTokens ?? 0,
      outputTokens: totalUsage?.outputTokens ?? 0,
    },
  };
};
