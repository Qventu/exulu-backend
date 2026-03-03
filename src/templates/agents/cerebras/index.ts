import { ExuluAgent } from "src/exulu/agent";
import { createCerebras } from "@ai-sdk/cerebras";

export const gptOss120bAgent = new ExuluAgent({
  id: `default_gpt_oss_120b_agent`,
  name: `GPT-OSS-120B`,
  provider: "custom",
  description: `Custom GPT-OSS-120B model. High intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [],
    files: [".pdf", ".txt"],
    audio: [],
    video: [],
  },
  authenticationInformation: "",
  maxContextLength: 128000,
  config: {
    name: `GPT-OSS-120B`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for GPT-OSS-120B agent, make sure you have set the provider api key to a valid custom API key.",
          );
        }

        const vertex = createCerebras({
          apiKey: apiKey,
        });

        const model = vertex("gpt-oss-120b");
        return model;
      },
    },
  },
});

export const llama38bAgent = new ExuluAgent({
  id: `default_llama_38b_agent`,
  name: `LLAMA-38B`,
  provider: "custom",
  description: `Custom LLAMA-38B model. High intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [],
    files: [".pdf", ".txt"],
    audio: [],
    video: [],
  },
  authenticationInformation: "",
  maxContextLength: 32000,
  config: {
    name: `LLAMA-38B`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for LLAMA-38B agent, make sure you have set the provider api key to a valid custom API key.",
          );
        }

        const vertex = createCerebras({
          apiKey: apiKey,
        });

        const model = vertex("llama3.1-8b");
        return model;
      },
    },
  },
});

export const llama3370bAgent = new ExuluAgent({
  id: `default_llama_3370b_agent`,
  name: `LLAMA-3.3-70B`,
  provider: "custom",
  description: `Custom LLAMA-3.3-70B model. High intelligence and capability. Moderately Fast.`,
  type: "agent",
  capabilities: {
    text: true,
    images: [],
    files: [".pdf", ".txt"],
    audio: [],
    video: [],
  },
  authenticationInformation: "",
  maxContextLength: 32000,
  config: {
    name: `LLAMA-3.3-70B`,
    instructions: "",
    model: {
      create: ({ apiKey }) => {
        if (!apiKey) {
          throw new Error(
            "Auth credentials not found for LLAMA-3.3-70B agent, make sure you have set the provider api key to a valid custom API key.",
          );
        }

        const vertex = createCerebras({
          apiKey: apiKey,
        });

        const model = vertex("llama-3.3-70b");
        return model;
      },
    },
  },
});
