import { S3Client, PutObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import type { ExuluTool } from "@SRC/exulu/tool";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import { updateStatistic } from "@SRC/exulu/statistics";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";
import { postgresClient } from "@SRC/postgres/client";
import CryptoJS from "crypto-js";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { LanguageModel, Tool } from "ai";
import type { allFileTypes, ExuluAgent } from "@EXULU_TYPES/models/agent";
import { createProjectItemsRetrievalTool } from "./project-retrieval-tool";
import { createSessionItemsRetrievalTool } from "./session-items-retrieval-tool";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";
import type { Item } from "@EXULU_TYPES/models/item";
import { randomUUID } from "node:crypto";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { Request } from "express";
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

const hydrateVariables = async (tool: ExuluAgentToolConfig): Promise<ExuluAgentToolConfig> => {
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
  approvedTools: string[] | undefined,
  allExuluTools: ExuluTool[] | undefined,
  configs: ExuluAgentToolConfig[] | undefined,
  providerapikey?: string,
  contexts?: ExuluContext[],
  rerankers?: ExuluReranker[],
  user?: User,
  exuluConfig?: ExuluConfig,
  sessionID?: string,
  req?: Request,
  project?: string,
  items?: string[],
  model?: LanguageModel,
  agent?: ExuluAgent,
): Promise<Record<string, Tool>> => {
  if (!currentTools) return {};

  if (!allExuluTools) {
    allExuluTools = [];
  }

  if (!contexts) {
    contexts = [];
  }

  let projectRetrievalTool: ExuluTool | undefined;
  if (project) {
    projectRetrievalTool = await createProjectItemsRetrievalTool({
      user: user,
      role: user?.role?.id,
      contexts: contexts,
      projectId: project,
    });
    if (projectRetrievalTool) {
      currentTools.push(projectRetrievalTool);
    }
  }

  console.log("[EXULU] Convert tools array to object, session items", items);
  if (items) {
    const sessionItemsRetrievalTool = await createSessionItemsRetrievalTool({
      user: user,
      role: user?.role?.id,
      contexts: contexts,
      items: items,
    });
    if (sessionItemsRetrievalTool) {
      currentTools.push(sessionItemsRetrievalTool);
    }
  }

  console.log("[EXULU] Creating agentic search tool", contexts?.length, model);
  if (contexts?.length && model) {
    const agenticSearchTool = createAgenticRetrievalTool({
      contexts: contexts.filter((context) => context.id !== agent?.memory), // dont include the agents memory in the agentic search tool!
      rerankers: rerankers || [],
      user: user,
      role: user?.role?.id,
      model: model,
      projectRetrievalTool: projectRetrievalTool,
    });
    if (agenticSearchTool) {
      // Replace the agentic search tool with the new one.
      const index = currentTools.findIndex((tool) => tool.id === "agentic_context_search");
      if (index !== -1) {
        currentTools[index] = {
          ...currentTools[index], // important to keep the original tool config
          ...agenticSearchTool,
        };
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

  return {
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
          needsApproval: approvedTools?.includes("tool-" + cur.name) ? false : true, // todo make configurable
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
                }) => Promise<Item | undefined>) = undefined;

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
              }): Promise<Item | undefined> => {
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
                  const response = await s3Client.send(command);
                  console.log(response);
                  return response;
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

            // Check if response is an async generator
            if (response && typeof response === "object" && Symbol.asyncIterator in response) {
              let lastValue;
              // Iterate through all yielded values from the generator
              for await (const value of response) {
                yield value;
                lastValue = value;
              }
              return lastValue;
            } else {
              // Regular response (not a generator)
              yield response;
              return response;
            }
          },
        },
      };
    }, {}),
    // askForConfirmation
  };
};
