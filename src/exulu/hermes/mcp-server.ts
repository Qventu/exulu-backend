import type { Express, Request, Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { exuluApp } from "../app/singleton.ts";
import type { ExuluConfig } from "../app/index.ts";
import { getEnabledTools } from "../../utils/enabled-tools.ts";
import { sanitizeName } from "../../utils/sanitize-name.ts";
import {
  getExuluMcpBaseUrl,
  getExuluMcpKey,
  isHermesEnabled,
} from "./config";
import {
  listWorkspaceFiles,
  readWorkspaceText,
  writeWorkspaceFile,
} from "./workspace-store";

/**
 * Exposes an agent's enabled ExuluTools to a Hermes gateway over HTTP MCP, at
 * `/mcp/:agentId`. These ADD to Hermes' native tools (bash, filesystem, …) —
 * they do not replace them.
 *
 * Each Exulu tool becomes an MCP tool; a `tools/call` runs the same
 * `ExuluTool.execute()` path used everywhere else (variable hydration, context
 * search, etc.). Tools execute with agent-level context (no specific user),
 * which covers context search, web search, and custom tools configured on the
 * agent. The transport is stateless: a fresh MCP server is built per request
 * from the agent's current tool set, so there is no connection state to manage.
 *
 * Auth: a bearer token the provisioner also writes into the profile's
 * config.yaml `mcp_servers` header. Defaults to LITELLM_MASTER_KEY so no new
 * secret is required, overridable via EXULU_MCP_KEY.
 *
 * Design doc: docs/superpowers/specs/2026-06-03-hermes-agent-mode-design.md
 */

const log = (line: string) => console.log(`[EXULU-HERMES-MCP] ${line}`);

/**
 * Register the shared-workspace file tools on the MCP server. They operate on
 * the agent's host workspace dir — the same folder the Files panel shows — so
 * the agent and the user share one folder, independent of the agent's private
 * container filesystem.
 */
const registerWorkspaceFileTools = (server: McpServer, agentId: string): void => {
  server.registerTool(
    "list_shared_files",
    {
      description:
        "List files in the shared workspace the user sees in the Files panel " +
        "(their uploads + files you've saved there). Use this to find files the " +
        "user refers to.",
    },
    async () => {
      const files = await listWorkspaceFiles(agentId);
      const text = files.length
        ? files.map((f) => `${f.path} (${f.size} bytes)`).join("\n")
        : "(no files in the shared workspace yet)";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "read_shared_file",
    {
      description:
        "Read a UTF-8 text file from the shared workspace by its path (as shown " +
        "by list_shared_files).",
      inputSchema: { path: z.string().describe("Workspace-relative file path") },
    },
    async ({ path }: { path: string }) => {
      const content = await readWorkspaceText(agentId, path);
      if (content === undefined) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${path}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: content }] };
    },
  );

  server.registerTool(
    "write_shared_file",
    {
      description:
        "Save a text file to the shared workspace so the user can see and " +
        "download it in the Files panel. Use this for any deliverable you want " +
        "the user to keep (summaries, reports, generated code, etc.).",
      inputSchema: {
        path: z.string().describe("Workspace-relative file path, e.g. summary.md"),
        content: z.string().describe("Full file contents"),
      },
    },
    async ({ path, content }: { path: string; content: string }) => {
      try {
        await writeWorkspaceFile(agentId, path, Buffer.from(content, "utf8"));
        return {
          content: [
            {
              type: "text" as const,
              text: `Saved ${path} to the shared workspace (visible in the Files panel).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
};

/** Build an MCP server exposing the agent's enabled ExuluTools. */
const buildServerForAgent = async (
  agentId: string,
  config: ExuluConfig,
): Promise<McpServer | undefined> => {
  const app = exuluApp.get();
  const agent = await app.agent(agentId);
  if (!agent) return undefined;

  const tools = await getEnabledTools(
    agent,
    app.tools(),
    app.contexts ?? [],
    undefined,
    [],
    app.providers,
    undefined,
  );

  const server = new McpServer({ name: "exulu-tools", version: "1.0.0" });

  // Shared-workspace file tools. These bridge the agent to the SAME folder the
  // user sees in the Files panel (the host workspace dir), independent of the
  // agent's private container filesystem. The agent uses these for any file it
  // wants the user to see / for files the user uploaded. Keyed by agentId (the
  // agent-level workspace).
  registerWorkspaceFileTools(server, agentId);

  for (const tool of tools) {
    const name = sanitizeName(tool.name);
    // registerTool wants a Zod *raw shape*; ExuluTool.inputSchema is usually a
    // ZodObject. Fall back to no-args when it isn't an object schema.
    const shape =
      tool.inputSchema instanceof z.ZodObject
        ? (tool.inputSchema.shape as z.ZodRawShape)
        : undefined;

    server.registerTool(
      name,
      {
        description: tool.description || tool.name,
        ...(shape ? { inputSchema: shape } : {}),
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.execute({
            agent: agentId,
            config,
            inputs: args ?? {},
          });
          const text =
            typeof result === "string" ? result : JSON.stringify(result);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            content: [
              { type: "text" as const, text: `Error: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      },
    );
  }

  return server;
};

const handleMcpPost = async (
  req: Request,
  res: Response,
  config: ExuluConfig,
): Promise<void> => {
  const key = getExuluMcpKey();
  const auth = req.headers["authorization"];
  if (!key || auth !== `Bearer ${key}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const agentId = req.params.agentId;
  if (!agentId) {
    res.status(400).json({ error: "Missing agent id" });
    return;
  }
  const server = await buildServerForAgent(agentId, config);
  if (!server) {
    res.status(404).json({ error: `Agent ${agentId} not found` });
    return;
  }

  // Stateless: a transport per request, torn down when the response closes.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};

/**
 * Mount the ExuluTools MCP endpoint. No-op unless ENABLE_HERMES_AGENT is set.
 * The global express.json() middleware already populates req.body.
 */
export const registerExuluMcpRoute = (app: Express, config: ExuluConfig): void => {
  if (!isHermesEnabled()) return;

  app.post("/mcp/:agentId", (req: Request, res: Response) => {
    handleMcpPost(req, res, config).catch((err) => {
      log(`MCP request error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal MCP server error" });
      }
    });
  });

  // Stateless server: GET (SSE) and DELETE (session teardown) are not supported.
  const methodNotAllowed = (_req: Request, res: Response) =>
    res.status(405).json({ error: "Method not allowed (stateless MCP server)" });
  app.get("/mcp/:agentId", methodNotAllowed);
  app.delete("/mcp/:agentId", methodNotAllowed);

  log(`ExuluTools MCP endpoint mounted at ${getExuluMcpBaseUrl()}/mcp/:agentId`);
};
