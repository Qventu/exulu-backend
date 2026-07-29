import { getChunksTableName, type ExuluContext } from "@SRC/exulu/context";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { postgresClient } from "@SRC/postgres/client";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { isLiteLLMEnabled } from "@SRC/exulu/litellm/supervisor";
import {
  findLiteLLMModel,
  type LiteLLMCatalogEntry,
} from "@SRC/exulu/litellm/catalog";
import { addBudgetField, BUDGET_ENTITY_SINGULARS } from "./budget-field";

const addProviderFields = async (
  args: Record<string, any>,
  requestedFields: string[],
  result: any,
  tools: ExuluTool[],
  user: User,
  contexts: ExuluContext[],
) => {
  let litellmEntry: LiteLLMCatalogEntry | undefined;
  if (isLiteLLMEnabled() && result?.model) {
    litellmEntry = await findLiteLLMModel(result.model);
  } else {
    throw new Error("Could not load modal for: " + result?.model)
  }

  if (requestedFields.includes("providerName")) {
    result.providerName = isLiteLLMEnabled()
      ? "LiteLLM"
      : "";
  }

  if (requestedFields.includes("modelName")) {
    // LiteLLM mode: agent.model is the LiteLLM model_name string — show it as-is.
    result.modelName = isLiteLLMEnabled()
      ? (result?.model ?? "")
      : "";
  }

  if (requestedFields.includes("slug")) {
    result.slug = "/agents/litellm/run";
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
              if (!instance.model) {
                throw new Error(
                  "Trying to load a tool of type 'agent', but the associated agent with id " +
                    tool.id +
                    " does not have a model set for it.",
                );
              }
              // if no access do not return it
              const hasAccessToAgent = await checkRecordAccess(instance, "read", user);
              if (!hasAccessToAgent) {
                return null;
              }

              if (isLiteLLMEnabled()) {
                hydrated = {
                  id: instance.id,
                  name: instance.name,
                  description:
                    `This tool calls an agent named: ${instance.name}. ` +
                    `The agent does the following: ${instance.description ?? ""}.`,
                  type: "agent",
                  category: "agents",
                  needsApproval: true
                } as ExuluTool;
              } else {
                throw new Error("Litellm not configured or running.")
              }
            } else {
              hydrated = tools.find((t) => t.id === tool.id);
            }

            const hydratedTool = {
              ...tool,
              name: hydrated?.name || "",
              description: hydrated?.description || "",
              category: tool?.category || "default",
              needsApproval: true
            };

            console.log("[EXULU] hydratedTool", hydratedTool);
            return hydratedTool;
          },
        ),
      );

      if (args.project) {
        // Project chats surface the agentic search capability in the tool sheet.
        // When the agent already has the tool there is nothing to add (no
        // duplicate ids); when it doesn't, show the pipeline entry the runtime
        // will auto-inject (EE license permitting — unlicensed → no entry).
        const hasAgentic = result.tools.some(
          (tool: { id?: string } | null) => tool?.id === "agentic_context_search",
        );
        if (!hasAgentic) {
          const instance = createAgenticRetrievalTool({
            contexts: [],
            user: user,
            role: user.role?.id,
            model: undefined,
          });
          if (instance) {
            result.tools.unshift({
              id: instance.id,
              name: instance.name,
              description: instance.description,
              category: instance.category,
              type: instance.type,
              config: [],
            });
          }
        }
      }

      result.tools = result.tools.filter((tool) => tool !== null);
    } else {
      result.tools = [];
    }
  }
  if (requestedFields.includes("streaming")) {
    // LiteLLM proxies all calls over its OpenAI-compatible endpoint, which
    // supports streaming for every backend it routes to.
    result.streaming = isLiteLLMEnabled() ? true : false;
  }
  if (requestedFields.includes("capabilities")) {
    if (isLiteLLMEnabled()) {
      result.capabilities = {
        text: true,
        images: litellmEntry?.supports_vision
          ? [".png", ".jpg", ".jpeg", ".webp", ".gif"]
          : [],
        files: litellmEntry?.supports_pdf_input ? [".pdf"] : [],
        audio: litellmEntry?.supports_audio_input
          ? [".mp3", ".wav", ".m4a"]
          : [],
        video: [],
      };
    } else {
      result.capabilities = [];
    }
  }
  if (requestedFields.includes("maxContextLength")) {
    if (isLiteLLMEnabled()) {
      // Prefer max_input_tokens (the actual context window for chat models);
      // fall back to max_tokens which LiteLLM reports for some upstreams.
      result.maxContextLength =
        litellmEntry?.max_input_tokens ?? litellmEntry?.max_tokens ?? 0;
    } else {
      result.maxContextLength = 0;
    }
  }
  if (requestedFields.includes("authenticationInformation")) {
    result.authenticationInformation = ""; // @deprecated legacy 
  }
  if (requestedFields.includes("provider")) {
    result.provider = isLiteLLMEnabled() ? "litellm" : ""; // @deprecated legacy
  }
  if (requestedFields.includes("systemInstructions")) {
    result.systemInstructions = undefined; // @deprecated legacy, handled via database
  }
  if (!requestedFields.includes("provider")) {
    delete result.provider;
  }
  return result;
};

export const finalizeRequestedFields = async ({
  args,
  table,
  requestedFields,
  contexts,
  tools,
  result,
  user,
}: {
  args: Record<string, any>;
  table: ExuluTableDefinition;
  requestedFields: string[];
  contexts: ExuluContext[];
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
        contexts,
        tools,
        result: item,
        user: user,
      });
    });
  } else {
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
        result,
        tools,
        user,
        contexts,
      );
      if (!requestedFields.includes("provider")) {
        delete result.provider;
      }
      if (requestedFields.includes("guest_has_password")) {
        // Derive the computed boolean BEFORE the generic hidden-field sweep
        // below removes guest_password_hash from the result object.
        result.guest_has_password = !!result.guest_password_hash;
      }
    }
    // Generic sweep: remove every hidden (write-only secret) field from the
    // result for ALL tables, regardless of whether it was requested. This
    // covers users (password, apikey, anthropic_token, temporary_token),
    // agents (guest_password_hash), and shared_artifacts (password_hash).
    // Runs AFTER the agent branch above so guest_has_password is already set.
    for (const field of table.fields) {
      if (field.hidden === true) {
        delete result[field.name];
      }
    }
    if (BUDGET_ENTITY_SINGULARS.has(table.name.singular)) {
      result = await addBudgetField(requestedFields, result, table.name.singular, user);
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
          .select("id", "content", "source", "chunk_index", "createdAt", "updatedAt", "metadata");

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
          chunk_metadata: chunk.metadata,
        }));
      }
    }
  }
  return result;
};
