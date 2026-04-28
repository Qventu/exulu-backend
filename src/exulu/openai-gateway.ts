import { type Express, type Request, type Response } from "express";
import {
  streamText,
  generateText,
  stepCountIs,
  type CoreMessage,
  type CoreUserMessage,
  type CoreAssistantMessage,
} from "ai";
import { randomUUID } from "node:crypto";
import CryptoJS from "crypto-js";
import express from "express";
import { postgresClient } from "../postgres/client.ts";
import { requestValidators } from "../validators/requests.ts";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control.ts";
import { coreSchemas } from "../postgres/core-schema.ts";
import { getEnabledTools } from "@SRC/utils/enabled-tools.ts";
import { convertExuluToolsToAiSdkTools } from "@SRC/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts";
import { updateStatistic } from "./statistics.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import type { STATISTICS_LABELS } from "@EXULU_TYPES/statistics.ts";
import type { ExuluConfig } from "./app/index.ts";
import type { ExuluProvider } from "./provider.ts";
import type { ExuluTool } from "./tool.ts";
import type { ExuluContext } from "./context.ts";
import type { ExuluReranker } from "./reranker.ts";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import type { Project } from "@EXULU_TYPES/models/project";
import { REQUEST_SIZE_LIMIT } from "./routes.ts";

type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[];
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

function convertOpenAIMessagesToCoreMessages(messages: OpenAIMessage[]): {
  systemPrompt: string;
  coreMessages: CoreMessage[];
} {
  const systemParts: string[] = [];
  const coreMessages: CoreMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(typeof msg.content === "string" ? msg.content : "");
      continue;
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        coreMessages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts = (msg.content as OpenAIContentPart[]).flatMap((part) => {
          if (part.type === "text") return [{ type: "text" as const, text: part.text }];
          if (part.type === "image_url") return [{ type: "image" as const, image: part.image_url.url }];
          return [];
        });
        coreMessages.push({ role: "user", content: parts } as CoreUserMessage);
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: CoreAssistantMessage["content"] = [];
        if (typeof msg.content === "string" && msg.content) {
          parts.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            args: JSON.parse(tc.function.arguments || "{}"),
          });
        }
        coreMessages.push({ role: "assistant", content: parts });
      } else {
        coreMessages.push({
          role: "assistant",
          content: typeof msg.content === "string" ? msg.content : "",
        });
      }
      continue;
    }

    if (msg.role === "tool") {
      coreMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.tool_call_id ?? "",
            result: msg.content,
          },
        ],
      });
    }
  }

  return { systemPrompt: systemParts.join("\n\n"), coreMessages };
}

async function writeStatistics(
  agent: ExuluAgent,
  project: Project | null,
  user: { id: number | string; role?: { id?: string } },
  inputTokens: number,
  outputTokens: number,
) {
  const label = agent.name;
  const trigger = "agent" as STATISTICS_LABELS;
  const projectId = project?.id ? { project: project.id } : {};

  await Promise.all([
    updateStatistic({
      name: "count",
      label,
      type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
      trigger,
      count: 1,
      user: user.id,
      role: user.role?.id,
      ...projectId,
    }),
    ...(inputTokens
      ? [
        updateStatistic({
          name: "inputTokens",
          label,
          type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
          trigger,
          count: inputTokens,
          user: user.id,
          role: user.role?.id,
          ...projectId,
        }),
      ]
      : []),
    ...(outputTokens
      ? [
        updateStatistic({
          name: "outputTokens",
          label,
          type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
          trigger,
          count: outputTokens,
          user: user.id,
          role: user.role?.id,
          ...projectId,
        }),
      ]
      : []),
  ]);
}

export const registerOpenAIGatewayRoutes = async (
  app: Express,
  providers: ExuluProvider[],
  tools: ExuluTool[],
  contexts: ExuluContext[] | undefined,
  config: ExuluConfig,
  rerankers?: ExuluReranker[],
): Promise<void> => {
  const { agentsSchema, projectsSchema } = coreSchemas.get();

  // Lists all agents in the project as OpenAI-compatible models.
  app.get(
    "/gateway/open-ai/:project/v1/models",
    async (req: Request, res: Response) => {
      try {
        const authResult = await requestValidators.authenticate(req);
        if (!authResult.user?.id) {
          res
            .status(authResult.code || 401)
            .json({ error: { message: authResult.message, type: "authentication_error" } });
          return;
        }

        const { db } = await postgresClient();

        let agentsQuery = db("agents").select("id", "name");
        agentsQuery = applyAccessControl(agentsSchema(), agentsQuery, authResult.user);
        const agents: Pick<ExuluAgent, "id" | "name">[] = await agentsQuery;

        const data = agents.map((a) => ({
          id: a.id,
          object: "model",
          created: 0,
          owned_by: "exulu",
          name: a.name,
        }));

        res.json({ object: "list", data });
      } catch (error: any) {
        console.error("[OPENAI GATEWAY] /v1/models error:", error);
        res.status(500).json({ error: { message: error.message, type: "server_error" } });
      }
    },
  );

  app.get(
    "/gateway/open-ai/:project/v1/models/:id",
    async (req: Request, res: Response) => {
      try {
        const authResult = await requestValidators.authenticate(req);
        if (!authResult.user?.id) {
          res
            .status(authResult.code || 401)
            .json({ error: { message: authResult.message, type: "authentication_error" } });
          return;
        }

        const { db } = await postgresClient();
        let agentQuery = db("agents").select("id", "name");
        agentQuery = applyAccessControl(agentsSchema(), agentQuery, authResult.user);
        agentQuery.where({ id: req.params.id });
        const agent: Pick<ExuluAgent, "id" | "name"> | undefined = await agentQuery.first();

        if (!agent) {
          res.status(404).json({ error: { message: "Model not found", type: "invalid_request_error" } });
          return;
        }

        res.json({ id: agent.id, object: "model", created: 0, owned_by: "exulu", name: agent.name });
      } catch (error: any) {
        console.error("[OPENAI GATEWAY] /v1/models/:id error:", error);
        res.status(500).json({ error: { message: error.message, type: "server_error" } });
      }
    },
  );

  app.post(
    "/gateway/open-ai/:project/v1/chat/completions",
    express.json({ limit: REQUEST_SIZE_LIMIT }),
    async (req: Request, res: Response) => {
      try {
        const { db } = await postgresClient();

        const authResult = await requestValidators.authenticate(req);
        if (!authResult.user?.id) {
          res
            .status(authResult.code || 401)
            .json({ error: { message: authResult.message, type: "authentication_error" } });
          return;
        }
        const user = authResult.user;

        const agentId: string | undefined = req.body.model;
        if (!agentId) {
          res.status(400).json({
            error: { message: "Missing required field: model", type: "invalid_request_error" },
          });
          return;
        }

        let agentQuery = db("agents").select("*");
        agentQuery = applyAccessControl(agentsSchema(), agentQuery, user);
        agentQuery.where({ id: agentId });
        const agent: ExuluAgent | undefined = await agentQuery.first();

        if (!agent) {
          res.status(404).json({
            error: {
              message: `Agent ${agentId} not found or you do not have access to it.`,
              type: "invalid_request_error",
            },
          });
          return;
        }

        let project: Project | null = null;
        if (req.params.project && req.params.project !== "DEFAULT") {
          let projectQuery = db("projects").select("*");
          projectQuery = applyAccessControl(projectsSchema(), projectQuery, user);
          projectQuery.where({ id: req.params.project });
          project = await projectQuery.first();
        }

        if (!process.env.NEXTAUTH_SECRET) {
          res.status(500).json({ error: { message: "Server configuration error", type: "server_error" } });
          return;
        }

        if (!agent.providerapikey) {
          res.status(400).json({
            error: { message: "Agent has no API key configured", type: "invalid_request_error" },
          });
          return;
        }

        const variable = await db.from("variables").where({ name: agent.providerapikey }).first();
        if (!variable) {
          res.status(400).json({
            error: { message: "API key variable not found", type: "invalid_request_error" },
          });
          return;
        }

        if (!variable.encrypted) {
          res.status(400).json({
            error: { message: "API key variable must be encrypted", type: "invalid_request_error" },
          });
          return;
        }

        const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
        const providerapikey = bytes.toString(CryptoJS.enc.Utf8);

        const provider =
          providers.find((p) => p.id === agent.providerName) ??
          providers.find((p) => p.provider === agent.provider);

        if (!provider?.config?.model?.create) {
          res.status(400).json({
            error: { message: "No provider configured for this agent", type: "invalid_request_error" },
          });
          return;
        }

        const languageModel = provider.config.model.create({ apiKey: providerapikey });

        const disabledTools: string[] = req.body.disabledTools ?? [];
        const enabledTools = await getEnabledTools(
          agent,
          tools,
          contexts ?? [],
          rerankers ?? [],
          disabledTools,
          providers,
          user,
        );

        const convertedTools = await convertExuluToolsToAiSdkTools(
          enabledTools,
          [],
          tools,
          agent.tools,
          providerapikey,
          contexts,
          rerankers,
          user,
          config,
          undefined,
          req,
          project?.id,
          undefined,
          languageModel,
          agent,
        );

        const openaiMessages: OpenAIMessage[] = req.body.messages ?? [];
        const { systemPrompt: requestSystemPrompt, coreMessages } =
          convertOpenAIMessagesToCoreMessages(openaiMessages);

        const agentInstructions = agent.instructions ?? "";
        const systemParts = [
          agentInstructions
            ? `You are an agent named: ${agent.name}\nHere are your instructions: ${agentInstructions}`
            : `You are an agent named: ${agent.name}`,
          project
            ? `The project you are working on is: ${project.name}${project.description ? `\n${project.description}` : ""}`
            : "",
          requestSystemPrompt,
        ].filter(Boolean);
        const systemPrompt = systemParts.join("\n\n");

        const completionId = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        const hasTools = Object.keys(convertedTools).length > 0;

        if (req.body.stream === true) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          const result = streamText({
            model: languageModel,
            system: systemPrompt || undefined,
            messages: coreMessages,
            tools: hasTools ? convertedTools : undefined,
            maxRetries: 2,
            stopWhen: [stepCountIs(5)],
            onError: (error) => {
              console.error("[OPENAI GATEWAY] stream error:", error);
            },
          });

          result.consumeStream();

          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: agentId,
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            })}\n\n`,
          );

          let inputTokens = 0;
          let outputTokens = 0;

          for await (const chunk of result.fullStream) {
            if (chunk.type === "text-delta") {
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: agentId,
                  choices: [{ index: 0, delta: { content: chunk.textDelta }, finish_reason: null }],
                })}\n\n`,
              );
            } else if (chunk.type === "tool-call-streaming-start") {
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: agentId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: chunk.toolCallId,
                            type: "function",
                            function: { name: chunk.toolName, arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
            } else if (chunk.type === "tool-call-delta") {
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: agentId,
                  choices: [
                    {
                      index: 0,
                      delta: { tool_calls: [{ index: 0, function: { arguments: chunk.argsTextDelta } }] },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
            } else if (chunk.type === "finish") {
              inputTokens = chunk.usage?.promptTokens ?? 0;
              outputTokens = chunk.usage?.completionTokens ?? 0;
              const finishReason = chunk.finishReason === "tool-calls" ? "tool_calls" : "stop";
              res.write(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: agentId,
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                  usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  },
                })}\n\n`,
              );
            }
          }

          res.write("data: [DONE]\n\n");
          res.end();

          await writeStatistics(agent, project, user, inputTokens, outputTokens);
        } else {
          const { text, usage } = await generateText({
            model: languageModel,
            system: systemPrompt || undefined,
            messages: coreMessages,
            tools: hasTools ? convertedTools : undefined,
            maxRetries: 2,
            stopWhen: [stepCountIs(5)],
          });

          res.json({
            id: completionId,
            object: "chat.completion",
            created,
            model: agentId,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: text },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            },
          });

          await writeStatistics(agent, project, user, usage.promptTokens, usage.completionTokens);
        }
      } catch (error: any) {
        console.error("[OPENAI GATEWAY] /v1/chat/completions error:", error);
        if (!res.headersSent) {
          res.status(500).json({ error: { message: error.message, type: "server_error" } });
        }
      }
    },
  );
};
