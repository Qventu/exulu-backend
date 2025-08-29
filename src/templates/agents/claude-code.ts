import { ExuluAgent } from "../../registry/classes"

export const claudeCodeAgent = new ExuluAgent({
    id: `claude_code_agent`,
    name: `Claude Code Agent`,
    description: `Claude Code agent, enabling the creation of multiple Claude Code Agent instances with different configurations (rate limits, functions, etc).`,
    type: "custom",
})