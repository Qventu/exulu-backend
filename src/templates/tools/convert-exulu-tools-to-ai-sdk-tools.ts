import { S3Client, PutObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluContext } from "@SRC/exulu/context";
import { updateStatistic } from "@SRC/exulu/statistics";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";
import { postgresClient } from "@SRC/postgres/client";
import CryptoJS from "crypto-js";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { LanguageModel, Tool } from "ai";
import type { allFileTypes, ExuluAgent } from "@EXULU_TYPES/models/agent";
import { createSessionItemsRetrievalTool } from "./session-items-retrieval-tool";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index";
import {
  buildProjectKbProfileDefaults,
  type ProjectScope,
} from "@EE/agentic-retrieval/pipeline/project-scope";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";
import type { Item } from "@EXULU_TYPES/models/item";
import { randomUUID } from "node:crypto";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { Request } from "express";
import { createNewMemoryItemTool } from "./memory-tool";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import type { ExuluSkill } from "@EXULU_TYPES/skill";
import { createSessionSandbox } from "@EE/invoke-skills/create-sandbox";
import { getPresignedUrl } from "@SRC/uppy";
import { truncateToolOutput } from "@SRC/utils/truncate-tool-output";
import { guardToolOutput } from "@SRC/exulu/tool-output-offload";
import { createSessionFileReadTool } from "./session-file-read-tool";
import { createParseDocumentTool } from "./parse-document-tool";
import { createViewDocumentPageTool } from "./view-document-page-tool";
import { deriveContextBudget } from "@SRC/exulu/context-budget";

/**
 * Tools whose outputs are consumed inline by the model and must NOT be
 * offloaded to session files. Agentic retrieval chunks feed the answer and
 * its citations directly; capping them just forces read_session_file
 * round-trips (2026-07-08 decision, amends context-window spec §2's
 * "every tool" rule).
 */
const OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS = new Set(["agentic_context_search"]);
const generateS3Key = (filename) => `${randomUUID()}-${filename}`;


/**
 * @type {S3Client}
 */
let s3Client: S3Client | undefined;

const getMimeType = (type: allFileTypes) => {
  switch (type) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpg";
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".csv":
      return "text/csv";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".m4a":
      return "audio/mp4";
    case ".mp4":
      return "audio/mp4";
    case ".mpeg":
      return "audio/mpeg";
    case ".mp3":
      return "audio/mp3";
    case ".wav":
      return "audio/wav";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    default:
      return "";
  }
};

export const hydrateVariables = async (tool: ExuluAgentToolConfig): Promise<ExuluAgentToolConfig> => {
  const { db } = await postgresClient();
  const promises = tool.config.map(async (toolConfig) => {
    if (!toolConfig.variable) {
      return toolConfig;
    }

    const variableName = toolConfig.variable;
    const type = toolConfig.type;

    if (type === "boolean") {
      toolConfig.value =
        toolConfig.variable === "true" || toolConfig.variable === true || toolConfig.variable === 1;
      return toolConfig;
    } else if (type === "number") {
      toolConfig.value = parseInt(toolConfig.variable.toString());
      return toolConfig;
    } else if (type === "string") {
      toolConfig.value = toolConfig.variable;
      return toolConfig;
    } else if (type === "json") {
      if (typeof toolConfig.variable === "object") {
        toolConfig.value = toolConfig.variable;
        return toolConfig;
      }
      try {
        toolConfig.value = JSON.parse(toolConfig.variable.toString());
      } catch (err) {
        console.warn(
          `[EXULU] Config option "${toolConfig.name}" holds invalid JSON — falling back to the tool's declared default.`,
          err,
        );
        toolConfig.value = undefined;
      }
      return toolConfig;
    }

    const variable = await db.from("variables").where({ name: variableName }).first();

    if (!variable) {
      throw new Error(
        "Variable " +
        variableName +
        " not found in hydrateVariables method, with type " +
        type +
        ".",
      );
    }

    // Get the API key from the variable (decrypt if encrypted)
    let value = variable.value;

    if (variable.encrypted) {
      const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
      value = bytes.toString(CryptoJS.enc.Utf8);
    }

    toolConfig.value = value;

    return toolConfig;
  });
  await Promise.all(promises);
  return tool;
};

export const convertExuluToolsToAiSdkTools = async (
  currentTools: ExuluTool[] | undefined,
  currentSkills: ExuluSkill[] | undefined,
  approvedTools: string[] | undefined,
  allExuluTools: ExuluTool[] | undefined,
  configs: ExuluAgentToolConfig[] | undefined,
  providerapikey?: string,
  contexts?: ExuluContext[],
  user?: User,
  exuluConfig?: ExuluConfig,
  sessionID?: string,
  req?: Request,
  project?: string,
  sessionItems?: string[],
  model?: LanguageModel,
  agent?: ExuluAgent,
  memoryItems?: VectorSearchChunkResult[],
  contextWindow?: number,
  disabledTools?: string[],
): Promise<Record<string, Tool>> => {
  if (!currentTools) return {};

  if (!allExuluTools) {
    allExuluTools = [];
  }

  if (!contexts) {
    contexts = [];
  }

  const budget = deriveContextBudget(contextWindow);
  const toolOutputCharLimit = budget.toolOutputCapTokens * 4;

  // Eagerly create the shared session sandbox so the OUTER agent can read/write
  // files (and run skill scripts — it executes skills directly, there is no skill
  // sub-agent) under a per-session tree with the same S3 persistence pipeline.
  // GATED on the agent's `sandbox_enabled` flag (pure opt-in, default off): a
  // knowledge-only agent gets no sandbox and won't be tempted into spurious shell
  // calls. Undefined/false → no sandbox. Skill execution requires this enabled.
  let sharedSessionSandbox:
    | Awaited<ReturnType<typeof createSessionSandbox>>
    | undefined;
  if (sessionID && exuluConfig && agent?.sandbox_enabled === true) {
    try {
      sharedSessionSandbox = await createSessionSandbox(
        sessionID,
        currentSkills || [],
        exuluConfig,
        user?.id,
      );
    } catch (err) {
      console.error(
        "[EXULU] Failed to eagerly create shared skill sandbox; outer agent will not have readFile/writeFile available.",
        err,
      );
    }
  }

  const disabled = new Set(disabledTools ?? []);

  // Project scope: when the session belongs to a project, its items become an
  // additional source for the agentic retrieval pipeline (EE-only by design —
  // the legacy basic project tool was removed; see the 2026-07-07 design spec).
  let projectScope: ProjectScope | undefined;
  if (project && !disabled.has("agentic_context_search")) {
    const { db } = await postgresClient();
    const projectRow = await db.from("projects").where("id", project).first();
    let rawItems: unknown = projectRow?.project_items;
    if (typeof rawItems === "string") {
      try {
        rawItems = JSON.parse(rawItems);
      } catch {
        rawItems = undefined;
      }
    }
    if (projectRow && Array.isArray(rawItems) && rawItems.length > 0) {
      projectScope = {
        id: projectRow.id,
        name: projectRow.name,
        description: projectRow.description ?? undefined,
        customInstructions: projectRow.custom_instructions ?? undefined,
        items: rawItems as string[],
        kbProfileDefaults: buildProjectKbProfileDefaults(rawItems as string[]),
      };
    }
  }

  if (agent?.memory && contexts?.length) {

    const context = contexts.find((context) => context.id === agent?.memory);
    if (!context) {
      throw new Error(
        "Context was set for agent memory but not found in the contexts: " +
        agent?.memory +
        " please double check with a developer to see if the context was removed from code.",
      );
    }

    const createNewMemoryTool = createNewMemoryItemTool(agent, context);
    if (createNewMemoryTool && !disabled.has(createNewMemoryTool.id)) {
      if (!currentTools) {
        currentTools = [];
      }
      currentTools.push(createNewMemoryTool);
    }
  }

  console.log("[EXULU] Convert tools array to object, session items", sessionItems);
  if (sessionItems) {
    const sessionItemsRetrievalTool = await createSessionItemsRetrievalTool({
      user: user,
      role: user?.role?.id,
      contexts: contexts,
      items: sessionItems,
    });
    if (sessionItemsRetrievalTool && !disabled.has(sessionItemsRetrievalTool.id)) {
      currentTools.push(sessionItemsRetrievalTool);
    }
  }

  const sessionFileReadTool = createSessionFileReadTool({ sessionID, user, exuluConfig });
  if (sessionFileReadTool && !disabled.has(sessionFileReadTool.id)) {
    currentTools.push(sessionFileReadTool);
  }

  const parseDocumentTool = createParseDocumentTool({ sessionID, user, exuluConfig });
  if (parseDocumentTool && !disabled.has(parseDocumentTool.id)) {
    currentTools.push(parseDocumentTool);
  }

  const viewDocumentPageTool = createViewDocumentPageTool({ sessionID, user, exuluConfig });
  if (viewDocumentPageTool && !disabled.has(viewDocumentPageTool.id)) {
    currentTools.push(viewDocumentPageTool);
  }

  console.log("[EXULU] Creating agentic search tool", contexts?.length, model);
  if (contexts?.length && model && !disabled.has("agentic_context_search")) {
    const index = currentTools.findIndex((tool) => tool.id === "agentic_context_search");
    const memoryContext = agent?.memory
      ? contexts.find((c) => c.id === agent.memory)
      : undefined;
    if (index !== -1) {
      // Case 2: the agent has agentic retrieval configured — the project (when
      // present) rides the same instance as an additional source.
      const agenticSearchTool = createAgenticRetrievalTool({
        contexts: contexts.filter((context) => context.id !== agent?.memory), // memory is searched by the memory phase, not as a KB
        memoryContext,
        user: user,
        role: user?.role?.id,
        model: model,
        preselected: sessionItems,
        memoryItems: memoryItems,
        projectScope,
      });
      if (agenticSearchTool) {
        currentTools[index] = {
          ...currentTools[index], // important to keep the original tool config
          ...agenticSearchTool,
        };
      }
    } else if (projectScope) {
      // Case 1: no agentic retrieval configured, but the chat has a project —
      // auto-inject an instance scoped to the project's knowledge. Zod defaults
      // are the preset (no stored config exists for a pushed tool).
      const projectContextIds = new Set(
        projectScope.items.map((gid) => {
          const i = gid.indexOf("/");
          return i === -1 ? gid : gid.slice(0, i);
        }),
      );
      const scopedContexts = contexts.filter(
        (c) => projectContextIds.has(c.id) && c.id !== agent?.memory,
      );
      if (scopedContexts.length > 0) {
        const projectSearchTool = createAgenticRetrievalTool({
          contexts: scopedContexts,
          memoryContext,
          user: user,
          role: user?.role?.id,
          model: model,
          preselected: [...(sessionItems ?? []), ...projectScope.items],
          memoryItems: memoryItems,
          projectScope,
        });
        if (projectSearchTool) {
          currentTools.push(projectSearchTool);
        }
      }
    }
  } else {
    // Double check to remove the agentic search tool if it
    // was enabled but no contexts or model are available.
    const agenticSearchTool = currentTools.find((tool) => tool.id === "agentic_context_search");
    if (agenticSearchTool) {
      currentTools.splice(currentTools.indexOf(agenticSearchTool), 1);
    }
  }

  const sanitizedTools = currentTools
    ? currentTools.map((tool) => ({
      ...tool,
      name: sanitizeToolName(tool.name),
    }))
    : [];

  console.log(
    "[EXULU] Sanitized tools",
    sanitizedTools.map((x) => x.name + " (" + x.id + ")"),
  );

  console.log("[EXULU] Approved tools", approvedTools);

  // Expose the shared sandbox's readFile/writeFile/bash to the OUTER agent. It
  // executes skills directly (no skill sub-agent), so it needs bash to run skill
  // scripts, plus readFile/writeFile to read inputs and save outputs (e.g. "store
  // the result as a .md file"). Files land under the session dir with the same S3
  // persistence + presigned URL pipeline. Only present when the agent has
  // sandbox_enabled — otherwise the block above leaves sharedSessionSandbox
  // undefined and this becomes {}.
  const sandboxTools: Record<string, any> = sharedSessionSandbox
    ? {
        readFile: {
          ...sharedSessionSandbox.tools.readFile,
          needsApproval: false,
          execute: async (args: any, opts: any) => {
            const origExecute = sharedSessionSandbox.tools.readFile.execute as
              | ((input: any, options: any) => Promise<any>)
              | undefined;
            if (!origExecute) throw new Error('readFile execute is undefined');
            const result = await origExecute(args, opts);
            if (typeof result?.content === 'string') {
              return {
                ...result,
                content: truncateToolOutput(result.content, budget.contextWindow, 'readFile', 0.05, toolOutputCharLimit),
              };
            }
            return result;
          },
        },
        writeFile: { ...sharedSessionSandbox.tools.writeFile, needsApproval: false },
        bash: {
          ...sharedSessionSandbox.tools.bash,
          needsApproval: false,
          execute: async (args: any, opts: any) => {
            const origExecute = sharedSessionSandbox.tools.bash.execute as
              | ((input: any, options: any) => Promise<any>)
              | undefined;
            if (!origExecute) throw new Error('bash execute is undefined');
            const result = await origExecute(args, opts);
            return {
              ...result,
              ...(typeof result?.stdout === 'string' && {
                stdout: truncateToolOutput(result.stdout, budget.contextWindow, 'bash', 0.10, toolOutputCharLimit),
              }),
              ...(typeof result?.stderr === 'string' && {
                stderr: truncateToolOutput(result.stderr, budget.contextWindow, 'bash stderr', 0.40, toolOutputCharLimit),
              }),
            };
          },
        },
      }
    : {};

  return {
    ...sandboxTools,
    ...sanitizedTools?.reduce((prev, cur) => {
      let toolVariableConfig = configs?.find((config) => config.id === cur.id);

      // Allows a dev to set a config option for an ExuluTool that overwrites the default tool description.
      const userDefinedConfigDescription = toolVariableConfig?.config.find(
        (config) => config.name === "description",
      )?.value;
      const defaultConfigDescription = toolVariableConfig?.config.find(
        (config) => config.name === "description",
      )?.default;
      const toolDescription = cur.description;
      const description =
        userDefinedConfigDescription || defaultConfigDescription || toolDescription;

      console.log(
        "[EXULU] Tool",
        cur.name,
        "needs approval",
        approvedTools?.includes(cur.name) ? false : true,
      );
      return {
        ...prev,
        [cur.name]: {
          ...cur.tool,
          description,
          // The approvedTools array uses the tool.name lookup as the frontend
          // Vercel AI SDK uses the sanitized tool name as the key, so this matches.
          needsApproval: (approvedTools?.includes("tool-" + cur.name) || !cur.needsApproval) ? false : true, // todo make configurable
          async *execute(inputs: any, options: any) {
            // generator function allows to use yield to stream tool call results
            console.log(
              "[EXULU] Executing tool",
              cur.name,
              "with inputs",
              inputs,
              "and options",
              options,
            );
            if (!cur.tool?.execute) {
              console.error("[EXULU] Tool execute function is undefined.", cur.tool);
              throw new Error("Tool execute function is undefined.");
            }

            if (toolVariableConfig) {
              toolVariableConfig = await hydrateVariables(toolVariableConfig || []);
            }

            let upload:
              | undefined
              | ((file: {
                name: string;
                data: string | Uint8Array | Buffer;
                type: allFileTypes;
                tags?: string[];
              }) => Promise<{ url: string; key: string } | undefined>) = undefined;

            if (
              exuluConfig?.fileUploads?.s3endpoint &&
              exuluConfig?.fileUploads?.s3key &&
              exuluConfig?.fileUploads?.s3secret &&
              exuluConfig?.fileUploads?.s3Bucket
            ) {
              s3Client ??= new S3Client({
                region: exuluConfig?.fileUploads?.s3region,
                ...(exuluConfig?.fileUploads?.s3endpoint && {
                  forcePathStyle: true,
                  endpoint: exuluConfig?.fileUploads?.s3endpoint,
                }),
                credentials: {
                  accessKeyId: exuluConfig?.fileUploads?.s3key ?? "",
                  secretAccessKey: exuluConfig?.fileUploads?.s3secret ?? "",
                },
              });

              upload = async ({
                name,
                data,
                type,
              }: {
                name: string;
                type: allFileTypes;
                data: string | Uint8Array | Buffer;
                tags?: string[];
              }): Promise<{ url: string; key: string } | undefined> => {
                const mime = getMimeType(type);
                const prefix = exuluConfig?.fileUploads?.s3prefix
                  ? `${exuluConfig.fileUploads.s3prefix.replace(/\/$/, "")}/`
                  : "";
                const key = `${prefix}${user?.id}/${generateS3Key(name)}${type}`;
                const command = new PutObjectCommand({
                  Bucket: exuluConfig?.fileUploads?.s3Bucket,
                  Key: key,
                  Body: data,
                  ContentType: mime,
                });
                try {
                  if (!s3Client) {
                    throw new Error("S3 client not initialized");
                  }
                  await s3Client.send(command);
                  // Return a presigned GET URL (usable immediately) plus the durable
                  // bucket-prefixed key (re-presignable later via /s3/download).
                  const bucket = exuluConfig?.fileUploads?.s3Bucket ?? "";
                  const presignedUrl = await getPresignedUrl(bucket, key, exuluConfig);
                  return { url: presignedUrl, key: `${bucket}/${key}` };
                } catch (caught: any) {
                  if (caught instanceof S3ServiceException && caught.name === "EntityTooLarge") {
                    throw new Error(`[EXULU] Error from S3 while uploading object to ${exuluConfig?.fileUploads?.s3Bucket}. \
                                      The object was too large. To upload objects larger than 5GB, use the S3 console (160GB max) \
                                      or the multipart upload API (5TB max).`);
                  } else if (caught instanceof S3ServiceException) {
                    throw new Error(
                      `[EXULU] Error from S3 while uploading object to ${exuluConfig?.fileUploads?.s3Bucket}.  ${caught.name}: ${caught.message}`,
                    );
                  } else {
                    throw caught;
                  }
                }
              };
            }

            const contextsMap = contexts?.reduce((acc, curr) => {
              acc[curr.id] = curr;
              return acc;
            }, {});

            const toolVariablesConfigData = toolVariableConfig
              ? toolVariableConfig.config.reduce((acc, curr) => {
                acc[curr.name] = curr.value;
                return acc;
              }, {})
              : {};

            const response = await cur.tool.execute(
              {
                ...inputs,
                model: model,
                sessionID: sessionID,
                sessionItems: sessionItems,
                memory: memoryItems,
                req: req,
                // Convert config to object format if a config object
                // is available, after we added the .value property
                // by hydrating it from the variables table.
                providerapikey: providerapikey,
                allExuluTools,
                currentTools,
                user,
                contexts: contextsMap,
                upload,
                exuluConfig,
                toolVariablesConfig: toolVariablesConfigData,
              },
              options,
            );

            await updateStatistic({
              name: "count",
              label: cur.name,
              type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
              trigger: "agent",
              count: 1,
              user: user?.id,
              role: user?.role?.id,
            });

            const guardCtx = {
              toolName: cur.name,
              contextWindow,
              sessionID,
              user,
              exuluConfig,
            };
            const offloadExempt = OUTPUT_OFFLOAD_EXEMPT_TOOL_IDS.has(cur.id);

            // Check if response is an async generator
            if (response && typeof response === "object" && Symbol.asyncIterator in response) {
              let lastValue;
              // Iterate through all yielded values from the generator
              for await (const value of response) {
                yield value;
                lastValue = value;
              }
              if (offloadExempt) return lastValue;
              // Cap + offload the FINAL value — that is what becomes the
              // persisted tool result and what every later turn re-sends.
              const guarded = await guardToolOutput(lastValue, guardCtx);
              if (guarded !== lastValue) {
                yield guarded;
              }
              return guarded;
            } else {
              const guarded = offloadExempt
                ? response
                : await guardToolOutput(response, guardCtx);
              yield guarded;
              return guarded;
            }
          },
        },
      };
    }, {}),
    // askForConfirmation
  };
};
