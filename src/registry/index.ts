import { ExuluAgent, ExuluContext, getTableName, type ExuluTool } from "./classes.ts";
import { type Express } from "express"
import { createExpressRoutes } from "./routes.ts";
import { createWorkers } from "./workers.ts";
import { ExuluMCP } from "../mcp";
import express from "express";
import { claudeCodeAgent } from "../templates/agents/claude-code.ts";
import { defaultAgent } from "../templates/agents/claude-opus-4.ts";
import { trace, type Tracer } from "@opentelemetry/api";
import createLogger from "./logger.ts";
import { codeStandardsContext } from "../templates/contexts/code-standards.ts";
import { postgresClient } from "../postgres/client.ts";
import { filesContext } from "../templates/contexts/files.ts";

// Add a helper function to validate PostgreSQL table names
const isValidPostgresName = (id: string): boolean => {
    const regex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    const isValid = regex.test(id);
    const length = id.length;
    return isValid && length <= 80 && length > 5;
};

export type ExuluConfig = {
    telemetry?: {
        enabled: boolean,
    }
    workers: {
        enabled: boolean,
        logsDir?: string,
        telemetry?: {
            enabled: boolean,
        }
    }
    MCP: {
        enabled: boolean,
    },
    fileUploads: {
        s3region: string,
        s3key: string,
        s3secret: string,
        s3Bucket: string,
        s3endpoint?: string,
    }
}

export class ExuluApp {

    private _agents: ExuluAgent[] = []
    private _config?: ExuluConfig;
    private _queues: string[] = []
    private _contexts?: Record<string, ExuluContext> = {}
    private _tools: ExuluTool[] = []
    private _expressApp: Express | null = null;

    constructor() { }

    // Factory function so we can async 
    // initialize the MCP server if needed.
    create = async ({ contexts, agents, config, tools }: {
        contexts?: Record<string, ExuluContext>,
        config: ExuluConfig,
        agents?: ExuluAgent[],
        tools?: ExuluTool[]
    }): Promise<Express> => {

        this._contexts = {
            ...contexts,
            codeStandardsContext,
            filesContext
        };

        this._agents = [
            claudeCodeAgent,
            defaultAgent,
            ...(agents ?? [])
        ];
        this._config = config;

        this._tools = [
            ...(tools ?? []),
            // Add contexts as tools
            ...Object.values(contexts || {}).map(context => context.tool()),
            // Add agents as tools
            ...(agents || []).map(agent => agent.tool())
        ]

        const checks: {
            name: string,
            id: string,
            type: "context" | "agent" | "tool"
        }[] = [
                ...Object.keys(this._contexts || {}).map(x => ({
                    name: this._contexts?.[x]?.name ?? "",
                    id: this._contexts?.[x]?.id ?? "",
                    type: "context" as const
                })),
                ...this._agents.map(agent => ({
                    name: agent.name ?? "",
                    id: agent.id ?? "",
                    type: "agent" as const
                })),
                ...this._tools.map(tool => ({
                    name: tool.name ?? "",
                    id: tool.id ?? "",
                    type: "tool" as const
                }))
            ]

        // Integrate validation into the create method
        const invalid = checks.filter(x => !isValidPostgresName(x?.id ?? ""));
        if (invalid.length > 0) {
            console.error(`%c[EXULU] Invalid ID found for a context, tool or agent: ${invalid.map(x => x.id).join(', ')}. An ID must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or underscores and be a max length of 80 characters and at least 5 characters long.`, 'color: orange; font-weight: bold; \n \n');
            throw new Error(`Invalid ID found for a context, tool or agent: ${invalid.map(x => x.id).join(', ')}. An ID must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or underscores and be a max length of 80 characters and at least 5 characters long.`);
        }

        // todo check for duplicate IDs across tools, agents and contexts

        const contextsArray = Object.values(contexts || {});

        const queues = [
            ...(contextsArray?.length ?
                contextsArray.map(context => context.embedder?.queue?.name || null) :
                []
            )
        ]

        this._queues = [...new Set(queues.filter(o => !!o))] as any;

        if (!this._expressApp) {
            this._expressApp = express();
            await this.server.express.init();
            console.log("[EXULU] Express app initialized.")
        }
        return this._expressApp;
    }

    public get expressApp(): Express {
        if (!this._expressApp) {
            throw new Error("Express app not initialized, initialize it by calling await ExuluApp.create() first.")
        }
        return this._expressApp;
    }

    public tool(id: string): ExuluTool | undefined {
        return this._tools.find(x => x.id === id)
    }

    public tools(): ExuluTool[] {
        return this._tools;
    }

    public context(id: string): ExuluContext | undefined {
        return Object.values(this._contexts ?? {}).find(x => x.id === id)
    }

    public agent(id: string): ExuluAgent | undefined {
        return this._agents.find(x => x.id === id)
    }

    public get contexts(): ExuluContext[] {
        return Object.values(this._contexts ?? {});
    }

    public get agents(): ExuluAgent[] {
        return this._agents;
    }

    public embeddings = {
        generate: {
            one: async ({
                context: contextId,
                item: itemId
            }: {
                context: string,
                item: string
            }) => {
                const { db } = await postgresClient();
                const item = await db.from(getTableName(contextId)).where({ id: itemId }).select("*").first()
                ;
                const context = this.contexts.find(x => contextId === x.id)

                if (!context) {
                    throw new Error(`Context ${contextId} not found in registry.`)
                }

                return await context.embeddings.generate.one({
                    item,
                    trigger: "api"
                })
            },
            all: async ({
                context: contextId
            }: {
                context: string
            }) => {
                const context = this.contexts.find(x => contextId === x.id)
                if (!context) { 
                    throw new Error(`Context ${contextId} not found in registry.`)
                }
                return await context.embeddings.generate.all(undefined, undefined)
            }
        }
    }

    public bullmq = {
        workers: {
            create: async () => {

                let tracer: Tracer | undefined;

                if (this._config?.telemetry?.enabled) {
                    tracer = trace.getTracer("exulu", "1.0.0") // todo link to Exulu version
                }

                const logger = createLogger({
                    enableOtel: this._config?.workers?.telemetry?.enabled ?? false
                })

                return await createWorkers(
                    this._queues,
                    logger,
                    Object.values(this._contexts ?? {}),
                    this._config?.workers?.logsDir,
                    tracer
                )
            }
        }
    }

    private server = {
        express: {
            init: async (): Promise<Express> => {

                if (!this._expressApp) {
                    throw new Error("Express app not initialized.")
                }

                const app = this._expressApp;

                let tracer: Tracer | undefined;
                if (this._config?.telemetry?.enabled) {
                    tracer = trace.getTracer("exulu", "1.0.0") // todo link to Exulu version
                }

                const logger = createLogger({
                    enableOtel: this._config?.telemetry?.enabled ?? false
                })

                await createExpressRoutes(
                    app,
                    logger,
                    this._agents,
                    this._tools,
                    Object.values(this._contexts ?? {}),
                    this._config,
                    tracer
                )

                if (this._config?.MCP.enabled) {
                    const mcp = new ExuluMCP();
                    await mcp.create({
                        express: app,
                        contexts: this._contexts,
                        agents: this._agents,
                        config: this._config,
                        tools: this._tools,
                        tracer,
                        logger
                    });

                    await mcp.connect();
                }

                return app;
            }
        }
    }
}
