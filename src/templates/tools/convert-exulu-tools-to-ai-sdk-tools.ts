import { S3Client, PutObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { ExuluTool } from "@SRC/exulu/tool";
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
import { createAgenticRetrievalToolV3 } from "@EE/agentic-retrieval/v3/index";
import { getSessionTools } from "@EE/agentic-retrieval/v3/session-tools-registry";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name";
import type { Item } from "@EXULU_TYPES/models/item";
import { randomUUID } from "node:crypto";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { Request } from "express";
import { createNewMemoryItemTool } from "./memory-tool";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import type { ExuluSkill } from "@EXULU_TYPES/skill";
import { createSkillSandbox } from "@EE/invoke-skills/create-sandbox";
const generateS3Key = (filename) => `${randomUUID()}-${filename}`;
import { hasToolCall, Output, stepCountIs, ToolLoopAgent } from "ai";
import { z } from "zod";
import { QuestionAskTool } from "./question/question-ask";
import type { AgenticRetrievalOutput } from "@EE/agentic-retrieval/v3/types";
import { join, dirname } from 'node:path'

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
  currentSkills: ExuluSkill[] | undefined,
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
  sessionItems?: string[],
  model?: LanguageModel,
  agent?: ExuluAgent,
  memoryItems?: VectorSearchChunkResult[]
): Promise<Record<string, Tool>> => {
  if (!currentTools) return {};

  if (!allExuluTools) {
    allExuluTools = [];
  }

  if (!contexts) {
    contexts = [];
  }

  if (currentSkills?.length && sessionID && exuluConfig && model) {
    for (const skill of currentSkills) {
      currentTools.push(new ExuluTool({
        id: skill.id,
        name: sanitizeToolName(skill.name),
        description: skill.description,
        type: "skill",
        inputSchema: z.object({
          task: z.string().describe("The task to execute using the skill."),
        }),
        config: [],
        // generator function for execute
        execute: async function* (inputs) {

          // Create skill sandbox + tools (the tools provide a way to execute
          // commands inside the session specific sandbox environment).
          // todo inject any files or context items into the sandbox environment!
          // todo inject any context search tools into the tool loop agent that works
          // inside the sandbox environment
          const skillSandbox = await createSkillSandbox(sessionID, [skill], exuluConfig, user?.id);

          // Bridge onStepFinish callback -> generator: callback pushes into a
          // queue, generator awaits/yields from it while agent.generate() runs.
          const buffer: any[] = [];
          let resolveNext: ((v: IteratorResult<any>) => void) | null = null;
          let closed = false;
          const push = (step: any) => {
            if (resolveNext) {
              resolveNext({ value: step, done: false });
              resolveNext = null;
            } else {
              buffer.push(step);
            }
          };
          const close = () => {
            closed = true;
            if (resolveNext) {
              resolveNext({ value: undefined, done: true });
              resolveNext = null;
            }
          };


          const yields: AgenticRetrievalOutput = {
            steps: [],
            reasoning: [],
            chunks: [],
            usage: [],
            totalTokens: 0,
          };

          // Tracks in-flight tool calls so a tool-result content item arriving
          // in a later step can be attributed back to the original tool-call
          // entry (input + output rendered together by the frontend).
          type ToolEntry = { name: string; id: string; input: any; output: any };
          const pendingToolCalls = new Map<string, ToolEntry>();

          // todo figure out a way for this internal agent loop to be stopped by the user
          // in the chat interface
          const agent = new ToolLoopAgent({
            model: model,
            // multiline
            instructions: ``,
            output: Output.object({
              schema: z.object({
                result: z.string(),
                type: z.enum(["file", "text", "question"]),
              }),
              // todo allow setting token limit for the output
            }),
            onStepFinish: (step) => {
              console.log("[EXULU] Skill tool loop agent step finish:", step);

              let stepText = "";
              const stepTools: ToolEntry[] = [];

              if (step.content) {
                for (const content of step.content as any[]) {
                  if (content.type === "text") {
                    stepText += (stepText ? "\n" : "") + content.text;
                  } else if (content.type === "tool-call") {
                    const entry: ToolEntry = {
                      name: content.toolName,
                      id: content.toolCallId,
                      input: content.input,
                      output: undefined,
                    };
                    pendingToolCalls.set(content.toolCallId, entry);
                    stepTools.push(entry);
                  } else if (content.type === "tool-result") {
                    const existing = pendingToolCalls.get(content.toolCallId);
                    if (existing) {
                      // Mutate the original entry so the next yielded snapshot
                      // backfills the output into the step that made the call.
                      existing.output = content.output;
                      pendingToolCalls.delete(content.toolCallId);
                    } else {
                      // Orphan result (no matching call seen) — surface it on
                      // its own so it isn't silently dropped.
                      stepTools.push({
                        name: content.toolName,
                        id: content.toolCallId,
                        input: undefined,
                        output: content.output,
                      });
                    }
                  }
                }
              }

              // Skip steps that contributed no text and no new tool calls
              // (e.g. a step that only delivered a tool-result already
              // attributed to its originating step above).
              if (stepText || stepTools.length > 0) {
                yields.steps.push({
                  stepNumber: yields.steps.length + 1,
                  text: stepText,
                  toolCalls: stepTools,
                  chunks: [],
                  dynamicToolsCreated: [],
                  tokens: 0,
                });
                yields.reasoning.push({
                  text: stepText,
                  tools: stepTools,
                });
              }

              // Frontend expects { result: { reasoning, ... } } shape (see
              // message-renderer.tsx UntypedToolPartComponent block). New
              // array refs prevent later .push()s from leaking into this
              // frame; item-level mutations (tool output backfill above)
              // intentionally do propagate.
              push({
                result: {
                  ...yields,
                  steps: [...yields.steps],
                  reasoning: [...yields.reasoning],
                },
              });
            },
            // Use the sanitized name — that's the key the tool is actually
            // registered under and the name that shows up in tool-call events.
            // Passing the raw "Question Ask" never matches.
            stopWhen: [stepCountIs(20), hasToolCall(sanitizeToolName(QuestionAskTool.name))], // todo make configurable per skill?
            // todo inject skills to upload artifacts to s3
            tools: {
              ...skillSandbox.tools,
              [sanitizeToolName(QuestionAskTool.name)]: {
                ...QuestionAskTool.tool,
                // The AI SDK calls execute(inputs, options). QuestionAskTool reads
                // sessionID / user from inside `inputs` (see its execute body), so
                // inject them there rather than via bind (which would shift the
                // arg positions and lose the model's actual inputs).
                execute: async (inputs: any, options: any) => {
                  if (!QuestionAskTool?.tool?.execute) {
                    throw new Error("QuestionAskTool.tool.execute is undefined");
                  }
                  return QuestionAskTool.tool.execute(
                    { ...inputs, sessionID, user },
                    options,
                  );
                },
              },
            },
          });

          const skillDir = join(skillSandbox.sessionDir, 'skills', skill.name);
          const prompt = `
            You are a helpful assistant, you have been asked to execute the following skill: ${skill.name}

            For this task:

            <task>
            ${inputs.task}
            </task>

            You have the following tools available to you:

            <tools>
            - bash: run shell commands. The working directory is "${skillSandbox.sessionDir}".
            - readFile: read a file by absolute path. Use this to read skill instructions.
            - writeFile: write a file by absolute path. USE THIS when the task asks you to save, store, or produce a file. Do not claim files cannot be saved — call writeFile.
            - ${sanitizeToolName(QuestionAskTool.name)}: ask the user a multiple-choice question. After calling this tool you MUST stop and wait for the answer; do not continue reasoning or produce a final result.
            </tools>

            The skill files are available in the following directory:
            ${skillDir}

            Start by reading the skill instructions (typically ${skillDir}/SKILL.md) and follow them.

            If the task asks for a file (e.g. "save as .md", "store the result as a file"), write the result to a file under "${skillSandbox.sessionDir}" using writeFile, then return type="file" with the absolute path as the result.

            If you need to ask the user a question, call ${sanitizeToolName(QuestionAskTool.name)} and then stop — do not also generate a final answer. The user will respond and the skill will be re-invoked.

            Otherwise, return type="text" with your answer as the result.
            `
          console.log("[EXULU] Skill tool loop agent prompt:", prompt);

          const finalPromise = agent.generate({
            prompt: prompt,
          }).finally(close);

          // Drain step events as they arrive from onStepFinish.
          while (true) {
            if (buffer.length) {
              yield buffer.shift();
              continue;
            }
            if (closed) break;
            const next = await new Promise<IteratorResult<any>>((r) => {
              resolveNext = r;
            });
            if (next.done) break;
            yield next.value
          }

          const result = await finalPromise;

          console.log("[EXULU] Skill tool loop agent result:", result);

          // Determine how the loop ended. If we stopped because the model
          // asked the user a question, there is no structured Output.object —
          // accessing result.output would throw NoOutputGeneratedError.
          // In that case, surface the question itself as the final value.
          const questionToolName = sanitizeToolName(QuestionAskTool.name);
          const lastStep = result.steps?.[result.steps.length - 1];
          const questionCall = lastStep?.content?.find(
            (c: any) => c.type === "tool-call" && c.toolName === questionToolName,
          );
          const questionResult = lastStep?.content?.find(
            (c: any) => c.type === "tool-result" && c.toolName === questionToolName,
          );

          let finalResult: string | undefined;
          let finalType: "file" | "text" | "question" | undefined;

          if (questionCall) {
            // The question_ask tool's result already contains the persisted
            // question payload (id, question, answerOptions, status). Pass it
            // through so the frontend can render the question UI.
            const raw = (questionResult as any)?.output?.result;
            finalResult = typeof raw === "string" ? raw : JSON.stringify(raw ?? (questionCall as any).input);
            finalType = "question";
          } else {
            // Normal completion — Output.object should be populated. Guard
            // against the rare case where it still isn't.
            try {
              finalResult = result.output?.result;
              finalType = result.output?.type;
            } catch (err) {
              console.warn("[EXULU] Skill agent finished without structured output:", err);
              finalResult = result.text ?? "";
              finalType = "text";
            }
          }

          yield {
            result: JSON.stringify({
              result: finalResult,
              type: finalType,
              reasoning: yields.reasoning,
              steps: yields.steps,
            }),
          };
        }
      }));
    }
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
    if (createNewMemoryTool) {
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
    if (sessionItemsRetrievalTool) {
      currentTools.push(sessionItemsRetrievalTool);
    }
  }

  console.log("[EXULU] Creating agentic search tool", contexts?.length, model);
  if (contexts?.length && model) {
    const agenticSearchTool = createAgenticRetrievalToolV3({
      contexts: contexts.filter((context) => context.id !== agent?.memory), // dont include the agents memory in the agentic search tool!
      rerankers: rerankers || [],
      user: user,
      role: user?.role?.id,
      model: model,
      preselected: sessionItems,
      memoryItems: memoryItems,
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

  // Session-scoped dynamic tools created by agentic retrieval (e.g. get_more_content_from_X).
  // These are registered during retrieval runs so the outer agent can call them directly
  // on follow-up questions without re-running the full retrieval loop.
  const sessionDynamicTools = sessionID
    ? Object.entries(getSessionTools(sessionID)).reduce<Record<string, any>>((acc, [name, t]) => {
      acc[name] = { ...t, needsApproval: false };
      return acc;
    }, {})
    : {};

  return {
    ...sessionDynamicTools,
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
