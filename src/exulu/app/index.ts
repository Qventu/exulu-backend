import {
  ExuluAgent,
  ExuluContext,
  ExuluEval,
  ExuluReranker,
  getTableName,
  type ExuluContextSource,
  type ExuluQueueConfig,
  type ExuluTool,
} from "src/exulu/classes.ts"; /* ExuluMcpToolsClient */
import { type Express } from "express";
import { createExpressRoutes, global_queues } from "src/exulu/routes.ts";
import { createWorkers } from "src/exulu/workers.ts";
import { ExuluMCP } from "src/mcp/index.ts";
import express from "express";
import {
  claudeSonnet4Agent,
  claudeOpus4Agent,
  claudeSonnet45Agent,
} from "src/templates/agents/anthropic/claude";
import { gptOss120bAgent, llama38bAgent, llama3370bAgent } from "src/templates/agents/cerebras";
import {
  vertexGemini25FlashAgent,
  vertexGemini25ProAgent,
  vertexGemini3ProAgent,
} from "src/templates/agents/google/vertex";
import {
  gpt5MiniAgent,
  gpt5agent,
  gpt5proAgent,
  gpt5CodexAgent,
  gpt5NanoAgent,
  gpt41Agent,
  gpt41MiniAgent,
  gpt4oAgent,
  gpt4oMiniAgent,
} from "src/templates/agents/openai/gpt.ts";
import { trace, type Tracer } from "@opentelemetry/api";
import createLogger from "src/exulu/logger.ts";
import { postgresClient } from "src/postgres/client.ts";
import winston, { type transport } from "winston";
import util from "util";
import { redisServer } from "src/bullmq/server.ts";
import { getDefaultEvals } from "src/templates/evals/index.ts";
import { ExuluQueues } from "src/index.ts";
import { todoTools } from "src/templates/tools/todo/todo.ts";
import { perplexityTools } from "src/templates/tools/perplexity.ts";
import { isValidPostgresName } from "src/validators/postgres-name.ts";

const isDev = process.env.NODE_ENV !== "production";
const consoleTransport = new winston.transports.Console({
  format: isDev
    ? winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp as string} [${level as string}] ${message as string}`;
        }),
      )
    : winston.format.json(),
});

// Monkey-patch console to use Winston with metadata support
const formatArg = (arg: any) =>
  typeof arg === "object" ? util.inspect(arg, { depth: null, colors: isDev }) : String(arg);

const createLogMethod = (logger: winston.Logger, logLevel: "info" | "warn" | "error" | "debug") => {
  return (...args: any[]) => {
    // Check if last argument is metadata object with id
    const lastArg = args[args.length - 1];
    let metadata: any = undefined;
    let messageArgs = args;

    if (lastArg && typeof lastArg === "object" && lastArg.__logMetadata === true) {
      metadata = lastArg;
      messageArgs = args.slice(0, -1);
    }

    const message = messageArgs.map(formatArg).join(" ");
    logger[logLevel](message, metadata);
  };
};

export type ExuluConfig = {
  telemetry?: {
    enabled: boolean;
  };
  logger?: {
    winston: {
      transports: transport[];
    };
  };
  workers: {
    enabled: boolean;
    logger?: {
      winston: {
        transports: transport[];
      };
    };
    telemetry?: {
      enabled: boolean;
    };
  };
  MCP: {
    enabled: boolean;
  };
  fileUploads?: {
    s3region: string;
    s3key: string;
    s3secret: string;
    s3Bucket: string;
    s3endpoint?: string;
    s3prefix?: string;
  };
  privacy?: {
    systemPromptPersonalization?: boolean;
  };
};

export class ExuluApp {
  private _agents: ExuluAgent[] = [];
  private _config?: ExuluConfig;
  private _evals: ExuluEval[] = [];
  private _queues: ExuluQueueConfig[] = [];
  private _rerankers: ExuluReranker[] = [];
  private _contexts?: Record<string, ExuluContext> = {};
  private _tools: ExuluTool[] = [];
  private _expressApp: Express | null = null;

  constructor() {}

  // Factory function so we can async
  // initialize the MCP server if needed.
  create = async ({
    contexts,
    agents,
    config,
    tools,
    evals,
    rerankers,
  }: {
    // mcps
    contexts?: Record<string, ExuluContext>;
    config: ExuluConfig;
    agents?: ExuluAgent[];
    rerankers?: ExuluReranker[];
    evals?: ExuluEval[];
    tools?: ExuluTool[];
    // mcps?: ExuluMcpToolsClient[]
  }): Promise<ExuluApp> => {
    this._evals =
      redisServer.host?.length && redisServer.port?.length
        ? [...getDefaultEvals(), ...(evals ?? [])]
        : [];

    this._contexts = {
      ...contexts,
    };

    this._rerankers = [...(rerankers ?? [])];

    this._agents = [
      claudeSonnet4Agent,
      claudeOpus4Agent,
      gptOss120bAgent,
      llama38bAgent,
      llama3370bAgent,
      vertexGemini25FlashAgent,
      vertexGemini25ProAgent,
      vertexGemini3ProAgent,
      claudeSonnet45Agent,
      gpt5MiniAgent,
      gpt5agent,
      gpt5proAgent,
      gpt5CodexAgent,
      gpt5NanoAgent,
      gpt41Agent,
      gpt41MiniAgent,
      gpt4oAgent,
      gpt4oMiniAgent,
      ...(agents ?? []),
    ];
    this._config = config;

    /* let mcpTools: ExuluTool[] = [];
        if (mcps) {
            const promises = mcps.map(async (mcp) => {
                console.log('[EXULU] Loading MCP tools from: ' + mcp.name);
                const response = await mcp.tools();
                console.log('[EXULU] Adding MCP tools from: ' + mcp.name + ' tools: ' + response.map(x => x.name + " (" + x.id + ")").join(', '));
                return response;
            });
            const responses = await Promise.all(promises);
            mcpTools.push(...responses.flat());
        } */

    this._tools = [
      ...(tools ?? []),
      ...todoTools,
      ...perplexityTools,
      // Add contexts as tools
      ...(Object.values(contexts || {})
        .map((context) => context.tool())
        .filter(Boolean) as ExuluTool[]),
      // Because agents are stored in the database,  we add those as tools
      // at request time, not during ExuluApp initialization. We add them
      // in the grahql tools resolver.
      // ...mcpTools
    ];

    const checks: {
      name: string;
      id: string;
      type: "context" | "agent" | "tool" | "reranker";
    }[] = [
      ...Object.keys(this._contexts || {}).map((x) => ({
        name: this._contexts?.[x]?.name ?? "",
        id: this._contexts?.[x]?.id ?? "",
        type: "context" as const,
      })),
      ...this._agents.map((agent) => ({
        name: agent.name ?? "",
        id: agent.id ?? "",
        type: "agent" as const,
      })),
      ...this._tools.map((tool) => ({
        name: tool.name ?? "",
        id: tool.id ?? "",
        type: "tool" as const,
      })),
      ...this._rerankers.map((reranker) => ({
        name: reranker.name ?? "",
        id: reranker.id ?? "",
        type: "reranker" as const,
      })),
    ];

    // Integrate validation into the create method
    const invalid = checks.filter((x) => !isValidPostgresName(x?.id ?? ""));
    if (invalid.length > 0) {
      console.error(
        `%c[EXULU] Invalid ID found for a context, tool, reranker or agent: ${invalid.map((x) => x.id).join(", ")}. An ID must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or underscores and be a max length of 80 characters and at least 5 characters long.`,
        "color: orange; font-weight: bold; \n \n",
      );
      throw new Error(
        `Invalid ID found for a context, tool or agent: ${invalid.map((x) => x.id).join(", ")}. An ID must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or underscores and be a max length of 80 characters and at least 5 characters long.`,
      );
    }

    const queueSet = new Set<ExuluQueueConfig>();

    if (redisServer.host?.length && redisServer.port?.length) {
      ExuluQueues.register(
        global_queues.eval_runs,
        {
          worker: 10,
          queue: 10,
        },
        1,
      );
      for (const queue of ExuluQueues.list.values()) {
        const config = await queue.use();
        queueSet.add(config);
      }
    }

    this._queues = [...new Set(queueSet.values())] as any;
    console.log("[EXULU] App initialized.");
    return this;
  };

  express = {
    init: async (): Promise<Express> => {
      if (!this._expressApp) {
        this._expressApp = express();
        await this.server.express.init();
        console.log("[EXULU] Express app initialized.");
      }
      return this._expressApp;
    },
  };

  public get expressApp(): Express {
    if (!this._expressApp) {
      throw new Error(
        "Express app not initialized, initialize it by calling await ExuluApp.create() first.",
      );
    }
    return this._expressApp;
  }

  public tool(id: string): ExuluTool | undefined {
    return this._tools.find((x) => x.id === id);
  }

  public tools(): ExuluTool[] {
    return this._tools;
  }

  public context(id: string): ExuluContext | undefined {
    return Object.values(this._contexts ?? {}).find((x) => x.id === id);
  }

  public agent(id: string): ExuluAgent | undefined {
    return this._agents.find((x) => x.id === id);
  }

  public get contexts(): ExuluContext[] {
    return Object.values(this._contexts ?? {});
  }

  public get agents(): ExuluAgent[] {
    return this._agents;
  }

  public embeddings = {
    generate: {
      one: async ({ context: contextId, item: itemId }: { context: string; item: string }) => {
        const { db } = await postgresClient();
        const item = await db
          .from(getTableName(contextId))
          .where({ id: itemId })
          .select("*")
          .first();
        const context = this.contexts.find((x) => contextId === x.id);

        if (!context) {
          throw new Error(`Context ${contextId} not found in registry.`);
        }

        return await context.embeddings.generate.one({
          item,
          trigger: "api",
          config: this._config || ({} as ExuluConfig),
        });
      },
      all: async ({ context: contextId }: { context: string }) => {
        const context = this.contexts.find((x) => contextId === x.id);
        if (!context) {
          throw new Error(`Context ${contextId} not found in registry.`);
        }
        return await context.embeddings.generate.all(
          this._config || ({} as ExuluConfig),
          undefined,
          undefined,
        );
      },
    },
  };

  public bullmq = {
    workers: {
      create: async (queues?: string[] | undefined) => {
        console.log(`
                    ███████╗██╗  ██╗██╗   ██╗██╗      ██╗   ██╗
                    ██╔════╝╚██╗██╔╝██║   ██║██║      ██║   ██║
                    █████╗   ╚███╔╝ ██║   ██║██║      ██║   ██║
                    ██╔══╝   ██╔██╗ ██║   ██║██║      ██║   ██║
                    ███████╗██╔╝ ██╗╚██████╔╝███████╗╚██████╔╝
                    ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝
                    Intelligence Management Platform - Workers

                    `);

        if (!this._config) {
          throw new Error(
            "Config not initialized, make sure to call await ExuluApp.create() first when starting your server.",
          );
        }

        let tracer: Tracer | undefined;

        if (this._config?.telemetry?.enabled) {
          tracer = trace.getTracer("exulu", "1.0.0"); // todo link to Exulu version
        }

        // Either a specific logger transport is defined for workers, or a global one for the entire app, or if
        // no transports are defined, we use the console transport as a default logger fallback.
        const transports = this._config?.workers?.logger?.winston?.transports ??
          this._config?.logger?.winston?.transports ?? [consoleTransport];

        const logger = createLogger({
          enableOtel: this._config?.workers?.telemetry?.enabled ?? false,
          transports,
        });

        console.log = createLogMethod(logger, "info");
        console.info = createLogMethod(logger, "info");
        console.warn = createLogMethod(logger, "warn");
        console.error = createLogMethod(logger, "error");
        console.debug = createLogMethod(logger, "debug");

        // Allow a dev that creates a worker to optionally define
        // a list of queue names the worker should listen to. If not
        // defined, the worker will listen to all queues.
        let filteredQueues = this._queues;
        if (queues) {
          filteredQueues = filteredQueues.filter((q) => queues.includes(q.queue.name));
        }

        // Create ContextSource schedulers
        const contexts = Object.values(this._contexts ?? {});
        let sources: (ExuluContextSource & { context: string })[] = [];
        for (const context of contexts) {
          for (const source of context.sources) {
            sources.push({
              ...source,
              context: context.id,
            });
          }
        }

        if (sources.length > 0) {
          console.log("[EXULU] Creating ContextSource schedulers for", sources.length, "sources.");
          for (const source of sources) {
            const queue = await source.config?.queue;
            if (!queue) {
              console.warn("[EXULU] No queue configured for source", source.name);
              continue;
            }
            if (queue && source.config?.schedule) {
              console.log(
                "[EXULU] Creating ContextSource scheduler for",
                source.name,
                "in queue",
                queue.queue?.name,
              );
              await queue.queue?.upsertJobScheduler(
                source.id,
                {
                  pattern: source.config?.schedule,
                },
                {
                  // default job data
                  name: `${source.id}-job`,
                  data: {
                    source: source.id,
                    context: source.context,
                    type: "source",
                    inputs: {},
                  },
                  opts: {
                    backoff: {
                      type: source.config.backoff?.type || "exponential",
                      delay: source.config.backoff?.delay || 2000,
                    },
                    attempts: source.config.retries || 3,
                    removeOnFail: 200,
                  },
                },
              );
            }
          }
        }

        return await createWorkers(
          this._agents,
          filteredQueues,
          this._config,
          Object.values(this._contexts ?? {}),
          this._rerankers,
          this._evals,
          this._tools,
          tracer,
        );
      },
    },
  };

  private server = {
    express: {
      init: async (): Promise<Express> => {
        if (!this._expressApp) {
          throw new Error("Express app not initialized.");
        }

        const app = this._expressApp;

        let tracer: Tracer | undefined;
        if (this._config?.telemetry?.enabled) {
          tracer = trace.getTracer("exulu", "1.0.0"); // todo link to Exulu version
        }

        const transports = this._config?.logger?.winston?.transports ?? [consoleTransport];

        const logger = createLogger({
          enableOtel: this._config?.telemetry?.enabled ?? false,
          transports,
        });

        console.log = createLogMethod(logger, "info");
        console.info = createLogMethod(logger, "info");
        console.warn = createLogMethod(logger, "warn");
        console.error = createLogMethod(logger, "error");
        console.debug = createLogMethod(logger, "debug");

        if (!this._config) {
          throw new Error(
            "Config not initialized, make sure to call await ExuluApp.create() first when starting your server.",
          );
        }

        await createExpressRoutes(
          app,
          this._agents,
          this._tools,
          Object.values(this._contexts ?? {}),
          this._config,
          this._evals,
          tracer,
          this._queues,
          this._rerankers,
        );

        if (this._config?.MCP.enabled) {
          const mcp = new ExuluMCP();
          await mcp.create({
            express: app,
            allTools: this._tools,
            allAgents: this._agents,
            allContexts: Object.values(this._contexts ?? {}),
            allRerankers: this._rerankers,
            config: this._config,
          });
        }

        return app;
      },
    },
  };
}
