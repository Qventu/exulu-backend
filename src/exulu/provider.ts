import type { ExuluProviderConfig } from "@EXULU_TYPES/provider-config.ts";
import type { imageTypes } from "@EXULU_TYPES/models/agent";
import type { fileTypes } from "@EXULU_TYPES/models/agent";
import type { audioTypes } from "@EXULU_TYPES/models/agent";
import type { videoTypes } from "@EXULU_TYPES/models/agent";
import type { RateLimiterRule } from "@EXULU_TYPES/models/rate-limiter-rules.ts";
import { z } from "zod";
import { ExuluTool } from "./tool.ts";
import { updateStatistic } from "./statistics.ts";
import type { ExuluContext } from "./context.ts";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config.ts";
import {
  convertToModelMessages,
  generateObject,
  generateText,
  type LanguageModel,
  streamText,
  type UIMessage,
  validateUIMessages,
  stepCountIs,
} from "ai";
import { generateSlug } from "@SRC/utils/generate-slug";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import { getEnabledTools } from "@SRC/utils/enabled-tools";
import { postgresClient } from "@SRC/postgres/client";
import CryptoJS from "crypto-js";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import type { ExuluReranker } from "./reranker.ts";
import type { ExuluStatisticParams } from "@EXULU_TYPES/statistics.ts";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config.ts";
import { convertExuluToolsToAiSdkTools } from "@SRC/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts";
import { parseOfficeAsync } from "officeparser";
import type { ExuluConfig } from "./app/index.ts";
import { createNewMemoryItemTool } from "@SRC/templates/tools/memory-tool.ts";
import type { Request } from "express";
import { exuluApp } from "./app/singleton.ts";
import { checkLicense } from "@EE/entitlements.ts";

export type ExuluProviderWorkflowConfig = {
  enabled: boolean;
  queue?: Promise<ExuluQueueConfig>;
};

interface ExuluProviderParams {
  id: string;
  name: string;
  type: "agent";
  description: string;
  config?: ExuluProviderConfig | undefined;
  queue?: ExuluQueueConfig;
  maxContextLength?: number;
  authenticationInformation?: string;
  provider: string;
  workflows?: ExuluProviderWorkflowConfig;
  capabilities?: {
    text: boolean;
    images: imageTypes[];
    files: fileTypes[];
    audio: audioTypes[];
    video: videoTypes[];
  };
  outputSchema?: z.ZodType;
  rateLimit?: RateLimiterRule;
}

export class ExuluProvider {
  // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or
  // underscores and be a max length of 80 characters and at least 5 characters long.
  // The ID is used for storing references to agents so it is important it does not change.
  public id: string;
  public name: string;
  public provider: string;
  public description: string = "";
  public slug: string = "";
  public type: "agent";
  public streaming: boolean = false;
  public authenticationInformation?: string;
  public maxContextLength?: number;
  public workflows?: ExuluProviderWorkflowConfig;
  public queue?: ExuluQueueConfig;
  public rateLimit?: RateLimiterRule;
  public config?: ExuluProviderConfig | undefined;
  public model?: {
    create: ({ apiKey }: { apiKey?: string | undefined }) => LanguageModel;
  };
  public capabilities: {
    text: boolean;
    images: string[];
    files: string[];
    audio: string[];
    video: string[];
  };

  constructor({
    id,
    name,
    description,
    config,
    rateLimit,
    capabilities,
    type,
    maxContextLength,
    provider,
    queue,
    authenticationInformation,
    workflows,
  }: ExuluProviderParams) {
    this.id = id;
    this.name = name;
    this.workflows = workflows;
    this.description = description;
    this.rateLimit = rateLimit;
    this.provider = provider;
    this.authenticationInformation = authenticationInformation;
    this.config = config;
    this.type = type;
    this.maxContextLength = maxContextLength;
    this.queue = queue;
    this.capabilities = capabilities || {
      text: false,
      images: [],
      files: [],
      audio: [],
      video: [],
    };
    this.slug = `/agents/${generateSlug(this.name)}/run`;
    this.model = this.config?.model;
  }

  get providerName(): string {
    if (!this.config?.model?.create) {
      return "";
    }
    return this.provider;
  }

  get modelName(): string {
    if (!this.config?.model?.create) {
      return "";
    }
    return this.config?.name || "";
  }

  // Exports the agent as a tool that can be used by another agent
  public tool = async (
    instance: string,
    providers: ExuluProvider[],
    contexts: ExuluContext[],
    rerankers: ExuluReranker[],
  ): Promise<ExuluTool | null> => {

    const agent = await exuluApp.get().agent(instance);

    if (!agent) {
      return null;
    }

    const license = checkLicense()

    if (!license["multi-agent-tooling"]) {
      console.warn(`[EXULU] You are not licensed to use multi-agent tooling so cannot export this agent as a tool. Please set your EXULU_ENTERPRISE_LICENSE env variable.`);
    }

    return new ExuluTool({
      id: agent.id,
      name: `${agent.name}`,
      type: "agent",
      category: "agents",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe("The prompt (usually a question for the agent) to send to the agent."),
        information: z
          .string()
          .describe("A summary of relevant context / information from the current session"),
      }),
      description: `This tool calls an AI agent named: ${agent.name}. The agent does the following: ${agent.description}.`,
      config: [],
      execute: async ({ prompt, information, user, allExuluTools }: any) => {
        const hasAccessToAgent = await checkRecordAccess(agent, "read", user);

        if (!hasAccessToAgent) {
          throw new Error("You don't have access to this agent.");
        }

        let enabledTools: ExuluTool[] = await getEnabledTools(
          agent,
          allExuluTools,
          contexts,
          rerankers,
          [],
          providers,
          user,
        );

        // Get the variable name from user's anthropic_token field
        const variableName = agent.providerapikey;

        let providerapikey: string | undefined;

        if (variableName) {
          const { db } = await postgresClient();
          // Look up the variable from the variables table
          const variable = await db.from("variables").where({ name: variableName }).first();
          if (!variable) {
            throw new Error(
              "Provider API key variable not found for agent: " +
              agent.name +
              " (" +
              agent.id +
              ") being called as a tool.",
            );
          }

          // Get the API key from the variable (decrypt if encrypted)
          providerapikey = variable.value;

          if (!variable.encrypted) {
            throw new Error(
              "Provider API key variable not encrypted for agent: " +
              agent.name +
              " (" +
              agent.id +
              ") being called as a tool, for security reasons you are only allowed to use encrypted variables for provider API keys.",
            );
          }

          if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            providerapikey = bytes.toString(CryptoJS.enc.Utf8);
          }
        }
        console.log(
          "[EXULU] Enabled tools for agent '" +
          agent.name +
          " (" +
          agent.id +
          ")" +
          " that is being called as a tool",
          enabledTools.map((x) => x.name + " (" + x.id + ")"),
        );
        console.log(
          "[EXULU] Prompt for agent '" + agent.name + "' that is being called as a tool",
          prompt.slice(0, 100) + "...",
        );
        console.log(
          "[EXULU] Instructions for agent '" +
          agent.name +
          "' that is being called as a tool",
          agent.instructions?.slice(0, 100) + "...",
        );

        // todo cant use outputSchema when calling an agent as a tool for now, maybe look into
        // enabling this in the future by adding a "outputSchema" field to the inputSchema of this
        // tool definition so agents can dynamically define a desired output schema.
        const response = await this.generateSync({
          agent: agent,
          contexts: contexts,
          rerankers: rerankers,
          instructions: agent.instructions,
          prompt:
            "The user has asked the following question: " +
            prompt +
            " and the following information is available: " +
            information,
          providerapikey: providerapikey,
          user,
          currentTools: enabledTools,
          allExuluTools: allExuluTools,
          statistics: {
            label: agent.name,
            trigger: "tool",
          },
        });

        await updateStatistic({
          name: "count",
          label: agent.name,
          type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
          trigger: "tool",
          count: 1,
          user: user?.id,
          role: user?.role?.id,
        });

        return {
          result: response,
        };
      },
    });
  };

  generateSync = async ({
    prompt,
    req,
    user,
    session,
    inputMessages,
    currentTools,
    allExuluTools,
    statistics,
    toolConfigs,
    providerapikey,
    contexts,
    rerankers,
    exuluConfig,
    outputSchema,
    agent,
    instructions,
  }: {
    prompt?: string;
    user?: User;
    req?: Request;
    session?: string;
    agent?: ExuluAgent;
    inputMessages?: UIMessage[];
    currentTools?: ExuluTool[];
    allExuluTools?: ExuluTool[];
    statistics?: ExuluStatisticParams;
    toolConfigs?: ExuluAgentToolConfig[];
    providerapikey?: string | undefined;
    contexts?: ExuluContext[] | undefined;
    rerankers?: ExuluReranker[] | undefined;
    exuluConfig?: ExuluConfig;
    instructions?: string;
    outputSchema?: z.ZodType;
    // todo get rid of any
  }): Promise<any> => {
    console.log(
      "[EXULU] Called generate sync for agent: " + this.name,
      "with prompt: " + prompt?.slice(0, 100) + "...",
    );

    if (!this.model) {
      throw new Error("Model is required for streaming.");
    }

    if (!this.config) {
      throw new Error("Config is required for generating.");
    }

    if (prompt && inputMessages?.length) {
      throw new Error("Message and prompt cannot be provided at the same time.");
    }

    if (!prompt && !inputMessages?.length) {
      throw new Error("Prompt or message is required for generating.");
    }

    if (outputSchema && !prompt) {
      throw new Error("Prompt is required for generating with an output schema.");
    }

    const model = this.model.create({
      ...(providerapikey ? { apiKey: providerapikey } : {}),
    });

    console.log("[EXULU] Model for agent: " + this.name, " created for generating sync.");

    let messages: UIMessage[] = inputMessages || [];
    if (messages && session && user) {
      // load the previous messages from the server:
      const previousMessages = await getAgentMessages({
        session,
        user: user.id,
        limit: 50,
        page: 1,
      });

      const previousMessagesContent = previousMessages.map((message) =>
        JSON.parse(message.content),
      );
      // validate messages
      messages = await validateUIMessages({
        // append the new message to the previous messages:
        messages: [...previousMessagesContent, ...messages],
      });
    }

    console.log(
      "[EXULU] Message count for agent: " + this.name,
      "loaded for generating sync.",
      messages.length,
    );

    let project: string | undefined;
    let sessionItems: string[] | undefined;
    if (session) {
      const sessionData = await getSession({ sessionID: session });
      sessionItems = sessionData.session_items;
      project = sessionData.project;
    }

    const query = prompt;

    // If memory context was configured for the agent, we retrieve
    // relevant memory items and add it to the genericContext
    let memoryContext = "";
    if (agent?.memory && contexts?.length && query) {

      const context = contexts.find((context) => context.id === agent?.memory);
      if (!context) {
        throw new Error(
          "Context was set for agent memory but not found in the contexts: " +
          agent?.memory +
          " please double check with a developer to see if the context was removed from code.",
        );
      }

      const result = await context?.search({
        query: query,
        itemFilters: [],
        chunkFilters: [],
        method: "hybridSearch",
        sort: {
          field: "updatedAt",
          direction: "desc",
        },
        trigger: "agent",
        limit: 10, // todo make this configurable?
        page: 1,
      });

      if (result?.chunks?.length) {
        // Todo, sort by hybrid score? Retrieve more and set adaptive cutoff?
        memoryContext = `
                  Pre-fetched relevant information for this query:
  
                  ${result.chunks.map((chunk) => chunk.chunk_content).join("\n\n")}`;
      }

      const createNewMemoryTool = createNewMemoryItemTool(agent, context);
      if (createNewMemoryTool) {
        if (!currentTools) {
          currentTools = [];
        }
        currentTools.push(createNewMemoryTool);
      }
    }

    const personalizationInformation =
      exuluConfig?.privacy?.systemPromptPersonalization !== false
        ? `
                  ${user?.firstname ? `The users first name is "${user.firstname}"` : ""}
                  ${user?.lastname ? `The users last name is "${user.lastname}"` : ""}
                  ${user?.email ? `The users email is "${user.email}"` : ""}
          `
        : "";

    const genericContext = `IMPORTANT general information:
                  ${personalizationInformation}
                  The current date is "${new Date().toLocaleDateString()}" and the current time is "${new Date().toLocaleTimeString()}". 
                  If the user does not explicitly provide the current date, for examle when saying ' this weekend', you should assume 
                  they are talking with the current date in mind as a reference.`;

    let system =
      instructions ||
      "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.";
    system += "\n\n" + genericContext;

    if (memoryContext) {
      system += "\n\n" + memoryContext;
    }

    const includesContextSearchTool = currentTools?.some(
      (tool) =>
        tool.name.toLowerCase().includes("context_search") ||
        tool.id.includes("context_search") ||
        tool.type === "context",
    );

    const includesWebSearchTool = currentTools?.some(
      (tool) =>
        tool.name.toLowerCase().includes("web_search") ||
        tool.id.includes("web_search") ||
        tool.type === "web_search",
    );

    console.log("[EXULU] Current tools: " + currentTools?.map((tool) => tool.name).join("\n"));
    console.log("[EXULU] Includes context search tool: " + includesContextSearchTool);

    if (includesContextSearchTool) {
      system +=
        "\n\n" +
        `
  
              When you use a context search tool, you will include references to the items
              retrieved from the tool call result inline in the response using this exact JSON format
              (all on one line, no line breaks):
              {item_name: <item_name>, item_id: <item_id>, context: <context_id>, chunk_id: <chunk_id>, chunk_index: <chunk_index>}
  
              IMPORTANT formatting rules:
              - Use the exact format shown above, all on ONE line
              - Do NOT use quotes around field names or values
              - Use the context ID from the tool result
              - Include the file/item name, not the full path
              - Separate multiple citations with spaces
  
              Example: {item_name: document.pdf, item_id: abc123, context: my-context-id, chunk_id: chunk_456, chunk_index: 0}
  
              The citations will be rendered as interactive badges in the UI.
              `;
    }

    if (includesWebSearchTool) {
      system +=
        "\n\n" +
        `
              When you use a web search tool, you will include references to the results of the tool call result inline in the response using this exact JSON format
              (all on one line, no line breaks):
              {url: <url>, title: <title>, snippet: <snippet>}
  
              IMPORTANT formatting rules:
              - Use the exact format shown above, all on ONE line
              - Do NOT use quotes around field names or values
              - Separate multiple results with spaces
  
              Example: {url: https://www.google.com, title: Google, snippet: The result of the web search.}
              `;
    }

    if (prompt) {
      let result: { object?: any; text?: string } = { object: null, text: "" };
      let inputTokens: number = 0;
      let outputTokens: number = 0;
      if (outputSchema) {
        const { object, usage } = await generateObject({
          model: model,
          system,
          prompt: prompt,
          maxRetries: 3,
          schema: outputSchema,
        });
        result.object = object;
        inputTokens = usage.inputTokens || 0;
        outputTokens = usage.outputTokens || 0;
      } else {
        console.log(
          "[EXULU] Generating text for agent: " + this.name,
          "with prompt: " + prompt?.slice(0, 100) + "...",
        );

        const { text, totalUsage } = await generateText({
          model: model,
          system,
          prompt: prompt,
          maxRetries: 2,
          tools: await convertExuluToolsToAiSdkTools(
            currentTools,
            [],
            allExuluTools,
            toolConfigs,
            providerapikey,
            contexts,
            rerankers,
            user,
            exuluConfig,
            session,
            req,
            project,
            sessionItems,
            model,
            agent,
          ),
          stopWhen: [stepCountIs(5)],
        });
        result.text = text;
        inputTokens = totalUsage?.inputTokens || 0;
        outputTokens = totalUsage?.outputTokens || 0;
      }

      if (statistics) {
        await Promise.all([
          updateStatistic({
            name: "count",
            label: statistics.label,
            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
            trigger: statistics.trigger,
            count: 1,
            user: user?.id,
            role: user?.role?.id,
          }),
          ...(inputTokens
            ? [
              updateStatistic({
                name: "inputTokens",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: inputTokens,
              }),
            ]
            : []),
          ...(outputTokens
            ? [
              updateStatistic({
                name: "outputTokens",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: outputTokens,
              }),
            ]
            : []),
        ]);
      }

      return result.text || result.object;
    }
    if (messages) {
      console.log(
        "[EXULU] Generating text for agent: " + this.name,
        "with messages: " + messages.length,
      );
      const { text, totalUsage } = await generateText({
        model: model, // Should be a LanguageModelV1
        system,
        messages: await convertToModelMessages(messages, {
          ignoreIncompleteToolCalls: true,
        }),
        maxRetries: 2,
        tools: await convertExuluToolsToAiSdkTools(
          currentTools,
          [],
          allExuluTools,
          toolConfigs,
          providerapikey,
          contexts,
          rerankers,
          user,
          exuluConfig,
          session,
          req,
          project,
          sessionItems,
          model,
          agent,
        ),
        stopWhen: [stepCountIs(5)],
      });

      if (statistics) {
        await Promise.all([
          updateStatistic({
            name: "count",
            label: statistics.label,
            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
            trigger: statistics.trigger,
            count: 1,
            user: user?.id,
            role: user?.role?.id,
          }),
          ...(totalUsage?.inputTokens
            ? [
              updateStatistic({
                name: "inputTokens",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: totalUsage?.inputTokens,
                user: user?.id,
                role: user?.role?.id,
              }),
            ]
            : []),
          ...(totalUsage?.outputTokens
            ? [
              updateStatistic({
                name: "outputTokens",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: totalUsage?.outputTokens,
              }),
            ]
            : []),
        ]);
      }

      return text;
    }
    return "";
  };

  /**
   * Convert file parts in messages to OpenAI Responses API compatible format.
   * The OpenAI Responses API doesn't support inline file parts with type 'file'.
   * This function converts:
   * - Document files (PDF, DOCX, etc.) -> text parts with extracted content using officeparser
   * - Image files -> image parts (which ARE supported by Responses API)
   */
  private async processFilePartsInMessages(messages: UIMessage[]): Promise<UIMessage[]> {
    const processedMessages = await Promise.all(
      messages.map(async (message) => {
        // Only process user messages with content array
        if (message.role !== "user" || !Array.isArray(message.parts)) {
          return message;
        }

        const processedParts: UIMessage["parts"] = await Promise.all(
          message.parts.map(async (part: any) => {
            // If not a file part, return as-is
            if (part.type !== "file") {
              return part;
            }

            console.log(`[EXULU] Processing part`, part);
            const { mediaType, url, filename } = part;

            // Check if it's an image file - these are supported as image parts
            console.log(`[EXULU] Media type: ${mediaType}`);
            console.log(`[EXULU] URL: ${url}`);
            console.log(`[EXULU] Filename: ${filename}`);
            const imageTypes = [".png", ".jpeg", ".jpg", ".gif", ".webp"];
            const imageType = imageTypes.find((type) =>
              filename.toLowerCase().includes(type.toLowerCase()),
            );
            if (imageType) {
              console.log(`[EXULU] Converting file part to image part: ${filename} `);
              return {
                type: "file",
                mediaType: `image/${imageType.replace(".", "")}`,
                url: url,
              };
            }

            // For document files, fetch content and extract text using officeparser
            console.log(`[EXULU] Converting file part to text using officeparser: ${filename}`);
            try {
              // Fetch the file content from the URL
              const response = await fetch(url);
              if (!response.ok) {
                console.error(
                  `[EXULU] Failed to fetch file: ${filename}, status: ${response.status} `,
                );
                return {
                  type: "text",
                  text: `[Error: Could not load file ${filename}]`,
                };
              }

              // Get the file as a buffer
              const arrayBuffer = await response.arrayBuffer();

              // Parse the document using officeparser
              const extractedText = await parseOfficeAsync(arrayBuffer, {
                outputErrorToConsole: false,
                newlineDelimiter: "\n",
              });

              // Return as text part with extracted content wrapped in XML-like tags
              return {
                type: "text",
                text: `<file file name = "${filename}" >\n${extractedText} \n </file>`,
              };
            } catch (error) {
              console.error(`[EXULU] Error processing file ${filename}:`, error);
              return {
                type: "text",
                text: `[Error extracting text from file ${filename}: ${error instanceof Error ? error.message : "Unknown error"}]`,
              };
            }
          }),
        );

        const result = {
          ...message,
          parts: processedParts,
        };
        console.log("[EXULU] Result: " + JSON.stringify(result, null, 2));
        return result;
      }),
    );

    return processedMessages;
  }

  generateStream = async ({
    user,
    session,
    agent,
    message,
    previousMessages,
    currentTools,
    approvedTools,
    allExuluTools,
    toolConfigs,
    providerapikey,
    contexts,
    rerankers,
    exuluConfig,
    instructions,
    req,
  }: {
    user?: User;
    session?: string;
    agent?: ExuluAgent;
    message?: UIMessage;
    previousMessages?: UIMessage[];
    currentTools?: ExuluTool[];
    approvedTools?: string[];
    allExuluTools?: ExuluTool[];
    toolConfigs?: ExuluAgentToolConfig[];
    providerapikey?: string | undefined;
    contexts?: ExuluContext[] | undefined;
    rerankers?: ExuluReranker[] | undefined;
    exuluConfig?: ExuluConfig;
    instructions?: string;
    req?: Request;
  }): Promise<{
    stream: ReturnType<typeof streamText>;
    originalMessages: UIMessage[];
    previousMessages: UIMessage[];
  }> => {
    if (!this.model) {
      console.error("[EXULU] Model is required for streaming.");
      throw new Error("Model is required for streaming.");
    }

    if (!this.config) {
      console.error("[EXULU] Config is required for streaming.");
      throw new Error("Config is required for generating.");
    }

    if (!message) {
      console.error("[EXULU] Message is required for streaming.");
      throw new Error("Message is required for streaming.");
    }

    const model = this.model.create({
      ...(providerapikey ? { apiKey: providerapikey } : {}),
    });

    let messages: UIMessage[] = [];
    let previousMessagesContent: UIMessage[] = previousMessages || [];
    // load the previous messages from the server:
    let project: string | undefined;
    let sessionItems: string[] | undefined;
    if (session) {
      const sessionData = await getSession({ sessionID: session });
      project = sessionData.project;
      sessionItems = sessionData.session_items;

      console.log("[EXULU] loading previous messages from session: " + session);
      const previousMessages = await getAgentMessages({
        session,
        user: user?.id,
        limit: 50,
        page: 1,
      });
      previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
    }

    // validate messages
    messages = await validateUIMessages({
      // append the new message to the previous messages:
      messages: [...previousMessagesContent, message],
    });

    const query = message.parts?.[0]?.type === "text" ? message.parts[0].text : undefined;

    // If memory context was configured for the agent, we retrieve
    // relevant memory items and add it to the genericContext
    let memoryContext = "";
    if (agent?.memory && contexts?.length && query) {
      const context = contexts.find((context) => context.id === agent?.memory);
      if (!context) {
        throw new Error(
          "Context was set for agent memory but not found in the contexts: " +
          agent?.memory +
          " please double check with a developer to see if the context was removed from code.",
        );
      }
      const result = await context?.search({
        query: query,
        itemFilters: [],
        chunkFilters: [],
        method: "hybridSearch",
        sort: {
          field: "updatedAt",
          direction: "desc",
        },
        trigger: "agent",
        limit: 10, // todo make this configurable?
        page: 1,
      });

      if (result?.chunks?.length) {
        // Todo, sort by hybrid score? Retrieve more and set adaptive cutoff?
        memoryContext = `
                  Pre-fetched relevant information for this query:
  
                  ${result.chunks.map((chunk) => chunk.chunk_content).join("\n\n")}`;
      }

      const createNewMemoryTool = createNewMemoryItemTool(agent, context);
      if (createNewMemoryTool) {
        if (!currentTools) {
          currentTools = [];
        }
        currentTools.push(createNewMemoryTool);
      }
    }

    // filter out messages with duplicate ids
    // If we encounter a duplicate message ID, we take the last
    // message with that ID, this happens for example when in the history
    // there is a message with state "approval-requested", and the frontend
    // then sends the same message id but with state updated to "approval-responded".
    messages = messages.filter(
      (message, index, self) => index === self.findLastIndex((t) => t.id === message.id),
    );

    // Process file parts to convert them to OpenAI Responses API compatible format
    // which mostly means converting file parts to text parts unless they are images.

    messages = await this.processFilePartsInMessages(messages);

    // Simple things like the current date, time, etc.
    // we add these to the context to help the agent
    // by default.
    const genericContext =
      "IMPORTANT: \n\n The current date is " +
      new Date().toLocaleDateString() +
      " and the current time is " +
      new Date().toLocaleTimeString() +
      ". If the user does not explicitly provide the current date, for examle when saying ' this weekend', you should assume they are talking with the current date in mind as a reference.";

    let system =
      instructions ||
      "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.";
    system += "\n\n" + genericContext;

    if (memoryContext) {
      system += "\n\n" + memoryContext;
    }

    const includesContextSearchTool = currentTools?.some(
      (tool) =>
        tool.name.toLowerCase().includes("context_search") ||
        tool.id.includes("context_search") ||
        tool.type === "context",
    );
    const includesWebSearchTool = currentTools?.some(
      (tool) =>
        tool.name.toLowerCase().includes("web_search") ||
        tool.id.includes("web_search") ||
        tool.type === "web_search",
    );
    console.log("[EXULU] Current tools: " + currentTools?.map((tool) => tool.name).join("\n"));
    console.log("[EXULU] Includes context search tool: " + includesContextSearchTool);
    console.log("[EXULU] Includes web search tool: " + includesWebSearchTool);

    if (includesContextSearchTool) {
      system +=
        "\n\n" +
        `
  
              When you use a context search tool, you will include references to the items
              retrieved from the tool call result inline in the response using this exact JSON format
              (all on one line, no line breaks):
              {item_name: <item_name>, item_id: <item_id>, context: <context_id>, chunk_id: <chunk_id>, chunk_index: <chunk_index>}
  
              IMPORTANT formatting rules:
              - Use the exact format shown above, all on ONE line
              - Do NOT use quotes around field names or values
              - Use the context ID from the tool result
              - Include the file/item name, not the full path
              - Separate multiple citations with spaces
  
              Example: {item_name: document.pdf, item_id: abc123, context: my-context-id, chunk_id: chunk_456, chunk_index: 0}
  
              The citations will be rendered as interactive badges in the UI.
              `;
    }

    if (includesWebSearchTool) {
      system +=
        "\n\n" +
        `
              When you use a web search tool, you will include references to the results of the tool call result inline in the response using this exact JSON format
              (all on one line, no line breaks):
              {url: <url>, title: <title>, snippet: <snippet>}
  
              IMPORTANT formatting rules:
              - Use the exact format shown above, all on ONE line
              - Do NOT use quotes around field names or values
              - Separate multiple results with spaces
  
              Example: {url: https://www.google.com, title: Google, snippet: The result of the web search.}
              `;
    }

    const result = streamText({
      model: model, // Should be a LanguageModelV1
      messages: await convertToModelMessages(messages, {
        ignoreIncompleteToolCalls: true,
      }),
      // PrepareStep could be used here to set the model
      // for the first step or change other parameters.
      system,
      maxRetries: 2,
      providerOptions: {
        openai: {
          reasoningSummary: "auto",
        },
      },
      tools: await convertExuluToolsToAiSdkTools(
        currentTools,
        approvedTools,
        allExuluTools,
        toolConfigs,
        providerapikey,
        contexts,
        rerankers,
        user,
        exuluConfig,
        session,
        req,
        project,
        sessionItems,
        model,
        agent,
      ),
      onError: (error) => {
        console.error("[EXULU] chat stream error.", error);
        throw new Error(
          `Chat stream error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        );
      },
      stopWhen: [stepCountIs(5)],
    });

    return {
      stream: result,
      originalMessages: messages,
      previousMessages: previousMessagesContent,
    };
  };
}

// todo deal with session pagination
const getAgentMessages = async ({
  session,
  user,
  limit,
  page,
}: {
  session: string;
  user?: number;
  limit: number;
  page: number;
}) => {
  const { db } = await postgresClient();
  console.log(
    "[EXULU] getting agent messages for session: " +
    session +
    " and user: " +
    user +
    " and page: " +
    page,
  );
  const query = db
    .from("agent_messages")
    .where({ session, user: user || null })
    .limit(limit);
  if (page > 0) {
    query.offset((page - 1) * limit);
  }
  const messages = await query;
  return messages;
};

export const getSession = async ({ sessionID }: { sessionID: string }) => {
  const { db } = await postgresClient();
  console.log("[EXULU] getting session for session ID: " + sessionID);
  const session = await db.from("agent_sessions").where({ id: sessionID }).first();
  if (!session) {
    throw new Error("Session not found for session ID: " + sessionID);
  }
  return session;
};

export const saveChat = async ({
  session,
  user,
  messages,
}: {
  session: string;
  user: number;
  messages: UIMessage[];
}) => {
  const { db } = await postgresClient();
  // Save messages sequentially to maintain correct createdAt timestamps
  for (const message of messages) {
    const mutation = db
      .from("agent_messages")
      .insert({
        session,
        user,
        content: JSON.stringify(message),
        message_id: message.id,
        title: message.role === "user" ? "User" : "Assistant",
      })
      .returning("id");
    mutation.onConflict("message_id").merge();
    await mutation;
  }
};
