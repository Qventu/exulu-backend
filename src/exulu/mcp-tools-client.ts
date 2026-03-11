// Draft: turns all available tools into MCP tools
// to expose to MCP clients such as Claude, enabling
// reusability, and a central MCP middleware for auth,
// audit logs and more.

/* export class ExuluMcpToolsClient {
    public id: string;
    public name: string;
    public url: string;
    private connection: {
        client: Awaited<ReturnType<typeof createMCPClient>>,
        ttl: number
    } | undefined = undefined;
    private headers: Record<string, string> = {};
    private toolsCache: {
        tools: ExuluTool[],
        ttl: number
    } | undefined = {
            tools: [],
            ttl: 0
        };

    constructor({ id, name, url, headers }: {
        id: string,
        name: string,
        url: string,
        headers?: Record<string, string>,
    }) {
        this.id = id;
        this.name = name;
        this.url = url;
        this.headers = headers || {};
    }

    public client = async (): Promise<{
        client: Awaited<ReturnType<typeof createMCPClient>>,
        ttl: number
    }> => {
        const baseUrl = new URL(this.url);

        if (this.connection && this.connection.ttl > Date.now()) {
            return this.connection;
        }

        const maxRetries = 3;

        let lastError: Error | null = null;

        console.log('[EXULU] MCP ' + this.name + ' connecting to ' + baseUrl.toString() + ' with headers: ' + JSON.stringify(this.headers));

        let connection: {
            client: Awaited<ReturnType<typeof createMCPClient>>,
            ttl: number
        } | undefined = undefined;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const isLastAttempt = attempt === maxRetries - 1;
            const ttl = Date.now() + 1000 * 60 * 60 * 1 // 5 minutes
            try {
                const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
                    requestInit: {
                        headers: this.headers
                    }
                });

                const client: Awaited<ReturnType<typeof createMCPClient>> = await createMCPClient({
                    transport,
                });

                console.log('[EXULU] MCP ' + this.name + ' connected using Streamable HTTP transport' + (attempt > 0 ? ` on attempt ${attempt + 1}` : ''));
                connection = {
                    client,
                    ttl
                };
                
            } catch (error) {
                console.error('[EXULU] MCP ' + this.name + ' connection failed', error);
                lastError = error as Error;
            }

            if (!isLastAttempt) {
                const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff with max 10s
                console.log('[EXULU] MCP ' + this.name + ' retrying connection in ' + backoffDelay + 'ms');
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            } else {
                throw lastError;
            }
        }

        if (lastError) {
            console.error('[EXULU] MCP ' + this.name + ' connection failed', lastError);
            throw new Error(lastError.message);
        }

        if (!connection) {
            throw new Error('[EXULU] MCP ' + this.name + ' connection failed');
        }

        this.connection = connection;
        return connection;
    }

    private sanitizeToolName = (name: string) => {
        return name.toLowerCase().replace(/ /g, "_").replace(/[^a-z0-9_]/g, "");
    }

    public tools = async (): Promise<ExuluTool[]> => {
        if (this.toolsCache && this.toolsCache.ttl > Date.now()) {
            return this.toolsCache.tools;
        }
        const connection = await this.client();

        if (!connection) {
            return [];
        }

        const mcpTools = await connection.client.tools() ?? [];

        if (!mcpTools) {
            return [];
        }

        const array: string[] = Object.keys(mcpTools);

        const exuluTools: (ExuluTool | null)[] = await Promise.all(array.map(async (toolName) => {
            const tool = mcpTools[toolName];
            if (!tool) {
                return null;
            }
            return new ExuluTool({
                id: this.name + "_" + this.sanitizeToolName(toolName) as string,
                name: toolName,
                category: this.name,
                config: [],
                execute: tool.execute,
                description: tool.description || "",
                inputSchema: tool.inputSchema,
                type: "function",
            });
        }));

        this.toolsCache = {
            tools: exuluTools.filter(tool => tool !== null) as ExuluTool[],
            ttl: Date.now() + 1000 * 60 * 60 * 1 // 1 hour
        };

        return tools;
    }
} */
