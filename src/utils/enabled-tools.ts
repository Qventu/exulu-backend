import { createAgenticRetrievalTool } from "@SRC/templates/tools/agentic-retrieval/index.ts";
import type { Agent } from "@EXULU_TYPES/models/agent.ts";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import type { ExuluAgent } from "@SRC/exulu/agent";
import type { User } from "@EXULU_TYPES/models/user.ts";
import { loadAgent } from "@SRC/utils/load-agent.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";

export const getEnabledTools = async (
  agentInstance: Agent,
  allExuluTools: ExuluTool[],
  allContexts: ExuluContext[],
  allRerankers: ExuluReranker[] | undefined,
  disabledTools: string[] = [],
  agents: ExuluAgent[],
  user?: User,
) => {
  let enabledTools: ExuluTool[] = [];
  if (agentInstance.tools) {
    const results = await Promise.all(
      agentInstance.tools.map(async ({ id, type }) => {
        let hydrated: ExuluTool | null | undefined;
        if (id === "agentic_context_search") {
          return createAgenticRetrievalTool({
            // This tool is reinstantiated in the convertExuluToolsToAiSdkTools function, where
            // we can access the activated contexts and model that is calling it but we also
            // return it here so we know it was generally enabled as a tool.
            contexts: allContexts,
            rerankers: allRerankers || [],
            user: user,
            role: user?.role?.id,
            model: undefined,
          });
        }
        if (type === "agent") {
          if (id === agentInstance.id) {
            return null;
          }
          // The target agent instance, not the agentInstance that is calling the tool
          const instance = await loadAgent(id); // for agents used as tools, the tool id === the agent id
          if (!instance) {
            throw new Error(
              "Trying to load a tool of type 'agent', but the associated agent with id " +
                id +
                " was not found in the database.",
            );
          }
          const backend = agents.find((a) => a.id === instance.backend);
          if (!backend) {
            throw new Error(
              "Trying to load a tool of type 'agent', but the associated agent with id " +
                id +
                " does not have a backend set for it.",
            );
          }

          // if no access do not return it
          const hasAccessToAgent = await checkRecordAccess(instance, "read", user);

          if (!hasAccessToAgent) {
            return null;
          }

          hydrated = await backend.tool(instance.id, agents, allContexts, allRerankers || []);
        } else {
          hydrated = allExuluTools.find((t) => t.id === id);
        }
        return hydrated;
      }),
    );
    enabledTools = results.filter(Boolean) as ExuluTool[];
  }

  console.log("[EXULU] available tools", enabledTools?.length);

  // Message specific tools, the user can overwrite to disable specific tools
  // for individual messages.
  console.log("[EXULU] disabled tools", disabledTools?.length);
  enabledTools = enabledTools.filter((tool) => !disabledTools.includes(tool.id));
  return enabledTools;
};
