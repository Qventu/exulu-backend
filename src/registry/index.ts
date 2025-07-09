import { ExuluAgent, ExuluContext, ExuluEmbedder, ExuluWorkflow, type ExuluTool } from "./classes.ts";
import { type Express } from "express"
import { createExpressRoutes } from "./routes.ts";
import { createWorkers } from "./workers.ts";
import { ExuluMCP } from "../mcp";

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
    private _embedders: ExuluEmbedder[] = []
    private _queues: string[] = []
    private _contexts?: Record<string, ExuluContext> = {}
    private _tools: ExuluTool[] = []

    constructor() { }

    // Factory function so we can async initialize the
    // MCP server if needed.
    create = async ({ contexts, embedders, agents, workflows, config, tools }: {
        contexts?: Record<string, ExuluContext>,
        config: ExuluConfig,
        embedders?: ExuluEmbedder[],
        agents?: ExuluAgent[],
        workflows?: ExuluWorkflow[],
        tools?: ExuluTool[]
    }) => {
        this._embedders = embedders ?? [];
        this._workflows = workflows ?? [];
        this._contexts = contexts ?? {};
        this._agents = agents ?? [];
        this._config = config;
        this._tools = tools ?? [];
        const queues = [
            ...(embedders?.length ?
                embedders.map(agent => agent.queue?.name || null) :
                []
            ),
            ...(workflows?.length ?
                workflows.map(workflow => workflow.queue?.name || null) :
                []
            ),
        ]
        this._queues = [...new Set(queues.filter(o => !!o))] as any;
    }

    public embedder(id: string): ExuluEmbedder | undefined {
        return this._embedders.find(x => x.id === id)
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

    public get embedders(): ExuluEmbedder[] {
        return this._embedders;
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

    bullmq = {
        workers: {
            create: async () => {
                return await createWorkers(
                    this._queues,
                    Object.values(this._contexts ?? {}),
                    this._embedders,
                    this._workflows,
                    this._config?.workers?.logsDir
                )
            }
        }
    }
    server = {
        express: {
            init: async (app: Express): Promise<Express> => {

                await createExpressRoutes(
                    app,
                    this._agents,
                    this._embedders,
                    this._tools,
                    this._workflows,
                    Object.values(this._contexts ?? {})
                )

                if (this._config?.MCP.enabled) {
                    const mcp = new ExuluMCP();
                    await mcp.create({
                        express: app,
                        contexts: this._contexts,
                        embedders: this._embedders,
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
