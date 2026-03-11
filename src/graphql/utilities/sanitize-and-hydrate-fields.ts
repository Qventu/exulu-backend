import { getChunksTableName, type ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/index.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { postgresClient } from "@SRC/postgres/client";
import { createProjectItemsRetrievalTool } from "@SRC/templates/tools/project-retrieval-tool.ts";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { ExuluProvider } from "@SRC/exulu/provider";
import { exuluApp } from "@SRC/exulu/app/singleton";

const addProviderFields = async (
  args: Record<string, any>,
  requestedFields: string[],
  providers: ExuluProvider[],
  result: any,
  tools: ExuluTool[],
  user: User,
  contexts: ExuluContext[],
  rerankers: ExuluReranker[],
) => {
  let provider = providers.find((a) => a.id === result?.provider);
  if (requestedFields.includes("providerName")) {
    result.providerName = provider?.providerName || "";
  }

  if (requestedFields.includes("modelName")) {
    result.modelName = provider?.modelName || "";
  }

  if (requestedFields.includes("slug")) {
    result.slug = provider?.slug || "";
  }

  if (requestedFields.includes("rateLimit")) {
    result.rateLimit = provider?.rateLimit || "";
  }

  if (requestedFields.includes("tools")) {
    if (result.tools) {
      result.tools = await Promise.all(
        result.tools.map(
          async (tool: {
            config: any;
            id: string;
            type: "function" | "agent" | "context";
            category: string;
            // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
          }): Promise<Omit<ExuluTool, "tool" | "execute"> | null | undefined> => {
            let hydrated: ExuluTool | null | undefined;

            if (tool.id === "agentic_context_search") {
              const instance = createAgenticRetrievalTool({
                contexts: [],
                rerankers: [],
                user: user,
                role: user.role?.id,
                model: undefined,
              });
              if (!instance) {
                return null;
              }
              return {
                ...instance,
                name: instance.name,
                description: instance.description,
                category: instance.category,
                config: tool.config,
              };
            }

            if (tool.type === "agent") {
              if (tool.id === result.id) {
                return null;
              }
              const instance = await exuluApp.get().agent(tool.id); // for agents used as tools, the tool id === the agent id
              if (!instance) {
                throw new Error(
                  "Trying to load a tool of type 'agent', but the associated agent with id " +
                    tool.id +
                    " was not found in the database.",
                );
              }
              const provider = providers.find((a) => a.id === instance.provider);
              if (!provider) {
                throw new Error(
                  "Trying to load a tool of type 'agent', but the associated agent with id " +
                    tool.id +
                    " does not have a provider set for it.",
                );
              }

              // if no access do not return it
              const hasAccessToAgent = await checkRecordAccess(instance, "read", user);

              if (!hasAccessToAgent) {
                return null;
              }

              hydrated = await provider.tool(instance.id, providers, contexts, rerankers);
            } else {
              hydrated = tools.find((t) => t.id === tool.id);
            }

            const hydratedTool = {
              ...tool,
              name: hydrated?.name || "",
              description: hydrated?.description || "",
              category: tool?.category || "default",
            };

            console.log("[EXULU] hydratedTool", hydratedTool);
            return hydratedTool;
          },
        ),
      );

      if (args.project) {
        const projectTool = await createProjectItemsRetrievalTool({
          projectId: args.project,
          user: user,
          role: user.role?.id,
          contexts: contexts,
        });

        if (projectTool) {
          result.tools.unshift(projectTool);
        }
      }

      result.tools = result.tools.filter((tool) => tool !== null);
    } else {
      result.tools = [];
    }
  }
  if (requestedFields.includes("streaming")) {
    result.streaming = provider?.streaming || false;
  }
  if (requestedFields.includes("capabilities")) {
    result.capabilities = provider?.capabilities || [];
  }
  if (requestedFields.includes("maxContextLength")) {
    result.maxContextLength = provider?.maxContextLength || 0;
  }
  if (requestedFields.includes("authenticationInformation")) {
    result.authenticationInformation = provider?.authenticationInformation || "";
  }
  if (requestedFields.includes("provider")) {
    result.provider = provider?.provider || "";
  }
  if (requestedFields.includes("systemInstructions")) {
    result.systemInstructions = provider?.config?.instructions || undefined;
  }
  if (!requestedFields.includes("provider")) {
    delete result.provider;
  }
  if (requestedFields.includes("workflows")) {
    let enabled = false;
    let queueName: string | undefined = undefined;

    if (provider?.workflows) {
      enabled = provider?.workflows?.enabled || false;
      if (provider?.workflows?.queue) {
        const queue = await provider?.workflows?.queue;
        queueName = queue?.queue.name || undefined;
      }
    }
    result.workflows = {
      enabled: enabled,
      queue: queueName
        ? {
            name: queueName,
          }
        : undefined,
    };
  }
  return result;
};

export const finalizeRequestedFields = async ({
  args,
  table,
  requestedFields,
  providers,
  contexts,
  rerankers,
  tools,
  result,
  user,
}: {
  args: Record<string, any>;
  table: ExuluTableDefinition;
  requestedFields: string[];
  providers: ExuluProvider[];
  contexts: ExuluContext[];
  rerankers: ExuluReranker[];
  tools: ExuluTool[];
  result: any;
  user: User;
}) => {
  if (!result) {
    return result;
  }
  if (!requestedFields.includes("id")) {
    delete result.id;
  }
  // todo figure out how to deal with code defined agents in the graphql api
  if (Array.isArray(result)) {
    result = result.map((item) => {
      return finalizeRequestedFields({
        args,
        table,
        requestedFields,
        providers,
        contexts,
        rerankers,
        tools,
        result: item,
        user: user,
      });
    });
  } else {
    console.log("[EXULU] table name singular", table.name.singular);
    console.log("[EXULU] requestedFields", requestedFields);
    console.log("[EXULU] result", result);
    if (table.name.singular === "workflow_template") {
      if (requestedFields.includes("variables")) {
        const variables: Record<string, any> = [];
        for (const step of result?.steps_json || []) {
          if (step.role === "user") {
            const text = step.parts?.map((part) => part.text)?.join("");
            const variableNames = [...text.matchAll(/{([^}]+)}/g)].map((match) => match[1]);
            console.log("[EXULU] variableNames", variableNames);
            if (variableNames) {
              for (const variableName of variableNames) {
                variables.push(variableName);
                console.log("[EXULU] variableName", variableName);
              }
            }
          }
        }
        result.variables = variables;
      }
      if (!requestedFields.includes("steps_json")) {
        // We always add this to the fields retrieved from the
        // database in case the user requests the variables but
        // not the steps_json, which are needed to identify the
        // variables. So we remove it again here so the steps_json
        // are not included in the final payload if they are
        // not requested.
        delete result.steps_json;
      }
    }
    if (table.name.singular === "agent") {
      result = await addProviderFields(
        args,
        requestedFields,
        providers,
        result,
        tools,
        user,
        contexts,
        rerankers,
      );
      if (!requestedFields.includes("provider")) {
        delete result.provider;
      }
    }
    if (table.type === "items") {
      if (requestedFields.includes("chunks")) {
        if (!result.id) {
          result.chunks = [];
          return result;
        }

        const context = contexts.find((context) => context.id === table.id);
        if (!context) {
          throw new Error("Context " + table.id + " not found in registry.");
        }

        if (!context.embedder) {
          result.chunks = [];
          return result;
        }

        const { db } = await postgresClient();
        const query = db
          .from(getChunksTableName(context.id))
          .where({ source: result.id })
          .select("id", "content", "source", "chunk_index", "createdAt", "updatedAt");

        const chunks = await query;

        result.chunks = chunks.map((chunk: any) => ({
          chunk_content: chunk.content,
          chunk_source: chunk.source,
          chunk_index: chunk.chunk_index,
          chunk_id: chunk.id,
          chunk_created_at: chunk.createdAt,
          chunk_updated_at: chunk.updatedAt,
          item_updated_at: chunk.item_updated_at,
          item_created_at: chunk.item_created_at,
          item_id: chunk.item_id,
          item_external_id: chunk.item_external_id,
          item_name: chunk.item_name,
        }));
      }
    }
  }
  return result;
};
