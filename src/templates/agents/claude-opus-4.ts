import { ExuluAgent } from "../../registry/classes"
import { createAnthropic } from '@ai-sdk/anthropic';

const agentId = "5434-5678-9143-2590";
export const defaultAgent = new ExuluAgent({
    id: `${agentId}-default-claude-4-opus-agent`,
    name: `Default Claude 4 Opus Agent`,
    description: `Basic agent without any defined tools, that can support MCP's.`,
    type: "agent",
    capabilities: {
        text: true,
        images: [],
        files: [],
        audio: [],
        video: [],
    },
    evals: [],
    config: {
        name: `Default agent`,
        instructions: "You are a helpful assistant.",
        model: {
            create: ({ apiKey }) => {
                const anthropic = createAnthropic({
                    apiKey: apiKey
                })
                return anthropic.languageModel("claude-4-opus-20250514")
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