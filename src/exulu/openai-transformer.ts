import type { TextStreamPart, ToolSet } from "ai";

type OpenAIStreamChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type OpenAICompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type TransformerContext = {
  completionId: string;
  created: number;
  modelId: string;
};

export function transformStreamChunk(
  chunk: TextStreamPart<ToolSet>,
  ctx: TransformerContext,
): OpenAIStreamChunk | null {
  const base = {
    id: ctx.completionId,
    object: "chat.completion.chunk" as const,
    created: ctx.created,
    model: ctx.modelId,
  };

  switch (chunk.type) {
    case "text-delta":
      return {
        ...base,
        choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }],
      };

    case "tool-input-start":
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: chunk.id,
                  type: "function",
                  function: { name: chunk.toolName, arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

    case "tool-input-delta":
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: chunk.delta } }] },
            finish_reason: null,
          },
        ],
      };

    case "finish": {
      const inputTokens = chunk.usage?.inputTokens ?? 0;
      const outputTokens = chunk.usage?.outputTokens ?? 0;
      const finishReason = chunk.finishReason === "tool-calls" ? "tool_calls" : "stop";
      return {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };
    }

    default:
      return null;
  }
}

export function transformCompletion(
  text: string,
  inputTokens: number,
  outputTokens: number,
  ctx: TransformerContext,
): OpenAICompletion {
  return {
    id: ctx.completionId,
    object: "chat.completion",
    created: ctx.created,
    model: ctx.modelId,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
