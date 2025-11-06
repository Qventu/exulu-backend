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

        // Look up the variable from the variables table
        const variable = await db.from("variables").where({ name: variableName }).first();

        if (!variable) {
            throw new Error("Provider API key variable not found.");
        }

        // Get the API key from the variable (decrypt if encrypted)
        let providerapikey = variable.value;

        if (!variable.encrypted) {
            throw new Error("Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys.");
        }

        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            providerapikey = bytes.toString(CryptoJS.enc.Utf8);
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

                const tools = convertToolsArrayToObject(
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
