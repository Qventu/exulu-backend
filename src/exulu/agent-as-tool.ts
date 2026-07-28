import { checkLicense } from "@EE/entitlements";
import { exuluApp } from "./app/singleton";
import { ExuluTool } from "./tool";
import { z } from "zod";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import { getEnabledTools } from "@SRC/utils/enabled-tools";
import { resolveModel } from "./resolve-model";
import { updateStatistic } from "./statistics";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { ExuluContext } from "./context";
import { generateSync } from "./generate-stream";

export const createAgentTool = async (
    instance: string,
    contexts: ExuluContext[],
  ): Promise<ExuluTool | null> => {

    const agent = await exuluApp.get().agent(instance);

    if (!agent) {
      return null;
    }

    const license = checkLicense()

    if (!license["multi-agent-tooling"]) {
      console.warn(`[EXULU] You are not licensed to use multi-agent tooling so cannot export this agent as a tool. Please set your EXULU_ENTERPRISE_LICENSE env variable.`);
    }

    return ExuluTool.internal({
      id: agent.id,
      name: `${agent.name}`,
      type: "agent",
      category: "agents",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe("The prompt (usually a question for the agent) to send to the agent."),
        information: z
          .string()
          .describe("A summary of relevant context / information from the current session"),
      }),
      description: `This tool calls an agent named: ${agent.name}. The agent does the following: ${agent.description}.`,
      config: [],
      execute: async ({ prompt, information, user, allExuluTools }: any) => {
        const hasAccessToAgent = await checkRecordAccess(agent, "read", user);

        if (!hasAccessToAgent) {
          throw new Error("You don't have access to this agent.");
        }

        let enabledTools: ExuluTool[] = await getEnabledTools(
          agent,
          allExuluTools,
          contexts,
          [],
          user,
        );

        if (!agent.model) {
          throw new Error(
            `Agent ${agent.name} (${agent.id}) has no model configured (called as a tool).`,
          );
        }

        const resolved = await resolveModel({
          modelId: agent.model,
          user,
          agent: agent,
        });
        
        console.log(
          "[EXULU] Enabled tools for agent '" +
          agent.name +
          " (" +
          agent.id +
          ")" +
          " that is being called as a tool",
          enabledTools.map((x) => x.name + " (" + x.id + ")")
        );

        console.log(
          "[EXULU] Prompt for agent '" + agent.name + "' that is being called as a tool",
          prompt.slice(0, 100) + "...",
        );

        console.log(
          "[EXULU] Instructions for agent '" +
          agent.name +
          "' that is being called as a tool",
          agent.instructions?.slice(0, 100) + "..."
        );

        const response = await generateSync({
          agent: agent,
          contexts: contexts,
          instructions: agent.instructions,
          prompt:
            "The user has asked the following question: " +
            prompt +
            " and the following information is available: " +
            information,
          languageModel: resolved.languageModel,
          user,
          currentTools: enabledTools,
          allExuluTools: allExuluTools,
          statistics: {
            label: agent.name,
            trigger: "tool",
          },
        });

        await updateStatistic({
          name: "count",
          label: agent.name,
          type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
          trigger: "tool",
          count: 1,
          user: user?.id,
          role: user?.role?.id,
        });

        return {
          result: response,
        };

      },
    });
  };