import { ExuluAgent } from "../../registry/classes"

const agentId = "0832-5178-1145-2194";
export const claudeCodeAgent = new ExuluAgent({
    id: `${agentId}-claude-code-agent`,
    name: `Claude Code Agent`,
    description: `Claude Code agent, enabling the creation of multiple Claude Code Agent instances with different configurations (rate limits, functions, etc).`,
    type: "custom",
})