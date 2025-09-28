import { ExuluAgent } from "../../registry/classes"
import { createOpenAI } from '@ai-sdk/openai';

export const gpt5MiniAgent = new ExuluAgent({
    id: `default_gpt_5_mini_agent`,
    name: `Default GPT 5 Mini OpenAI provider`,
    description: `Basic agent gpt 5 mini agent you can use to chat with.`,
    type: "agent",
    capabilities: {
        text: true,
        images: [".png", ".jpg", ".jpeg", ".webp"],
        files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
        audio: [],
        video: [],
    },
    evals: [],
    maxContextLength: 128000,
    config: {
        name: `Default agent`,
        instructions: "You are a helpful assistant.",
        model: {
            create: ({ apiKey }) => {
                const openai = createOpenAI({
                    apiKey: apiKey,
                })
                return openai.languageModel("gpt-5-mini")
            },
            // todo add a field of type string that adds a dropdown list from which the user can select the model
            // todo for each model, check which provider is used, and require the admin to add one or multiple
            //   API keys for the provider (which we can then auto-rotate).
            // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
            //   and allow him/her to decide if the rate limit is per user or per agent.
            // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
            //   and stores the logs into the pre-defined storage.
        }
    }
})

export const gpt5agent = new ExuluAgent({
    id: `default_gpt_5_agent`,
    name: `Default GPT 5 OpenAI provider`,
    description: `Basic agent gpt 5 agent you can use to chat with.`,
    type: "agent",
    capabilities: {
        text: true,
        images: [".png", ".jpg", ".jpeg", ".webp"],
        files: [".pdf", ".docx", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".json"],
        audio: [],
        video: [],
    },
    evals: [],
    maxContextLength: 128000,
    config: {
        name: `Default agent`,
        instructions: "You are a helpful assistant.",
        model: {
            create: ({ apiKey }) => {
                const openai = createOpenAI({
                    apiKey: apiKey
                })
                return openai.languageModel("gpt-5")
            },
            // todo add a field of type string that adds a dropdown list from which the user can select the model
            // todo for each model, check which provider is used, and require the admin to add one or multiple
            //   API keys for the provider (which we can then auto-rotate).
            // todo also add custom fields for rate limiting, so the admin can set custom rate limits for the agent
            //   and allow him/her to decide if the rate limit is per user or per agent.
            // todo finally allow switching on or off immutable audit logs on the agent. Which then enables OTEL
            //   and stores the logs into the pre-defined storage.
        }
    }
})