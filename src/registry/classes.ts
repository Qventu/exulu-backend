import { Queue } from "bullmq";
import { z } from "zod"
import { convertToModelMessages, createIdGenerator, generateObject, generateText, type LanguageModel, streamText, tool, type Tool, type UIMessage, validateUIMessages, stepCountIs, hasToolCall } from "ai";
import { type STATISTICS_TYPE, STATISTICS_TYPE_ENUM } from "@EXULU_TYPES/enums/statistics";
import { postgresClient, refreshPostgresClient } from "../postgres/client";
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";
import type { Item } from "@EXULU_TYPES/models/item";
import pgvector from 'pgvector/knex'; // DONT REMOVE THIS
import { bullmqDecorator } from "./decoraters/bullmq";
import { mapType } from "./utils/map-types";
import { sanitizeName } from "./utils/sanitize-name";
import CryptoJS from 'crypto-js';
import { type Request, type Response } from "express";
import { vectorSearch } from "./utils/graphql";
import {
    PutObjectCommand,
    S3Client,
    S3ServiceException,
} from "@aws-sdk/client-s3";
import type { ExuluConfig } from ".";
import { randomUUID } from 'node:crypto';
import { checkRecordAccess, getEnabledTools, loadAgent } from "./utils";
import type { User } from "@EXULU_TYPES/models/user";
import { getPresignedUrl as getPresignedUrlUppy, uploadFile as uploadFileUppy } from "./uppy";

/**
 * @type {S3Client}
 */
let s3Client

export function sanitizeToolName(name) {
    if (typeof name !== 'string') return '';

    // Step 1: Replace invalid characters with underscores
    // Only keep a-z, A-Z, 0-9, hyphens and underscores
    let sanitized = name.replace(/[^a-zA-Z0-9_-]+/g, '_');

    // Step 2: Remove leading/trailing underscores
    sanitized = sanitized.replace(/^_+|_+$/g, '');

    // Step 3: Trim to 128 characters
    if (sanitized.length > 128) {
        sanitized = sanitized.substring(0, 128);
    }

    return sanitized;
}

const convertToolsArrayToObject = (
    currentTools: ExuluTool[] | undefined,
    allExuluTools: ExuluTool[] | undefined,
    configs: ExuluAgentToolConfig[] | undefined,
    providerapikey: string,
    contexts: ExuluContext[] | undefined,
    user?: User,
    exuluConfig?: ExuluConfig,
): Record<string, Tool> => {

    if (!currentTools) return {};
    if (!allExuluTools) return {};
    const sanitizedTools = currentTools ? currentTools.map(tool => ({
        ...tool,
        name: sanitizeToolName(tool.name)
    })) : [];

    console.log("[EXULU] Sanitized tools", sanitizedTools.map(x => x.name + " (" + x.id + ")"))

    const askForConfirmation: Tool = {
        description: 'Ask the user for confirmation.',
        inputSchema: z.object({
            message: z.string().describe('The message to ask for confirmation.'),
        })
    }

    return {
        ...sanitizedTools?.reduce(
            (prev, cur) =>
            ({
                ...prev, [cur.name]: {
                    ...cur.tool,
                    async *execute(inputs: any, options: any) { // generator function allows to use yield to stream tool call results
                        if (!cur.tool?.execute) {
                            console.error("[EXULU] Tool execute function is undefined.", cur.tool)
                            throw new Error("Tool execute function is undefined.")
                        }
                        let config = configs?.find(config => config.id === cur.id);

                        if (config) {
                            config = await hydrateVariables(config || []);
                        }

                        let upload: undefined | (
                            (file: {
                                name: string,
                                data: string | Uint8Array | Buffer,
                                type: allFileTypes,
                                tags?: string[]
                            }) => Promise<Item | undefined>) = undefined;

                        if (
                            exuluConfig?.fileUploads?.s3endpoint &&
                            exuluConfig?.fileUploads?.s3key &&
                            exuluConfig?.fileUploads?.s3secret &&
                            exuluConfig?.fileUploads?.s3Bucket
                        ) {
                            s3Client ??= new S3Client({
                                region: exuluConfig?.fileUploads?.s3region,
                                ...(exuluConfig?.fileUploads?.s3endpoint && {
                                    forcePathStyle: true,
                                    endpoint: exuluConfig?.fileUploads?.s3endpoint
                                }),
                                credentials: {
                                    accessKeyId: exuluConfig?.fileUploads?.s3key ?? "",
                                    secretAccessKey: exuluConfig?.fileUploads?.s3secret ?? "",
                                },
                            })

                            upload = async ({
                                name,
                                data,
                                type,
                                tags
                            }: {
                                name: string,
                                type: allFileTypes,
                                data: string | Uint8Array | Buffer,
                                tags?: string[]
                            }): Promise<Item | undefined> => {
                                const mime = getMimeType(type)
                                const prefix = exuluConfig?.fileUploads?.s3prefix
                                    ? `${exuluConfig.fileUploads.s3prefix.replace(/\/$/, '')}/`
                                    : '';
                                const key = `${prefix}${user}/${generateS3Key(name)}${type}`;
                                const command = new PutObjectCommand({
                                    Bucket: exuluConfig?.fileUploads?.s3Bucket,
                                    Key: key,
                                    Body: data,
                                    ContentType: mime
                                });
                                try {
                                    const response = await s3Client.send(command);
                                    console.log(response);
                                    return response;
                                } catch (caught) {
                                    if (
                                        caught instanceof S3ServiceException &&
                                        caught.name === "EntityTooLarge"
                                    ) {
                                        console.error(
                                            `Error from S3 while uploading object to ${exuluConfig?.fileUploads?.s3Bucket}. \
                                The object was too large. To upload objects larger than 5GB, use the S3 console (160GB max) \
                                or the multipart upload API (5TB max).`,
                                        );
                                    } else if (caught instanceof S3ServiceException) {
                                        console.error(
                                            `Error from S3 while uploading object to ${exuluConfig?.fileUploads?.s3Bucket}.  ${caught.name}: ${caught.message}`,
                                        );
                                    } else {
                                        throw caught;
                                    }
                                }
                            }
                        }

                        const contextsMap = contexts?.reduce((acc, curr) => {
                            acc[curr.id] = curr;
                            return acc;
                        }, {});

                        console.log("[EXULU] Config", config)
                        const response = await cur.tool.execute({
                            ...inputs,
                            // Convert config to object format if a config object 
                            // is available, after we added the .value property
                            // by hydrating it from the variables table.
                            providerapikey: providerapikey,
                            allExuluTools,
                            currentTools,
                            user,
                            contexts: contextsMap,
                            upload,
                            config: config ? config.config.reduce((acc, curr) => {
                                acc[curr.name] = curr.value;
                                return acc;
                            }, {}) : {}
                        }, options);

                        await updateStatistic({
                            name: "count",
                            label: cur.name,
                            type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
                            trigger: "agent",
                            count: 1,
                            user: user?.id,
                            role: user?.role?.id
                        })

                        yield response;
                        return response;
                    }
                }
            }), {}
        ),
        askForConfirmation
    }
}

const hydrateVariables = async (tool: ExuluAgentToolConfig): Promise<ExuluAgentToolConfig> => {
    const { db } = await postgresClient();
    const promises = tool.config.map(async (toolConfig) => {

        // Get the variable name from user's anthropic_token field
        const variableName = toolConfig.variable;

        // Look up the variable from the variables table
        const variable = await db.from("variables").where({ name: variableName }).first();
        if (!variable) {
            console.error("[EXULU] Variable " + variableName + " not found.")
            throw new Error("Variable " + variableName + " not found.")
        }

        // Get the API key from the variable (decrypt if encrypted)
        let value = variable.value;

        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            value = bytes.toString(CryptoJS.enc.Utf8);
        }

        toolConfig.value = value;

    })
    await Promise.all(promises);
    console.log("[EXULU] Variable values retrieved and added to tool config.")
    return tool;
}

export function generateSlug(name: string): string {
    // Normalize Unicode characters (e.g., ü -> u)
    const normalized = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    // Convert to lowercase
    const lowercase = normalized.toLowerCase();
    // Replace non-word characters and spaces with hyphens
    const slug = lowercase.replace(/[\W_]+/g, '-').replace(/^-+|-+$/g, '');
    return slug;
}

interface RateLimiterRule {
    name?: string; // optional, if not provided the rate limiter uses the agent id for the queue name
    rate_limit: {
        time: number; // time until usage expires in seconds
        limit: number;
    }
}

export type ExuluAgentConfig = {
    name: string,
    instructions: string,
    model: {
        create: ({ apiKey }: { apiKey: string }) => LanguageModel
    },
    outputSchema?: z.ZodType;
    custom?: {
        name: string,
        description: string
    }[];
    memory?: {
        lastMessages: number,
        vector: boolean;
        semanticRecall: {
            topK: number,
            messageRange: number
        }
    },
}

export type imageTypes = '.png' | '.jpg' | '.jpeg' | '.gif' | '.webp';
export type fileTypes = '.pdf' | '.docx' | '.xlsx' | '.xls' | '.csv' | '.pptx' | '.ppt' | '.txt' | '.md' | '.json';
export type audioTypes = '.mp3' | '.wav' | '.m4a' | '.mp4' | '.mpeg';
export type videoTypes = '.mp4' | '.m4a' | '.mp3' | '.mpeg' | '.wav';
export type allFileTypes = imageTypes | fileTypes | audioTypes | videoTypes;

interface ExuluAgentParams {
    id: string;
    name: string;
    type: "agent";
    description: string;
    config?: ExuluAgentConfig | undefined;
    maxContextLength?: number;
    provider: string;
    capabilities?: {
        text: boolean;
        images: imageTypes[];
        files: fileTypes[];
        audio: audioTypes[];
        video: videoTypes[];
    };
    outputSchema?: z.ZodType;
    rateLimit?: RateLimiterRule;
    evals?: ExuluEval[];
}

interface ExuluAgentToolConfig {
    id: string,
    type: string,
    config: {
        name: string,
        variable: string // is a variable name
        value?: any // fetched on demand from the database based on the variable name
    }[]
}

export function errorHandler(error: unknown) {
    if (error == null) {
        return 'unknown error';
    }
    if (typeof error === 'string') {
        return error;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return JSON.stringify(error);
}

export type ExuluQueueConfig = {
    queue: Queue,
    ratelimit: number
    concurrency: number
};

export type ExuluEvalTokenMetadata = {
    totalTokens?: number,
    reasoningTokens?: number,
    inputTokens?: number,
    outputTokens?: number,
    cachedInputTokens?: number
};

export type ExuluEvalMetadata = {
    tokens?: ExuluEvalTokenMetadata,
    duration?: number
};

interface ExuluEvalParams {
    id: string;
    name: string;
    description: string;
    execute: (params: {
        messages: UIMessage[],
        metadata: ExuluEvalMetadata,
        config?: Record<string, any>
    }) => Promise<number>;
    config?: {
        name: string,
        description: string
    }[];
    queue: ExuluQueueConfig;
}

export class ExuluEval {
    public id: string;
    public name: string;
    public description: string;
    private execute: (params: {
        messages: UIMessage[],
        metadata: ExuluEvalMetadata,
        config?: Record<string, any>
    }) => Promise<number>;
    public config?: {
        name: string,
        description: string
    }[];
    public queue: ExuluQueueConfig;

    constructor({ id, name, description, execute, config, queue }: ExuluEvalParams) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.execute = execute;
        this.config = config;
        this.queue = queue;
    }

    public async run(messages: UIMessage[], metadata: ExuluEvalMetadata, config?: Record<string, any>): Promise<number> {
        const score = await this.execute({ messages, metadata, config });
        if (score < 0 || score > 100) {
            throw new Error(`Eval function ${this.name} must return a score between 0 and 100, got ${score}`);
        }
        return score;
    }
}

export class ExuluAgent {

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
    public maxContextLength?: number;
    public rateLimit?: RateLimiterRule;
    public config?: ExuluAgentConfig | undefined;
    public evals?: ExuluEval[];
    // private memory: Memory | undefined; // TODO do own implementation
    public model?: {
        create: ({ apiKey }: { apiKey: string }) => LanguageModel
    };
    public capabilities: {
        text: boolean,
        images: string[],
        files: string[],
        audio: string[],
        video: string[]
    }
    constructor({ id, name, description, config, rateLimit, capabilities, type, maxContextLength, evals, provider }: ExuluAgentParams) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.rateLimit = rateLimit;
        this.provider = provider;
        this.config = config;
        this.type = type;
        this.maxContextLength = maxContextLength;
        this.evals = evals;
        this.capabilities = capabilities || {
            text: false,
            images: [],
            files: [],
            audio: [],
            video: []
        };
        this.slug = `/agents/${generateSlug(this.name)}/run`;

        // If it is a custom agent,it is only
        // used as a config object, but the actual
        // inference is done by outside of Exulu.
        this.model = this.config?.model;
    }

    get providerName(): string {
        if (!this.config?.model?.create) {
            return ""
        }
        const model = this.config?.model?.create({ apiKey: "" });
        return typeof model === 'string' ? model : model?.provider || "";
    }

    get modelName(): string {
        if (!this.config?.model?.create) {
            return ""
        }
        const model = this.config?.model?.create({ apiKey: "" });
        return typeof model === 'string' ? model : model?.modelId || "";
    }

    // Exports the agent as a tool that can be used by another agent
    // todo test this
    public tool = async (instance: string, agents: ExuluAgent[]): Promise<ExuluTool | null> => {

        const agentInstance = await loadAgent(instance);

        if (!agentInstance) {
            return null;
        }

        return new ExuluTool({
            id: agentInstance.id,
            name: `${agentInstance.name}`,
            type: "agent",
            inputSchema: z.object({
                prompt: z.string().describe("The prompt (usually a question for the agent) to send to the agent."),
                information: z.string().describe("A summary of relevant context / information from the current session")
            }),
            description: `This tool calls an AI agent named: ${agentInstance.name}. The agent does the following: ${agentInstance.description}.`,
            config: [],
            execute: async ({ prompt, information, user, allExuluTools, }: any) => {

                const hasAccessToAgent = await checkRecordAccess(agentInstance, "read", user);

                if (!hasAccessToAgent) {
                    throw new Error("You don't have access to this agent.");
                }

                let enabledTools: ExuluTool[] = await getEnabledTools(agentInstance, allExuluTools, [], agents, user)

                // Get the variable name from user's anthropic_token field
                const variableName = agentInstance.providerapikey;

                if (!variableName) {
                    throw new Error("Provider API key variable not set for agent: " + agentInstance.name + " (" + agentInstance.id + ") being called as a tool.")
                }

                const { db } = await postgresClient();
                // Look up the variable from the variables table
                const variable = await db.from("variables").where({ name: variableName }).first();
                if (!variable) {
                    throw new Error("Provider API key variable not found for agent: " + agentInstance.name + " (" + agentInstance.id + ") being called as a tool.")
                }

                // Get the API key from the variable (decrypt if encrypted)
                let providerapikey = variable.value;

                if (!variable.encrypted) {
                    throw new Error("Provider API key variable not encrypted for agent: " + agentInstance.name + " (" + agentInstance.id + ") being called as a tool, for security reasons you are only allowed to use encrypted variables for provider API keys.")
                }

                if (variable.encrypted) {
                    const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                    providerapikey = bytes.toString(CryptoJS.enc.Utf8);
                }

                console.log("[EXULU] Enabled tools for agent '" + agentInstance.name + " (" + agentInstance.id + ")" + " that is being called as a tool", enabledTools.map(x => x.name + " (" + x.id + ")"))
                console.log("[EXULU] Prompt for agent '" + agentInstance.name + "' that is being called as a tool", prompt.slice(0, 100) + "...")
                console.log("[EXULU] Instructions for agent '" + agentInstance.name + "' that is being called as a tool", agentInstance.instructions?.slice(0, 100) + "...")

                // todo cant use outputSchema when calling an agent as a tool for now, maybe look into 
                // enabling this in the future by adding a "outputSchema" field to the inputSchema of this 
                // tool definition so agents can dynamically define a desired output schema.
                const response = await this.generateSync({
                    instructions: agentInstance.instructions,
                    prompt: "The user has asked the following question: " + prompt + " and the following information is available: " + information,
                    providerapikey: providerapikey,
                    user,
                    currentTools: enabledTools,
                    allExuluTools: allExuluTools,
                    statistics: {
                        label: agentInstance.name,
                        trigger: "tool"
                    }
                })

                await updateStatistic({
                    name: "count",
                    label: agentInstance.name,
                    type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
                    trigger: "tool",
                    count: 1,
                    user: user?.id,
                    role: user?.role?.id
                })

                return {
                    result: response,
                }
            },
        });
    }

    generateSync = async ({
        prompt,
        user,
        session,
        message,
        currentTools,
        allExuluTools,
        statistics,
        toolConfigs,
        providerapikey,
        contexts,
        exuluConfig,
        outputSchema,
        instructions

    }: {
        prompt?: string,
        user?: User,
        session?: string,
        message?: UIMessage,
        currentTools?: ExuluTool[],
        allExuluTools?: ExuluTool[],
        statistics?: ExuluStatisticParams,
        toolConfigs?: ExuluAgentToolConfig[],
        providerapikey: string,
        contexts?: ExuluContext[] | undefined
        exuluConfig?: ExuluConfig,
        instructions?: string,
        outputSchema?: z.ZodType
    }): Promise<string | any> => {

        console.log("[EXULU] Called generate sync for agent: " + this.name, "with prompt: " + prompt?.slice(0, 100) + "...")

        if (!this.model) {
            throw new Error("Model is required for streaming.")
        }

        if (!this.config) {
            throw new Error("Config is required for generating.")
        }

        if (prompt && message) {
            throw new Error("Message and prompt cannot be provided at the same time.")
        }

        if (!prompt && !message) {
            throw new Error("Prompt or message is required for generating.")
        }

        if (outputSchema && !prompt) {
            throw new Error("Prompt is required for generating with an output schema.")
        }

        const model = this.model.create({
            apiKey: providerapikey
        })

        console.log("[EXULU] Model for agent: " + this.name, " created for generating sync.")

        let messages: UIMessage[] = [];
        if (message && session && user) {
            // load the previous messages from the server:
            const previousMessages = await getAgentMessages({
                session,
                user: user.id,
                limit: 50,
                page: 1
            })

            const previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
            // validate messages
            messages = await validateUIMessages({
                // append the new message to the previous messages:
                messages: [...previousMessagesContent, message],
            });
        }

        console.log("[EXULU] Message count for agent: " + this.name, "loaded for generating sync.", messages.length)

        const genericContext =
            "IMPORTANT: \n\n The current date is " + new Date().toLocaleDateString() + " and the current time is " + new Date().toLocaleTimeString() + ". If the user does not explicitly provide the current date, for examle when saying ' this weekend', you should assume they are talking with the current date in mind as a reference.";

        let system = instructions || "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.";
        system += "\n\n" + genericContext;

        if (prompt) {
            let result: { object?: any, text?: string } = { object: null, text: "" };
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
                console.log("[EXULU] Generating text for agent: " + this.name, "with prompt: " + prompt?.slice(0, 100) + "...")
                const { text, totalUsage } = await generateText({
                    model: model,
                    system,
                    prompt: prompt,
                    maxRetries: 2,
                    tools: convertToolsArrayToObject(
                        currentTools,
                        allExuluTools,
                        toolConfigs,
                        providerapikey,
                        contexts,
                        user,
                        exuluConfig
                    ),
                    stopWhen: [stepCountIs(2)],
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
                        role: user?.role?.id
                    }),
                    ...(inputTokens ? [
                        updateStatistic({
                            name: "inputTokens",
                            label: statistics.label,
                            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                            trigger: statistics.trigger,
                            count: inputTokens,
                        })] : []
                    ),
                    ...(outputTokens ? [
                        updateStatistic({
                            name: "outputTokens",
                            label: statistics.label,
                            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                            trigger: statistics.trigger,
                            count: outputTokens,
                        })] : []
                    )
                ])
            }

            return result.text || result.object;
        }
        if (messages) {
            console.log("[EXULU] Generating text for agent: " + this.name, "with messages: " + messages.length)
            const { text, totalUsage } = await generateText({
                model: model, // Should be a LanguageModelV1
                system,
                messages: convertToModelMessages(messages, {
                    ignoreIncompleteToolCalls: true
                }),
                maxRetries: 2,
                tools: convertToolsArrayToObject(
                    currentTools,
                    allExuluTools,
                    toolConfigs,
                    providerapikey,
                    contexts,
                    user,
                    exuluConfig
                ),
                stopWhen: [stepCountIs(2)],
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
                        role: user?.role?.id
                    }),
                    ...(totalUsage?.inputTokens ? [
                        updateStatistic({
                            name: "inputTokens",
                            label: statistics.label,
                            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                            trigger: statistics.trigger,
                            count: totalUsage?.inputTokens,
                            user: user?.id,
                            role: user?.role?.id
                        })] : []
                    ),
                    ...(totalUsage?.outputTokens ? [
                        updateStatistic({
                            name: "outputTokens",
                            label: statistics.label,
                            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                            trigger: statistics.trigger,
                            count: totalUsage?.outputTokens,
                        })] : []
                    )
                ])
            }

            return text;
        }
        return "";
    }

    generateStream = async ({
        express,
        user,
        session,
        message,
        currentTools,
        allExuluTools,
        statistics,
        toolConfigs,
        providerapikey,
        contexts,
        exuluConfig,
        instructions,
    }: {
        express: {
            res: Response,
            req: Request,
        },
        user: User,
        session: string,
        message?: UIMessage,
        currentTools?: ExuluTool[],
        allExuluTools?: ExuluTool[],
        statistics?: ExuluStatisticParams,
        toolConfigs?: ExuluAgentToolConfig[],
        providerapikey: string,
        contexts?: ExuluContext[] | undefined
        exuluConfig?: ExuluConfig,
        instructions?: string,
    }) => {

        if (!this.model) {
            throw new Error("Model is required for streaming.")
        }

        if (!this.config) {
            throw new Error("Config is required for generating.")
        }

        if (!message) {
            throw new Error("Message is required for streaming.")
        }

        const model = this.model.create({
            apiKey: providerapikey
        })

        let messages: UIMessage[] = [];
        // load the previous messages from the server:
        const previousMessages = await getAgentMessages({
            session,
            user: user.id,
            limit: 50,
            page: 1
        })

        const previousMessagesContent = previousMessages.map(
            (message) => JSON.parse(message.content)
        );

        // validate messages
        messages = await validateUIMessages({
            // append the new message to the previous messages:
            messages: [...previousMessagesContent, message],
        });

        // Simple things like the current date, time, etc.
        // we add these to the context to help the agent
        // by default.
        const genericContext =
            "IMPORTANT: \n\n The current date is " + new Date().toLocaleDateString() + " and the current time is " + new Date().toLocaleTimeString() + ". If the user does not explicitly provide the current date, for examle when saying ' this weekend', you should assume they are talking with the current date in mind as a reference.";

        let system = instructions || "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.";
        system += "\n\n" + genericContext;

        console.log("[EXULU] tools for agent: " + this.name, currentTools?.map(x => x.name + " (" + x.id + ")"))
        console.log("[EXULU] system", system.slice(0, 100) + "...")

        const result = streamText({
            model: model, // Should be a LanguageModelV1
            messages: convertToModelMessages(messages, {
                ignoreIncompleteToolCalls: true
            }),
            // prepareStep could be used here to set the model for the first step or change other params
            system,
            maxRetries: 2,
            providerOptions: {
                openai: {
                    reasoningSummary: 'auto',
                },
            },
            tools: convertToolsArrayToObject(
                currentTools,
                allExuluTools,
                toolConfigs,
                providerapikey,
                contexts,
                user,
                exuluConfig
            ),
            onError: error => console.error("[EXULU] chat stream error.", error),
            // stopWhen: [stepCountIs(1)],
        });

        // consume the stream to ensure it runs to completion & triggers onFinish
        // even when the client response is aborted:
        result.consumeStream(); // no await

        result.pipeUIMessageStreamToResponse(express.res, {
            messageMetadata: ({ part }) => {
                if (part.type === 'finish') {
                    return {
                        totalTokens: part.totalUsage.totalTokens,
                        reasoningTokens: part.totalUsage.reasoningTokens,
                        inputTokens: part.totalUsage.inputTokens,
                        outputTokens: part.totalUsage.outputTokens,
                        cachedInputTokens: part.totalUsage.cachedInputTokens,
                    };
                }
            },
            originalMessages: messages,
            sendReasoning: true,
            sendSources: true,
            onError: error => {
                console.error("[EXULU] chat response error.", error)
                return errorHandler(error)
            },
            generateMessageId: createIdGenerator({
                prefix: 'msg_',
                size: 16,
            }),
            onFinish: async ({ messages, isContinuation, isAborted, responseMessage }) => {
                if (session) {
                    // But only save the new messages, not the previous ones, otherwise we get duplicates.
                    await saveChat({
                        session,
                        user: user.id,
                        messages: messages.filter(x => !previousMessagesContent.find(y => y.id === x.id))
                    })
                }
                const metadata = messages[messages.length - 1]?.metadata as any;
                console.log("[EXULU] Finished streaming", metadata)
                console.log("[EXULU] Statistics", statistics)
                if (statistics) {
                    await Promise.all([
                        updateStatistic({
                            name: "count",
                            label: statistics.label,
                            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                            trigger: statistics.trigger,
                            count: 1,
                            user: user.id,
                            role: user?.role?.id
                        }),
                        ...(metadata?.inputTokens ? [
                            updateStatistic({
                                name: "inputTokens",
                                label: statistics.label,
                                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                                trigger: statistics.trigger,
                                count: metadata?.inputTokens,
                                user: user.id,
                                role: user?.role?.id
                            })] : []
                        ),
                        ...(metadata?.outputTokens ? [
                            updateStatistic({
                                name: "outputTokens",
                                label: statistics.label,
                                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                                trigger: statistics.trigger,
                                count: metadata?.outputTokens,
                            })] : []
                        )
                    ])
                }
            },
        });
        return;
    }
}

// todo check how to deal with pagination
const getAgentMessages = async ({ session, user, limit, page }: { session: string, user: number, limit: number, page: number }) => {
    const { db } = await postgresClient();
    console.log("[EXULU] getting agent messages for session: " + session + " and user: " + user + " and page: " + page)
    const query = db.from("agent_messages").where({ session, user }).limit(limit)
    if (page > 0) {
        query.offset((page - 1) * limit)
    }
    const messages = await query;
    return messages;
}

const saveChat = async ({ session, user, messages }: { session: string, user: number, messages: UIMessage[] }) => {
    const { db } = await postgresClient();
    const promises = messages.map((message) => {
        return db.from("agent_messages").insert({
            session,
            user,
            content: JSON.stringify(message),
            title: message.role === "user" ? "User" : "Assistant"
        })
    })
    await Promise.all(promises)
}

export type VectorOperationResponse = Promise<{
    count: number,
    results: any, // todo
    errors?: string[]
}>

type VectorGenerateOperation = (inputs: ChunkerResponse) => VectorGenerationResponse

type ChunkerOperation = (item: Item & { id: string }, maxChunkSize: number, utils: {
    storage: ExuluStorage
}) => Promise<ChunkerResponse>

type ChunkerResponse = {
    item: Item & { id: string },
    chunks: {
        content: string,
        index: number,
    }[]
}

type VectorGenerationResponse = Promise<{
    id: string,
    chunks: {
        content: string,
        index: number,
        vector: number[]
    }[]
}>

export class ExuluEmbedder {

    public id: string;
    public name: string;
    public slug: string = "";
    public queue?: Promise<ExuluQueueConfig>;
    private generateEmbeddings: VectorGenerateOperation;
    public description: string;
    public vectorDimensions: number;
    public maxChunkSize: number;
    public _chunker: ChunkerOperation;
    constructor({ id, name, description, generateEmbeddings, queue, vectorDimensions, maxChunkSize, chunker }: {
        id: string,
        name: string,
        description: string,
        generateEmbeddings: VectorGenerateOperation,
        chunker: ChunkerOperation,
        queue?: Promise<ExuluQueueConfig>,
        vectorDimensions: number,
        maxChunkSize: number
    }) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.vectorDimensions = vectorDimensions;
        this.maxChunkSize = maxChunkSize;

        this._chunker = chunker;
        this.slug = `/embedders/${generateSlug(this.name)}/run`
        this.queue = queue;
        this.generateEmbeddings = generateEmbeddings;
    }

    public chunker = (item: Item & { id: string }, maxChunkSize: number, config: ExuluConfig) => {
        const utils = {
            storage: new ExuluStorage({ config })
        }
        return this._chunker(item, maxChunkSize, utils);
    }

    public async generateFromQuery(query: string, statistics?: ExuluStatisticParams, user?: number, role?: string): VectorGenerationResponse {

        if (statistics) {
            await updateStatistic({
                name: "count",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: 1,
                user: user,
                role: role
            })
        }

        return await this.generateEmbeddings({
            item: {
                id: "placeholder",
            },
            chunks: [{
                content: query,
                index: 1,
            }]
        })
    }

    public async generateFromDocument(input: Item, config: ExuluConfig, statistics?: ExuluStatisticParams, user?: number, role?: string): VectorGenerationResponse {

        if (statistics) {
            await updateStatistic({
                name: "count",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: 1,
                user: user,
                role: role
            })
        }

        if (!this.chunker) {
            throw new Error("Chunker not found for embedder " + this.name)
        }

        if (!input.id) {
            throw new Error("Item id is required for generating embeddings.")
        }

        const output = await this.chunker(input as Item & { id: string }, this.maxChunkSize, config)

        console.log("[EXULU] Generating embeddings.")

        return await this.generateEmbeddings(output)
    };
}

interface WorkflowVariable {
    name: string
    description?: string
    type: 'string'
    required: boolean
    defaultValue?: string
}

interface WorkflowStep {
    id: string
    type: 'user' | 'assistant' | 'tool'
    content?: string
    contentExample?: string
    toolName?: string
    variablesUsed?: string[]
}
export interface ExuluWorkflow {
    id: string
    name: string
    description?: string
    rights_mode?: ExuluRightsMode
    RBAC?: ExuluRBAC
    variables?: WorkflowVariable[]
    steps_json?: WorkflowStep[]
}

export interface ExuluRBAC {
    users?: Array<{ id: string; rights: 'read' | 'write' }>
    roles?: Array<{ id: string; rights: 'read' | 'write' }>
}

export class ExuluTool {

    // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or 
    // underscores and be a max length of 80 characters and at least 5 characters long.
    // The ID is used for storing references to tools so it is important it does not change.
    public id: string;
    public name: string;
    public description: string;
    public inputSchema?: z.ZodType;
    public type: "context" | "function" | "agent";
    public tool: Tool
    public config: {
        name: string,
        description: string
    }[]

    constructor({ id, name, description, inputSchema, type, execute, config }: {
        id: string,
        name: string,
        description: string,
        inputSchema?: z.ZodType,
        type: "context" | "function" | "agent",
        config: {
            name: string,
            description: string
        }[],
        execute: (inputs: any) => Promise<{
            result?: string
            job?: string
            items?: Item[]
        }> | AsyncGenerator<{
            result?: string
            job?: string
            items?: Item[]
        }>,
    }) {
        this.id = id;
        this.config = config;
        this.name = name;
        this.description = description;
        this.inputSchema = inputSchema;
        this.type = type;
        this.tool = tool({
            description: description,
            inputSchema: inputSchema || z.object({}),
            execute
        });
    }
}

export type ExuluContextFieldProcessor = {
    description: string,
    execute: ({ item, user, role, utils, config }: {
        item: Item & { field: string }, user: number, role: string, utils: {
            storage: ExuluStorage
            items: {
                update: ExuluContext['updateItem'],
                create: ExuluContext['createItem'],
                delete: ExuluContext['deleteItem']
            }
        },
        config: ExuluConfig
    }) => Promise<string>,
    config?: {
        queue?: Promise<ExuluQueueConfig>,
        trigger: "manual" | "onUpdate" | "onCreate" | "always"
    },
}

export type ExuluContextFieldDefinition = {
    name: string,
    type: ExuluFieldTypes
    unique?: boolean
    required?: boolean
    default?: any
    calculated?: boolean
    index?: boolean
    enumValues?: string[]
    allowedFileTypes?: allFileTypes[]
    // todo require defining a processor if type above is file
    processor?: ExuluContextFieldProcessor
}


export const getTableName = (id: string) => {
    return sanitizeName(id) + "_items";
}

export const getChunksTableName = (id: string) => {
    return sanitizeName(id) + "_chunks";
}

export type ExuluRightsMode = "private" | "users" | "roles" | "public" | "projects"

export class ExuluStorage {
    private config: ExuluConfig
    constructor({ config }: { config: ExuluConfig }) {
        this.config = config;
    }

    public getPresignedUrl = async (key: string) => {
        return await getPresignedUrlUppy(key, this.config);
    }

    public uploadFile = async (user: number, file: Buffer | Uint8Array, key: string, type: string, metadata?: Record<string, string>) => {
        return await uploadFileUppy(user, file, key, this.config, {
            contentType: type,
            metadata: {
                ...metadata,
                type: type
            }
        });
    }
    // todo add upload and delete methods
}

export class ExuluContext {

    // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or 
    // underscores and be a max length of 80 characters and at least 5 characters long.
    // The ID is used for the table name in the database, so it is important it does not change.
    public id: string;
    public name: string;
    public active: boolean;
    public fields: ExuluContextFieldDefinition[]
    public rateLimit?: RateLimiterRule;
    public description: string;
    public embedder?: ExuluEmbedder
    public queryRewriter?: (query: string) => Promise<string>;
    public resultReranker?: (results: any[]) => Promise<any[]>; // todo typings
    public configuration: {
        calculateVectors?: "manual" | "onUpdate" | "onInsert" | "always",
        defaultRightsMode?: ExuluRightsMode
        language?: "german" | "english"
    };

    constructor({ id, name, description, embedder, active, rateLimit, fields, queryRewriter, resultReranker, configuration }: {
        id: string,
        name: string,
        fields: ExuluContextFieldDefinition[],
        description: string,
        embedder?: ExuluEmbedder,
        active: boolean,
        rateLimit?: RateLimiterRule,
        queryRewriter?: (query: string) => Promise<string>,
        resultReranker?: (results: any[]) => Promise<any[]>,
        configuration?: {
            calculateVectors?: "manual" | "onUpdate" | "onInsert" | "always",
            defaultRightsMode?: ExuluRightsMode,
            language?: "german" | "english"
        }
    }) {
        this.id = id;
        this.name = name;
        this.fields = fields || [];
        this.configuration = configuration || {
            calculateVectors: "manual",
            language: "english",
            defaultRightsMode: "private"
        };
        this.description = description;
        this.embedder = embedder;
        this.active = active;
        this.rateLimit = rateLimit;
        this.queryRewriter = queryRewriter;
        this.resultReranker = resultReranker;
    }

    public process = async (
        trigger: STATISTICS_LABELS,
        user: number,
        role: string,
        item: Item & { field: string },
        config: ExuluConfig
    ): Promise<{
        result: string,
        job?: string
    }> => {
        // todo add tracking for processor execution
        console.log("[EXULU] processing field", item.field, " in context", this.id);
        console.log("[EXULU] fields", this.fields.map(field => field.name));
        const field = this.fields.find(field => field.name === item.field?.replace("_s3key", ""));
        if (!field || !field.processor) {
            console.error("[EXULU] field not found or processor not set for field", item.field, " in context", this.id);
            throw new Error("Field not found or processor not set for field " + item.field + " in context " + this.id);
        }
        const exuluStorage = new ExuluStorage({ config });
        const queue = await field.processor.config?.queue;
        if (queue?.queue.name) {
            console.log("[EXULU] processor is in queue mode, scheduling job.")
            const job = await bullmqDecorator({
                label: `${this.name} ${field.name} data processor`,
                processor: `${this.id}-${field.name}`,
                context: this.id,
                inputs: item,
                item: item.id,
                queue: queue.queue,
                user,
                role,
                trigger: trigger,
                retries: 2
            })

            return {
                result: "",
                job: job.id,
            };
        }

        const result = await field.processor.execute({
            item,
            user,
            role,
            utils: {
                storage: exuluStorage,
                items: {
                    update: this.updateItem,
                    create: this.createItem,
                    delete: this.deleteItem
                }
            },
            config
        });

        return {
            result,
            job: undefined
        };
    }

    public deleteAll = async (): Promise<VectorOperationResponse> => {
        const { db } = await postgresClient();
        await db.from(getTableName(this.id)).delete();
        await db.from(getChunksTableName(this.id)).delete();
        return {
            count: 0,
            results: []
        }
    }

    public tableExists = async () => {
        const { db } = await postgresClient();
        const tableName = getTableName(this.id);
        console.log("[EXULU] checking if table exists.", tableName)
        const tableExists = await db.schema.hasTable(tableName);
        return tableExists;
    }

    public chunksTableExists = async () => {
        const { db } = await postgresClient();
        const chunksTableName = getChunksTableName(this.id);
        const chunksTableExists = await db.schema.hasTable(chunksTableName);
        return chunksTableExists;
    }


    public createAndUpsertEmbeddings = async (
        item: Item,
        config: ExuluConfig,
        user?: number,
        statistics?: ExuluStatisticParams,
        role?: string,
        job?: string
    ): Promise<{
        id: string,
        chunks?: number
        job?: string
    }> => {

        if (!this.embedder) {
            throw new Error("Embedder is not set for this context.")
        }

        if (!item.id) {
            throw new Error("Item id is required for generating embeddings.")
        }

        const { db } = await postgresClient();

        const { id: source, chunks } = await this.embedder.generateFromDocument({
            ...item,
            id: item.id
        },
            config,
            {
                label: statistics?.label || this.name,
                trigger: statistics?.trigger || "agent"
            }, user, role)

        // first delete all chunks with source = id
        await db.from(getChunksTableName(this.id)).where({ source }).delete();

        // then insert the new / updated chunks
        await db.from(getChunksTableName(this.id)).insert(chunks.map(chunk => ({
            source,
            content: chunk.content,
            chunk_index: chunk.index,
            embedding: pgvector.toSql(chunk.vector)
        })))

        await db.from(getTableName(this.id)).where({ id: item.id }).update({
            embeddings_updated_at: new Date().toISOString()
        }).returning("id")

        return {
            id: item.id,
            chunks: chunks?.length || 0,
            job
        };
    }

    private createItem = async (item: Item, config: ExuluConfig, user?: number, role?: string, upsert?: boolean): Promise<{
        item: Item
        job?: string
    }> => {

        const { db } = await postgresClient();
        const mutation = db.from(getTableName(
            this.id
        )).insert(
            {
                ...item,
                tags: item.tags ? (Array.isArray(item.tags) ? item.tags.join(",") : item.tags) : undefined
            }
        ).returning("id")

        if (upsert) {
            mutation.onConflict().merge();
        }

        const results = await mutation;

        if (!results[0]) {
            throw new Error("Failed to create item.")
        }

        if (
            this.embedder && (
                this.configuration.calculateVectors === "onUpdate" ||
                this.configuration.calculateVectors === "always"
            )
        ) {
            const { job } = await this.embeddings.generate.one({
                item: results[0],
                user: user,
                role: role,
                trigger: "api",
                config: config
            });
            return {
                item: results[0],
                job
            };
        }

        return {
            item: results[0],
            job: undefined
        };
    }

    private updateItem = async (item: Item, config: ExuluConfig, user?: number, role?: string): Promise<{
        item: Item
        job?: string
    }> => {
        const { db } = await postgresClient();

        if (item.field) {
            delete item.field;
        }

        const record = await db.from(
            getTableName(this.id)
        ).where(
            { id: item.id }
        ).first();

        if (!record) {
            throw new Error("Item not found.")
        }

        const mutation = db.from(
            getTableName(this.id)
        ).where(
            { id: record.id }
        ).update(
            {
                ...item,
                tags: item.tags ? (Array.isArray(item.tags) ? item.tags.join(",") : item.tags) : undefined
            }
        ).returning("id");

        await mutation;

        if (
            this.embedder && (
                this.configuration.calculateVectors === "onUpdate" ||
                this.configuration.calculateVectors === "always"
            )
        ) {
            const { job } = await this.embeddings.generate.one({
                item: record, // important we need to full record here with all fields
                user: user,
                role: role,
                trigger: "api",
                config: config
            });
            return {
                item: record,
                job
            };
        }

        return {
            item: record,
            job: undefined
        };
    }

    private deleteItem = async (item: Item, user?: number, role?: string): Promise<{
        id: string
        job?: string
    }> => {

        if (!item.id) {
            throw new Error("Item id is required for deleting item.")
        }

        const { db } = await postgresClient();
        await db.from(getTableName(this.id)).where({ id: item.id }).delete();

        if (!this.embedder) {
            return {
                id: item.id,
                job: undefined
            };
        }

        const chunks = await db.from(getChunksTableName(this.id))
            .where({ source: item.id })
            .select("id");

        if (chunks.length > 0) {
            // delete chunks first
            await db.from(getChunksTableName(this.id))
                .where({ source: item.id })
                .delete();
        }
        return {
            id: item.id,
            job: undefined
        };
    }

    public embeddings = {
        generate: {
            one: async ({
                item,
                user,
                role,
                trigger,
                config
            }: {
                item: Item,
                user?: number,
                role?: string,
                trigger: STATISTICS_LABELS,
                config: ExuluConfig
            }): Promise<{
                id: string,
                job?: string,
                chunks?: number
            }> => {

                console.log("[EXULU] Generating embeddings for item", item.id)

                if (!this.embedder) {
                    throw new Error("Embedder is not set for this context.")
                }

                if (!item.id) {
                    throw new Error("Item id is required for generating embeddings.")
                }

                const queue = await this.embedder.queue;
                if (queue?.queue.name) {
                    console.log("[EXULU] embedder is in queue mode, scheduling job.")
                    const job = await bullmqDecorator({
                        label: `${this.embedder.name}`,
                        embedder: this.embedder.id,
                        context: this.id,
                        inputs: item,
                        item: item.id,
                        queue: queue.queue,
                        user: user,
                        role: role,
                        trigger: trigger || "agent",
                    })

                    return {
                        id: item.id,
                        job: job.id,
                        chunks: 0
                    };
                }

                // If no queue set, calculate embeddings directly.
                return await this.createAndUpsertEmbeddings(item, config, user, {
                    label: this.embedder.name,
                    trigger: trigger || "agent"
                }, role, undefined);
            },
            all: async (config: ExuluConfig, userId?: number, roleId?: string): Promise<{
                jobs: string[],
                items: number
            }> => {

                const { db } = await postgresClient();

                const items = await db.from(getTableName(this.id))
                    .select("*");

                const jobs: string[] = [];

                const queue = await this.embedder?.queue;
                // Safeguard against too many items
                if (
                    !queue?.queue.name &&
                    items.length > 2000
                ) {
                    throw new Error(`Embedder is not in queue mode, cannot generate embeddings for more than 
                        2.000 items at once, if you need to generate embeddings for more items please configure 
                        the embedder to use a queue. You can configure the embedder to use a queue by setting 
                        the queue property in the embedder configuration.`)
                }

                for (const item of items) {
                    const { job } = await this.embeddings.generate.one({
                        item,
                        user: userId,
                        role: roleId,
                        trigger: "api",
                        config: config
                    });
                    if (job) {
                        jobs.push(job);
                    }
                }

                return {
                    jobs: jobs || [],
                    items: items.length
                };

            }
        }
    }

    public createItemsTable = async () => {
        const { db } = await postgresClient();
        const tableName = getTableName(this.id);
        console.log("[EXULU] Creating table: " + tableName);
        return await db.schema.createTable(tableName, (table) => {
            console.log("[EXULU] Creating fields for table.", this.fields);
            table.uuid("id").primary().defaultTo(db.fn.uuid());
            table.text("name");
            table.text('description');
            table.text('tags');
            table.boolean('archived').defaultTo(false);
            table.text('external_id');
            table.text('created_by');
            table.text('ttl')
            table.text('rights_mode').defaultTo(this.configuration?.defaultRightsMode ?? "private");
            table.integer('textlength');
            table.text('source');
            table.timestamp('embeddings_updated_at')
            table.unique(["id", "external_id"])
            for (const field of this.fields) {
                let { type, name, unique } = field;
                if (!type || !name) {
                    continue;
                }
                if (type === "file") {
                    name = name + "_s3key"
                }
                mapType(table, type, sanitizeName(name), undefined, unique);
            }
            table.timestamp('createdAt').defaultTo(db.fn.now());
            table.timestamp('updatedAt').defaultTo(db.fn.now());
        });
    }

    public createChunksTable = async () => {
        // We refresh the connection here because when running this as
        // part of the database initialization, the connection might not
        // have all extensions setup yet, which can cause issues with the
        // the use of vector_cosine_ops.
        const { db } = await refreshPostgresClient();
        const tableName = getChunksTableName(this.id);
        console.log("[EXULU] Creating table: " + tableName);

        await db.schema.createTable(tableName, (table) => {
            if (!this.embedder) {
                throw new Error("Embedder must be set for context " + this.name + " to create chunks table.")
            }
            table.uuid("id").primary().defaultTo(db.fn.uuid());
            table.uuid("source").references("id").inTable(getTableName(this.id));
            table.text("content");
            // Metadata column
            table.jsonb("metadata");
            table.integer("chunk_index");
            table.specificType('embedding', `vector(${this.embedder.vectorDimensions})`);

            // Generated tsvector column (PG 12+)
            table.specificType(
                "fts",
                `tsvector GENERATED ALWAYS AS (to_tsvector('${this.configuration.language || "english"}', coalesce(content, ''))) STORED`
            );

            // GIN index on the tsvector and hnsw index on the embedding
            table.index(["fts"], `${tableName}_fts_gin_idx`, "gin");
            table.index(["source"], `${tableName}_source_idx`);
            table.timestamp('createdAt').defaultTo(db.fn.now());
            table.timestamp('updatedAt').defaultTo(db.fn.now());
        });

        // HNSW for ANN search (pgvector >= 0.5)
        await db.raw(`
            CREATE INDEX IF NOT EXISTS ${tableName}_embedding_hnsw_cosine
            ON ${tableName}
            USING hnsw (embedding vector_cosine_ops)
            WITH (m = 16, ef_construction = 64)
            WHERE embedding IS NOT NULL
        `);

        return;
    }

    // Exports the context as a tool that can be used by an agent
    public tool = (): ExuluTool => {
        return new ExuluTool({
            id: this.id,
            name: `${this.name}`,
            type: "context",
            inputSchema: z.object({
                query: z.string(),
            }),
            config: [],
            description: `Gets information from the context called: ${this.name}. The context description is: ${this.description}.`,
            execute: async ({ query, user, role }: any) => {
                const { db } = await postgresClient();
                // todo make trigger more specific with the agent name
                // todo roadmap, auto add the normal filter criteria of a context as input schema so the agent can
                //   next to semantic search also add regular filters.
                const result = await vectorSearch({
                    page: 1,
                    limit: 10,
                    query,
                    filters: [],
                    user,
                    role,
                    method: "hybridSearch",
                    context: this,
                    db,
                    sort: undefined,
                    trigger: "agent"
                })

                await updateStatistic({
                    name: "count",
                    label: this.name,
                    type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
                    trigger: "tool",
                    count: 1,
                    user: user?.id,
                    role: user?.role?.id
                })

                return {
                    items: result.items
                }
            },
        });
    }
}

export type STATISTICS_LABELS = "tool" | "agent" | "flow" | "api" | "claude-code" | "user"
export type ExuluStatistic = {
    name: string,
    label: string,
    type: STATISTICS_TYPE,
    trigger: STATISTICS_LABELS,
    total: number,
}

export type ExuluStatisticParams = Omit<ExuluStatistic, "total" | "name" | "type">

export const updateStatistic = async (statistic: Omit<ExuluStatistic, "total"> & { count?: number, user?: number, role?: string }) => {
    console.log("[EXULU] Updating statistic", statistic)
    const currentDate = new Date().toISOString().split('T')[0];
    const { db } = await postgresClient();

    const existing = await db.from("tracking").where({
        ...(statistic.user ? { user: statistic.user } : {}),
        ...(statistic.role ? { role: statistic.role } : {}),
        name: statistic.name,
        label: statistic.label,
        type: statistic.type,
        createdAt: currentDate
    }).first();

    console.log("[EXULU] Existing", existing)

    // Update a specific statistic by name, label and type for a particular day.
    // If the statistic does not exist, it will be created.
    // If the statistic exists, it will be updated by incrementing the total count.
    if (!existing) {
        await db.from("tracking").insert({
            name: statistic.name,
            label: statistic.label,
            type: statistic.type,
            total: statistic.count ?? 1,
            createdAt: currentDate,
            ...(statistic.user ? { user: statistic.user } : {}),
            ...(statistic.role ? { role: statistic.role } : {})
        })
    } else {
        await db.from("tracking").update({
            total: db.raw("total + ?", [statistic.count ?? 1]),
        }).where({
            name: statistic.name,
            label: statistic.label,
            type: statistic.type,
            createdAt: currentDate
        })
    }

}

const generateS3Key = (filename) => `${randomUUID()}-${filename}`

const getMimeType = (type: allFileTypes) => {
    switch (type) {
        case '.png':
            return 'image/png'
        case '.jpg':
            return 'image/jpg'
        case '.jpeg':
            return 'image/jpeg'
        case '.gif':
            return 'image/gif'
        case '.webp':
            return 'image/webp'
        case '.pdf':
            return 'application/pdf'
        case '.docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        case '.xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        case '.xls':
            return 'application/vnd.ms-excel'
        case '.csv':
            return 'text/csv'
        case '.pptx':
            return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        case '.ppt':
            return 'application/vnd.ms-powerpoint'
        case '.m4a':
            return 'audio/mp4'
        case '.mp4':
            return 'audio/mp4'
        case '.mpeg':
            return 'audio/mpeg'
        case '.mp3':
            return 'audio/mp3'
        case '.wav':
            return 'audio/wav'
        case '.txt':
            return 'text/plain'
        case '.md':
            return 'text/markdown'
        case '.json':
            return 'application/json'
        default:
            return ''
    }
}