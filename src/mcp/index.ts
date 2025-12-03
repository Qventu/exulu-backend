import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { convertToolsArrayToObject, ExuluAgent, ExuluContext, sanitizeToolName, type ExuluTool } from "../registry/classes";
import { type Express, type Request, type Response } from "express";
import { type Tracer } from "@opentelemetry/api";
import { requestValidators } from "../registry/route-validators";
import { checkRecordAccess, getEnabledTools, loadAgent } from "../registry/utils";
import { postgresClient } from "../postgres/client";
export const SESSION_ID_HEADER = "mcp-session-id";
import CryptoJS from 'crypto-js';
import type { ExuluConfig } from "../registry";
import type { Agent } from "@EXULU_TYPES/models/agent";
import type { User } from "@EXULU_TYPES/models/user";
import { z } from "zod";
// Create an MCP server

export class ExuluMCP {

    private server: Record<string, {
        mcp: McpServer,
        tools: Record<string, any>,
    }> = {};
    private transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    constructor() {
    }

    private configure = async ({ user, agentInstance, allTools, allAgents, allContexts, config, tracer }: {
        agentInstance: Agent,
        user: User,
        tracer?: Tracer,
        allTools: ExuluTool[],
        allAgents: ExuluAgent[],
        allContexts: ExuluContext[],
        config: ExuluConfig,
    }): Promise<McpServer> => {

        let server = this.server[agentInstance.id];

        if (!server) {
            console.log("[EXULU] Creating MCP server.");
            server = {
                mcp: new McpServer({
                    name: "exulu-mcp-server-" + agentInstance.name + "(" + agentInstance.id + ")",
                    version: "1.0.0"
                }), tools: {}
            };
            this.server[agentInstance.id] = server;
        }

        const disabledTools = []
        let enabledTools: ExuluTool[] = await getEnabledTools(agentInstance, allTools, disabledTools, allAgents, user)

        const backend = allAgents.find(a => a.id === agentInstance.backend);

        if (!backend) {
            throw new Error("Agent backend not found for agent " + agentInstance.name + " (" + agentInstance.id + ").");
        }

        // Add the agent itself as a tool so MCP clients can also call the
        // agent directly, instead of just its tools.
        const agentTool = await backend.tool(agentInstance.id, allAgents)

        if (agentTool) {
            enabledTools = [
                ...enabledTools,
                agentTool
            ]
        }

        // Get the variable name from user's anthropic_token field
        const variableName = agentInstance.providerapikey;

        const { db } = await postgresClient();

        let providerapikey: string | undefined;

        // Look up the variable from the variables table
        if (variableName) {
            const variable = await db.from("variables").where({ name: variableName }).first();

            if (!variable) {
                throw new Error("Provider API key variable not found for " + agentInstance.name + " (" + agentInstance.id + ").");
            }

            // Get the API key from the variable (decrypt if encrypted)
            providerapikey = variable.value;

            if (!variable.encrypted) {
                throw new Error("Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys.");
            }

            if (variable.encrypted) {
                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                providerapikey = bytes.toString(CryptoJS.enc.Utf8);
            }
        }

        console.log("[EXULU] Enabled tools", enabledTools?.map(x => x.name + " (" + x.id + ")"))

        for (const tool of enabledTools || []) {
            if (server.tools[tool.id]) {
                continue;
            }

            server.mcp.registerTool(sanitizeToolName(tool.name + "_agent_" + tool.id), {
                title: tool.name + " agent",
                description: tool.description,
                inputSchema: {
                    inputs: tool.inputSchema || z.object({})
                }
            }, async ({ inputs }, args): Promise<any> => {

                console.log("[EXULU] MCP tool name", tool.name)
                console.log("[EXULU] MCP tool inputs", inputs)
                console.log("[EXULU] MCP tool args", args)

                const configValues = agentInstance.tools;

                const tools = await convertToolsArrayToObject(
                    [tool],
                    allTools,
                    configValues,
                    providerapikey,
                    allContexts,
                    user,
                    config
                )

                const convertedTool = tools[sanitizeToolName(tool.name)];

                if (!convertedTool?.execute) {
                    console.error("[EXULU] Tool not found in converted tools array.", tools);
                    throw new Error("Tool not found in converted tools array.");
                }

                const iterator = await convertedTool.execute(inputs, {
                    toolCallId: tool.id + "_" + randomUUID(),
                    messages: []
                })

                let result;
                for await (const value of iterator) {
                    result = value; // keep overwriting, the last one is the final return
                }

                console.log("[EXULU] MCP tool result", result)

                return {
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                    structuredContent: result
                };
            });

            server.tools[tool.id] = tool.name;
        }

        // Register prompt template tools
        const getListOfPromptTemplatesName = "getListOfPromptTemplates";
        if (!server.tools[getListOfPromptTemplatesName]) {
            server.mcp.registerTool(getListOfPromptTemplatesName, {
                title: "Get List of Prompt Templates",
                description: "Retrieves a list of prompt templates available for this agent. Returns the name, description, and ID of each template.",
                inputSchema: {
                    inputs: z.object({})
                }
            }, async ({ inputs }, args): Promise<any> => {
                console.log("[EXULU] Getting list of prompt templates for agent", agentInstance.id);

                const { db } = await postgresClient();

                // Query prompts assigned to this agent
                const prompts = await db.from("prompt_library")
                    .select("id", "name", "description")
                    .whereRaw("assigned_agents @> ?::jsonb", [JSON.stringify(agentInstance.id)])
                    .orderBy("updatedAt", "desc");

                console.log("[EXULU] Found", prompts.length, "prompt templates");

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            prompts: prompts.map(p => ({
                                id: p.id,
                                name: p.name,
                                description: p.description || "No description provided"
                            })),
                            count: prompts.length
                        }, null, 2)
                    }],
                    structuredContent: {
                        prompts: prompts.map(p => ({
                            id: p.id,
                            name: p.name,
                            description: p.description || "No description provided"
                        })),
                        count: prompts.length
                    }
                };
            });
        }

        const getPromptTemplateDetailsName = "getPromptTemplateDetails";
        if (!server.tools[getPromptTemplateDetailsName]) {
            server.mcp.registerTool(getPromptTemplateDetailsName, {
                title: "Get Prompt Template Details",
                description: "Retrieves the full details of a specific prompt template by ID, including the actual template content with variables.",
                inputSchema: {
                    inputs: z.object({
                        id: z.string().describe("The ID of the prompt template to retrieve")
                    })
                }
            }, async ({ inputs }, args): Promise<any> => {
                console.log("[EXULU] Getting prompt template details for ID", inputs.id);

                const { db } = await postgresClient();

                // Query the specific prompt
                const prompt = await db.from("prompt_library")
                    .select("id", "name", "description", "content", "createdAt", "updatedAt", "usage_count", "favorite_count")
                    .where({ id: inputs.id })
                    .first();

                if (!prompt) {
                    throw new Error(`Prompt template with ID ${inputs.id} not found`);
                }

                // Check if this prompt is assigned to the current agent
                const isAssignedToAgent = await db.from("prompt_library")
                    .select("id")
                    .where({ id: inputs.id })
                    .whereRaw("assigned_agents @> ?::jsonb", [JSON.stringify(agentInstance.id)])
                    .first();

                console.log("[EXULU] Prompt template found:", prompt.name);

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            id: prompt.id,
                            name: prompt.name,
                            description: prompt.description || "No description provided",
                            content: prompt.content,
                            createdAt: prompt.createdAt,
                            updatedAt: prompt.updatedAt,
                            usageCount: prompt.usage_count || 0,
                            favoriteCount: prompt.favorite_count || 0,
                            isAssignedToThisAgent: !!isAssignedToAgent
                        }, null, 2)
                    }],
                    structuredContent: {
                        id: prompt.id,
                        name: prompt.name,
                        description: prompt.description || "No description provided",
                        content: prompt.content,
                        createdAt: prompt.createdAt,
                        updatedAt: prompt.updatedAt,
                        usageCount: prompt.usage_count || 0,
                        favoriteCount: prompt.favorite_count || 0,
                        isAssignedToThisAgent: !!isAssignedToAgent
                    }
                };
            });
        }

        server.tools[getListOfPromptTemplatesName] = getListOfPromptTemplatesName;
        server.tools[getPromptTemplateDetailsName] = getPromptTemplateDetailsName;

        return server.mcp;
    }

    create = async ({ express, allTools, allAgents, allContexts, config }: {
        express: Express,
        allTools: ExuluTool[],
        allAgents: ExuluAgent[],
        allContexts: ExuluContext[],
        config: ExuluConfig,
    }): Promise<Express> => {

        if (!express) {
            throw new Error("Express not initialized.");
        }

        if (!this.server) {
            throw new Error("MCP server not initialized.");
        }

        // Handle POST requests for client-to-server communication
        express.post("/mcp/:agent", async (req, res) => {

            console.log("[EXULU] MCP request received.", req.params.agent)

            if (!req.params.agent) {
                res.status(400).json({
                    error: 'Bad Request: No agent ID provided',
                });
                return;
            }

            const agentInstance = await loadAgent(req.params.agent);

            if (!agentInstance) {
                console.error("[EXULU] Agent not found.", req.params.agent)
                res.status(404).json({
                    error: 'Agent not found',
                });
                return;
            }

            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            const user = authenticationResult.user;

            const hasAccessToAgent = await checkRecordAccess(agentInstance, "read", user);

            if (!hasAccessToAgent) {
                res.status(401).json({
                    message: "You don't have access to this agent."
                })
                return;
            }

            const server = await this.configure({
                agentInstance,
                user,
                allTools,
                allAgents,
                allContexts,
                config,
            })

            if (!server) {
                throw new Error("MCP server for agent " + req.params.agent + " not initialized.");
            }

            // Check for existing session ID
            const sessionId = req.headers[SESSION_ID_HEADER] as string | undefined;

            let transport: StreamableHTTPServerTransport;

            if (sessionId && this.transports[sessionId]) {
                // Reuse existing transport
                transport = this.transports[sessionId];
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // New initialization request
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (sessionId) => {
                        // Store the transport by session ID
                        this.transports[sessionId] = transport;
                    },
                    // DNS rebinding protection is disabled by default for backwards compatibility. If you are running this server
                    // locally, make sure to set:
                    // enableDnsRebindingProtection: true,
                    // allowedHosts: ['127.0.0.1'],
                });

                // Clean up transport when closed
                transport.onclose = () => {
                    if (transport.sessionId) {
                        delete this.transports[transport.sessionId];
                    }
                };
                // Connect to the MCP server
                await server.connect(transport);
            } else {
                // Invalid request
                res.status(400).json({
                    error: 'Bad Request: No valid session ID provided',
                });
                return;
            }

            req.headers["exulu-agent-id"] = req.params.agent;

            await transport.handleRequest(req, res, req.body);
        });

        // Reusable handler for GET and DELETE requests
        const handleSessionRequest = async (req: Request, res: Response) => {
            const sessionId = req.headers[SESSION_ID_HEADER] as string | undefined;
            if (!sessionId || !this.transports[sessionId]) {
                console.log("[EXULU] MCP request invalid or missing session ID");
                res.status(400).send('Invalid or missing session ID');
                return;
            }

            const transport = this.transports[sessionId];
            await transport.handleRequest(req, res);
        };

        // Handle GET requests for server-to-client notifications via SSE
        express.get("/mcp/:agent", handleSessionRequest);
        // Handle DELETE requests for session termination
        express.delete("/mcp/:agent", handleSessionRequest);

        console.log("[EXULU] MCP server created.")
        return express;
    }

}
