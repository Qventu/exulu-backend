import { createAnthropic } from "@ai-sdk/anthropic"
import { ExuluAgent } from "../../registry/classes"

// Most often used with Claude Code CLI
export const claudeSonnet4Agent = new ExuluAgent({
    id: `claude_code_agent`,
    name: `Claude Code Agent`,
    description: `Claude Code agent, enabling the creation of multiple Claude Code Agent instances with different configurations (rate limits, functions, etc).`,
    type: "agent",
    config: {
        name: `Default Claude Code agent`,
        instructions: "You are a coding assistant.",
        model: {
            create: ({ apiKey }) => {
                const anthropic = createAnthropic({
                    apiKey: apiKey
                })
                return anthropic.languageModel("claude-sonnet-4-20250514")
            }
        }
    }
})