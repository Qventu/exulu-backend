import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluContext } from "@SRC/exulu/context";
import type { User } from "@EXULU_TYPES/models/user.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { KB_EDITOR_TOOL_ID } from "@SRC/templates/tools/kb-editor-config";
import { createAgentTool } from "@SRC/exulu/agent-as-tool";

export const getEnabledTools = async (
  agent: ExuluAgent,
  allExuluTools: ExuluTool[],
  allContexts: ExuluContext[],
  disabledTools: string[] = [],
  user?: User,
) => {
  let enabledTools: ExuluTool[] = [];
  if (agent.tools) {
    const results = await Promise.all(
      agent.tools.map(async ({ id, type }) => {
        let hydrated: ExuluTool | null | undefined;
        if (id === "agentic_context_search") {
          return createAgenticRetrievalTool({
            // This tool is reinstantiated in the convertExuluToolsToAiSdkTools function, where
            // we can access the activated contexts and model that is calling it but we also
            // return it here so we know it was generally enabled as a tool.
            contexts: allContexts,
            user: user,
            role: user?.role?.id,
            model: undefined,
          });
        }
        if (id === KB_EDITOR_TOOL_ID) {
          // Config-only entry: it is expanded into per-context write tools in
          // convertExuluToolsToAiSdkTools (which has the agent/context closures).
          // Without this skip it would fall through to the registry lookup below.
          return null;
        }
        if (type === "agent") {
          if (id === agent.id) {
            return null;
          }
          // The target agent instance, not the agentInstance that is calling the tool
          const agentAsTool = await exuluApp.get().agent(id); // for agents used as tools, the tool id === the agent id
          if (!agentAsTool) {
            throw new Error(
              "Trying to load a tool of type 'agent', but the associated agent with id " +
                id +
                " was not found in the database.",
            );
          }

          // if no access do not return it
          const hasAccessToAgent = await checkRecordAccess(agentAsTool, "read", user);

          if (!hasAccessToAgent) {
            return null;
          }

          hydrated = await createAgentTool(agentAsTool.id, allContexts)

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
