import { getChunksTableName, type ExuluContext } from "@SRC/exulu/context";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { postgresClient } from "@SRC/postgres/client";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import type { ExuluProvider } from "@SRC/exulu/provider";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { isLiteLLMEnabled } from "@SRC/exulu/litellm/supervisor";
import {
  findLiteLLMModel,
  type LiteLLMCatalogEntry,
} from "@SRC/exulu/litellm/catalog";
import { budgetTagFor, type BudgetEntityType } from "@SRC/exulu/tags";
import { getTagBudgetMap } from "@SRC/exulu/litellm/budget-service";

const BUDGET_ENTITY_SINGULARS = new Set<string>([
  "user",
  "role",
  "team",
  "project",
  "agent",
  // `workflow_template` is the GraphQL table singular; budgets attach to it
  // under the user-facing BudgetEntityType "routine" (see tags.ts). The mapping
  // happens in BUDGET_ENTITY_TYPE_BY_SINGULAR below so budgetTagFor() emits the
  // correct `routine_id_<uuid>` tag.
  "workflow_template",
]);

/**
 * Some GraphQL table singulars don't match their BudgetEntityType verbatim
 * (e.g. workflow_template → routine). Map here so addBudgetField builds the
 * correct LiteLLM tag (`routine_id_<uuid>`) that matches what buildTags() emits
 * from the workflow job runner.
 */
const BUDGET_ENTITY_TYPE_BY_SINGULAR: Record<string, BudgetEntityType> = {
  user: "user",
  role: "role",
  team: "team",
  project: "project",
  agent: "agent",
  workflow_template: "routine",
};

/**
 * Resolve the computed `budget` field for an entity row. The budget lives in
 * LiteLLM (keyed by the entity's *_id_* tag); getTagBudgetMap is cached ~30s so
 * resolving a full page of rows is a single LiteLLM call + cheap map lookups.
 * Gated to super_admin / budget_management so non-privileged users querying the
 * field just get null.
 */
const addBudgetField = async (
  requestedFields: string[],
  result: any,
  tableSingular: string,
  user: User | undefined,
): Promise<any> => {
  if (!requestedFields.includes("budget")) return result;

  const scope = (user as any)?.role?.budget_management;
  const canRead = !!user?.super_admin || scope === "read" || scope === "write";
  if (!canRead || result?.id == null) {
    result.budget = null;
    return result;
  }

  // Translate GraphQL table singular → BudgetEntityType (e.g. workflow_template → routine).
  const entityType = BUDGET_ENTITY_TYPE_BY_SINGULAR[tableSingular];
  if (!entityType) {
    result.budget = null;
    return result;
  }

  const map = await getTagBudgetMap();
  const tag = budgetTagFor(entityType, result.id);
  result.budget = tag ? (map[tag] ?? null) : null;
  return result;
};

const addProviderFields = async (
  args: Record<string, any>,
  requestedFields: string[],
  providers: ExuluProvider[],
  result: any,
  tools: ExuluTool[],
  user: User,
  contexts: ExuluContext[],
) => {
  // Resolve the underlying ExuluProvider via the agent's Model row.
  // agent.model -> models row -> models.provider -> ExuluProvider.
  //
  // In LiteLLM mode we instead look the agent's model string up in LiteLLM's
  // /model/info catalog (cached for 30s by the shared catalog module) so we
  // can hydrate accurate maxContextLength / capabilities for the chat UI's
  // context bar and modality badges.
  let provider: ExuluProvider | undefined;
  let modelRow: { name?: string; provider?: string } | undefined;
  let litellmEntry: LiteLLMCatalogEntry | undefined;
  if (isLiteLLMEnabled() && result?.model) {
    litellmEntry = await findLiteLLMModel(result.model);
  } else if (result?.model) {
    const { db } = await postgresClient();
    modelRow = await db.from("models").where({ id: result.model }).first();
    if (modelRow?.provider) {
      provider = providers.find((a) => a.id === modelRow!.provider);
    }
  }

  if (requestedFields.includes("providerName")) {
    result.providerName = isLiteLLMEnabled()
      ? "LiteLLM"
      : provider?.providerName || "";
  }

  if (requestedFields.includes("modelName")) {
    // LiteLLM mode: agent.model is the LiteLLM model_name string — show it as-is.
    // Catalog mode: prefer the admin-set display name on the Model row; fall
    // back to the ExuluProvider's hardcoded config.name.
    result.modelName = isLiteLLMEnabled()
      ? (result?.model ?? "")
      : modelRow?.name || provider?.modelName || "";
  }

  if (requestedFields.includes("slug")) {
    // In LiteLLM mode the per-ExuluProvider slug routes don't apply (no
    // ExuluProvider). The backend mounts a single agent-run handler at
    // "/agents/litellm/run" — point the frontend there.
    result.slug = isLiteLLMEnabled()
      ? "/agents/litellm/run"
      : provider?.slug || "";
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
                // No ExuluProvider lookup in LiteLLM mode. The hydrated tool
                // metadata (name + description) is sourced directly from the
                // callee agent, since the ExuluProvider catalog isn't relevant.
                hydrated = {
                  id: instance.id,
                  name: instance.name,
                  description:
                    `This tool calls an agent named: ${instance.name}. ` +
                    `The agent does the following: ${instance.description ?? ""}.`,
                  type: "agent",
                  category: "agents",
                } as ExuluTool;
              } else {
                const { db } = await postgresClient();
                const innerModelRow = await db
                  .from("models")
                  .where({ id: instance.model })
                  .first();
                const provider = innerModelRow?.provider
                  ? providers.find((a) => a.id === innerModelRow.provider)
                  : undefined;
                if (!provider) {
                  throw new Error(
                    "Trying to load a tool of type 'agent', but the model referenced by agent with id " +
                      tool.id +
                      " does not point at a registered ExuluProvider.",
                  );
                }
                hydrated = await provider.tool(
                  instance.id,
                  providers,
                  contexts,
                );
              }
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
    result.streaming = isLiteLLMEnabled() ? true : provider?.streaming || false;
  }
  if (requestedFields.includes("capabilities")) {
    if (isLiteLLMEnabled()) {
      // Derive modality support from LiteLLM's catalog metadata. The chat UI's
      // capability badges use the same shape as ExuluProvider.capabilities, so
      // we map LiteLLM's boolean flags into the per-modality file-extension
      // arrays that frontend renders.
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
      result.capabilities = provider?.capabilities || [];
    }
  }
  if (requestedFields.includes("maxContextLength")) {
    if (isLiteLLMEnabled()) {
      // Prefer max_input_tokens (the actual context window for chat models);
      // fall back to max_tokens which LiteLLM reports for some upstreams.
      result.maxContextLength =
        litellmEntry?.max_input_tokens ?? litellmEntry?.max_tokens ?? 0;
    } else {
      result.maxContextLength = provider?.maxContextLength || 0;
    }
  }
  if (requestedFields.includes("authenticationInformation")) {
    result.authenticationInformation = isLiteLLMEnabled()
      ? ""
      : provider?.authenticationInformation || "";
  }
  if (requestedFields.includes("provider")) {
    result.provider = isLiteLLMEnabled() ? "litellm" : provider?.provider || "";
  }
  if (requestedFields.includes("systemInstructions")) {
    result.systemInstructions = isLiteLLMEnabled()
      ? undefined
      : provider?.config?.instructions || undefined;
  }
  if (!requestedFields.includes("provider")) {
    delete result.provider;
  }
  if (requestedFields.includes("workflows")) {
    let enabled = false;
    let queueName: string | undefined = undefined;

    // LiteLLM mode: workflows aren't supported (they hang off the ExuluProvider).
    if (!isLiteLLMEnabled() && provider?.workflows) {
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
  tools,
  result,
  user,
}: {
  args: Record<string, any>;
  table: ExuluTableDefinition;
  requestedFields: string[];
  providers: ExuluProvider[];
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
        providers,
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
        providers,
        result,
        tools,
        user,
        contexts,
      );
      if (!requestedFields.includes("provider")) {
        delete result.provider;
      }
      if (requestedFields.includes("guest_has_password")) {
        result.guest_has_password = !!result.guest_password_hash;
      }
      // Never let the hash column reach a payload, requested or not.
      delete result.guest_password_hash;
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
