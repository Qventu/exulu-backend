import type { ExuluProviderConfig } from "@EXULU_TYPES/provider-config.ts";
import { resolveMaxStepsFromToolConfigs, finalAnswerGuard, DEFAULT_MAX_STEPS } from "./resolve-max-steps";
import { contextGuard, composePrepareSteps } from "./context-guard";
import { autoDeclineStaleApprovals } from "./auto-decline-stale-approvals";
import type { imageTypes } from "@EXULU_TYPES/models/agent";
import type { fileTypes } from "@EXULU_TYPES/models/agent";
import type { audioTypes } from "@EXULU_TYPES/models/agent";
import type { videoTypes } from "@EXULU_TYPES/models/agent";
import { z } from "zod";
import { ExuluTool } from "./tool.ts";
import { resolveModel } from "./resolve-model.ts";
import { updateStatistic } from "./statistics.ts";
import type { ExuluContext } from "./context.ts";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config.ts";
import {
  convertToModelMessages,
  generateText,
  type LanguageModel,
  streamText,
  type UIMessage,
  validateUIMessages,
  stepCountIs,
  hasToolCall,
} from "ai";
import { generateSlug } from "@SRC/utils/generate-slug";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import { getEnabledTools } from "@SRC/utils/enabled-tools";
import { postgresClient } from "@SRC/postgres/client";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import type { ExuluStatisticParams } from "@EXULU_TYPES/statistics.ts";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config.ts";
import { convertExuluToolsToAiSdkTools } from "@SRC/templates/tools/convert-exulu-tools-to-ai-sdk-tools.ts";
import { parseOfficeAsync } from "officeparser";
import type { ExuluConfig } from "./app/index.ts";
import type { Request } from "express";
import { exuluApp } from "./app/singleton.ts";
import { checkLicense } from "@EE/entitlements.ts";
import { setSessionCurrentTask } from "./task-description.ts";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search.ts";
import type { ExuluSkill } from "@EXULU_TYPES/skill.ts";
import { sliceHistoryAtCheckpoint, getCompaction, deriveContextBudget, contextOccupancy, ContextCompactionRequiredError } from "./context-budget";

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
  public config?: ExuluProviderConfig | undefined;
  public model?: {
    create: ({ apiKey, user, role, project, agent }: {
      apiKey?: string | undefined;
      user?: number;
      role?: string;
      project?: string;
      agent?: string;
    }) => LanguageModel;
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
  ): Promise<ExuluTool | null> => {

    const agent = await exuluApp.get().agent(instance);

    if (!agent) {
      return null;
    }

    const license = checkLicense()

    if (!license["multi-agent-tooling"]) {
      console.warn(`[EXULU] You are not licensed to use multi-agent tooling so cannot export this agent as a tool. Please set your EXULU_ENTERPRISE_LICENSE env variable.`);
    }

    return ExuluTool.internal({
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
      description: `This tool calls an agent named: ${agent.name}. The agent does the following: ${agent.description}.`,
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
          [],
          providers,
          user,
        );

        if (!agent.model) {
          throw new Error(
            `Agent ${agent.name} (${agent.id}) has no model configured (called as a tool).`,
          );
        }

        const resolved = await resolveModel({
          modelId: agent.model,
          user,
          providers,
          agent: agent,
        });
        
        const providerapikey = resolved.apiKey;
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

        const response = await this.generateSync({
          agent: agent,
          contexts: contexts,
          instructions: agent.instructions,
          prompt:
            "The user has asked the following question: " +
            prompt +
            " and the following information is available: " +
            information,
          languageModel: resolved.languageModel,
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
    approvedTools,
    currentTools,
    currentSkills,
    allExuluTools,
    statistics,
    toolConfigs,
    providerapikey,
    languageModel,
    contexts,
    exuluConfig,
    agent,
    instructions,
    maxStepCount,
    onTokenUsage,
    contextWindow
  }: {
    prompt?: string;
    user?: User;
    maxStepCount?: number;
    req?: Request;
    session?: string;
    agent?: ExuluAgent;
    approvedTools?: string[];
    inputMessages?: UIMessage[];
    currentTools?: ExuluTool[];
    currentSkills?: ExuluSkill[];
    allExuluTools?: ExuluTool[];
    statistics?: ExuluStatisticParams;
    toolConfigs?: ExuluAgentToolConfig[];
    providerapikey?: string | undefined;
    languageModel: LanguageModel;
    contexts?: ExuluContext[] | undefined;
    exuluConfig?: ExuluConfig;
    instructions?: string;
    onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => Promise<void> | void;
    contextWindow?: number;
    // todo get rid of any
  }): Promise<any> => {
    console.log(
      "[EXULU] Called generate sync for agent: " + this.name,
      "with prompt: " + prompt?.slice(0, 100) + "...",
    );

    if (!this.config) {
      throw new Error("Config is required for generating.");
    }

    if (prompt && inputMessages?.length) {
      throw new Error("Message and prompt cannot be provided at the same time.");
    }

    if (!prompt && !inputMessages?.length) {
      throw new Error("Prompt or message is required for generating.");
    }

    let project: string | undefined;
    let sessionItems: string[] | undefined;
    if (session) {
      const sessionData = await getSession({ sessionID: session });
      sessionItems = sessionData.session_items;
      project = sessionData.project;
    }

    const model = languageModel;

    console.log("[EXULU] Model for agent: " + this.name, " created for generating sync.");

    let messages: UIMessage[] = inputMessages || [];
    if (messages && session && user) {
      // load the previous messages from the server:
      const previousMessages = await getAgentMessages({
        session,
        user: user.id,
      });

      const previousMessagesContent = previousMessages.map((message) =>
        JSON.parse(message.content),
      );
      // validate messages
      messages = await validateUIMessages({
        // append the new message to the previous messages:
        messages: [...previousMessagesContent, ...messages],
      });
      const contextBudget = deriveContextBudget(contextWindow);
      const occupancy = contextOccupancy(messages);
      if (occupancy >= contextBudget.blockThreshold) {
        throw new ContextCompactionRequiredError(occupancy, contextBudget);
      }
      messages = sliceHistoryAtCheckpoint(messages);
    }

    console.log(
      "[EXULU] Message count for agent: " + this.name,
      "loaded for generating sync.",
      messages.length,
    );

    const query = prompt;

    // Non-blocking: generate and persist a privacy-safe task description for the dashboard
    if (session && query) {
      setSessionCurrentTask({
        session,
        userMessage: query,
        model: model,
      }).catch(() => { });
    }

    // If memory context was configured for the agent, we retrieve
    // relevant memory items and add it to the genericContext
    let memoryContext = "";
    let memoryItems: VectorSearchChunkResult[] | undefined;
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
        memoryItems = result.chunks;
        memoryContext = `
                  Pre-fetched relevant information for this query:
  
                  ${result.chunks.map((chunk) => chunk.chunk_content).join("\n\n")}`;
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

    if (user?.personal_system_prompt?.trim()) {
      system += "\n\nUser preferences:\n" + user.personal_system_prompt.trim();
    }

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
              - Do NOT reference just chunks like "Looking at chunk_index 5 and chunk_index 0 from the search result", always use the JSON format above.
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

    // Session files: any files the user uploads via the chat side panel land
    // in the working directory at their original filename, alongside files
    // produced by your own writeFile / bash artifact mirroring. Mentioning
    // this unconditionally so the agent always knows to look at the working
    // directory before saying "I can't see any file".
    system += "\n\n" + `
        Session files:
        The user can upload files to this session through a side panel in the chat UI. Any such
        file appears in your working directory by its original filename — list them with \`ls\` or
        read them with the readFile tool. Files you produce yourself (via writeFile or via shell
        commands like \`node create_doc.js\`) live in the same place. These files are scoped to
        this single session; they are NOT visible in other sessions, projects, or knowledge bases.
      `

    system += "\n\n" + `When a tool execution is not approved by the user, do not retry it unless explicitly asked by the user. ' +
    'Inform the user that the action was not performed.`

    if (prompt) {
      let result: { object?: any; text?: string } = { object: null, text: "" };
      let inputTokens: number = 0;
      let outputTokens: number = 0;
      console.log(
        "[EXULU] Generating text for agent: " + this.name,
        "with prompt: " + prompt?.slice(0, 100) + "...",
      );

      const output = await generateText({
        temperature: 0, // TODO Make this configurable
        model: model,
        system,
        prompt: prompt,
        maxRetries: 2,
        tools: await convertExuluToolsToAiSdkTools(
          currentTools,
          currentSkills,
          approvedTools,
          allExuluTools,
          toolConfigs,
          providerapikey,
          contexts,
          user,
          exuluConfig,
          session,
          req,
          project,
          sessionItems,
          model,
          agent,
          memoryItems,
          contextWindow
        ),
        // Stop after the image_generation tool fires — the widget IS the
        // assistant's response, no follow-up text turn is wanted (same
        // reasoning as question_ask: the UI artifact is the message).
        prepareStep: composePrepareSteps(contextGuard(contextWindow), finalAnswerGuard(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS)) as never,
        stopWhen: [stepCountIs(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS), hasToolCall("image_generation")]
      });
      console.log("[EXULU] Output: " + JSON.stringify(output, null, 2));
      const {
        text,
        totalUsage,
      } = output;
      result.text = text;
      inputTokens = totalUsage?.inputTokens || 0;
      outputTokens = totalUsage?.outputTokens || 0;

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

      if (onTokenUsage) {
        await onTokenUsage({ inputTokens, outputTokens });
      }

      return result.text || result.object;
    }
    if (messages) {
      console.log(
        "[EXULU] Generating text for agent: " + this.name,
        "with messages: " + messages.length,
      );
      const { text, totalUsage } = await generateText({
        temperature: 0, // TODO Make this configurable
        model: model, // Should be a LanguageModelV1
        system,
        messages: await convertToModelMessages(messages, {
          ignoreIncompleteToolCalls: true,
        }),
        maxRetries: 2,
        tools: await convertExuluToolsToAiSdkTools(
          currentTools,
          currentSkills,
          approvedTools,
          allExuluTools,
          toolConfigs,
          providerapikey,
          contexts,
          user,
          exuluConfig,
          session,
          req,
          project,
          sessionItems,
          model,
          agent,
          memoryItems,
          contextWindow
        ),
        prepareStep: composePrepareSteps(contextGuard(contextWindow), finalAnswerGuard(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS)) as never,
        stopWhen: [stepCountIs(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS), hasToolCall("image_generation")],
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

      if (onTokenUsage) {
        await onTokenUsage({
          inputTokens: totalUsage?.inputTokens || 0,
          outputTokens: totalUsage?.outputTokens || 0,
        });
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
    currentSkills,
    approvedTools,
    allExuluTools,
    toolConfigs,
    providerapikey,
    languageModel,
    contexts,
    exuluConfig,
    instructions,
    req,
    maxStepCount,
    contextWindow
  }: {
    user?: User;
    session?: string;
    agent?: ExuluAgent;
    maxStepCount?: number;
    message?: UIMessage;
    previousMessages?: UIMessage[];
    currentTools?: ExuluTool[];
    currentSkills?: ExuluSkill[];
    approvedTools?: string[];
    allExuluTools?: ExuluTool[];
    toolConfigs?: ExuluAgentToolConfig[];
    providerapikey?: string | undefined;
    languageModel: LanguageModel;
    contexts?: ExuluContext[] | undefined;
    exuluConfig?: ExuluConfig;
    instructions?: string;
    req?: Request;
    contextWindow?: number;
  }): Promise<{
    stream: ReturnType<typeof streamText>;
    originalMessages: UIMessage[];
    previousMessages: UIMessage[];
  }> => {
    if (!this.config) {
      console.error("[EXULU] Config is required for streaming.");
      throw new Error("Config is required for generating.");
    }

    if (!message) {
      console.error("[EXULU] Message is required for streaming.");
      throw new Error("Message is required for streaming.");
    }

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
      });
      previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
    }

    const model = languageModel;

    // validate messages
    messages = await validateUIMessages({
      // append the new message to the previous messages:
      messages: [...previousMessagesContent, message],
    });

    const query = message.parts?.[0]?.type === "text" ? message.parts[0].text : undefined;

    // Non-blocking: generate and persist a privacy-safe task description for the dashboard
    if (session && query) {
      setSessionCurrentTask({
        session,
        userMessage: query,
        model: model,
      }).catch(() => { });
    }

    // If memory context was configured for the agent, we retrieve
    // relevant memory items and add it to the genericContext
    let memoryContext = "";
    let memoryItems: VectorSearchChunkResult[] | undefined;
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
        memoryItems = result.chunks;
        // Todo, sort by hybrid score? Retrieve more and set adaptive cutoff?
        memoryContext = `
                  <pre-fetched relevant information for this query>:
  
                  ${result.chunks.map((chunk, index) => `
                    <general_information index="${index}">
                      ${chunk.chunk_content}
                    </general_information>
                    `).join("\n\n")}
                  
                  </pre-fetched relevant information for this query>`;
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

    // Tool calls still waiting for an approval response (the user sent a new
    // message instead of accepting/declining) would make the AI SDK throw
    // "Tool result is missing for tool call". Auto-decline them and persist
    // the rewritten messages so the UI stops showing the stale prompt.
    const { messages: reconciledMessages, declined } = autoDeclineStaleApprovals(messages);
    messages = reconciledMessages;
    if (declined.length && session && user) {
      await saveChat({ session, user: user.id, messages: declined });
    }

    // Process file parts to convert them to OpenAI Responses API compatible format
    // which mostly means converting file parts to text parts unless they are images.

    messages = await this.processFilePartsInMessages(messages);

    // Keep the chronological view for occupancy accounting; the model view
    // collapses everything a compaction checkpoint covers.
    const chronologicalMessages = messages;

    // Pre-flight budget gate (spec §3): never send a prompt past 95% of the
    // usable window — fail fast with the structured compaction-required error.
    const contextBudget = deriveContextBudget(contextWindow);
    const occupancy = contextOccupancy(chronologicalMessages);
    if (occupancy >= contextBudget.blockThreshold) {
      console.warn(
        `[EXULU] Blocking request: occupancy ${occupancy} >= blockThreshold ${contextBudget.blockThreshold} (window ${contextBudget.contextWindow}).`,
      );
      throw new ContextCompactionRequiredError(occupancy, contextBudget);
    }

    messages = sliceHistoryAtCheckpoint(chronologicalMessages);

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

    if (user?.personal_system_prompt?.trim()) {
      system += "\n\nUser preferences:\n" + user.personal_system_prompt.trim();
    }

    system += "\n\n" + genericContext;

    /* if (memoryContext) {
      system += "\n\n" + memoryContext;
    } */

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

    if (currentSkills?.length) {
      // Render each skill as a bulleted name + description block. Listing only
      // names (the previous shape) hides what each skill is FOR — the model
      // could see a skill named "Docx" but not realise it knows how to produce
      // valid .docx files, and would fall back to writeFile with raw markdown.
      const skillsList = currentSkills
        .map((skill) => {
          const description = (skill.description ?? "").trim();
          return description
            ? `        - ${skill.name}: ${description}`
            : `        - ${skill.name}`;
        })
        .join("\n");

      system += "\n\n" + `
        Skills are enabled for this session.

        CRITICAL — Skills are NOT tools. You cannot invoke a skill by calling its name as a tool.
        Skills are folders of instructions and scripts on the session filesystem. To "use a skill"
        means: read its SKILL.md with the readFile tool, follow the instructions inside it, and run
        any scripts it references with the bash tool. The list of skills below is reference material,
        not a tool catalogue — your callable tools are ONLY the ones declared in the tools list of
        this request (readFile, writeFile, bash, plus whatever else is registered). Trying to call a
        skill name as a tool will fail with "Model tried to call unavailable tool".

        Skills are stored in the skills/ folder of the session sandbox and are always structured like:

        skills/<skill_name>/SKILL.md
        skills/<skill_name>/scripts/
        skills/<skill_name>/assets/
        skills/<skill_name>/ ... any other files needed to follow the skill's instructions

        Available skills (name: description):
${skillsList}

        How to use a skill (the only correct workflow):
          1. Decide which skill matches the user's request based on the descriptions above. The user
             does not always name the skill explicitly — match on intent.
          2. Call readFile with path "skills/<skill_name>/SKILL.md" and read the instructions.
          3. Follow those instructions step by step. They may direct you to readFile other files in
             the skill folder, write working files with writeFile, and run scripts via bash.
          4. Produce the final output the user asked for.

        Specifically:
        - When the user asks for output in a specialized file format (.docx, .xlsx, .pdf, .pptx,
          etc.), check the list above for a skill that produces that format and follow its workflow.
          writeFile alone only writes raw bytes; it cannot construct the binary structure these
          formats require, so the file will not open in the target application.
        - When the user mentions a workflow or domain that matches a skill name or description,
          read that skill's SKILL.md instead of reasoning from scratch.
      `;
    }

    // Session files: any files the user uploads via the chat side panel land
    // in the working directory at their original filename, alongside files
    // produced by your own writeFile / bash artifact mirroring. Mentioning
    // this unconditionally so the agent always knows to look at the working
    // directory before saying "I can't see any file".
    system += "\n\n" + `
        Session files:
        The user can upload files to this session through a side panel in the chat UI. Any such
        file appears in your working directory by its original filename — list them with \`ls\` or
        read them with the readFile tool. Files you produce yourself (via writeFile or via shell
        commands like \`node create_doc.js\`) live in the same place. These files are scoped to
        this single session; they are NOT visible in other sessions, projects, or knowledge bases.

        Note on large outputs: oversized tool outputs and large uploaded documents are automatically
        truncated in the conversation; the FULL content is saved as a session file (named in the
        truncation notice, e.g. tool-output-*.txt). Use the read_session_file tool with offset/limit
        to page through it — do not ask the user to re-upload.
      `

    system += "\n\n" + `When a tool execution is not approved by the user, do not retry it unless explicitly asked by the user. ' +
    'Inform the user that the action was not performed.`

    console.log("[EXULU] Tools", currentTools?.map(x => x.name));
    console.log("[EXULU] Skills", currentSkills?.map(x => x.name));

    const tools = await convertExuluToolsToAiSdkTools(
      currentTools,
      currentSkills,
      approvedTools,
      allExuluTools,
      toolConfigs,
      providerapikey,
      contexts,
      user,
      exuluConfig,
      session,
      req,
      project,
      sessionItems,
      model,
      agent,
      memoryItems,
      contextWindow
    )
    console.log("[EXULU] Converted tools", Object.keys(tools));

    const result = streamText({
      temperature: 0, // TODO Make this configurable
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
      tools: tools,
      onError: (error) => {
        console.error("[EXULU] chat stream error.", error);
        throw new Error(
          `Chat stream error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        );
      },
      // todo allow configuring the step budget per skill
      prepareStep: composePrepareSteps(contextGuard(contextWindow), finalAnswerGuard(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS)) as never,
      stopWhen: [stepCountIs(maxStepCount ?? resolveMaxStepsFromToolConfigs(toolConfigs) ?? DEFAULT_MAX_STEPS), hasToolCall("image_generation")],
    });

    return {
      stream: result,
      originalMessages: messages,
      previousMessages: previousMessagesContent,
    };
  };
}

// Full ordered history. The previous version had `limit: 50` with NO ORDER BY
// — sessions past 50 messages sent an arbitrary heap-ordered subset to the
// model. Compaction (sliceHistoryAtCheckpoint) keeps the assembled prompt
// bounded, so loading the full session is safe.
export const getAgentMessages = async ({
  session,
  user,
}: {
  session: string;
  user?: number;
}) => {
  const { db } = await postgresClient();
  console.log("[EXULU] getting agent messages for session: " + session + " and user: " + user);
  const messages = await db
    .from("agent_messages")
    .where({ session, user: user || null })
    .orderBy([
      { column: "createdAt", order: "asc" },
      { column: "id", order: "asc" },
    ]);
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
  model,
}: {
  session: string;
  user: number;
  messages: UIMessage[];
  model?: string;
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
        ...(model ? { model } : {}),
      })
      .returning("id");
    mutation.onConflict("message_id").merge();
    await mutation;
  }
};
