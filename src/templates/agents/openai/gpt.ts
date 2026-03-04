import { ExuluAgent } from "@SRC/exulu/agent";
import { createOpenAI } from "@ai-sdk/openai";

export const gpt5proAgent = new ExuluAgent({
  id: `default_gpt_5_pro_agent`,
  provider: "openai",
  name: `GPT-5-PRO`,
  description: `
    GPT-5 pro uses more compute to think harder and provide consistently better 
    answers. GPT-5 pro is available in the Responses API only to enable support
    for multi-turn model interactions before responding to API requests, and other
    advanced API features in the future. Since GPT-5 pro is designed to tackle tough
    problems, some requests may take several minutes to finish. To avoid timeouts, 
    try using background mode. As our most advanced reasoning model, GPT-5 pro defaults
    to (and only supports) reasoning.effort: high. GPT-5 pro does not support code 
    interpreter.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 400000,
  workflows: {
    enabled: false,
    queue: undefined,
  },
  config: {
    name: `GPT-5-PRO`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-5-pro");
      },
    },
  },
});

export const gpt5CodexAgent = new ExuluAgent({
  id: `default_gpt_5_codex_agent`,
  provider: "openai",
  name: `GPT-5-CODEX`,
  description: `GPT-5-Codex is a version of GPT-5 optimized for agentic coding tasks in Codex or similar environments. It's available in the Responses API only and the underlying model snapshot will be regularly updated. If you want to learn more about prompting GPT-5-Codex, refer to the OpenAI dedicated guide.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 400000,
  config: {
    name: `GPT-5-CODEX`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-5-codex");
      },
    },
  },
});

export const gpt5MiniAgent = new ExuluAgent({
  id: `default_gpt_5_mini_agent`,
  provider: "openai",
  name: `GPT-5-MINI`,
  description: `GPT-5 mini is a faster, more cost-efficient version of GPT-5. It's great for well-defined tasks and precise prompts.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 400000,
  config: {
    name: `GPT-5-MINI`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-5-mini");
      },
      // todo add a field of type string that adds a dropdown list from which the user can select the model
      // todo for each model, check which provider is used, and require the admin to add one or multiple
      //   API keys for the provider (which we can then auto-rotate).
      // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
      //   and allow him/her to decide if the rate limit is per user or per agent.
      // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
      //   and stores the logs into the pre-defined storage.
    },
  },
});

export const gpt5agent = new ExuluAgent({
  id: `default_gpt_5_agent`,
  provider: "openai",
  name: `GPT-5`,
  description: `GPT-5 is the flagship model for coding, reasoning, and agentic tasks across domains.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 400000,
  config: {
    name: `GPT-5`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-5");
      },
      // todo add a field of type string that adds a dropdown list from which the user can select the model
      // todo for each model, check which provider is used, and require the admin to add one or multiple
      //   API keys for the provider (which we can then auto-rotate).
      // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
      //   and allow him/her to decide if the rate limit is per user or per agent.
      // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
      //   and stores the logs into the pre-defined storage.
    },
  },
});

export const gpt5NanoAgent = new ExuluAgent({
  id: `default_gpt_5_nano_agent`,
  provider: "openai",
  name: `GPT-5-NANO`,
  description: `GPT-5 Nano is the fastest, cheapest version of GPT-5. It's great for summarization and classification tasks. .`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 400000,
  config: {
    name: `GPT-5-NANO`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-5-nano");
      },
    },
  },
});

export const gpt41Agent = new ExuluAgent({
  id: `default_gpt_4_1_agent`,
  provider: "openai",
  name: `GPT-4.1`,
  description: `GPT-4.1 excels at instruction following and tool calling, with broad knowledge across domains. It features a 1M token context window, and low latency without a reasoning step. Note that we recommend starting with GPT-5 for complex tasks`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 1047576,
  config: {
    name: `GPT-4.1`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-4.1");
      },
    },
  },
});

export const gpt41MiniAgent = new ExuluAgent({
  id: `default_gpt_4_1_mini_agent`,
  provider: "openai",
  name: `GPT-4.1-MINI`,
  description: `GPT-4.1 mini excels at instruction following and tool calling. It features a 1M token context window, and low latency without a reasoning step.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 1047576,
  config: {
    name: `GPT-4.1-MINI`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-4.1-mini");
      },
    },
  },
});

export const gpt4oAgent = new ExuluAgent({
  id: `default_gpt_4o_agent`,
  provider: "openai",
  name: `GPT-4O`,
  description: `Basic agent gpt 4o agent you can use to chat with.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 128000,
  config: {
    name: `Default agent`,
    instructions: "You are a helpful assistant.",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-4o");
      },
    },
  },
});

export const gpt4oMiniAgent = new ExuluAgent({
  id: `default_gpt_4o_mini_agent`,
  provider: "openai",
  name: `GPT-4O-MINI`,
  description: `GPT-4o mini (“o” for “omni”) is a fast, affordable small model for focused tasks. It accepts both text and image inputs, and produces text outputs (including Structured Outputs). It is ideal for fine-tuning, and model outputs from a larger model like GPT-4o can be distilled to GPT-4o-mini to produce similar results at lower cost and latency.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 128000,
  config: {
    name: `GPT-4O-MINI`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const openai = createOpenAI({
          apiKey: apiKey,
        });
        return openai.languageModel("gpt-4o-mini");
      },
    },
  },
});
