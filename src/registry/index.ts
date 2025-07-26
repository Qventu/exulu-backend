import { ExuluAgent, ExuluContext, ExuluEmbedder, ExuluWorkflow, type ExuluTool } from "./classes.ts";
import { type Express } from "express"
import { createExpressRoutes } from "./routes.ts";
import { createWorkers } from "./workers.ts";
import { ExuluMCP } from "../mcp";
import express from "express";
import { claudeCodeAgent } from "../templates/agents/claude-code.ts";
import { defaultAgent } from "../templates/agents/default-agent.ts";

export type ExuluConfig = {
    workers: {
        enabled: boolean,
        logsDir?: string,
    }
    MCP: {
        enabled: boolean,
    }
}

export class ExuluApp {

    private _agents: ExuluAgent[] = []
    private _workflows: ExuluWorkflow[] = []
    private _config?: ExuluConfig;
    private _queues: string[] = []
    private _contexts?: Record<string, ExuluContext> = {}
    private _tools: ExuluTool[] = []
    private _expressApp: Express | null = null;

    constructor() { }

    // Factory function so we can async 
    // initialize the MCP server if needed.
    create = async ({ contexts, agents, workflows, config, tools }: {
        contexts?: Record<string, ExuluContext>,
        config: ExuluConfig,
        agents?: ExuluAgent[],
        workflows?: ExuluWorkflow[],
        tools?: ExuluTool[]
    }): Promise<Express> => {

        this._workflows = workflows ?? [];
        this._contexts = contexts ?? {};
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
                contextsArray.map(context => context.embedder.queue?.name || null) :
                []
            ),
            ...(workflows?.length ?
                workflows.map(workflow => workflow.queue?.name || null) :
                []
            ),
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

    public workflow(id: string): ExuluWorkflow | undefined {
        return this._workflows.find(x => x.id === id)
    }

    public get contexts(): ExuluContext[] {
        return Object.values(this._contexts ?? {});
    }

    public get workflows(): ExuluWorkflow[] {
        return this._workflows;
    }

    public get agents(): ExuluAgent[] {
        return this._agents;
    }

    public bullmq = {
        workers: {
            create: async () => {
                return await createWorkers(
                    this._queues,
                    Object.values(this._contexts ?? {}),
                    this._workflows,
                    this._config?.workers?.logsDir
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

                await createExpressRoutes(
                    app,
                    this._agents,
                    this._tools,
                    this._workflows,
                    Object.values(this._contexts ?? {})
                )

                if (this._config?.MCP.enabled) {
                    const mcp = new ExuluMCP();
                    await mcp.create({
                        express: app,
                        contexts: this._contexts,
                        agents: this._agents,
                        workflows: this._workflows,
                        config: this._config,
                        tools: this._tools
                    });
                    await mcp.connect();
                }

                return app;
            }
        }
    }
}
