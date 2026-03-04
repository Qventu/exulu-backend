import { ExuluAgent } from "@SRC/exulu/agent";
import { createAnthropic } from "@ai-sdk/anthropic";

export const claudeOpus4Agent = new ExuluAgent({
  id: `default_claude_4_opus_agent`,
  name: `CLAUDE-OPUS-4`,
  provider: "anthropic",
  description: `Previous Anthropic flagship model. Very high intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 200000,
  config: {
    name: `CLAUDE-OPUS-4`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const anthropic = createAnthropic({
          apiKey: apiKey,
        });
        return anthropic.languageModel("claude-opus-4-0");
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

// Most often used with Claude Code CLI
export const claudeSonnet4Agent = new ExuluAgent({
  id: `claude_sonnet_4_agent`,
  name: `CLAUDE-SONNET-4`,
  provider: "anthropic",
  description: `High intelligence and balanced performance, used a lot for agentic coding tasks. Anthropic provides a newer 4.5 model that is more powerful and faster.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 200000,
  config: {
    name: `CLAUDE-SONNET-4`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const anthropic = createAnthropic({
          apiKey: apiKey,
        });
        return anthropic.languageModel("claude-sonnet-4-0");
      },
    },
  },
});

// Most often used with Claude Code CLI
export const claudeSonnet45Agent = new ExuluAgent({
  id: `claude_sonnet_4_5_agent`,
  name: `CLAUDE-SONNET-4.5`,
  provider: "anthropic",
  description: `Best Anthropic model for complex agents and coding. Highest intelligence across most tasks with exceptional agent and coding capabilities`,
  type: "agent",
  capabilities: {
    text: true,
    images: [".png", ".jpg", ".jpeg", ".webp"],
    files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
    audio: [],
    video: [],
  },
  maxContextLength: 200000,
  config: {
    name: `CLAUDE-SONNET-4.5`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        const anthropic = createAnthropic({
          apiKey: apiKey,
        });
        return anthropic.languageModel("claude-sonnet-4-5");
      },
    },
  },
});
