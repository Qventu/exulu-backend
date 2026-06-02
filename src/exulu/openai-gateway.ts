import { type Express, type Request, type Response } from "express";
import {
  streamText,
  generateText,
  stepCountIs,
  jsonSchema,
  type ModelMessage,
  type UserModelMessage,
  type AssistantModelMessage,
  type ToolSet,
} from "ai";
import { transformStreamChunk, transformCompletion, type TransformerContext } from "./openai-transformer.ts";
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
import { resolveModel, ResolveModelError } from "./resolve-model.ts";
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

type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

function convertOpenAIToolsToAiSdkTools(tools: OpenAITool[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => {
      const params = t.function.parameters ?? {};
      return [
        t.function.name,
        {
          description: t.function.description ?? "",
          inputSchema: jsonSchema({
            type: "object" as const,
            properties: (params.properties as Record<string, unknown>) ?? {},
            ...(params.required ? { required: params.required as string[] } : {}),
          }),
        },
      ];
    }),
  );
}

function convertOpenAIMessagesToModelMessages(messages: OpenAIMessage[]): {
  systemPrompt: string;
  coreMessages: ModelMessage[];
} {
  const systemParts: string[] = [];
  const coreMessages: ModelMessage[] = [];

  // Track toolCallId → toolName from assistant messages for tool result lookup
  const toolCallIdToName = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(typeof msg.content === "string" ? msg.content : "");
      continue;
    }

    if (msg.role === "user") {
      const last = coreMessages[coreMessages.length - 1];
      if (typeof msg.content === "string") {
        if (last?.role === "user" && typeof last.content === "string") {
          last.content += "\n\n" + msg.content;
        } else {
          coreMessages.push({ role: "user", content: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        const parts = (msg.content as OpenAIContentPart[]).flatMap((part) => {
          if (part.type === "text") return [{ type: "text" as const, text: part.text }];
          if (part.type === "image_url") return [{ type: "image" as const, image: part.image_url.url }];
          return [];
        });
        if (last?.role === "user" && Array.isArray(last.content)) {
          (last.content as UserModelMessage["content"]).push(...(parts as UserModelMessage["content"]));
        } else {
          coreMessages.push({ role: "user", content: parts } as UserModelMessage);
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const parts: AssistantModelMessage["content"] = [];
        if (typeof msg.content === "string" && msg.content) {
          parts.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
          const rawArgs = tc.function.arguments;
          const input =
            rawArgs == null
              ? {}
              : typeof rawArgs === "object"
                ? rawArgs
                : (() => { try { return JSON.parse(rawArgs); } catch { return {}; } })();
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function.name,
            input,
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
      const toolCallId = msg.tool_call_id ?? "";
      const toolName = toolCallIdToName.get(toolCallId) ?? "unknown";
      const resultText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      coreMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            output: { type: "text" as const, value: resultText },
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

  app.get(
    "/gateway/open-ai/v1/models",
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

        let projectsQuery = db("projects").select("id", "name");
        projectsQuery = applyAccessControl(projectsSchema(), projectsQuery, authResult.user);
        const projects: Pick<Project, "id" | "name">[] = await projectsQuery;

        let agentsQuery = db("agents").select("id", "name");
        agentsQuery = applyAccessControl(agentsSchema(), agentsQuery, authResult.user);
        const agents: Pick<ExuluAgent, "id" | "name">[] = await agentsQuery;

        const data = projects.flatMap((p) =>
          agents.map((a) => ({
            id: `${p.name}/${a.name}`,
            object: "model",
            created: 0,
            owned_by: "exulu",
          })),
        );

        res.json({ object: "list", data });
      } catch (error: any) {
        console.error("[OPENAI GATEWAY] /v1/models error:", error);
        res.status(500).json({ error: { message: error.message, type: "server_error" } });
      }
    },
  );

  app.get(
    "/gateway/open-ai/v1/models/:projectId/:agentId",
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

        let projectQuery = db("projects").select("id", "name");
        projectQuery = applyAccessControl(projectsSchema(), projectQuery, authResult.user);
        projectQuery.where({ id: req.params.projectId });
        const project: Pick<Project, "id" | "name"> | undefined = await projectQuery.first();

        let agentQuery = db("agents").select("id", "name");
        agentQuery = applyAccessControl(agentsSchema(), agentQuery, authResult.user);
        agentQuery.where({ id: req.params.agentId });
        const agent: Pick<ExuluAgent, "id" | "name"> | undefined = await agentQuery.first();

        if (!project || !agent) {
          res.status(404).json({ error: { message: "Model not found", type: "invalid_request_error" } });
          return;
        }

        res.json({
          id: `${project.name}/${agent.name}`,
          object: "model",
          created: 0,
          owned_by: "exulu",
        });
      } catch (error: any) {
        console.error("[OPENAI GATEWAY] /v1/models/:id error:", error);
        res.status(500).json({ error: { message: error.message, type: "server_error" } });
      }
    },
  );

  app.post(
    ["/gateway/open-ai/v1/chat/completions", "/gateway/open-ai/v1/completions"],
    express.json({ limit: REQUEST_SIZE_LIMIT }),
    (req: Request, _res: Response, next) => {
      console.log("[OPENAI GATEWAY] incoming request:", {
        url: req.originalUrl,
        method: req.method,
        headers: {
          authorization: req.headers["authorization"] ? "[present]" : "[missing]",
          "x-api-key": req.headers["x-api-key"] ? "[present]" : "[missing]",
          "exulu-api-key": req.headers["exulu-api-key"] ? "[present]" : "[missing]",
          "content-type": req.headers["content-type"],
        },
        body: {
          model: req.body?.model,
          stream: req.body?.stream,
          messagesCount: req.body?.messages?.length,
          hasPrompt: typeof req.body?.prompt === "string",
          tools: req.body?.tools,
        },
      });
      if (typeof req.body.prompt === "string") {
        req.body.messages = [{ role: "user", content: req.body.prompt }];
        delete req.body.prompt;
      }
      next();
    },
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

        const modelId: string | undefined = req.body.model;
        if (!modelId) {
          res.status(400).json({
            error: { message: "Missing required field: model", type: "invalid_request_error" },
          });
          return;
        }

        const separatorIndex = modelId.indexOf("/");
        if (separatorIndex === -1) {
          res.status(400).json({
            error: { message: "Invalid model format. Expected: 'projectname/agentname'", type: "invalid_request_error" },
          });
          return;
        }
        const projectName = modelId.substring(0, separatorIndex);
        const agentName = modelId.substring(separatorIndex + 1);

        let agentQuery = db("agents").select("*");
        agentQuery = applyAccessControl(agentsSchema(), agentQuery, user);
        agentQuery.where({ name: agentName });
        const agent: ExuluAgent | undefined = await agentQuery.first();

        if (!agent) {
          res.status(404).json({
            error: {
              message: `Agent '${agentName}' not found or you do not have access to it.`,
              type: "invalid_request_error",
            },
          });
          return;
        }

        let project: Project | undefined = undefined;
        if (projectName) {
          let projectQuery = db("projects").select("*");
          projectQuery = applyAccessControl(projectsSchema(), projectQuery, user);
          projectQuery.where({ name: projectName });
          project = await projectQuery.first();
        }

        if (!process.env.NEXTAUTH_SECRET) {
          res.status(500).json({ error: { message: "Server configuration error", type: "server_error" } });
          return;
        }

        if (!agent.model) {
          res.status(400).json({
            error: { message: "Agent has no model configured", type: "invalid_request_error" },
          });
          return;
        }

        let resolved: Awaited<ReturnType<typeof resolveModel>>;
        try {
          resolved = await resolveModel({
            modelId: agent.model,
            user: user,
            providers,
            agent: agent,
            project: project
          });
        } catch (err) {
          if (err instanceof ResolveModelError) {
            const status = err.code === "MODEL_FORBIDDEN" ? 403 : 400;
            res.status(status).json({
              error: { message: err.message, type: "invalid_request_error", code: err.code },
            });
            return;
          }
          throw err;
        }
        const providerapikey = resolved.apiKey;
        const languageModel = resolved.languageModel;

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

        // Client-provided tools (e.g. from Continue.dev) take priority — they are
        // executed client-side, so we pass them without execute functions.
        const clientTools: OpenAITool[] = Array.isArray(req.body.tools) ? req.body.tools : [];
        const activeTools: ToolSet =
          clientTools.length > 0
            ? convertOpenAIToolsToAiSdkTools(clientTools)
            : convertedTools;

        const openaiMessages: OpenAIMessage[] = req.body.messages ?? [];
        const { systemPrompt: requestSystemPrompt, coreMessages } =
          convertOpenAIMessagesToModelMessages(openaiMessages);

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
        const hasTools = Object.keys(activeTools).length > 0;
        const ctx: TransformerContext = { completionId, created, modelId };

        if (req.body.stream === true) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");

          const result = streamText({
            model: languageModel,
            system: systemPrompt || undefined,
            messages: coreMessages,
            tools: hasTools ? activeTools : undefined,
            maxRetries: 2,
            stopWhen: clientTools.length > 0 ? undefined : [stepCountIs(5)],
            onError: (error) => {
              console.error("[OPENAI GATEWAY] stream error:", error);
            },
          });

          res.write(
            `data: ${JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
            })}\n\n`,
          );

          for await (const chunk of result.fullStream) {
            console.log("[OPENAI GATEWAY] chunk:", chunk.type);
            const openAIChunk = transformStreamChunk(chunk, ctx);
            if (openAIChunk) {
              if (chunk.type === "finish") {
                console.log("[OPENAI GATEWAY] finish_reason:", openAIChunk.choices[0]?.finish_reason);
              }
              res.write(`data: ${JSON.stringify(openAIChunk)}\n\n`);
            }
          }

          res.write("data: [DONE]\n\n");
          res.end();

          // Use result.usage (resolves after stream) — more reliable than chunk-based
          // tracking since not all providers include usage in the finish chunk.
          const usage = await result.usage;
          await writeStatistics(agent, project, user, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
        } else {
          const { text, usage } = await generateText({
            model: languageModel,
            system: systemPrompt || undefined,
            messages: coreMessages,
            tools: hasTools ? activeTools : undefined,
            maxRetries: 2,
            stopWhen: clientTools.length > 0 ? undefined : [stepCountIs(5)],
          });

          res.json(transformCompletion(text, usage.inputTokens ?? 0, usage.outputTokens ?? 0, ctx));

          await writeStatistics(agent, project, user, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
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
