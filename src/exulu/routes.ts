import { type Express, type Request, type Response } from "express";
import { requestValidators } from "../validators/requests.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import { postgresClient } from "../postgres/client.ts";
import express from "express";
import { ApolloServer } from '@apollo/server';
import cors from "cors";
import "reflect-metadata";
import { createSDL } from "@SRC/graphql/schemas/index.ts";
import { applyFilters } from "@SRC/graphql/resolvers/apply-filters.ts";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control.ts";
import type { Knex } from "knex";
import { expressMiddleware } from "@as-integrations/express5";
import { coreSchemas } from "../postgres/core-schema.ts";
import {
  createUppyRoutes,
  uploadFile,
  listS3ObjectsByPrefix,
  copyS3Object,
  deleteS3Object,
  getS3ObjectContent,
  getS3ObjectBytes,
  getS3ObjectEtag,
  getS3SignedUploadUrl,
  getPresignedUrl,
  type S3FileObject,
} from "../uppy/index.ts";
import { extractBundleToS3, BundleValidationError } from "../skills/bundle-extractor.ts";
import { getPdfPreviewBytes, PreviewRenderError } from "../sessions/pdf-preview-cache.ts";
import { downloadKeyIntoSandbox } from "../../ee/invoke-skills/create-sandbox.ts";
import { InMemoryLRUCache } from "@apollo/utils.keyvaluecache";
import bodyParser from "body-parser";
import CryptoJS from "crypto-js";
import OpenAI from "openai";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { type Tracer } from "@opentelemetry/api";
import type { ExuluConfig } from "./app/index.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { getEnabledTools } from "@SRC/utils/enabled-tools.ts";
export const REQUEST_SIZE_LIMIT = "50mb";
import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MESSAGES } from "../utils/claude-messages.ts";
import type { Queue } from "bullmq";
import { createIdGenerator, type UIMessage } from "ai";
import type { Project } from "@EXULU_TYPES/models/project";
import cookieParser from "cookie-parser";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition.ts";
import type { ExuluTool } from "./tool.ts";
import { getChunksTableName, getTableName, type ExuluContext } from "./context.ts";
import type { ExuluEval } from "./evals.ts";
import type { ExuluReranker } from "./reranker.ts";
import type { STATISTICS_LABELS } from "@EXULU_TYPES/statistics.ts";
import { updateStatistic } from "./statistics.ts";
import { ExuluProvider, saveChat } from "./provider.ts";
import { generateSuggestions } from "./suggestions.ts";
import { resolveModel, ResolveModelError } from "./resolve-model.ts";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor.ts";
import { transcribeAudio, TranscriptionError } from "./transcribe.ts";
import { synthesizeSpeech, SpeechError } from "./speech.ts";
import multer from "multer";
import { clearSessionCurrentTask } from "./task-description.ts";
import { checkProviderRateLimit } from "@SRC/utils/check-provider-rate-limit.ts";
import { checkApiKeyScope } from "@SRC/utils/check-api-key-scope.ts";
import {
  preCheckAgentRateLimit,
  recordAgentTokenUsage,
  resolveCallerId,
} from "@SRC/utils/check-agent-rate-limit.ts";
import { registerOpenAIGatewayRoutes } from "./openai-gateway.ts";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import { exuluApp } from "./app/singleton.ts";
import { checkLicense } from "@EE/entitlements.ts";
import { convertJsonSchemaToZod } from 'zod-from-json-schema';
import { getEnabledSkills } from "@SRC/utils/enabled-skills.ts";
import type { ExuluSkill } from "@EXULU_TYPES/skill.ts";

const getExuluVersionNumber = async () => {
  try {
    // Load the root package.json file of the project from the process folder
    const path = process.cwd();
    const packageJson = fs.readFileSync(path + "/package.json", "utf8");
    const packageData = JSON.parse(packageJson);
    const exuluVersion = packageData.dependencies["@exulu/backend"];
    console.log(`[EXULU] Installed exulu-backend version: ${exuluVersion}`);
    return exuluVersion;
  } catch (error: any) {
    console.error("Could not find or import package.json:", error.message);
  }
};

export const global_queues = {
  eval_runs: "eval_runs",
};

const {
  agentsSchema,
  feedbackSchema,
  projectsSchema,
  jobResultsSchema,
  testCasesSchema,
  evalSetsSchema,
  evalRunsSchema,
  platformConfigurationsSchema,
  agentSessionsSchema,
  agentMessagesSchema,
  modelsSchema,
  rolesSchema,
  usersSchema,
  skillsSchema,
  variablesSchema,
  workflowTemplatesSchema,
  rbacSchema,
  promptLibrarySchema,
  contextPresetsSchema,
  embedderSettingsSchema,
  promptFavoritesSchema,
  statisticsSchema,
} = coreSchemas.get();

export const createExpressRoutes = async (
  app: Express,
  providers: ExuluProvider[],
  tools: ExuluTool[],
  contexts: ExuluContext[] | undefined,
  config: ExuluConfig,
  evals: ExuluEval[],
  tracer?: Tracer,
  queues?: {
    queue: Queue;
    ratelimit: number;
    timeoutInSeconds?: number;
    concurrency: {
      worker: number;
      queue: number;
    };
  }[],
  rerankers?: ExuluReranker[],
): Promise<Express> => {
  // todo make this more secure / configurable
  let corsOptions = {
    origin: "*",
    exposedHeaders: "*",
    allowedHeaders: "*",
    optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
  };

  if (tracer) {
    console.log("[EXULU] tracer configured", tracer);
  }

  // important to set the limit here, otherwise the proxy will
  // fail for large requests such as those from Claude Code
  app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));
  app.use(cors(corsOptions));
  app.use(bodyParser.urlencoded({ extended: true, limit: REQUEST_SIZE_LIMIT }));
  app.use(bodyParser.json({ limit: REQUEST_SIZE_LIMIT }));
  app.use(cookieParser());

  // Add exulu-version header to all responses for debugging
  app.use(async (req: Request, res: Response, next: () => void) => {
    const version = await getExuluVersionNumber();
    if (version) {
      res.setHeader("exulu-version", version);
    }
    next();
  });

  console.log(`
    ███████╗██╗  ██╗██╗   ██╗██╗      ██╗   ██╗
    ██╔════╝╚██╗██╔╝██║   ██║██║      ██║   ██║
    █████╗   ╚███╔╝ ██║   ██║██║      ██║   ██║
    ██╔══╝   ██╔██╗ ██║   ██║██║      ██║   ██║
    ███████╗██╔╝ ██╗╚██████╔╝███████╗╚██████╔╝
    ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝ 
    Intelligence Management Platform - Server

    `);

  const schema = createSDL(
    [
      usersSchema(),
      skillsSchema(),
      rolesSchema(),
      agentsSchema(),
      feedbackSchema(),
      projectsSchema(),
      jobResultsSchema(),
      promptLibrarySchema(),
      contextPresetsSchema(),
      embedderSettingsSchema(),
      promptFavoritesSchema(),
      evalRunsSchema(),
      platformConfigurationsSchema(),
      evalSetsSchema(),
      testCasesSchema(),
      agentSessionsSchema(),
      agentMessagesSchema(),
      modelsSchema(),
      variablesSchema(),
      workflowTemplatesSchema(),
      statisticsSchema(),
      rbacSchema(),
    ],
    contexts ?? [],
    providers,
    tools,
    config,
    evals,
    rerankers || [],
  );

  interface GraphqlContext {
    db: Knex;
    req: Request;
  }

  const server = new ApolloServer<GraphqlContext>({
    cache: new InMemoryLRUCache(),
    schema,
    introspection: true,
  });

  // Note you must call `start()` on the `ApolloServer`
  // instance before passing the instance to `expressMiddleware`

  await server.start();

  app.use(
    "/graphql",
    cors(corsOptions),
    express.json({ limit: REQUEST_SIZE_LIMIT }),
    expressMiddleware(server, {
      context: async ({ req }) => {
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
          console.error("[EXULU] Authentication failed", authenticationResult);
          throw new Error(authenticationResult.message);
        }
        const { db } = await postgresClient();
        console.log("[EXULU] Graphql call");
        return {
          req,
          db,
          user: authenticationResult.user,
        };
      },
    }),
  );

  app.post("/test", async (req: Request, res: Response) => {
    const { item_name, context_id } = req.body;
    let itemFilters: any = [];
    if (item_name) {
      itemFilters.push({ name: { contains: item_name } });
    }

    const { db } = await postgresClient();

    let itemsQuery = db(getTableName(context_id) + " as items").select([
      "items.id as item_id",
      "items.name as item_name",
      "items.external_id as item_external_id",
      db.raw('items."updatedAt" as item_updated_at'),
      db.raw('items."createdAt" as item_created_at'),
    ]);

    const limit = 10;
    itemsQuery = itemsQuery.limit(limit);

    const ctx = contexts?.find((ctx) => ctx.id === context_id);

    if (!ctx) {
      res.status(400).json({
        message: "Context not found.",
      });
      return;
    }

    const tableDefinition = convertContextToTableDefinition(ctx);
    itemsQuery = applyFilters(itemsQuery, itemFilters || [], tableDefinition, "items");
    itemsQuery = applyAccessControl(
      tableDefinition,
      itemsQuery,
      {
        email: "test@test.com",
        id: 1,
        role: {
          id: "test",
          name: "test",
          agents: "read",
          evals: "read",
          workflows: "read",
          variables: "read",
          users: "read",
        },
        super_admin: true,
      },
      "items",
    );

    const items = await itemsQuery;

    const formattedResults: any[] = await Promise.all(
      items.map(async (item) => {
        const chunksTable = getChunksTableName(ctx?.id || "");
        console.log("[EXULU] chunksTable", chunksTable);
        if (!item.item_id) {
          console.error("[EXULU] Item id is required to get chunks.", item);
          throw new Error("Item id is required to get chunks.");
        }
        const chunks: any[] = await db
          .from(chunksTable)
          .select(["id", "source", "metadata"])
          .where("source", item.item_id)
          .limit(1);

        if (!chunks || !chunks[0]) {
          console.error("[EXULU] No chunks found for item.", item);
          return null;
        }

        console.log("[EXULU] chunks found for item.", chunks);
        return {
          item_name: item.name,
          item_id: item.id,
          context: ctx?.id || "",
          chunk_id: chunks[0].id,
          chunk_index: 1,
          chunk_content: undefined,
          metadata: chunks[0].metadata,
        };
      }),
    );

    res.json({
      items: formattedResults.filter((result) => result !== null),
    });
  });

  app.post("/generate/agent/image", async (req: Request, res: Response) => {
    console.log("[EXULU] generate/agent/image", req.body);
    const authenticationResult = await requestValidators.authenticate(req);
    if (!authenticationResult.user?.id) {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }

    const { name, description, style } = req.body;
    if (!name || !description) {
      res.status(400).json({
        message: "Missing name or description in request.",
      });
      return;
    }

    const { db } = await postgresClient();

    // Look up the variable from the variables table
    const variable = await db
      .from("variables")
      .where({ name: "OPENAI_IMAGE_GENERATION_API_KEY" })
      .first();
    if (!variable) {
      res.status(400).json({
        message: "Provider API key variable not found for OpenAI image generation.",
      });
      return;
    }

    // Get the API key from the variable (decrypt if encrypted)
    let providerapikey = variable.value;

    if (!variable.encrypted) {
      res.status(400).json({
        message:
          "Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys.",
      });
      return;
    }

    if (variable.encrypted) {
      const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
      providerapikey = bytes.toString(CryptoJS.enc.Utf8);
    }

    const openai = new OpenAI({
      apiKey: providerapikey,
    });

    let style_reference = "";
    if (style === "origami") {
      style_reference = "minimalistic origami-style, futuristic robot, portrait, focus on face.";
    } else if (style === "anime") {
      style_reference =
        "minimalistic, make it in the style of a felt puppet, futuristic robot, portrait, focus on face.";
    } else if (style === "japanese_anime") {
      style_reference =
        "minimalistic, make it in the style of japanese anime, futuristic robot, portrait, focus on face.";
    } else if (style === "vaporwave") {
      style_reference =
        "minimalistic, make it in the style of a vaporwave album cover, futuristic robot, portrait, focus on face.";
    } else if (style === "lego") {
      style_reference =
        "minimalistic, make it in the style of LEGO minifigures, futuristic robot, portrait, focus on face.";
    } else if (style === "paper_cut") {
      style_reference =
        "minimalistic, make it in the style of Paper-cut style portrait with color layers, futuristic robot, portrait, focus on face.";
    } else if (style === "felt_puppet") {
      style_reference =
        "minimalistic, make it in the style of a felt puppet, futuristic robot, portrait, focus on face.";
    } else if (style === "app_icon") {
      style_reference =
        "A playful and modern app icon design of a robot, minimal flat vector style, glossy highlights, soft shadows, centered composition, high contrast, vibrant colors, rounded corners, on a transparent background, icon-friendly, no text, no details outside the frame, size is 1024x1024.";
    } else if (style === "pixel_art") {
      style_reference =
        "A pixel art style of a robot, minimal flat vector style, glossy highlights, soft shadows, centered composition, high contrast, vibrant colors, rounded corners, on a transparent background, icon-friendly, no text, no details outside the frame, size is 1024x1024.";
    } else if (style === "isometric") {
      style_reference =
        "3D isometric icon of a robot, centered composition, on a transparent background, no text, no details outside the frame, size is 1024x1024.";
    } else {
      style_reference =
        "A minimalist 3D, robot, portrait, focus on face, floating in space, low-poly design with pastel colors.";
    }

    const prompt = `
        A digital portrait of ${name}, visualized as a futuristic robot.  
The robot’s design reflects '${description}', with props, tools, or symbolic objects that represent its expertise or area of work.  
Example: if the agent is a financial analyst, it may hold a stack of papers; if it’s a creative strategist it may be painting on a canvas.  
Style: ${style_reference}.  
The portrait should have a clean background.  
Framing: bust portrait, centered.  
Mood: friendly and intelligent.  
            `;

    const result = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
    });

    // Save the image to a file
    const image_base64 = result.data?.[0]?.b64_json;

    if (!image_base64) {
      res.status(500).json({
        message: "Failed to generate image.",
      });
      return;
    }

    const uuid = randomUUID();
    const image_url = await uploadFile(Buffer.from(image_base64, "base64"), `${uuid}.png`, config, {
      contentType: "image/png",
    }, authenticationResult.user?.id, undefined, true);

    res.status(200).json({
      message: "Image generated successfully.",
      image: image_url,
    });
  });

  // Ping route that can be used to check if the request
  // is authenticated and the server is running.
  app.get("/ping", async (req: Request, res: Response) => {
    const authenticationResult = await requestValidators.authenticate(req);
    if (!authenticationResult.user?.id) {
      res.status(200).json({
        authenticated: false,
      });
      return;
    }
    res.status(200).json({
      authenticated: true,
    });
  });

  app.get("/theme", async (req: Request, res: Response) => {
    const license = checkLicense();
    if (!license["custom-branding"]) {
      console.warn("[EXULU] You are not licensed to use custom branding so cannot fetch theme config.");
      res.status(200).json({
        theme: {
          light: {},
          dark: {},
        },
      });
      return;
    }
    const { db } = await postgresClient();
    const themeConfig = await db
      .from("platform_configurations")
      .where({ config_key: "theme_config" })
      .first();
    if (!themeConfig) {
      res.status(200).json({
        theme: {
          light: {},
          dark: {},
        },
      });
      return;
    }
    res.status(200).json({
      theme: themeConfig.config_value,
    });
  });

  // Route exposes some parts of the ExuluApp instance config options
  // via API so the frontend can show UI messages based on what is
  // enabled, for example if workers are disabled, a message is shown
  // on the evals page that they need to be configured before running evals.
  app.get("/config", async (req: Request, res: Response) => {
    res.status(200).json({
      authMode: process.env.AUTH_MODE as "password" | "otp",
      entitlements: checkLicense(),
      MCP: {
        enabled: config?.MCP.enabled,
      },
      telemetry: {
        enabled: config?.telemetry?.enabled,
      },
      fileUploads: {
        s3endpoint: config?.fileUploads?.s3endpoint,
      },
      workers: {
        telemetry: {
          enabled: config?.workers?.telemetry?.enabled,
        },
        redisHost: process.env.REDIS_HOST,
        enabled: config?.workers?.enabled,
      },
      liteLLM: {
        enabled: process.env.EXULU_USE_LITELLM === "true",
      },
    });
  });

  // Register the agent-run handler for a (provider, slug) pair. In Spec A
  // catalog mode this is called once per ExuluProvider in providers.forEach
  // below. In LiteLLM mode it is also called once with a fixed slug and any
  // provider as the orchestrator (the in-code provider here is only used as
  // a method-holder for generateStream/generateSync; the actual languageModel
  // comes from resolveModel's LiteLLM branch).
  const registerAgentRunRoute = (slug: string, provider: ExuluProvider) => {
    app.post(slug + "/:instance", async (req: Request, res: Response) => {
      console.log("[EXULU] POST " + slug + "/:instance", req.body);

      const headers: {
        stream: boolean;
        user: string | null;
        session: string | null;
      } = {
        stream: (req.headers["stream"] as string) === "true" || false,
        user: (req.headers["user"] as string) || null,
        session: (req.headers["session"] as string) || null,
      };

      await checkProviderRateLimit(provider);

      const instance = req.params.instance;
      if (!instance) {
        res.status(400).json({
          message: "Missing instance in request.",
        });
        return;
      }

      const { db } = await postgresClient();

      // For agents we dont use bullmq jobs, instead we use a rate limiter to
      // allow responses in real time while managing availability of infrastructure
      // or provider limits.
      // todo add "configuration" object to provider, and allow setting agent instance
      // specific configurations that overwrite the global ones.
      // todo allow setting agent instance specific configurations that overwrite the global ones
      // todo display rate limit message in the chat UI

      const agent = await exuluApp.get().agent(instance);

      if (!agent) {
        res.status(404).json({
          message: "Agent with id " + instance + " not found.",
        });
        return;
      }

      const requestValidationResult = requestValidators.agents(req);

      if (requestValidationResult.error) {
        res
          .status(requestValidationResult.code || 500)
          .json({ detail: `${requestValidationResult.message}` });
        return;
      }

      console.log("[EXULU] agent.rights_mode", agent.rights_mode);
      const authenticationResult = await requestValidators.authenticate(req);
      if (!authenticationResult.user?.id && agent.rights_mode !== "public") {
        res
          .status(authenticationResult.code || 500)
          .json({ detail: `${authenticationResult.message}` });
        return;
      }

      const user = authenticationResult.user;

      // API key scope check — early reject for agents-scoped keys with a clear message.
      const scopeCheck = checkApiKeyScope(user, instance);
      if (!scopeCheck.allowed) {
        res.status(scopeCheck.code).json({ detail: scopeCheck.reason });
        return;
      }

      const hasAccessToAgent = await checkRecordAccess(agent, "read", user);

      if (!hasAccessToAgent) {
        res.status(401).json({
          message: "You don't have access to this agent.",
        });
        return;
      }

      // Rate limit pre-check (per agent, per caller).
      // Enterprise feature — when the license is not active, agent.rate_limits is
      // ignored entirely (no pre-check, no post-record).
      const callerId = resolveCallerId(req, user?.id);
      const rateLimitsEnabled = checkLicense()["rate-limits"] === true;
      const effectiveLimits = rateLimitsEnabled
        ? ((agent as any).rate_limits ?? null)
        : null;
      const preCheck = await preCheckAgentRateLimit({
        agentId: instance,
        callerId,
        limits: effectiveLimits,
      });
      if (!preCheck.ok) {
        res.setHeader("Retry-After", String(preCheck.retryAfter));
        res.status(429).json({
          detail: `Rate limit exceeded for ${preCheck.metric} on agent ${agent.name}.`,
          metric: preCheck.metric,
          retryAfter: preCheck.retryAfter,
        });
        return;
      }

      if (headers.session) {
        // Check session RBAC
        const session = await db
          .from("agent_sessions")
          .where({
            id: headers.session,
          })
          .first();
        let hasAccessToSession = await checkRecordAccess(session, "write", user);
        if (!hasAccessToSession) {
          res.status(401).json({
            message: "You don't have access to this session.",
          });
          return;
        }
      }

      console.log(
        "[EXULU] agent tools",
        agent.tools?.map((x) => x.name + " (" + x.id + ")"),
      );

      const disabledTools = req.body.disabledTools ? req.body.disabledTools : [];
      const disabledSkills = req.body.disabledSkills ? req.body.disabledSkills : [];

      let enabledSkills: ExuluSkill[] = await getEnabledSkills(
        agent,
        disabledSkills,
      );

      let enabledTools: ExuluTool[] = await getEnabledTools(
        agent,
        tools,
        contexts || [],
        rerankers || [],
        disabledTools,
        providers,
        user,
      );

      const overrideModelId = req.headers["x-exulu-model-override"] as string | undefined;
      const modelId = overrideModelId ?? agent.model;
      if (!modelId) {
        res.status(400).json({
          message: `Agent ${agent.name} (${agent.id}) has no model configured.`,
        });
        return;
      }

      let resolved: Awaited<ReturnType<typeof resolveModel>>;
      try {
        resolved = await resolveModel({
          modelId,
          user,
          providers,
          agent: { id: agent.id },
        });
      } catch (err) {
        if (err instanceof ResolveModelError) {
          const status = err.code === "MODEL_FORBIDDEN" ? 403 : 400;
          res.status(status).json({ message: err.message, code: err.code });
          return;
        }
        throw err;
      }
      const providerapikey = resolved.apiKey;
      const resolvedLanguageModel = resolved.languageModel;
      const resolvedModelId = resolved.model.id;
      // todo add authentication based on thread id to guarantee privacy
      // todo validate req.body data structure
      if (!!headers.stream) {
        const statistics = {
          label: agent.name,
          trigger: "agent" as STATISTICS_LABELS,
        };

        let previousMessages: UIMessage[] = [];
        let message: UIMessage | undefined;
        if (!req.body.message && !headers.session && req.body.messages) {
          message = req.body.messages[req.body.messages.length - 1];
          previousMessages = req.body.messages.slice(0, -1);
        } else {
          message = req.body.message;
        }

        const approvedTools = req.body.approvedTools
          ? typeof req.body.approvedTools === "string"
            ? JSON.parse(req.body.approvedTools)
            : req.body.approvedTools
          : [];

        // Support custom instructions from the request body
        const customInstructions = req.body.customInstructions
          ? typeof req.body.customInstructions === "string"
            ? req.body.customInstructions
            : JSON.stringify(req.body.customInstructions)
          : "";

        const instructions = customInstructions
          ? `${agent.instructions}\n\n${customInstructions}`
          : agent.instructions;

        const result = await provider.generateStream({
          contexts: contexts,
          rerankers: rerankers || [],
          agent: agent,
          user,
          instructions: instructions,
          session: headers.session as string,
          message,
          previousMessages,
          currentTools: enabledTools,
          currentSkills: enabledSkills,
          approvedTools: approvedTools,
          allExuluTools: tools,
          languageModel: resolvedLanguageModel,
          providerapikey,
          toolConfigs: agent.tools,
          exuluConfig: config,
          req: req,
        });

        // consume the stream to ensure it runs to completion & triggers onFinish
        // even when the client response is aborted:
        result.stream.consumeStream(); // no await

        result.stream.pipeUIMessageStreamToResponse(res, {
          messageMetadata: ({ part }) => {
            if (part.type === "finish") {
              return {
                totalTokens: part.totalUsage.totalTokens,
                reasoningTokens: part.totalUsage.reasoningTokens,
                inputTokens: part.totalUsage.inputTokens,
                outputTokens: part.totalUsage.outputTokens,
                cachedInputTokens: part.totalUsage.cachedInputTokens,
              };
            }
            return undefined;
          },
          originalMessages: result.originalMessages,
          sendReasoning: true,
          sendSources: true,
          onError: (error) => {
            console.error("[EXULU] chat response error.", error);
            if (error == null) {
              return "unknown error";
            }
            if (typeof error === "string") {
              return error;
            }
            if (error instanceof Error) {
              return error.message;
            }
            return JSON.stringify(error);
          },
          generateMessageId: createIdGenerator({
            prefix: "msg_",
            size: 16,
          }),
          onFinish: async ({ messages, isContinuation, isAborted, responseMessage }) => {
            console.log(
              "[EXULU] onFinish",
              messages
                ?.map((msg) => msg.parts?.map((part) => (part.type === "text" ? part.text : null)))
                .join("\n"),
            );
            if (headers.session && user?.id) {
              await saveChat({
                session: headers.session as string,
                user: user.id,
                messages: messages,
                model: resolvedModelId,
              });
              clearSessionCurrentTask(headers.session as string).catch(() => { });
            }
            const metadata = messages[messages.length - 1]?.metadata as any;
            console.log("[EXULU] Finished streaming", metadata);
            console.log("[EXULU] Statistics", {
              label: agent.name,
              trigger: "agent",
            });
            if (statistics) {
              await Promise.all([
                updateStatistic({
                  name: "count",
                  label: statistics.label,
                  type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                  trigger: statistics.trigger,
                  count: 1,
                  user: user?.id,
                  role: user?.role?.id,
                }),
                ...(metadata?.inputTokens
                  ? [
                    updateStatistic({
                      name: "inputTokens",
                      label: statistics.label,
                      type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                      trigger: statistics.trigger,
                      count: metadata?.inputTokens,
                      user: user?.id,
                      role: user?.role?.id,
                    }),
                  ]
                  : []),
                ...(metadata?.outputTokens
                  ? [
                    updateStatistic({
                      name: "outputTokens",
                      label: statistics.label,
                      type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                      trigger: statistics.trigger,
                      count: metadata?.outputTokens,
                    }),
                  ]
                  : []),
              ]);
            }
            await recordAgentTokenUsage({
              agentId: instance,
              callerId,
              limits: effectiveLimits,
              inputTokens: metadata?.inputTokens,
              outputTokens: metadata?.outputTokens,
            });
          },
        });
        // Returns a response that can be used by the "useChat" hook
        // on the client side from the vercel "ai" SDK.

        return;
      } else {
        // Support custom instructions from the request body
        const customInstructions = req.body.customInstructions
          ? typeof req.body.customInstructions === "string"
            ? req.body.customInstructions
            : JSON.stringify(req.body.customInstructions)
          : "";

        const instructions = customInstructions
          ? `${agent.instructions}\n\n${customInstructions}`
          : agent.instructions;

        const response = await provider.generateSync({
          contexts: contexts,
          rerankers: rerankers || [],
          agent: agent,
          user,
          req: req,
          instructions: instructions,
          session: headers.session as string,
          inputMessages: [req.body.message],
          currentTools: enabledTools,
          currentSkills: enabledSkills,
          allExuluTools: tools,
          languageModel: resolvedLanguageModel,
          providerapikey,
          exuluConfig: config,
          toolConfigs: agent.tools,
          statistics: {
            label: agent.name,
            trigger: "agent",
          },
          onTokenUsage: async ({ inputTokens, outputTokens }) => {
            await recordAgentTokenUsage({
              agentId: instance,
              callerId,
              limits: effectiveLimits,
              inputTokens,
              outputTokens,
            });
          },
        });
        res.status(200).json(response);
        return;
      }
    });
  };

  // Spec A: one handler per code-defined ExuluProvider, mounted at its slug.
  providers.forEach((provider) => {
    const slug = provider.slug as string;
    if (!slug) return;
    registerAgentRunRoute(slug, provider);
  });

  // LiteLLM mode: a single handler at a fixed path. agent.slug is hydrated to
  // "/agents/litellm/run" in graphql/utilities/sanitize-and-hydrate-fields.ts
  // when isLiteLLMEnabled() is true, so the frontend constructs the same URL.
  if (isLiteLLMEnabled() && providers.length > 0) {
    registerAgentRunRoute("/agents/litellm/run", providers[0]!);
  }

  // Follow-up message suggestions. Stateless: no session is loaded or written.
  // The frontend posts the last user+assistant exchange and gets back up to 3
  // short follow-up prompts the user might want to send next. Toggle lives on
  // the agent (`suggestions_enabled`) and is enforced client-side; this route
  // also rejects when the agent does not have it enabled.
  app.post("/agents/suggestions/:agentId", async (req: Request, res: Response) => {
    const agentId = req.params.agentId;
    if (!agentId) {
      res.status(400).json({ detail: "Missing agentId" });
      return;
    }

    const agent = await exuluApp.get().agent(agentId);
    if (!agent) {
      res.status(404).json({ detail: `Agent ${agentId} not found.` });
      return;
    }

    if (!agent.suggestions_enabled) {
      res.status(400).json({ detail: "Suggestions are not enabled for this agent." });
      return;
    }

    const authenticationResult = await requestValidators.authenticate(req);
    if (!authenticationResult.user?.id && agent.rights_mode !== "public") {
      res
        .status(authenticationResult.code || 500)
        .json({ detail: `${authenticationResult.message}` });
      return;
    }
    const user = authenticationResult.user;

    const scopeCheck = checkApiKeyScope(user, agentId);
    if (!scopeCheck.allowed) {
      res.status(scopeCheck.code).json({ detail: scopeCheck.reason });
      return;
    }

    const hasAccessToAgent = await checkRecordAccess(agent, "read", user);
    if (!hasAccessToAgent) {
      res.status(401).json({ detail: "You don't have access to this agent." });
      return;
    }

    const callerId = resolveCallerId(req, user?.id);
    const rateLimitsEnabled = checkLicense()["rate-limits"] === true;
    const effectiveLimits = rateLimitsEnabled
      ? ((agent as any).rate_limits ?? null)
      : null;
    const preCheck = await preCheckAgentRateLimit({
      agentId,
      callerId,
      limits: effectiveLimits,
    });
    if (!preCheck.ok) {
      res.setHeader("Retry-After", String(preCheck.retryAfter));
      res.status(429).json({
        detail: `Rate limit exceeded for ${preCheck.metric} on agent ${agent.name}.`,
        metric: preCheck.metric,
        retryAfter: preCheck.retryAfter,
      });
      return;
    }

    const messages: UIMessage[] = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (messages.length === 0) {
      res.status(400).json({ detail: "Missing messages in request body." });
      return;
    }

    if (!agent.model) {
      res.status(400).json({
        detail: `Agent ${agent.name} (${agent.id}) has no model configured.`,
      });
      return;
    }

    let resolved: Awaited<ReturnType<typeof resolveModel>>;
    try {
      resolved = await resolveModel({
        modelId: agent.model,
        user,
        providers,
        agent: { id: agent.id },
      });
    } catch (err) {
      if (err instanceof ResolveModelError) {
        const status = err.code === "MODEL_FORBIDDEN" ? 403 : 400;
        res.status(status).json({ detail: err.message, code: err.code });
        return;
      }
      throw err;
    }

    try {
      const { suggestions, usage } = await generateSuggestions({
        languageModel: resolved.languageModel,
        messages,
        agentInstructions: agent.instructions,
      });

      await Promise.all([
        updateStatistic({
          name: "count",
          label: agent.name,
          type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
          trigger: "agent",
          count: 1,
          user: user?.id,
          role: user?.role?.id,
        }),
        ...(usage.inputTokens
          ? [
            updateStatistic({
              name: "inputTokens",
              label: agent.name,
              type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
              trigger: "agent",
              count: usage.inputTokens,
              user: user?.id,
              role: user?.role?.id,
            }),
          ]
          : []),
        ...(usage.outputTokens
          ? [
            updateStatistic({
              name: "outputTokens",
              label: agent.name,
              type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
              trigger: "agent",
              count: usage.outputTokens,
            }),
          ]
          : []),
        recordAgentTokenUsage({
          agentId,
          callerId,
          limits: effectiveLimits,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        }),
      ]);

      res.status(200).json({ suggestions });
    } catch (err) {
      console.error("[EXULU] suggestions generation failed", err);
      res.status(500).json({
        detail: err instanceof Error ? err.message : "Failed to generate suggestions.",
      });
    }
  });

  // Speech-to-text transcription. Forwards a multipart audio upload to the
  // LiteLLM proxy's /v1/audio/transcriptions endpoint with the model name from
  // TRANSCRIPTION_MODEL. Gated on both EXULU_USE_LITELLM=true and
  // TRANSCRIPTION_MODEL being set; either missing → 503.
  //
  // Design doc: docs/superpowers/specs/2026-05-24-speech-to-text-transcription-design.md
  const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
  const transcribeUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_TRANSCRIBE_BYTES },
  });

  app.post(
    "/transcribe",
    (req: Request, res: Response, next) => {
      transcribeUpload.single("file")(req, res, (err: unknown) => {
        if (!err) return next();
        const code = (err as { code?: string })?.code;
        if (code === "LIMIT_FILE_SIZE") {
          res
            .status(413)
            .json({ detail: "Recording too large. Please record a shorter clip." });
          return;
        }
        res
          .status(400)
          .json({ detail: err instanceof Error ? err.message : "Upload failed." });
      });
    },
    async (req: Request, res: Response) => {
      if (!isLiteLLMEnabled() || !process.env.TRANSCRIPTION_MODEL) {
        res.status(503).json({
          detail:
            "Speech-to-text is not enabled on this deployment. " +
            "Set EXULU_USE_LITELLM=true and TRANSCRIPTION_MODEL in the environment.",
        });
        return;
      }

      const authenticationResult = await requestValidators.authenticate(req);
      if (!authenticationResult.user?.id) {
        res
          .status(authenticationResult.code || 401)
          .json({ detail: authenticationResult.message });
        return;
      }

      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ detail: "No audio file provided in 'file' field." });
        return;
      }
      if (!file.mimetype.startsWith("audio/")) {
        res.status(400).json({
          detail: `Unsupported mimetype: ${file.mimetype}. Expected audio/*.`,
        });
        return;
      }

      try {
        await Promise.race([
          waitForLiteLLMReady(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("LiteLLM not ready")), 5_000),
          ),
        ]);
      } catch {
        res
          .status(503)
          .json({ detail: "Transcription service is not ready. Try again shortly." });
        return;
      }

      // Optional language hint (ISO-639-1, e.g. "de"). Without it Whisper
      // auto-detects, which sometimes flips short clips to English.
      const language =
        typeof req.body?.language === "string" && /^[a-z]{2}$/.test(req.body.language)
          ? req.body.language
          : undefined;

      try {
        const { text } = await transcribeAudio({ file, language });
        res.status(200).json({ text });
      } catch (err) {
        if (err instanceof TranscriptionError) {
          const code = err.upstreamStatus >= 500 ? 502 : err.upstreamStatus;
          res.status(code).json({ detail: err.message });
          return;
        }
        console.error("[EXULU] /transcribe failed", err);
        res.status(500).json({
          detail: err instanceof Error ? err.message : "Transcription failed.",
        });
      }
    },
  );

  // Text-to-speech. Forwards a JSON { text } payload to the LiteLLM proxy's
  // /v1/audio/speech endpoint with the model from TTS_MODEL and the optional
  // voice from TTS_VOICE, and streams the resulting MP3 bytes back as
  // audio/mpeg. Gated on both EXULU_USE_LITELLM=true and TTS_MODEL being set.
  //
  // Design doc: docs/superpowers/specs/2026-05-25-text-to-speech-design.md
  const MAX_TTS_INPUT_CHARS = 4000;

  app.post(
    "/speech",
    bodyParser.json({ limit: "64kb" }),
    async (req: Request, res: Response) => {
      if (!isLiteLLMEnabled() || !process.env.TTS_MODEL || !process.env.TTS_VOICE) {
        res.status(503).json({
          detail:
            "Text-to-speech is not enabled on this deployment. " +
            "Set EXULU_USE_LITELLM=true, TTS_MODEL, and TTS_VOICE in the environment.",
        });
        return;
      }

      const authenticationResult = await requestValidators.authenticate(req);
      if (!authenticationResult.user?.id) {
        res
          .status(authenticationResult.code || 401)
          .json({ detail: authenticationResult.message });
        return;
      }

      const text =
        typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) {
        res.status(400).json({ detail: "Missing 'text' in request body." });
        return;
      }
      if (text.length > MAX_TTS_INPUT_CHARS) {
        res.status(400).json({
          detail: `Text too long (${text.length} chars). Max ${MAX_TTS_INPUT_CHARS}.`,
        });
        return;
      }

      try {
        await Promise.race([
          waitForLiteLLMReady(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("LiteLLM not ready")), 5_000),
          ),
        ]);
      } catch {
        res
          .status(503)
          .json({ detail: "Speech service is not ready. Try again shortly." });
        return;
      }

      try {
        const audio = await synthesizeSpeech({ text });
        res.status(200);
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Length", String(audio.length));
        res.setHeader("Cache-Control", "no-store");
        res.send(audio);
      } catch (err) {
        if (err instanceof SpeechError) {
          const code = err.upstreamStatus >= 500 ? 502 : err.upstreamStatus;
          res.status(code).json({ detail: err.message });
          return;
        }
        console.error("[EXULU] /speech failed", err);
        res.status(500).json({
          detail: err instanceof Error ? err.message : "Speech generation failed.",
        });
      }
    },
  );

  if (
    config?.fileUploads &&
    config?.fileUploads?.s3region &&
    config?.fileUploads?.s3key &&
    config?.fileUploads?.s3secret &&
    config?.fileUploads?.s3Bucket
  ) {
    await createUppyRoutes(app, config);
  } else {
    console.log(
      "[EXULU] skipping uppy file upload routes, because no S3 compatible region, key or secret is set in ExuluApp instance.",
    );
  }

  app.get("/config", async (req: Request, res: Response) => {
    res.status(200).json({
      message: "Config fetched successfully.",
      config: {
        workers: {
          enabled: config?.workers?.enabled || false,
        },
      },
    });
  });

  // This route basically passes the request 1:1 to the Anthropic API, but we can
  // inject tools into the request body, publish data to audit logs and implement
  // custom authentication logic from the IMP UI.
  app.use(
    "/gateway/anthropic/:agent/:project",
    express.raw({ type: "*/*", limit: REQUEST_SIZE_LIMIT }),
    async (req, res) => {
      try {
        if (!req.body.tools) {
          req.body.tools = [];
        }

        const { db } = await postgresClient();

        // Authenticate the user, and exchange the user token for an anthropic token.
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
          console.log("[EXULU] failed authentication result", authenticationResult);
          res
            .status(authenticationResult.code || 500)
            .json({ detail: `${authenticationResult.message}` });
          return;
        }

        const user = authenticationResult.user;

        let agentQuery = db("agents");
        agentQuery.select("*");
        agentQuery = applyAccessControl(agentsSchema(), agentQuery, authenticationResult.user);
        agentQuery.where({ id: req.params.agent });
        const agent: ExuluAgent | undefined = await agentQuery.first();

        if (!agent) {
          const arrayBuffer = createCustomAnthropicStreamingMessage(`
\x1b[41m -- Agent ${req.params.agent} not found or you do not have access to it. --
\x1b[0m`);
          res.setHeader("Content-Type", "application/json");
          res.end(Buffer.from(arrayBuffer));
          return;
        }

        let project: Project | null = null;

        if (!req.params.project || req.params.project === "DEFAULT") {
          project = null;
        } else {
          let projectQuery = db("projects");
          projectQuery.select("*");
          projectQuery = applyAccessControl(
            projectsSchema(),
            projectQuery,
            authenticationResult.user,
          );
          projectQuery.where({ id: req.params.project });
          project = await projectQuery.first();

          if (!project) {
            const arrayBuffer = createCustomAnthropicStreamingMessage(
              CLAUDE_MESSAGES.missing_project,
            );
            res.setHeader("Content-Type", "application/json");
            res.end(Buffer.from(arrayBuffer));
            return;
          }
        }

        console.log("[EXULU] anthropic proxy called for agent:", agent?.name);

        if (!process.env.NEXTAUTH_SECRET) {
          const arrayBuffer = createCustomAnthropicStreamingMessage(
            CLAUDE_MESSAGES.missing_nextauth_secret,
          );
          res.setHeader("Content-Type", "application/json");
          res.end(Buffer.from(arrayBuffer));
          return;
        }

        if (!agent.model) {
          const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.not_enabled);
          res.setHeader("Content-Type", "application/json");
          res.end(Buffer.from(arrayBuffer));
          return;
        }

        let anthropicApiKey: string | undefined;
        try {
          const resolved = await resolveModel({
            modelId: agent.model,
            user,
            providers,
            agent: { id: agent.id },
            project: project ? { id: project.id } : undefined,
          });
          anthropicApiKey = resolved.apiKey;
        } catch (err) {
          if (err instanceof ResolveModelError) {
            const msg =
              err.code === "AUTH_VAR_NOT_FOUND"
                ? CLAUDE_MESSAGES.anthropic_token_variable_not_found
                : err.code === "AUTH_VAR_NOT_ENCRYPTED"
                  ? CLAUDE_MESSAGES.anthropic_token_variable_not_encrypted
                  : CLAUDE_MESSAGES.not_enabled;
            const arrayBuffer = createCustomAnthropicStreamingMessage(msg);
            res.setHeader("Content-Type", "application/json");
            res.end(Buffer.from(arrayBuffer));
            return;
          }
          throw err;
        }

        if (!anthropicApiKey) {
          const arrayBuffer = createCustomAnthropicStreamingMessage(
            CLAUDE_MESSAGES.anthropic_token_variable_not_found,
          );
          res.setHeader("Content-Type", "application/json");
          res.end(Buffer.from(arrayBuffer));
          return;
        }

        // todo get enabled tools from agent and add them to the request body
        // todo build logic to execute tool calls

        // Set the anthropic api key in the headers.
        const headers = {
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": req.headers["content-type"] || "application/json",
        };

        // Copy relevant headers
        if (req.headers["accept"]) headers["accept"] = req.headers["accept"];
        if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];

        const client = new Anthropic({
          apiKey: anthropicApiKey,
        });

        // console.log("[EXULU] Req.body", req.body)

        // Send the request to the anthropic api.
        // Stream the messages from Anthropic
        const tokens: Record<
          string,
          {
            input_tokens: number;
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
            output_tokens: number;
          }
        > = {};

        const disabledTools = req.body.disabledTools ? req.body.disabledTools : [];
        let enabledTools: ExuluTool[] = await getEnabledTools(
          agent,
          tools,
          contexts || [],
          rerankers || [],
          disabledTools,
          providers,
          user,
        );

        // Support custom instructions from the request body
        const customInstructions = req.body.customInstructions
          ? typeof req.body.customInstructions === "string"
            ? req.body.customInstructions
            : JSON.stringify(req.body.customInstructions)
          : "";

        const agentInstructions = customInstructions
          ? `${agent?.instructions}\n\n${customInstructions}`
          : agent?.instructions;

        let system:
          | string
          | {
            type: "text";
            text: string;
          }[] = req.body.system;

        if (Array.isArray(req.body.system)) {
          system = [
            ...req.body.system,
            ...(agent
              ? [
                {
                  type: "text",
                  text: `
                            You are an agent named: ${agent?.name}
                            Here are some additional instructions for you: ${agentInstructions}`,
                },
              ]
              : []),
            ...(project
              ? [
                {
                  type: "text",
                  text: `Additional information:

                            The project you are working on is: ${project?.name}
                            Here is some additional information about the project: ${project?.description}`,
                },
              ]
              : []),
          ];
        } else {
          system = `${req.body.system}\n\n
                ${agent
              ? `You are an agent named: ${agent?.name}
                Here are some additional instructions for you: ${agentInstructions}`
              : ""
            }

                ${project?.id
              ? `Additional information:

                The project you are working on is: ${project?.name}
                The project description is: ${project?.description}`
              : ""
            }
                `;
        }

        for await (const event of client.messages.stream({
          ...req.body,
          system,
        }) as AsyncIterable<{
          type: string;
          index: number;
          message?: {
            id: string;
            type: string;
            name: string;
            input: any;
            role: string;
            model: string;
            content: any[];
            stop_reason: string | null;
            stop_sequence: string | null;
            usage: {
              input_tokens: number;
              cache_creation_input_tokens: number;
              cache_read_input_tokens: number;
              output_tokens: number;
              service_tier: string;
            };
          };
          delta?: {
            type: string;
            text: string;
          };
        }>) {
          if (event.message?.id) {
            tokens[event.message.id] = {
              input_tokens: event.message.usage.input_tokens,
              cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
              cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
              output_tokens: event.message.usage.output_tokens,
            };
            // todo check against rate limit for this agent and project
          }

          // We only deal with tools that are prefixed with "exulu_"
          // on the server, other tools are handled by Claude Code
          // client side.
          if (event.message?.type === "tool_use" && event.message?.name?.includes("exulu_")) {
            const toolName = event.message?.name;
            console.log("[EXULU] Using tool", toolName);
            const inputs = event.message?.input;
            const id = event.message?.id;

            const tool: ExuluTool | undefined = enabledTools.find(
              (tool) => tool.id === toolName.replace("exulu_", ""),
            );
            if (!tool || !tool.tool.execute) {
              console.error("[EXULU] Tool not found or not enabled.", toolName);
              continue;
            }

            const toolResult = await tool.tool.execute(inputs, {
              toolCallId: id,
              messages: [
                {
                  ...event.message,
                  role: "tool",
                },
              ],
            });

            console.log("[EXULU] Tool result", toolResult);

            const toolResultMessage = {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: id,
                  content: toolResult,
                },
              ],
            };

            res.write(`event: tool_result\ndata: ${JSON.stringify(toolResultMessage)}\n\n`);
          } else {
            const msg = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            res.write(msg);
          }
        }

        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        for (const token of Object.values(tokens)) {
          totalInputTokens += token.input_tokens;
          totalOutputTokens += token.output_tokens;
        }

        const statistics = {
          label: agent.name,
          trigger: "agent" as STATISTICS_LABELS,
        };

        await Promise.all([
          updateStatistic({
            name: "count",
            label: statistics.label,
            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
            trigger: statistics.trigger,
            count: 1,
            user: user.id,
            role: user?.role?.id,
            ...(project ? { project: project.id } : {}),
          }),
          ...(totalInputTokens
            ? [
              updateStatistic({
                name: "inputTokens",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: totalInputTokens,
                user: user.id,
                role: user?.role?.id,
                ...(project ? { project: project.id } : {}),
              }),
            ]
            : []),
          ...(totalOutputTokens
            ? [
              updateStatistic({
                name: "outputTokens",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: totalInputTokens,
                user: user.id,
                role: user?.role?.id,
                ...(project ? { project: project.id } : {}),
              }),
            ]
            : []),
        ]);

        res.write("event: done\ndata: [DONE]\n\n");
        res.end();
      } catch (error: any) {
        console.error("[PROXY] Manual proxy error:", error);
        if (!res.headersSent) {
          if (error?.message === "Invalid token") {
            res
              .status(500)
              .json({ error: "Authentication error, please check your IMP token and try again." });
          } else {
            res.status(500).json({ error: error.message });
          }
        }
      }
    },
  );

  // ─── Skills File Management ──────────────────────────────────────────────────

  type SkillFileNode = {
    name: string;
    path: string;
    key: string;
    type: "file" | "folder";
    size?: number;
    lastModified?: Date;
    children?: SkillFileNode[];
  };

  /**
   * Reconstruct a virtual folder tree from a flat list of S3 file objects.
   * S3 keys are relative to a given prefix which is stripped before building
   * the tree, so each node's `path` is relative to the skill version root.
   */
  function buildFileTree(files: S3FileObject[], stripPrefix: string): SkillFileNode {
    const root: SkillFileNode = { name: "/", path: "/", key: "", type: "folder", children: [] };

    for (const file of files) {
      const relativePath = file.key.startsWith(stripPrefix)
        ? file.key.slice(stripPrefix.length)
        : file.key;

      const parts = relativePath.split("/").filter(Boolean);
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const isFile = i === parts.length - 1;
        const existingChild = current.children?.find((c) => c.name === part);

        if (existingChild) {
          current = existingChild;
        } else {
          const nodePath = "/" + parts.slice(0, i + 1).join("/");
          const node: SkillFileNode = isFile
            ? {
              name: part,
              path: nodePath,
              key: file.key,
              type: "file",
              size: file.size,
              lastModified: file.lastModified,
            }
            : { name: part, path: nodePath, key: "", type: "folder", children: [] };

          current.children = current.children ?? [];
          current.children.push(node);
          current = node;
        }
      }
    }

    return root;
  }

  /**
   * POST /skills/:skillId/init
   * Called immediately after skillsCreateOne. Creates SKILL.md in S3 and
   * initialises the skill's s3folder, current_version, and history fields.
   */
  app.post("/skills/:skillId/init", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { name = "Skill", description = "" } = req.body;

    const skillMdContent = [
      `# ${name}`,
      "",
      description || "Describe what this skill does and when to use it.",
      "",
      "## Overview",
      "",
      "...",
      "",
      "## Usage",
      "",
      "...",
    ].join("\n");

    const s3Key = `skills/${skillId}/v1/SKILL.md`;

    try {
      await uploadFile(Buffer.from(skillMdContent, "utf-8"), s3Key, config, { contentType: "text/markdown" }, undefined, undefined, true);
    } catch (err: any) {
      console.error("[SKILLS] Failed to create SKILL.md in S3", err);
      res.status(500).json({ detail: "Failed to initialise skill folder in S3." });
      return;
    }

    const { db } = await postgresClient();
    await db("skills").where({ id: skillId }).update({
      s3folder: `skills/${skillId}`,
      current_version: 1,
      history: JSON.stringify([
        { version: 1, created_at: new Date().toISOString(), label: "Initial" },
      ]),
    });

    res.json({ version: 1, skillMdKey: s3Key });
  });

  /**
   * POST /skills/:skillId/upload-sign
   * Returns a presigned PUT URL for uploading a skill bundle (.zip or .md) to
   * a per-user staging area in S3. The frontend uploads directly to the URL
   * (via the existing Uppy AwsS3 flow), then calls /init-from-upload below to
   * trigger extraction.
   *
   * Body: { extension: ".zip" | ".md", contentType: string }
   * Response: { uploadUrl: string, stagingKey: string }
   */
  app.post("/skills/:skillId/upload-sign", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { extension, contentType } = req.body ?? {};

    if (extension !== ".zip" && extension !== ".md") {
      res.status(400).json({ detail: 'extension must be ".zip" or ".md".' });
      return;
    }
    if (!contentType || typeof contentType !== "string") {
      res.status(400).json({ detail: "Missing contentType in request body." });
      return;
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    // Per-user staging path. The init-from-upload handler verifies the same
    // user owns the staging key, so users can't trigger extraction of someone
    // else's upload.
    const stagingKey = `user_${authResult.user.id}/skills/_staging/${randomUUID()}${extension}`;
    const fullKey = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/${stagingKey}`
      : stagingKey;

    const uploadUrl = await getS3SignedUploadUrl(fullKey, contentType, config);
    res.json({ uploadUrl, stagingKey });
  });

  /**
   * POST /skills/:skillId/init-from-upload
   * Fetches a staged bundle from S3, extracts it (validates SKILL.md presence,
   * path safety, size + count caps), and uploads the contents to
   * skills/<skillId>/v1/. Updates the skill row with s3folder, current_version,
   * and history — mirroring what /init does for blank-create.
   *
   * Body: { stagingKey: string, isZip: boolean }
   * Response: { version: 1, filesCount: number }
   */
  app.post("/skills/:skillId/init-from-upload", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const skillId = req.params.skillId;
    if (!skillId) {
      res.status(400).json({ detail: "Missing skillId in path." });
      return;
    }
    const { stagingKey, isZip } = req.body ?? {};

    if (!stagingKey || typeof stagingKey !== "string") {
      res.status(400).json({ detail: "Missing stagingKey in request body." });
      return;
    }
    if (typeof isZip !== "boolean") {
      res.status(400).json({ detail: "Missing or invalid isZip in request body." });
      return;
    }

    // Authorization: the staging key must belong to the calling user. Without
    // this check, a malicious caller could trigger extraction of another
    // user's staged upload into their own skill.
    const expectedPrefix = `user_${authResult.user.id}/skills/_staging/`;
    if (!stagingKey.startsWith(expectedPrefix)) {
      res.status(403).json({ detail: "stagingKey does not belong to the authenticated user." });
      return;
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    // Fetch the staged bundle. getS3ObjectBytes prepends the s3prefix the
    // same way uploadFile / getS3ObjectContent do, so we pass the
    // pre-prefix stagingKey directly.
    const fullStagingKey = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/${stagingKey}`
      : stagingKey;

    let bytes: Buffer;
    try {
      bytes = await getS3ObjectBytes(fullStagingKey, config);
    } catch (err: any) {
      console.error("[SKILLS] Failed to fetch staged bundle", err);
      res.status(500).json({ detail: "Failed to fetch staged bundle from S3." });
      return;
    }

    let result: { filesCount: number };
    try {
      result = await extractBundleToS3({ bytes, skillId, isZip, config });
    } catch (err: any) {
      // Extraction failed. Delete the skill row so the user can retry with
      // the same name (the alternative is hitting a unique-constraint error
      // on the second attempt). The row was created moments ago and contains
      // no real state — files haven't landed yet (extraction is pre-validated
      // so no partial S3 writes occur). Best-effort cleanup of the staging
      // key too.
      try {
        await db("skills").where({ id: skillId }).delete();
      } catch (cleanupErr: any) {
        console.warn(
          `[SKILLS] Failed to delete orphan skill row ${skillId} after extraction failure; user may need to delete it manually.`,
          cleanupErr,
        );
      }
      try {
        await deleteS3Object(fullStagingKey, config);
      } catch (cleanupErr: any) {
        console.warn(
          `[SKILLS] Failed to delete staging key ${fullStagingKey} after extraction failure; continuing.`,
          cleanupErr,
        );
      }

      if (err instanceof BundleValidationError) {
        res.status(400).json({ detail: err.message });
        return;
      }
      console.error("[SKILLS] Failed to extract bundle", err);
      res.status(500).json({ detail: "Failed to extract bundle." });
      return;
    }

    await db("skills").where({ id: skillId }).update({
      s3folder: `skills/${skillId}`,
      current_version: 1,
      history: JSON.stringify([
        { version: 1, created_at: new Date().toISOString(), label: "Uploaded bundle" },
      ]),
    });

    // Best-effort cleanup of the staging key. Failure to delete shouldn't
    // fail the request — the bundle has already landed in the skill folder.
    try {
      await deleteS3Object(fullStagingKey, config);
    } catch (err: any) {
      console.warn(`[SKILLS] Failed to delete staging key ${fullStagingKey}; continuing.`, err);
    }

    res.json({ version: 1, filesCount: result.filesCount });
  });

  /**
   * GET /skills/:skillId/files?version=N
   * Lists all files in a skill version and returns a virtual folder tree.
   */
  app.get("/skills/:skillId/files", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const version = req.query.version ? Number(req.query.version) : (skill.current_version ?? 1);
    const prefix = `skills/${skillId}/v${version}/`;

    const files = await listS3ObjectsByPrefix(prefix, config);
    const tree = buildFileTree(files, config.fileUploads?.s3prefix ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/` + prefix : prefix);

    res.json({ version, tree, fileCount: files.length });
  });

  /**
   * POST /skills/:skillId/sign
   * Returns a presigned PUT URL for uploading a file at an exact path within
   * the current version of the skill.
   * Body: { filePath: "scripts/analyze.py", contentType: "text/x-python" }
   */
  app.post("/skills/:skillId/sign", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { filePath, contentType = "application/octet-stream" } = req.body;

    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ detail: "Missing filePath in request body." });
      return;
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const version = skill.current_version ?? 1;
    // Sanitize: strip leading slash and prevent path traversal
    const safePath = filePath.replace(/^\/+/, "").replace(/\.\.\//g, "");
    const s3Key = `skills/${skillId}/v${version}/${safePath}`;
    const fullKey = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/${s3Key}`
      : s3Key;

    const url = await getS3SignedUploadUrl(fullKey, contentType, config);

    res.json({ key: s3Key, url, method: "PUT" });
  });

  /**
   * GET /skills/:skillId/file?key=<s3key>
   * Returns a presigned download URL. For small text files (≤ 200 KB) also
   * returns the raw content inline so the editor can avoid a second round trip.
   */
  app.get("/skills/:skillId/file", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { key } = req.query;

    if (!key || typeof key !== "string") {
      res.status(400).json({ detail: "Missing key query parameter." });
      return;
    }

    if (!key.startsWith(`skills/${skillId}/`)) {
      res.status(403).json({ detail: "Key does not belong to this skill." });
      return;
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const fullKey = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/${key}`
      : key;

    const TEXT_EXTENSIONS = new Set([".md", ".txt", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".sh", ".env", ".toml", ".xml", ".html", ".css"]);
    const ext = key.slice(key.lastIndexOf(".")).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext);

    const MAX_INLINE_BYTES = 200 * 1024;

    let content: string | undefined;
    if (isText) {
      try {
        const raw = await getS3ObjectContent(fullKey, config);
        if (raw.length <= MAX_INLINE_BYTES) {
          content = raw;
        }
      } catch {
        // Non-fatal: presigned URL will still be returned
      }
    }

    const bucket = config.fileUploads?.s3Bucket ?? "";
    const url = await getPresignedUrl(bucket, fullKey, config);

    res.json({ url, content, key });
  });

  /**
   * DELETE /skills/:skillId/file?key=<s3key>
   * Deletes a single file. Pass ?prefix=<prefix> to delete an entire folder.
   */
  app.delete("/skills/:skillId/file", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { key, prefix } = req.query;

    if (!key && !prefix) {
      res.status(400).json({ detail: "Provide either key or prefix query parameter." });
      return;
    }

    const guard = (s: string): boolean => !s.startsWith(`skills/${skillId}/`);

    if (key && typeof key === "string") {
      if (guard(key)) {
        res.status(403).json({ detail: "Key does not belong to this skill." });
        return;
      }
    }
    if (prefix && typeof prefix === "string") {
      if (guard(prefix)) {
        res.status(403).json({ detail: "Prefix does not belong to this skill." });
        return;
      }
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const s3Prefix = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/`
      : "";

    if (key && typeof key === "string") {
      const fullKey = s3Prefix + key;
      await deleteS3Object(fullKey, config);
      res.json({ deleted: 1 });
      return;
    }

    if (prefix && typeof prefix === "string") {
      const files = await listS3ObjectsByPrefix(prefix, config);
      await Promise.all(files.map((f) => deleteS3Object(f.key, config)));
      res.json({ deleted: files.length });
      return;
    }
  });

  /**
   * POST /skills/:skillId/version
   * Freezes the current version by copying all its files into the next version
   * folder. Going forward, the skill's current_version points to the new slot.
   * Body: { label?: string }
   */
  app.post("/skills/:skillId/version", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { label } = req.body;
    const { db } = await postgresClient();

    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const currentVersion: number = skill.current_version ?? 1;
    const newVersion = currentVersion + 1;
    const currentPrefix = `skills/${skillId}/v${currentVersion}/`;
    const newPrefix = `skills/${skillId}/v${newVersion}/`;

    const files = await listS3ObjectsByPrefix(currentPrefix, config);
    if (files.length === 0) {
      res.status(400).json({ detail: "No files found in current version to snapshot." });
      return;
    }

    const s3GeneralPrefix = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/`
      : "";

    for (const file of files) {
      const destKey = file.key.replace(s3GeneralPrefix + currentPrefix, s3GeneralPrefix + newPrefix);
      await copyS3Object(file.key, destKey, config);
    }

    const existingHistory = Array.isArray(skill.history) ? skill.history : [];
    const newHistory = [
      ...existingHistory,
      { version: newVersion, created_at: new Date().toISOString(), label: label ?? `v${newVersion}` },
    ];

    await db("skills").where({ id: skillId }).update({
      current_version: newVersion,
      history: JSON.stringify(newHistory),
    });

    res.json({ newVersion, fileCount: files.length });
  });

  /**
   * POST /skills/:skillId/rename
   * Moves a file within the current version by copying to the new path and
   * deleting the original.
   * Body: { sourceKey: "skills/<id>/v1/old.md", destPath: "new-name.md" }
   */
  app.post("/skills/:skillId/rename", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const { sourceKey, destPath } = req.body;

    if (!sourceKey || !destPath) {
      res.status(400).json({ detail: "sourceKey and destPath are required." });
      return;
    }

    if (!sourceKey.startsWith(`skills/${skillId}/`)) {
      res.status(403).json({ detail: "sourceKey does not belong to this skill." });
      return;
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const version = skill.current_version ?? 1;
    const safeDest = destPath.replace(/^\/+/, "").replace(/\.\.\//g, "");
    const destKey = `skills/${skillId}/v${version}/${safeDest}`;

    const s3Prefix = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/`
      : "";

    const fullSourceKey = s3Prefix + sourceKey;
    const fullDestKey = s3Prefix + destKey;

    await copyS3Object(fullSourceKey, fullDestKey, config);
    await deleteS3Object(fullSourceKey, config);

    res.json({ newKey: destKey });
  });

  /**
   * GET /skills/:skillId/diff?fromVersion=1&toVersion=2
   * Compares two versions of a skill, returning per-file status
   * (added / removed / modified) and unified diff strings for changed text files.
   */
  app.get("/skills/:skillId/diff", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }

    const { skillId } = req.params;
    const fromVersion = Number(req.query.fromVersion);
    const toVersion = Number(req.query.toVersion);

    if (!fromVersion || !toVersion) {
      res.status(400).json({ detail: "fromVersion and toVersion query params are required." });
      return;
    }

    const { db } = await postgresClient();
    const skill = await db("skills").where({ id: skillId }).first();
    if (!skill) {
      res.status(404).json({ detail: "Skill not found." });
      return;
    }

    const s3Prefix = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/`
      : "";

    const fromPrefix = `skills/${skillId}/v${fromVersion}/`;
    const toPrefix = `skills/${skillId}/v${toVersion}/`;

    const [fromFiles, toFiles] = await Promise.all([
      listS3ObjectsByPrefix(fromPrefix, config),
      listS3ObjectsByPrefix(toPrefix, config),
    ]);

    // Relativise keys so we can compare paths across versions
    const relativise = (files: S3FileObject[], prefix: string): Map<string, S3FileObject> => {
      const full = s3Prefix + prefix;
      return new Map(files.map((f) => [f.key.replace(full, ""), f]));
    };

    const fromMap = relativise(fromFiles, fromPrefix);
    const toMap = relativise(toFiles, toPrefix);

    const allPaths = new Set([...fromMap.keys(), ...toMap.keys()]);

    const TEXT_EXTENSIONS = new Set([".md", ".txt", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".sh", ".toml"]);
    const MAX_DIFF_BYTES = 500 * 1024;

    const fileDiffs = await Promise.all(
      [...allPaths].map(async (path) => {
        const inFrom = fromMap.has(path);
        const inTo = toMap.has(path);
        const status = !inFrom ? "added" : !inTo ? "removed" : "modified";

        if (status === "modified") {
          const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
          if (!TEXT_EXTENSIONS.has(ext)) {
            return { path, status };
          }
          try {
            const [fromContent, toContent] = await Promise.all([
              getS3ObjectContent(s3Prefix + fromPrefix + path, config),
              getS3ObjectContent(s3Prefix + toPrefix + path, config),
            ]);
            if (fromContent === toContent) {
              return { path, status: "unchanged" as const };
            }
            if (fromContent.length + toContent.length > MAX_DIFF_BYTES) {
              return { path, status };
            }
            // Build a simple unified diff
            const fromLines = fromContent.split("\n");
            const toLines = toContent.split("\n");
            const diff = buildUnifiedDiff(fromLines, toLines, `v${fromVersion}/${path}`, `v${toVersion}/${path}`);
            return { path, status, diff };
          } catch {
            return { path, status };
          }
        }

        return { path, status };
      }),
    );

    res.json({
      fromVersion,
      toVersion,
      files: fileDiffs.filter((f) => f.status !== "unchanged"),
    });
  });

  // ─── End Skills File Management ───────────────────────────────────────────────

  // ─── Session Files ────────────────────────────────────────────────────────────
  // Five routes that power the session files side panel on the chat page.
  // All files live under <s3prefix>/user_<userId>/sessions/<sessionId>/, the
  // same prefix the agent's writeFile and bash artifact mirroring use. User-
  // uploaded files become visible to the agent next turn (cold-start restore
  // or the explicit sync-to-sandbox route below).

  /**
   * Map a file extension to a content type. Inlined to avoid a mime-types
   * dependency; only covers the formats we actually surface in the side
   * panel (text/markdown/code/images/PDF + Office binaries). Anything else
   * falls through to application/octet-stream and the frontend offers a
   * download instead of a preview.
   */
  const SESSION_FILE_CONTENT_TYPES: Record<string, string> = {
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".json": "application/json",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".py": "text/x-python",
    ".js": "application/javascript",
    ".ts": "application/typescript",
    ".tsx": "application/typescript",
    ".html": "text/html",
    ".css": "text/css",
    ".sh": "application/x-sh",
    ".xml": "application/xml",
    ".toml": "application/toml",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
  };

  function inferContentType(name: string): string {
    const dotIdx = name.lastIndexOf(".");
    if (dotIdx < 0) return "application/octet-stream";
    const ext = name.slice(dotIdx).toLowerCase();
    return SESSION_FILE_CONTENT_TYPES[ext] ?? "application/octet-stream";
  }

  /**
   * Build the prefix-shape strings we use for session-file lookups. The
   * "userSessionPrefix" is what we list against (without s3prefix; the helper
   * prepends it). "fullSessionPrefix" is what S3 returns inside object keys
   * and what we use for the auth-by-prefix check.
   */
  function buildSessionPrefixes(userId: number | string, sessionId: string) {
    const userSessionPrefix = `user_${userId}/sessions/${sessionId}/`;
    const generalPrefix = config.fileUploads?.s3prefix
      ? `${config.fileUploads.s3prefix.replace(/\/$/, "")}/`
      : "";
    const fullSessionPrefix = `${generalPrefix}${userSessionPrefix}`;
    return { userSessionPrefix, fullSessionPrefix };
  }

  /**
   * Sanitize a user-supplied filename. Reject anything that escapes the
   * intended directory; mostly defensive — Uppy normally posts to the
   * presigned URL whose key we already control, so the filename arrives
   * here only as a label.
   */
  function sanitizeFilename(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "";
    if (trimmed.includes("..")) return "";
    if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return "";
    // Replace path separators in the basename — uploads are flat per session,
    // no subdir creation through this route.
    return trimmed.replace(/[\\/]/g, "_");
  }

  /**
   * GET /sessions/:sessionId/files
   * Lists all files under the calling user's session prefix. Returns
   * presigned download URLs inline so the frontend can render previews
   * (image, PDF) without a second round trip per file.
   */
  app.get("/sessions/:sessionId/files", async (req: Request, res: Response) => {
    const authResult = await requestValidators.authenticate(req);
    if (!authResult.user?.id) {
      res.status(authResult.code ?? 401).json({ detail: authResult.message });
      return;
    }
    const sessionId = req.params.sessionId;
    if (!sessionId) {
      res.status(400).json({ detail: "Missing sessionId in path." });
      return;
    }
    if (!config.fileUploads) {
      res.status(500).json({ detail: "File uploads are not configured." });
      return;
    }

    const { userSessionPrefix } = buildSessionPrefixes(
      authResult.user.id,
      sessionId,
    );

    let objects: S3FileObject[];
    try {
      objects = await listS3ObjectsByPrefix(userSessionPrefix, config);
    } catch (err: any) {
      console.error("[SESSION-FILES] Failed to list S3 objects", err);
      res.status(500).json({ detail: "Failed to list session files." });
      return;
    }

    const bucket = config.fileUploads.s3Bucket;
    const files = await Promise.all(
      objects
        // Skip the directory marker (key ending with /).
        .filter((obj) => !obj.key.endsWith("/"))
        .map(async (obj) => {
          const name = obj.key.split("/").pop() ?? obj.key;
          const presignedUrl = await getPresignedUrl(bucket, obj.key, config);
          return {
            key: obj.key,
            name,
            size: obj.size,
            lastModified: obj.lastModified.toISOString(),
            contentType: inferContentType(name),
            presignedUrl,
          };
        }),
    );

    // Most-recent first.
    files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));

    res.json({ files });
  });

  /**
   * POST /sessions/:sessionId/files/upload-sign
   * Returns a presigned PUT URL for uploading a single file into the
   * session prefix. Frontend uploads via Uppy, then calls
   * /sync-to-sandbox below to push it into the live sandbox dir.
   *
   * Body: { filename: string, contentType: string }
   * Response: { uploadUrl: string, key: string }
   */
  app.post(
    "/sessions/:sessionId/files/upload-sign",
    async (req: Request, res: Response) => {
      const authResult = await requestValidators.authenticate(req);
      if (!authResult.user?.id) {
        res.status(authResult.code ?? 401).json({ detail: authResult.message });
        return;
      }
      const sessionId = req.params.sessionId;
      if (!sessionId) {
        res.status(400).json({ detail: "Missing sessionId in path." });
        return;
      }
      if (!config.fileUploads) {
        res.status(500).json({ detail: "File uploads are not configured." });
        return;
      }

      const { filename, contentType } = req.body ?? {};
      if (!filename || typeof filename !== "string") {
        res.status(400).json({ detail: "Missing filename in request body." });
        return;
      }
      const safeName = sanitizeFilename(filename);
      if (!safeName) {
        res
          .status(400)
          .json({ detail: "Invalid filename (no path separators, no '..')." });
        return;
      }
      if (!contentType || typeof contentType !== "string") {
        res.status(400).json({ detail: "Missing contentType in request body." });
        return;
      }

      const { userSessionPrefix, fullSessionPrefix } = buildSessionPrefixes(
        authResult.user.id,
        sessionId,
      );
      const fullKey = `${fullSessionPrefix}${safeName}`;
      const uploadUrl = await getS3SignedUploadUrl(fullKey, contentType, config);

      // The frontend round-trips `key` back to the sync-to-sandbox and delete
      // routes; we return the full prefixed key so those routes can do the
      // prefix-check + S3 ops without any client-side reconstruction.
      res.json({ uploadUrl, key: fullKey });
    },
  );

  /**
   * POST /sessions/:sessionId/files/sync-to-sandbox
   * After Uppy reports a successful upload, the frontend calls this so the
   * agent's next readFile/bash sees the file. No-op if the sandbox isn't
   * currently materialized (cold-start restore handles that case).
   */
  app.post(
    "/sessions/:sessionId/files/sync-to-sandbox",
    async (req: Request, res: Response) => {
      const authResult = await requestValidators.authenticate(req);
      if (!authResult.user?.id) {
        res.status(authResult.code ?? 401).json({ detail: authResult.message });
        return;
      }
      const sessionId = req.params.sessionId;
      if (!sessionId) {
        res.status(400).json({ detail: "Missing sessionId in path." });
        return;
      }
      const { key } = req.body ?? {};
      if (!key || typeof key !== "string") {
        res.status(400).json({ detail: "Missing key in request body." });
        return;
      }

      const { fullSessionPrefix } = buildSessionPrefixes(
        authResult.user.id,
        sessionId,
      );
      if (!key.startsWith(fullSessionPrefix)) {
        res.status(403).json({ detail: "Key does not belong to this session." });
        return;
      }

      try {
        const result = await downloadKeyIntoSandbox({
          sessionId,
          userId: authResult.user.id,
          fullS3Key: key,
          config,
        });
        res.json(result);
      } catch (err: any) {
        console.error("[SESSION-FILES] sync-to-sandbox failed", err);
        res.status(500).json({ detail: "Failed to sync file into sandbox." });
      }
    },
  );

  /**
   * DELETE /sessions/:sessionId/files
   * Deletes a session file. The key arrives in the query string (URL paths
   * can't contain raw forward slashes from the S3 key safely). Prefix-check
   * enforces session ownership.
   */
  app.delete(
    "/sessions/:sessionId/files",
    async (req: Request, res: Response) => {
      const authResult = await requestValidators.authenticate(req);
      if (!authResult.user?.id) {
        res.status(authResult.code ?? 401).json({ detail: authResult.message });
        return;
      }
      const sessionId = req.params.sessionId;
      if (!sessionId) {
        res.status(400).json({ detail: "Missing sessionId in path." });
        return;
      }

      const key = req.query.key;
      if (!key || typeof key !== "string") {
        res
          .status(400)
          .json({ detail: "Missing or invalid 'key' query parameter." });
        return;
      }

      const { fullSessionPrefix } = buildSessionPrefixes(
        authResult.user.id,
        sessionId,
      );
      if (!key.startsWith(fullSessionPrefix)) {
        res.status(403).json({ detail: "Key does not belong to this session." });
        return;
      }

      try {
        await deleteS3Object(key, config);
        res.json({ deleted: true });
      } catch (err: any) {
        console.error("[SESSION-FILES] delete failed", err);
        res.status(500).json({ detail: "Failed to delete session file." });
      }
    },
  );

  /**
   * GET /sessions/:sessionId/file/preview-pdf
   * Renders an Office-binary (.docx/.xlsx/.pptx/etc.) to PDF via LibreOffice
   * and streams the PDF back. Cached on disk by source ETag — repeat
   * previews are instant, content updates auto-invalidate.
   */
  app.get(
    "/sessions/:sessionId/file/preview-pdf",
    async (req: Request, res: Response) => {
      // <iframe src=...> can't set Authorization: Bearer. Accept the token
      // via ?auth= query param as a fallback so the iframe can fetch the
      // PDF directly. Token still ends up in server logs / browser history —
      // acceptable for a same-user preview that's also auth-checked via the
      // session-prefix rule below.
      if (!req.headers.authorization && typeof req.query.auth === "string") {
        req.headers.authorization = `Bearer ${req.query.auth}`;
      }
      const authResult = await requestValidators.authenticate(req);
      if (!authResult.user?.id) {
        res.status(authResult.code ?? 401).json({ detail: authResult.message });
        return;
      }
      const sessionId = req.params.sessionId;
      if (!sessionId) {
        res.status(400).json({ detail: "Missing sessionId in path." });
        return;
      }

      const key = req.query.key;
      if (!key || typeof key !== "string") {
        res
          .status(400)
          .json({ detail: "Missing or invalid 'key' query parameter." });
        return;
      }

      const { fullSessionPrefix } = buildSessionPrefixes(
        authResult.user.id,
        sessionId,
      );
      if (!key.startsWith(fullSessionPrefix)) {
        res.status(403).json({ detail: "Key does not belong to this session." });
        return;
      }

      const etag = await getS3ObjectEtag(key, config);
      if (!etag) {
        res.status(404).json({ detail: "Source file not found in S3." });
        return;
      }

      try {
        const pdfBytes = await getPdfPreviewBytes({
          sourceKey: key,
          etag,
          config,
        });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Cache-Control", "private, max-age=300");
        res.send(pdfBytes);
      } catch (err: any) {
        if (err instanceof PreviewRenderError) {
          console.error("[SESSION-FILES] preview render failed", err);
          res.status(500).json({ detail: err.message });
          return;
        }
        console.error("[SESSION-FILES] preview unexpected error", err);
        res.status(500).json({ detail: "Failed to render preview." });
      }
    },
  );

  // ─── End Session Files ────────────────────────────────────────────────────────

  app.use(express.static("public"));

  await registerOpenAIGatewayRoutes(app, providers, tools, contexts, config, rerankers);

  return app;
};

/**
 * Produce a minimal unified diff string from two arrays of lines.
 * Uses a greedy LCS-based approach suitable for small-to-medium text files.
 */
function buildUnifiedDiff(
  fromLines: string[],
  toLines: string[],
  fromLabel: string,
  toLabel: string,
): string {
  // Simple Myers-diff-inspired implementation: compute edit script via LCS
  function lcs(a: string[], b: string[]): number[][] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i]![j] = a[i - 1] === b[j - 1] ? (dp[i - 1]![j - 1] ?? 0) + 1 : Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0);
      }
    }
    return dp;
  }

  type Hunk = { op: "=" | "-" | "+"; line: string };

  function diff(a: string[], b: string[]): Hunk[] {
    const table = lcs(a, b);
    const result: Hunk[] = [];
    let i = a.length;
    let j = b.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        result.unshift({ op: "=", line: a[i - 1]! });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || (table[i]![j - 1] ?? 0) >= (table[i - 1]![j] ?? 0))) {
        result.unshift({ op: "+", line: b[j - 1]! });
        j--;
      } else {
        result.unshift({ op: "-", line: a[i - 1]! });
        i--;
      }
    }
    return result;
  }

  const CONTEXT = 3;
  const hunks = diff(fromLines, toLines);
  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];

  // Group into context windows
  let hunkStart = -1;
  for (let idx = 0; idx < hunks.length; idx++) {
    const h = hunks[idx]!;
    if (h.op !== "=") {
      if (hunkStart < 0) {
        hunkStart = Math.max(0, idx - CONTEXT);
      }
    } else if (hunkStart >= 0 && idx - hunkStart > CONTEXT * 2) {
      // Flush hunk
      const slice = hunks.slice(hunkStart, Math.min(idx, hunkStart + (idx - hunkStart)));
      lines.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`);
      for (const s of slice) {
        lines.push((s.op === "=" ? " " : s.op) + s.line);
      }
      hunkStart = -1;
    }
  }
  if (hunkStart >= 0) {
    const slice = hunks.slice(hunkStart, Math.min(hunks.length, hunkStart + hunks.length));
    lines.push(`@@ -${hunkStart + 1} +${hunkStart + 1} @@`);
    for (const s of slice) {
      lines.push((s.op === "=" ? " " : s.op) + s.line);
    }
  }

  return lines.join("\n");
}

const createCustomAnthropicStreamingMessage = (message: string) => {
  const responseData = {
    type: "message",
    content: [
      {
        type: "text",
        text: message,
      },
    ],
  };
  const jsonString = JSON.stringify(responseData);
  const arrayBuffer = new TextEncoder().encode(jsonString).buffer;
  return arrayBuffer;
};
