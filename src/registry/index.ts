import { ExuluAgent, ExuluContext, type ExuluTool } from "./classes.ts";
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
            codeStandardsContext
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

    public bullmq = {
        workers: {
            create: async () => {

                let tracer: Tracer | undefined;

                if (this._config?.telemetry?.enabled) {
                    console.log("[EXULU] telemetry enabled")
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
                    throw new Error("Express app not initialized")
                }

                const app = this._expressApp;

                let tracer: Tracer | undefined;
                if (this._config?.telemetry?.enabled) {
                    console.log("[EXULU] telemetry enabled")
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
