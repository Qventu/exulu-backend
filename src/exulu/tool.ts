import type { Item } from "@EXULU_TYPES/models/item";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { ExuluConfig } from "./app";
import type { User } from "@EXULU_TYPES/models/user";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { randomUUID } from "node:crypto";
import { exuluApp } from "./app/singleton";
import { resolveModel } from "./resolve-model";
import type { ExuluOauthConfig } from "./oauth/types";
import { validateOauthConfig } from "./oauth/validate";
import { oauthRegistry } from "./oauth/registry";
import { wrapExecuteWithOauth } from "./oauth/wrap-execute";

// Tool kinds a package consumer is allowed to declare. "function" is the
// normal custom tool; "web_search" and "skill" are categorization hints that
// don't change how the id is resolved.
export const PUBLIC_TOOL_TYPES = ["function", "web_search", "skill", "context"] as const;
export type PublicToolType = (typeof PUBLIC_TOOL_TYPES)[number];

// "agent" and "context" are framework-managed and intentionally NOT part of
// PublicToolType. Exulu creates these itself: "agent" for agent-as-tool
// instrumentation (ExuluProvider.tool) and "context" for the internal
// retrieval tools. Their id carries a contract — e.g. an "agent" tool's id
// MUST be a real agent UUID, since hydration looks the agent up by it — so a
// consumer setting type:"agent" by mistake produces a UUID lookup crash. Build
// them via ExuluTool.internal() instead of the public constructor.
export type ToolType = PublicToolType | "agent" | "context";

export class ExuluTool {
  // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or
  // underscores and be a max length of 80 characters and at least 5 characters long.
  // The ID is used for storing references to tools so it is important it does not change.
  public id: string;
  public name: string;
  public description: string;
  public category: string;
  public inputSchema?: z.ZodType;
  public type: ToolType;
  public tool: Tool;
  public needsApproval: boolean;
  public oauth?: ExuluOauthConfig;
  public config: {
    name: string;
    description: string;
    type: "boolean" | "string" | "number" | "variable";
    default?: string | boolean | number;
  }[];

  constructor({
    id,
    name,
    description,
    category,
    inputSchema,
    type,
    execute,
    config,
    needsApproval,
    oauth,
  }: {
    id: string;
    name: string;
    description: string;
    category?: string;
    inputSchema?: z.ZodType;
    type: PublicToolType;
    config: {
      name: string;
      description: string;
      type: "boolean" | "string" | "number" | "variable";
      default?: string | boolean | number;
    }[];
    needsApproval?: boolean;
    // When set, Exulu wraps execute with the OAuth 2.0 authorization-code
    // flow: execute only runs with a valid access token for the calling
    // (toolId, userId) — injected as inputs.oauth — and otherwise
    // short-circuits with an authorization URL the agent shows the user.
    oauth?: ExuluOauthConfig;
    // The AI SDK's wrapped tool.execute is invoked with (input, options),
    // where options carries fields like `toolCallId` and `messages`. We
    // expose `options` as a second arg so tools that need it (e.g.
    // image_generation, which needs toolCallId to scope persistence) can
    // read it; tools that don't simply ignore it. Typed loosely as `any`
    // because the AI SDK options shape is provider-specific.
    execute: (inputs: any, options?: any) =>
      | Promise<{
          result?: string;
          job?: string;
          items?: Item[];
        }>
      | AsyncGenerator<{
          result?: string;
          job?: string;
          items?: Item[];
        }>;
  }) {
    // Guard for JS consumers (no compile-time check) and for any cast that
    // sneaks a framework-managed type past the narrowed param type above.
    if (!(PUBLIC_TOOL_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `ExuluTool "${id}": invalid type "${type}". Allowed types are ${PUBLIC_TOOL_TYPES.join(
          ", ",
        )}. The "agent" and "context" types are managed by Exulu internally and cannot be set on a tool.`,
      );
    }
    if (oauth) {
      validateOauthConfig(id, oauth);
      oauthRegistry.register(id, oauth);
    }
    this.oauth = oauth;
    this.id = id;
    this.config = config;
    this.needsApproval = needsApproval ?? true;
    this.category = category || "default";
    this.name = name;
    this.description = description;
    this.inputSchema = inputSchema;
    this.type = type;
    this.tool = tool({
      description: description,
      inputSchema: inputSchema || z.object({}),
      execute: oauth ? wrapExecuteWithOauth(id, oauth, execute) : execute,
    });
  }

  /**
   * Framework-only factory for tools whose `type` is managed by Exulu itself —
   * "agent" (agent-as-tool instrumentation) and "context" (internal retrieval
   * tools). NOT part of the public API: package consumers must use
   * `new ExuluTool(...)`, which only accepts a {@link PublicToolType}. Building
   * the tool as a "function" and then setting the managed type bypasses the
   * constructor guard without weakening it for consumers.
   */
  static internal(
    params: Omit<ConstructorParameters<typeof ExuluTool>[0], "type"> & { type: ToolType },
  ): ExuluTool {
    const instance = new ExuluTool({ ...params, type: "function" });
    instance.type = params.type;
    return instance;
  }

  public execute = async ({
    agent: agentId,
    config,
    user,
    inputs,
    project,
    items,
  }: {
    agent: string;
    config: ExuluConfig;
    user?: User;
    inputs: any;
    project?: string;
    items?: string[];
  }) => {
    console.log("[EXULU] Calling tool execute directly", {
      agentId,
      config,
      user,
      inputs,
      project,
      items,
    });

    const agent = await exuluApp.get().agent(agentId);
    if (!agent) {
      throw new Error("Agent not found.");
    }

    let providerapikey: string | undefined;
    if (agent.model) {
      const providers = exuluApp.get().providers;
      const resolved = await resolveModel({
        modelId: agent.model,
        user,
        providers,
        agent: agent,
        rbacBypass: true,
      });
      providerapikey = resolved.apiKey;
    }

    const { convertExuluToolsToAiSdkTools } = await import(
      "@SRC/templates/tools/convert-exulu-tools-to-ai-sdk-tools"
    );

    const tools = await convertExuluToolsToAiSdkTools(
      [this],
      [],
      [],
      [],
      agent.tools,
      providerapikey,
      undefined,
      undefined,
      user,
      config,
      undefined,
      undefined,
      project,
      items,
      undefined,
      agent,
    );

    const tool = tools[sanitizeName(this.name)] || tools[this.name] || tools[this.id];
    if (!tool?.execute) {
      throw new Error("Tool " + sanitizeName(this.name) + " not found in " + JSON.stringify(tools));
    }

    console.log("[EXULU] Tool found", this.name);

    const toolCallId = this.id + "_" + randomUUID();

    console.log("[EXULU] Calling tool execute", {
      inputs,
      toolCallId,
      messages: [],
    });

    const generator = tool.execute(inputs, {
      toolCallId,
      messages: [],
    });

    let lastValue;
    for await (const chunk of generator) {
      lastValue = chunk;
    }

    if (typeof lastValue === "string") {
      lastValue = JSON.parse(lastValue);
    }
    if (lastValue?.result && typeof lastValue.result === "string") {
      lastValue.result = JSON.parse(lastValue.result);
    }
    return lastValue;
  };
}
