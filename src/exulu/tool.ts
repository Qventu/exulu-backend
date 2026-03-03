import type { Item } from "@EXULU_TYPES/models/item";
import type { Tool } from "ai";
import { tool } from "ai";
import { z } from "zod";
import type { ExuluConfig } from "./app";
import type { User } from "@EXULU_TYPES/models/user";
import { loadAgent } from "src/utils/load-agent";
import { postgresClient } from "src/postgres/client";
import CryptoJS from "crypto-js";
import { convertExuluToolsToAiSdkTools } from "src/templates/tools/convert-exulu-tools-to-ai-sdk-tools";
import { sanitizeName } from "src/utils/sanitize-name";
import { randomUUID } from "node:crypto";

export class ExuluTool {
  // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or
  // underscores and be a max length of 80 characters and at least 5 characters long.
  // The ID is used for storing references to tools so it is important it does not change.
  public id: string;
  public name: string;
  public description: string;
  public category: string;
  public inputSchema?: z.ZodType;
  public type: "context" | "function" | "agent" | "web_search";
  public tool: Tool;
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
  }: {
    id: string;
    name: string;
    description: string;
    category?: string;
    inputSchema?: z.ZodType;
    type: "context" | "function" | "agent" | "web_search";
    config: {
      name: string;
      description: string;
      type: "boolean" | "string" | "number" | "variable";
      default?: string | boolean | number;
    }[];
    execute: (inputs: any) =>
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
    agent,
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
      agent,
      config,
      user,
      inputs,
      project,
      items,
    });

    const agentInstance = await loadAgent(agent);
    if (!agentInstance) {
      throw new Error("Agent not found.");
    }

    const { db } = await postgresClient();

    let providerapikey: string | undefined;
    const variableName = agentInstance.providerapikey;

    if (variableName) {
      console.log("[EXULU] provider api key variable name", variableName);
      // Look up the variable from the variables table
      const variable = await db.from("variables").where({ name: variableName }).first();
      if (!variable) {
        throw new Error(
          "Provider API key variable not found for " +
            agentInstance.name +
            " (" +
            agentInstance.id +
            ").",
        );
      }

      // Get the API key from the variable (decrypt if encrypted)
      providerapikey = variable.value;

      if (!variable.encrypted) {
        throw new Error(
          "Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys.",
        );
      }

      if (variable.encrypted) {
        const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
        providerapikey = bytes.toString(CryptoJS.enc.Utf8);
      }
    }

    const tools = await convertExuluToolsToAiSdkTools(
      [this],
      [],
      [],
      agentInstance.tools,
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
      agentInstance,
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
