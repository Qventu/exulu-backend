import {
    experimental_createSkillTool as createSkillTool,
    createBashTool,
} from "bash-tool";
import { stepCountIs, ToolLoopAgent } from "ai";
import { createVertex } from "@ai-sdk/google-vertex";

const vertex = createVertex({
    project: "dx-newlift",
    location: "europe-west1",
});

export const model = vertex("gemini-2.5-flash");

// Discover skills and get files to upload
const { skill, files, instructions } = await createSkillTool({
    skillsDirectory: "./.claude/skills",
});

// Create bash tool with skill files
const { tools } = await createBashTool({
    files,
    extraInstructions: instructions,
});

// Use both tools with an agent
const agent = new ToolLoopAgent({
    model,
    stopWhen: [stepCountIs(20)],
    tools: { skill, ...tools },
});

const result = await agent.generate({
    prompt: 'Use the exulu context retrieval skill to answer the question: "Kennst Du die Vorschriften EN-8100-1/2?"',
    onStepFinish: (step) => {
        console.log("Reasoning:");
        console.log(step.reasoningText);
        console.log("Response:");
        console.log(step.response?.messages?.map((message) => {
            switch (message.content.type === "text") {
                case "text":
                    return message.text;
                case "tool_use":
                    return message.toolUse.name + " - " + JSON.stringify(message.toolUse.input);
                default:
                    return message.content;
            }
        }));
        console.log("Tool calls:")
        console.log(step.toolCalls?.map((toolCall) => toolCall.toolName + " - " + JSON.stringify(toolCall.input)));
    }
});

console.log(result.text);
console.log(result.usage.totalTokens)