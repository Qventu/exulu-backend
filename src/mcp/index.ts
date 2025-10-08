import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod";
import type { ExuluAgent, ExuluContext, ExuluTool } from "../registry/classes";
import type { ExuluConfig } from "../registry";
import { type Express, type Request, type Response } from "express";
import { type Tracer } from "@opentelemetry/api";
export const SESSION_ID_HEADER = "mcp-session-id";

// Create an MCP server

export class ExuluMCP {

    private server?: McpServer;
    private transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
    private express?: Express;

    constructor() {
    }

    create = async ({ express, contexts, agents, config, tools, tracer }: {
        contexts?: Record<string, ExuluContext>,
        express?: Express,
        config: ExuluConfig,
        agents?: ExuluAgent[],
        tools?: ExuluTool[],
        tracer?: Tracer
    }) => {
        this.express = express;

        if (!this.server) {
            console.log("[EXULU] Creating MCP server.");
            this.server = new McpServer({
                name: "exulu-mcp-server",
                version: "1.0.0"
            });
        }

        // Add an addition tool
        this.server.registerTool("getAgents",
            {
                title: "Get agents",
                description: "Retrieves a list of all available agents"
            },
            async () => ({
                content: agents ? agents.map(agent => {
                    return {
                        type: "text",
                        text: `${agent.name} - ${agent.description}`
                    }
                }) : [{
                    type: "text",
                    text: "No agents found."
                }]
            })
        );

        // Add a dynamic greeting resource
        this.server.registerResource(
            "greeting",
            new ResourceTemplate("greeting://{name}", { list: undefined }),
            {
                title: "Greeting Resource",      // Display name for UI
                description: "Dynamic greeting generator"
            },
            async (uri, { name }) => ({
                contents: [{
                    uri: uri.href,
                    text: `Hello, ${name}!`
                }]
            })
        );

        this.server.registerPrompt(
            "review-code",
            {
                title: "Code Review",
                description: "Review code for best practices and potential issues",
                argsSchema: { code: z.string() }
            },
            ({ code }) => ({
                messages: [{
                    role: "user",
                    content: {
                        type: "text",
                        text: `Please review this code:\n\n${code}`
                    }
                }]
            })
        );
    }

    connect = async (): Promise<Express> => {
        if (!this.express) {
            throw new Error("Express not initialized.");
        }

        if (!this.server) {
            throw new Error("MCP server not initialized.");
        }

        // Handle POST requests for client-to-server communication
        this.express.post('/mcp', async (req, res) => {

            if (!this.server) {
                throw new Error("MCP server not initialized.");
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
                await this.server.connect(transport);
            } else {
                // Invalid request
                res.status(400).json({
                    error: 'Bad Request: No valid session ID provided',
                });
                return;
            }

            // Handle the request
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
        this.express.get('/mcp', handleSessionRequest);
        // Handle DELETE requests for session termination
        this.express.delete('/mcp', handleSessionRequest);
        return this.express;
    }

}
