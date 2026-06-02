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

export class ExuluTool {
  // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or
  // underscores and be a max length of 80 characters and at least 5 characters long.
  // The ID is used for storing references to tools so it is important it does not change.
  public id: string;
  public name: string;
  public description: string;
  public category: string;
  public inputSchema?: z.ZodType;
  public type: "context" | "function" | "agent" | "web_search" | "skill";
  public tool: Tool;
  public needsApproval: boolean;
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
  }: {
    id: string;
    name: string;
    description: string;
    category?: string;
    inputSchema?: z.ZodType;
    type: "context" | "function" | "agent" | "web_search" | "skill";
    config: {
      name: string;
      description: string;
      type: "boolean" | "string" | "number" | "variable";
      default?: string | boolean | number;
    }[];
    needsApproval?: boolean;
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
      execute,
    });
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
