import { Queue } from "bullmq";
import { z } from "zod"
import { convertToModelMessages, generateObject, generateText, type LanguageModel, streamText, tool, type Tool, type UIMessage, validateUIMessages, stepCountIs, hasToolCall } from "ai";
import { type STATISTICS_TYPE, STATISTICS_TYPE_ENUM } from "@EXULU_TYPES/enums/statistics";
import { postgresClient, refreshPostgresClient } from "../postgres/client";
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";
import type { Item } from "@EXULU_TYPES/models/item";
import pgvector from 'pgvector/knex'; // DONT REMOVE THIS
import { bullmqDecorator } from "./decoraters/bullmq";
import { mapType } from "./utils/map-types";
import { sanitizeName } from "./utils/sanitize-name";
import CryptoJS from 'crypto-js';
import { applyFilters, contextToTableDefinition, vectorSearch } from "./utils/graphql";
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
import type { Agent } from "@EXULU_TYPES/models/agent";
import type { TestCase } from "@EXULU_TYPES/models/test-case";
import type { Request } from "express";
import { parseOfficeAsync } from 'officeparser';
import type { VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import type { Project } from "@EXULU_TYPES/models/project";

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

const projectsCache = new Map<string, {
    age: Date,
    project: Project
}>();

export const createProjectRetrievalTool = async ({
    user,
    role,
    contexts,
    projectId
}: {
    user?: User,
    role?: string,
    contexts: ExuluContext[]
    projectId: string
}): Promise<ExuluTool | undefined> => {

    let project: Project | undefined;

    const cachedProject = projectsCache.get(projectId);
    // Check if cached project more than 1 minute old
    // this to avoid fetching the project for each tool
    // array generation.
    const OneMinuteAgo = new Date(Date.now() - 1000 * 60);
    if (cachedProject && cachedProject.age > OneMinuteAgo) {
        project = cachedProject.project;
    } else {
        const { db } = await postgresClient();
        project = await db.from("projects").where("id", projectId).first();
        if (project) {
            projectsCache.set(projectId, {
                age: new Date(),
                project: project
            });
        }
        else {
            return;
        }
    }
    console.log("[EXULU] Project search tool created for project", project);

    if (!project.project_items?.length) {
        return;
    }

    const projectRetrievalTool = new ExuluTool({
        id: "project_information_retrieval_tool_" + projectId,
        name: "Project information retrieval tool for project " + project.name,
        description: "This tool retrieves information about a project from conversations and items that were added to the project " + project.name + ".",
        inputSchema: z.object({
            query: z.string().describe("The query to retrieve information about the project " + project.name + "."),
            keywords: z.array(z.string()).describe("The most relevant keywords in the query, such as names of people, companies, products, etc. in the project " + project.name + "."),
        }),
        type: "function",
        category: "project",
        config: [],
        execute: async ({ query, keywords }: any) => {

            console.log("[EXULU] Project search tool searching for project", project);

            const items = project.project_items!;

            const set = {}
            for (const item of items) {
                // Items array in project are structured as 
                // global ids ('<context_id>/<item_id>').
                const context: string | undefined = item.split("/")[0];

                if (!context) {
                    throw new Error("The item added to the project does not have a valid gid with the context id as the prefix before the first slash.");
                }

                const id = item.split("/").slice(1).join("/");
                if (set[context]) {
                    set[context].push(id);
                } else {
                    set[context] = [id];
                }
            }

            console.log("[EXULU] Project search tool searching through contexts", Object.keys(set));
            // Run retrieval for each context in paralal.
            // todo add typing
            const results = await Promise.all(Object.keys(set).map(async (contextName, index) => {
                const context = contexts.find(context => context.id === contextName);
                if (!context) {
                    console.error("[EXULU] Context not found for project information retrieval tool.", contextName);
                    return [];
                }
                const itemIds = set[contextName];

                console.log("[EXULU] Project search tool searching through items", itemIds);

                // Run retrieval over the items that are added to
                // the project.
                return await context.search({
                    // todo check if it is more performant to use a concatenation of
                    // the query and keywords, or just the keywords, instead of the 
                    // query itself.
                    query: query,
                    filters: [{
                        id: {
                            in: itemIds
                        }
                    }],
                    user: user,
                    role: role,
                    method: "hybridSearch",
                    sort: {
                        field: "updatedAt",
                        direction: "desc",
                    },
                    trigger: "tool",
                    limit: 10,
                    page: 1,
                });
            }));

            // Todo for contexts that dont have an embedder fall back to keyword search.
            console.log("[EXULU] Project search tool results", results);
            return {
                result: JSON.stringify(results.flat()),
            }
        }
    })

    return projectRetrievalTool;
}

export const convertToolsArrayToObject = async (
    currentTools: ExuluTool[] | undefined,
    allExuluTools: ExuluTool[] | undefined,
    configs: ExuluAgentToolConfig[] | undefined,
    providerapikey?: string,
    contexts?: ExuluContext[] | undefined,
    user?: User,
    exuluConfig?: ExuluConfig,
    sessionID?: string,
    req?: Request,
    project?: string
): Promise<Record<string, Tool>> => {

    if (!currentTools) return {};
    if (!allExuluTools) return {};
    if (!contexts) {
        contexts = [];
    }

    if (project) {
        const projectRetrievalTool = await createProjectRetrievalTool({
            user: user,
            role: user?.role?.id,
            contexts: contexts,
            projectId: project
        });
        if (projectRetrievalTool) {
            currentTools.push(projectRetrievalTool);
        }
    }

    const sanitizedTools = currentTools ? currentTools.map(tool => ({
        ...tool,
        name: sanitizeToolName(tool.name)
    })) : [];

    console.log("[EXULU] Sanitized tools", sanitizedTools.map(x => x.name + " (" + x.id + ")"))

    return {
        ...sanitizedTools?.reduce(
            (prev, cur) => {

                let toolVariableConfig = configs?.find(config => config.id === cur.id);

                // Allows a dev to set a config option for an ExuluTool that overwrites the default tool description.
                const userDefinedConfigDescription = toolVariableConfig?.config.find(config => config.name === "description")?.value
                const defaultConfigDescription = toolVariableConfig?.config.find(config => config.name === "description")?.default
                const toolDescription = cur.description;
                const description = userDefinedConfigDescription || defaultConfigDescription || toolDescription;

                return {
                    ...prev, [cur.name]: {
                        ...cur.tool,
                        description,
                        async *execute(inputs: any, options: any) { // generator function allows to use yield to stream tool call results
                            if (!cur.tool?.execute) {
                                console.error("[EXULU] Tool execute function is undefined.", cur.tool)
                                throw new Error("Tool execute function is undefined.")
                            }

                            if (toolVariableConfig) {
                                toolVariableConfig = await hydrateVariables(toolVariableConfig || []);
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
                                                `[EXULU] Error from S3 while uploading object to ${exuluConfig?.fileUploads?.s3Bucket}. \
                                    The object was too large. To upload objects larger than 5GB, use the S3 console (160GB max) \
                                    or the multipart upload API (5TB max).`,
                                            );
                                        } else if (caught instanceof S3ServiceException) {
                                            console.error(
                                                `[EXULU] Error from S3 while uploading object to ${exuluConfig?.fileUploads?.s3Bucket}.  ${caught.name}: ${caught.message}`,
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

                            const response = await cur.tool.execute({
                                ...inputs,
                                sessionID: sessionID,
                                req: req,
                                // Convert config to object format if a config object 
                                // is available, after we added the .value property
                                // by hydrating it from the variables table.
                                providerapikey: providerapikey,
                                allExuluTools,
                                currentTools,
                                user,
                                contexts: contextsMap,
                                upload,
                                exuluConfig,
                                toolVariablesConfig: toolVariableConfig ? toolVariableConfig.config.reduce((acc, curr) => {
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
                }
            }, {}
        ),
        // askForConfirmation
    }
}

const hydrateVariables = async (tool: ExuluAgentToolConfig): Promise<ExuluAgentToolConfig> => {
    const { db } = await postgresClient();
    const promises = tool.config.map(async (toolConfig) => {

        if (!toolConfig.variable) {
            return toolConfig;
        }

        // Get the variable name from user's anthropic_token field
        const variableName = toolConfig.variable;

        // Look up the variable from the variables table
        const variable = await db.from("variables").where({ name: variableName }).first();

        if (!variable) {
            throw new Error("Variable " + variableName + " not found.")
        }

        // Get the API key from the variable (decrypt if encrypted)
        let value = variable.value;

        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            value = bytes.toString(CryptoJS.enc.Utf8);
        }

        toolConfig.value = value;

        return toolConfig;
    })
    await Promise.all(promises);
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
        create: ({ apiKey }: { apiKey?: string | undefined }) => LanguageModel
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
    queue?: ExuluQueueConfig;
    maxContextLength?: number;
    authenticationInformation?: string;
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
}

interface ExuluAgentToolConfig {
    id: string,
    type: string,
    config: {
        name: string,
        variable: string // is a variable name
        value?: any // fetched on demand from the database based on the variable name
        default?: string
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
    timeoutInSeconds?: number, // 3 minutes default
    concurrency: {
        worker: number
        queue: number
    }
    retries?: number
    backoff?: {
        type: 'exponential' | 'linear'
        delay: number // in milliseconds
    }
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
    llm: boolean;
    execute: (params: {
        agent: Agent,
        backend: ExuluAgent,
        messages: UIMessage[],
        testCase: TestCase,
        config?: Record<string, any>
    }) => Promise<number>;
    config?: {
        name: string,
        description: string
    }[];
    queue: Promise<ExuluQueueConfig>;
}

export class ExuluEval {
    public id: string;
    public name: string;
    public description: string;
    public llm: boolean;
    private execute: (params: {
        agent: Agent,
        testCase: TestCase,
        backend: ExuluAgent,
        messages: UIMessage[],
        config?: Record<string, any>
    }) => Promise<number>;
    public config?: {
        name: string,
        description: string
    }[];

    public queue?: Promise<ExuluQueueConfig>;

    constructor({ id, name, description, execute, config, queue, llm }: ExuluEvalParams) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.execute = execute;
        this.config = config;
        this.llm = llm;
        this.queue = queue;
    }

    public async run(agent: Agent, backend: ExuluAgent, testCase: TestCase, messages: UIMessage[], config?: Record<string, any>): Promise<number> {
        try {
            const score = await this.execute({ agent, backend, testCase, messages, config });
            if (score < 0 || score > 100) {
                throw new Error(`Eval function ${this.name} must return a score between 0 and 100, got ${score}`);
            }
            return score;
        } catch (error: unknown) {
            console.error(`[EXULU] error running eval function ${this.name}.`, error);
            throw new Error(`Error running eval function ${this.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
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
    public authenticationInformation?: string;
    public maxContextLength?: number;
    public queue?: ExuluQueueConfig;
    public rateLimit?: RateLimiterRule;
    public config?: ExuluAgentConfig | undefined;
    // private memory: Memory | undefined; // TODO do own implementation
    public model?: {
        create: ({ apiKey }: { apiKey?: string | undefined }) => LanguageModel
    };
    public capabilities: {
        text: boolean,
        images: string[],
        files: string[],
        audio: string[],
        video: string[]
    }
    constructor({ id, name, description, config, rateLimit, capabilities, type, maxContextLength, provider, queue, authenticationInformation }: ExuluAgentParams) {
        this.id = id;
        this.name = name;
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
        return this.provider;
    }

    get modelName(): string {
        if (!this.config?.model?.create) {
            return ""
        }
        return this.config?.name || "";
    }

    // Exports the agent as a tool that can be used by another agent
    public tool = async (instance: string, agents: ExuluAgent[]): Promise<ExuluTool | null> => {

        const agentInstance = await loadAgent(instance);

        if (!agentInstance) {
            return null;
        }

        return new ExuluTool({
            id: agentInstance.id,
            name: `${agentInstance.name}`,
            type: "agent",
            category: "agents",
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


                let providerapikey: string | undefined;

                if (variableName) {

                    const { db } = await postgresClient();
                    // Look up the variable from the variables table
                    const variable = await db.from("variables").where({ name: variableName }).first();
                    if (!variable) {
                        throw new Error("Provider API key variable not found for agent: " + agentInstance.name + " (" + agentInstance.id + ") being called as a tool.")
                    }

                    // Get the API key from the variable (decrypt if encrypted)
                    providerapikey = variable.value;

                    if (!variable.encrypted) {
                        throw new Error("Provider API key variable not encrypted for agent: " + agentInstance.name + " (" + agentInstance.id + ") being called as a tool, for security reasons you are only allowed to use encrypted variables for provider API keys.")
                    }

                    if (variable.encrypted) {
                        const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                        providerapikey = bytes.toString(CryptoJS.enc.Utf8);
                    }

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
        exuluConfig,
        outputSchema,
        instructions

    }: {
        prompt?: string,
        user?: User,
        req?: Request,
        session?: string,
        inputMessages?: UIMessage[],
        currentTools?: ExuluTool[],
        allExuluTools?: ExuluTool[],
        statistics?: ExuluStatisticParams,
        toolConfigs?: ExuluAgentToolConfig[],
        providerapikey?: string | undefined,
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

        if (prompt && inputMessages?.length) {
            throw new Error("Message and prompt cannot be provided at the same time.")
        }

        if (!prompt && !inputMessages?.length) {
            throw new Error("Prompt or message is required for generating.")
        }

        if (outputSchema && !prompt) {
            throw new Error("Prompt is required for generating with an output schema.")
        }

        const model = this.model.create({
            ...(providerapikey ? { apiKey: providerapikey } : {})
        })

        console.log("[EXULU] Model for agent: " + this.name, " created for generating sync.")

        let messages: UIMessage[] = inputMessages || [];
        if (messages && session && user) {
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
                messages: [...previousMessagesContent, ...messages],
            });
        }

        console.log("[EXULU] Message count for agent: " + this.name, "loaded for generating sync.", messages.length)

        let project: string | undefined;
        if (session) {
            const sessionData = await getSession({ sessionID: session })
            project = sessionData.project;
        }

        const personalizationInformation = exuluConfig?.privacy?.systemPromptPersonalization !== false ? `
                ${user?.firstname ? `The users first name is "${user.firstname}"` : ""}
                ${user?.lastname ? `The users last name is "${user.lastname}"` : ""}
                ${user?.email ? `The users email is "${user.email}"` : ""}
        ` : "";

        const genericContext =
            `IMPORTANT general information:
                ${personalizationInformation}
                The current date is "${new Date().toLocaleDateString()}" and the current time is "${new Date().toLocaleTimeString()}". 
                If the user does not explicitly provide the current date, for examle when saying ' this weekend', you should assume 
                they are talking with the current date in mind as a reference.`;

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
                    tools: await convertToolsArrayToObject(
                        currentTools,
                        allExuluTools,
                        toolConfigs,
                        providerapikey,
                        contexts,
                        user,
                        exuluConfig,
                        session,
                        req,
                        project
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
                tools: await convertToolsArrayToObject(
                    currentTools,
                    allExuluTools,
                    toolConfigs,
                    providerapikey,
                    contexts,
                    user,
                    exuluConfig,
                    session,
                    req,
                    project
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

    /**
     * Convert file parts in messages to OpenAI Responses API compatible format.
     * The OpenAI Responses API doesn't support inline file parts with type 'file'.
     * This function converts:
     * - Document files (PDF, DOCX, etc.) -> text parts with extracted content using officeparser
     * - Image files -> image parts (which ARE supported by Responses API)
     */
    private async processFilePartsInMessages(messages: UIMessage[]): Promise<UIMessage[]> {
        const processedMessages = await Promise.all(messages.map(async (message) => {

            // Only process user messages with content array
            if (message.role !== 'user' || !Array.isArray(message.parts)) {
                return message;
            }

            const processedParts: UIMessage['parts'] = await Promise.all(message.parts.map(async (part: any) => {
                // If not a file part, return as-is
                if (part.type !== 'file') {
                    return part;
                }

                console.log(`[EXULU] Processing part`, part);
                const { mediaType, url, filename } = part;

                // Check if it's an image file - these are supported as image parts
                console.log(`[EXULU] Media type: ${mediaType}`);
                console.log(`[EXULU] URL: ${url}`);
                console.log(`[EXULU] Filename: ${filename}`);
                const imageTypes = ['.png', '.jpeg', '.jpg', '.gif', '.webp'];
                const imageType = imageTypes.find(type => filename.toLowerCase().includes(type.toLowerCase()));
                if (imageType) {
                    console.log(`[EXULU] Converting file part to image part: ${filename} `);
                    return {
                        type: 'file',
                        mediaType: `image/${imageType.replace('.', '')}`,
                        url: url,
                    };
                }

                // For document files, fetch content and extract text using officeparser
                console.log(`[EXULU] Converting file part to text using officeparser: ${filename}`);
                try {
                    // Fetch the file content from the URL
                    const response = await fetch(url);
                    if (!response.ok) {
                        console.error(`[EXULU] Failed to fetch file: ${filename}, status: ${response.status} `);
                        return {
                            type: 'text',
                            text: `[Error: Could not load file ${filename}]`
                        };
                    }

                    // Get the file as a buffer
                    const arrayBuffer = await response.arrayBuffer();

                    // Parse the document using officeparser
                    const extractedText = await parseOfficeAsync(arrayBuffer, {
                        outputErrorToConsole: false,
                        newlineDelimiter: '\n'
                    });

                    // Return as text part with extracted content wrapped in XML-like tags
                    return {
                        type: 'text',
                        text: `<file file name = "${filename}" >\n${extractedText} \n </file>`
                    };
                } catch (error) {
                    console.error(`[EXULU] Error processing file ${filename}:`, error);
                    return {
                        type: 'text',
                        text: `[Error extracting text from file ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}]`
                    };
                }
            }));

            const result = {
                ...message,
                parts: processedParts
            };
            console.log("[EXULU] Result: " + JSON.stringify(result, null, 2));
            return result;
        }));

        return processedMessages;
    }

    generateStream = async ({
        user,
        session,
        message,
        previousMessages,
        currentTools,
        allExuluTools,
        toolConfigs,
        providerapikey,
        contexts,
        exuluConfig,
        instructions,
        req,
    }: {
        user?: User,
        session?: string,
        message?: UIMessage,
        previousMessages?: UIMessage[],
        currentTools?: ExuluTool[],
        allExuluTools?: ExuluTool[],
        toolConfigs?: ExuluAgentToolConfig[],
        providerapikey?: string | undefined,
        contexts?: ExuluContext[] | undefined
        exuluConfig?: ExuluConfig,
        instructions?: string,
        req?: Request,
    }) => {

        if (!this.model) {
            console.error("[EXULU] Model is required for streaming.")
            throw new Error("Model is required for streaming.")
        }

        if (!this.config) {
            console.error("[EXULU] Config is required for streaming.")
            throw new Error("Config is required for generating.")
        }

        if (!message) {
            console.error("[EXULU] Message is required for streaming.")
            throw new Error("Message is required for streaming.")
        }

        const model = this.model.create({
            ...(providerapikey ? { apiKey: providerapikey } : {})
        })

        let messages: UIMessage[] = [];
        let previousMessagesContent: UIMessage[] = previousMessages || [];
        // load the previous messages from the server:
        let project: string | undefined;
        if (session) {
            const sessionData = await getSession({ sessionID: session })
            project = sessionData.project;

            console.log("[EXULU] loading previous messages from session: " + session)
            const previousMessages = await getAgentMessages({
                session,
                user: user?.id,
                limit: 50,
                page: 1
            })
            previousMessagesContent = previousMessages.map(
                (message) => JSON.parse(message.content)
            );
        }

        // validate messages
        messages = await validateUIMessages({
            // append the new message to the previous messages:
            messages: [...previousMessagesContent, message],
        });

        // filter out messages with duplicate ids
        messages = messages.filter((message, index, self) =>
            index === self.findIndex((t) => t.id === message.id)
        );

        // Process file parts to convert them to OpenAI Responses API compatible format
        // which mostly means converting file parts to text parts unless they are images.

        messages = await this.processFilePartsInMessages(messages);

        // Simple things like the current date, time, etc.
        // we add these to the context to help the agent
        // by default.
        const genericContext =
            "IMPORTANT: \n\n The current date is " + new Date().toLocaleDateString() + " and the current time is " + new Date().toLocaleTimeString() + ". If the user does not explicitly provide the current date, for examle when saying ' this weekend', you should assume they are talking with the current date in mind as a reference.";

        let system = instructions || "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.";
        system += "\n\n" + genericContext;

        const result = streamText({
            model: model, // Should be a LanguageModelV1
            messages: convertToModelMessages(messages, {
                ignoreIncompleteToolCalls: true
            }),
            // PrepareStep could be used here to set the model 
            // for the first step or change other parameters.
            system,
            maxRetries: 2,
            providerOptions: {
                openai: {
                    reasoningSummary: 'auto',
                },
            },
            tools: await convertToolsArrayToObject(
                currentTools,
                allExuluTools,
                toolConfigs,
                providerapikey,
                contexts,
                user,
                exuluConfig,
                session,
                req,
                project
            ),
            onError: error => {
                console.error("[EXULU] chat stream error.", error);
                throw new Error(`Chat stream error: ${error instanceof Error ? error.message : String(error)}`);
            },
            // stopWhen: [stepCountIs(1)],
        });

        return {
            stream: result,
            originalMessages: messages,
            previousMessages: previousMessagesContent,
        };
    }
}

// todo check how to deal with pagination
const getAgentMessages = async ({ session, user, limit, page }: { session: string, user?: number, limit: number, page: number }) => {
    const { db } = await postgresClient();
    console.log("[EXULU] getting agent messages for session: " + session + " and user: " + user + " and page: " + page)
    const query = db.from("agent_messages").where({ session, user: user || null }).limit(limit)
    if (page > 0) {
        query.offset((page - 1) * limit)
    }
    const messages = await query;
    return messages;
}

export const getSession = async ({ sessionID }: { sessionID: string }) => {
    const { db } = await postgresClient();
    console.log("[EXULU] getting session for session ID: " + sessionID)
    const session = await db.from("agent_sessions").where({ id: sessionID }).first();
    if (!session) {
        throw new Error("Session not found for session ID: " + sessionID);
    }
    return session;
}

export const saveChat = async ({ session, user, messages }: { session: string, user: number, messages: UIMessage[] }) => {
    const { db } = await postgresClient();
    // Save messages sequentially to maintain correct createdAt timestamps
    for (const message of messages) {
        const mutation = db.from("agent_messages").insert({
            session,
            user,
            content: JSON.stringify(message),
            message_id: message.id,
            title: message.role === "user" ? "User" : "Assistant"
        }).returning('id');
        mutation.onConflict('message_id').merge();
        await mutation;
    }
}

export type VectorOperationResponse = Promise<{
    count: number,
    results: any, // todo
    errors?: string[]
}>

type VectorGenerateOperation = (inputs: ChunkerResponse, settings: Record<string, string>) => VectorGenerationResponse

type ChunkerOperation = (item: Item & { id: string }, maxChunkSize: number, utils: {
    storage: ExuluStorage
}, config: Record<string, string>) => Promise<ChunkerResponse>

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
        metadata: Record<string, string>,
        vector: number[]
    }[]
}>

type ExuluEmbedderConfig = {
    name: string,
    description: string
    default?: string
}

export class ExuluEmbedder {

    public id: string;
    public name: string;
    public slug: string = "";
    public queue?: Promise<ExuluQueueConfig>;
    private generateEmbeddings: VectorGenerateOperation;
    public description: string;
    public vectorDimensions: number;
    public config?: ExuluEmbedderConfig[]
    public maxChunkSize: number;
    public _chunker: ChunkerOperation;
    constructor({ id, name, description, generateEmbeddings, queue, vectorDimensions, maxChunkSize, chunker, config }: {
        id: string,
        name: string,
        description: string,
        config?: ExuluEmbedderConfig[],
        generateEmbeddings: VectorGenerateOperation,
        chunker: ChunkerOperation,
        queue?: Promise<ExuluQueueConfig>,
        vectorDimensions: number,
        maxChunkSize: number
    }) {
        this.id = id;
        this.name = name;
        this.config = config;
        this.description = description;
        this.vectorDimensions = vectorDimensions;
        this.maxChunkSize = maxChunkSize;

        this._chunker = chunker;
        this.slug = `/embedders/${generateSlug(this.name)}/run`
        this.queue = queue;
        this.generateEmbeddings = generateEmbeddings;
    }

    public chunker = async (
        context: string,
        item: Item & { id: string },
        maxChunkSize: number,
        config: ExuluConfig
    ) => {
        const utils = {
            storage: new ExuluStorage({ config })
        }
        const settings = await this.hydrateEmbedderConfig(context);
        return this._chunker(item, maxChunkSize, utils, settings);
    }

    private hydrateEmbedderConfig = async (context: string): Promise<Record<string, string>> => {

        const hydrated: {
            id: string,
            name: string,
            value: string
        }[] = []

        const { db } = await postgresClient();

        const variables = await db.from("embedder_settings").where({
            context: context,
            embedder: this.id
        })

        for (const config of this.config || []) {
            const name = config.name;
            const setting = variables.find(v => v.name === name);

            if (!setting) {
                throw new Error("Setting value not found for embedder setting: " + name + ", for context: " + context + " and embedder: " + this.id + ". Make sure to set the value for this setting in the embedder settings.");
            }

            const {
                value: variableName,
                id
            } = setting;

            let value = "";

            // Look up the variable from the variables table
            const variable = await db.from("variables").where({ name: variableName }).first();

            if (!variable) {
                throw new Error("Variable not found for embedder setting: " + name + " in context: " + context + " and embedder: " + this.id);
            }

            if (variable.encrypted) {
                if (!process.env.NEXTAUTH_SECRET) {
                    throw new Error("NEXTAUTH_SECRET environment variable is not set, cannot decrypt variable: " + name);
                }

                try {
                    const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                    const decrypted = bytes.toString(CryptoJS.enc.Utf8);

                    if (!decrypted) {
                        throw new Error("Decryption returned empty string - invalid key or corrupted data");
                    }

                    value = decrypted;
                } catch (error) {
                    throw new Error(`Failed to decrypt variable "${name}" for embedder setting in context "${context}": ${error instanceof Error ? error.message : "Unknown error"}. Verify that NEXTAUTH_SECRET matches the key used during encryption.`);
                }
            } else {
                value = variable.value;
            }

            hydrated.push({
                id: id || "",
                name: name,
                value: value || ""
            })
        }
        return hydrated.reduce((acc, curr) => {
            acc[curr.name] = curr.value;
            return acc;
        }, {});
    }

    public async generateFromQuery(context: string, query: string, statistics?: ExuluStatisticParams, user?: number, role?: string): VectorGenerationResponse {

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

        const settings = await this.hydrateEmbedderConfig(context);

        return await this.generateEmbeddings({
            item: {
                id: "placeholder",
            },
            chunks: [{
                content: query,
                index: 1,
            }]
        }, settings)
    }

    public async generateFromDocument(
        context: string,
        input: Item,
        config: ExuluConfig,
        statistics?: ExuluStatisticParams,
        user?: number,
        role?: string
    ): VectorGenerationResponse {

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

        const settings = await this.hydrateEmbedderConfig(context);

        const output = await this.chunker(
            context,
            input as Item & { id: string },
            this.maxChunkSize,
            config
        )

        console.log("[EXULU] Generating embeddings.")

        return await this.generateEmbeddings(
            output,
            settings
        )
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

export class ExuluTool {

    // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or 
    // underscores and be a max length of 80 characters and at least 5 characters long.
    // The ID is used for storing references to tools so it is important it does not change.
    public id: string;
    public name: string;
    public description: string;
    public category: string;
    public inputSchema?: z.ZodType;
    public type: "context" | "function" | "agent";
    public tool: Tool
    public config: {
        name: string,
        description: string
        default?: string
    }[]

    constructor({ id, name, description, category, inputSchema, type, execute, config }: {
        id: string,
        name: string,
        description: string,
        category?: string,
        inputSchema?: z.ZodType,
        type: "context" | "function" | "agent",
        config: {
            name: string,
            description: string
            default?: string
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
        this.category = category || "default";
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
    execute: ({
        item,
        user,
        role,
        utils,
        exuluConfig
    }: {
        item: Item & { field: string },
        user?: number,
        role?: string,
        utils: {
            storage: ExuluStorage
        },
        exuluConfig: ExuluConfig
    }) => Promise<Item>,
    config?: {
        queue?: Promise<ExuluQueueConfig>,
        timeoutInSeconds?: number, // 3 minutes default
        trigger: "manual" | "onUpdate" | "onInsert" | "always"
        generateEmbeddings?: boolean, // defines if embeddings are generated after the processor finishes executing
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

export type ExuluRightsMode = "private" | "users" | "roles" | "public"/*  | "projects" */

export class ExuluStorage {
    private config: ExuluConfig
    constructor({ config }: { config: ExuluConfig }) {
        this.config = config;
    }

    public getPresignedUrl = async (key: string) => {
        const bucket = key.split("/")[0];
        if (!bucket || typeof bucket !== 'string' || bucket.trim() === '') {
            throw new Error("Invalid S3 key, must be in the format of <bucket>/<key>.");
        }
        key = key.split("/").slice(1).join("/");
        if (!key || typeof key !== 'string' || key.trim() === '') {
            throw new Error("Invalid S3 key, must be in the format of <bucket>/<key>.");
        }
        return await getPresignedUrlUppy(bucket, key, this.config);
    }

    public uploadFile = async (
        file: Buffer | Uint8Array, 
        fileName: string, 
        type: string,
        user?: number,
        metadata?: Record<string, string>,
        customBucket?: string
    ) => {
        return await uploadFileUppy(
            file,
            fileName,
            this.config,
            {
                contentType: type,
                metadata: {
                    ...metadata,
                    type: type
                },
            },
            user,
            customBucket
        );
    }
    // todo add upload and delete methods
}
export type ExuluContextSource = {
    id: string,
    name: string,
    description: string,
    config?: {
        schedule?: string, // cron expression
        queue?: Promise<ExuluQueueConfig>
        retries?: number
        backoff?: {
            type: 'exponential' | 'linear'
            delay: number // in milliseconds
        }
        params?: {
            name: string,
            description: string,
            default?: string
        }[]
    }

    execute: (inputs: {
        exuluConfig: ExuluConfig
        [key: string]: any;
    }) => Promise<Item[]>,
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
    public sources: ExuluContextSource[] = [];

    constructor({
        id,
        name,
        description,
        embedder,
        active,
        rateLimit,
        fields,
        queryRewriter,
        resultReranker,
        configuration,
        sources
    }: {
        id: string,
        name: string,
        fields: ExuluContextFieldDefinition[],
        description: string,
        embedder?: ExuluEmbedder,
        sources: ExuluContextSource[],
        category?: string,
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
        this.sources = sources || [];
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

    public processField = async (
        trigger: STATISTICS_LABELS,
        item: Item & { field: string },
        exuluConfig: ExuluConfig,
        user?: number,
        role?: string,
    ): Promise<{
        result: Item,
        job?: string
    }> => {

        if (!item.field) {
            throw new Error("Field property on item is required for running a specific processor.")
        }

        // todo add tracking for processor execution
        console.log("[EXULU] processing field", item.field, " in context", this.id);
        console.log("[EXULU] fields", this.fields.map(field => field.name));
        const field = this.fields.find(field => {
            return field.name.replace("_s3key", "") === item.field.replace("_s3key", "");
        });
        if (!field || !field.processor) {
            console.error("[EXULU] field not found or processor not set for field", item.field, " in context", this.id);
            throw new Error("Field not found or processor not set for field " + item.field + " in context " + this.id);
        }
        const exuluStorage = new ExuluStorage({ config: exuluConfig });

        const queue = await field.processor.config?.queue;
        if (queue?.queue.name) {
            console.log("[EXULU] processor is in queue mode, scheduling job.")
            const job = await bullmqDecorator({
                timeoutInSeconds: field.processor?.config?.timeoutInSeconds || 600,
                label: `${this.name} ${field.name} data processor`,
                processor: `${this.id}-${field.name}`,
                context: this.id,
                inputs: item,
                item: item.id,
                queue: queue.queue,
                backoff: queue.backoff || {
                    type: 'exponential',
                    delay: 2000,
                },
                retries: queue.retries || 2,
                user,
                role,
                trigger: trigger
            })

            return {
                result: {},
                job: job.id,
            };
        }

        console.log("[EXULU] POS 1 -- EXULU CONTEXT PROCESS FIELD")
        const processorResult = await field.processor.execute({
            item,
            user,
            role,
            utils: {
                storage: exuluStorage
            },
            exuluConfig
        });

        if (!processorResult) {
            throw new Error("Processor result is required for updating the item in the db.")
        }

        const { db } = await postgresClient();


        // The field key is used to define a processor, but is 
        // not part of the database, so remove it here before
        // we upadte the item in the db.
        delete processorResult.field;

        // Update the item in the db with the processor result
        await db.from(getTableName(this.id)).where({
            id: processorResult.id
        }).update({
            ...processorResult
        });

        return {
            result: processorResult,
            job: undefined
        };
    }

    public search = async (options: {
        query: string,
        filters: any[],
        user?: User,
        role?: string,
        method: VectorMethod,
        sort: any,
        trigger: STATISTICS_LABELS,
        limit: number,
        page: number,
    }): Promise<{
        filters: any[]
        query: string
        method: VectorMethod
        context: {
            name: string
            id: string
            embedder: string
        },
        items: any[]
    }> => {

        const { db } = await postgresClient();

        const result = await vectorSearch({
            ...options,
            user: options.user,
            role: options.role,
            context: this,
            db,
        });

        return result;
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

    public executeSource = async (
        source: ExuluContextSource,
        inputs: any,
        exuluConfig: ExuluConfig
    ): Promise<Item[]> => {
        return await source.execute({
            ...inputs,
            exuluConfig
        });
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

        const { id: source, chunks } = await this.embedder.generateFromDocument(
            this.id,
            {
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
        if (chunks?.length) {
            await db.from(getChunksTableName(this.id)).insert(chunks.map(chunk => ({
                source,
                metadata: chunk.metadata,
                content: chunk.content,
                chunk_index: chunk.index,
                embedding: pgvector.toSql(chunk.vector)
            })))
        }

        await db.from(getTableName(this.id)).where({ id: item.id }).update({
            embeddings_updated_at: new Date().toISOString()
        }).returning("id")

        return {
            id: item.id,
            chunks: chunks?.length || 0,
            job
        };
    }

    public createItem = async (
        item: Item,
        config: ExuluConfig,
        user?: number,
        role?: string,
        upsert?: boolean,
        generateEmbeddingsOverwrite?: boolean | undefined
    ): Promise<{ item: Item, job?: string }> => {


        console.log("[EXULU] creating item", item)
        console.log("[EXULU] upsert", upsert)
        if (upsert && (
            !item.id &&
            !item.external_id
        )) {
            throw new Error("Item id or external id is required for upsert.")
        }

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
            if (item.external_id) {
                mutation.onConflict('external_id').merge();
            } else if (item.id) {
                mutation.onConflict('id').merge();
            } else {
                throw new Error("Either id or external_id must be provided for upsert");
            }
        }

        const results = await mutation;

        if (!results[0]) {
            throw new Error("Failed to create item.")
        }

        console.log("[EXULU] context configuration", this.configuration)

        let jobs: string[] = [];

        let shouldGenerateEmbeddings = (
            this.embedder && generateEmbeddingsOverwrite !== false && (
                generateEmbeddingsOverwrite ||
                this.configuration.calculateVectors === "onInsert" ||
                this.configuration.calculateVectors === "always"
            )
        )

        for (const [key, value] of Object.entries(item)) {

            console.log("[EXULU] Checking for processors for field", key)

            // On purpose only running over the fields included in the item's payload
            // from graphql, as we dont want to process fields that were not provided
            // in the create call, assuming they were not provided on purpose.
            const processor = this.fields.find(field => field.name === key.replace("_s3key", ""))?.processor;

            console.log("[EXULU] Processor found", processor)

            if (
                processor &&
                (
                    processor?.config?.trigger === "onInsert" ||
                    processor?.config?.trigger === "onUpdate" ||
                    processor?.config?.trigger === "always"
                )
            ) {
                const {
                    job: processorJob,
                    result: processorResult
                } = await this.processField(
                    "api",
                    {
                        ...item,
                        id: results[0].id,
                        field: key
                    },
                    config,
                    user,
                    role
                )

                if (processorJob) {
                    jobs.push(processorJob);
                }

                if (!processorJob) {
                    // Update the item in the db with the processor result
                    await db.from(getTableName(this.id)).where({ id: results[0].id }).update({
                        ...processorResult
                    });

                    if (processor.config?.generateEmbeddings) {
                        // means the processor finished already, so we can trigger embeddings
                        // generation directly if the processor has the generateEmbeddings flag 
                        // set to true.
                        shouldGenerateEmbeddings = true;
                    }
                }
            }
        }

        if (shouldGenerateEmbeddings) {
            console.log("[EXULU] generating embeddings for item", results[0].id)
            const { job: embeddingsJob } = await this.embeddings.generate.one({
                item: {
                    ...item,
                    id: results[0].id
                },
                user: user,
                role: role,
                trigger: "api",
                config: config
            });

            if (embeddingsJob) {
                jobs.push(embeddingsJob);
            }
        }

        return {
            item: results[0],
            job: jobs.length > 0 ? jobs.join(",") : undefined
        };
    }

    public updateItem = async (
        item: Item,
        config: ExuluConfig,
        user?: number,
        role?: string,
        generateEmbeddingsOverwrite?: boolean | undefined
    ): Promise<{ item: Item, job?: string }> => {

        console.log("[EXULU] updating item", item)
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

        let jobs: string[] = [];

        let shouldGenerateEmbeddings = (
            this.embedder && generateEmbeddingsOverwrite !== false && (
                generateEmbeddingsOverwrite ||
                this.configuration.calculateVectors === "onUpdate" ||
                this.configuration.calculateVectors === "always"
            )
        )

        for (const [key, value] of Object.entries(item)) {

            // On purpose only running over the fields included in the item's payload
            // from graphql, as we dont want to process fields that were not provided
            // in the update call, assuming they did not change.
            const processor = this.fields.find(field => field.name === key.replace("_s3key", ""))?.processor;

            if (
                processor &&
                (
                    processor?.config?.trigger === "onInsert" ||
                    processor?.config?.trigger === "onUpdate" ||
                    processor?.config?.trigger === "always"
                )
            ) {
                const {
                    job: processorJob,
                    result: processorResult
                } = await this.processField(
                    "api",
                    {
                        ...item,
                        id: record.id,
                        field: key
                    },
                    config,
                    user,
                    role
                )

                if (processorJob) {
                    jobs.push(processorJob);
                }

                if (!processorJob) {

                    // Update the item in the db with the processor result
                    await db.from(getTableName(this.id)).where({ id: record.id }).update({
                        ...processorResult
                    });

                    if (processor.config?.generateEmbeddings) {
                        // means the processor finished already, so we can trigger embeddings
                        // generation directly if the processor has the generateEmbeddings flag 
                        // set to true.
                        shouldGenerateEmbeddings = true;
                    }
                }
            }
        }

        if (shouldGenerateEmbeddings) {
            const { job: embeddingsJob } = await this.embeddings.generate.one({
                item: record, // important we need to full record here with all fields for the embedder
                user: user,
                role: role,
                trigger: "api",
                config: config
            });
            if (embeddingsJob) {
                jobs.push(embeddingsJob);
            }
        }

        return {
            item: record,
            job: jobs.length > 0 ? jobs.join(",") : undefined
        };
    }

    public deleteItem = async (item: Item, user?: number, role?: string): Promise<{ id: string, job?: string }> => {

        const { db } = await postgresClient();

        if (!item.id && !item.external_id) {
            throw new Error("Item id or external id is required for deleting an item.")
        }

        if (!item.id?.length && item?.external_id) {
            item = await db.from(getTableName(this.id)).where({ external_id: item.external_id }).first();
            if (!item || !item.id) {
                throw new Error(`Item not found for external id ${item?.external_id || "undefined"}.`)
            }
        }

        const chunkTableExists = await this.chunksTableExists();
        if (chunkTableExists) {
            const chunks = await db.from(getChunksTableName(this.id))
                .where({ source: item.id })
                .select("id");

            if (chunks.length > 0) {
                // delete chunks first
                await db.from(getChunksTableName(this.id))
                    .where({ source: item.id })
                    .delete();
            }
        }

        await db.from(getTableName(this.id)).where({ id: item.id }).delete();

        return {
            id: item.id!,
            job: undefined
        };
    }

    public getItem = async ({ item }: { item: Item }): Promise<Item> => {
        // Note this method does not apply access control, the developer that uses
        // it is responsible for applying access control themselves. This is on 
        // to expose a method to retrieve items for internal user.
        const { db } = await postgresClient();

        if (!item.id && !item.external_id) {
            throw new Error("Item id or external id is required to get an item.");
        }

        const result = await db.from(getTableName(this.id)).where({
            ...(item.id ? { id: item.id } : {}),
            ...(item.external_id ? { external_id: item.external_id } : {}),
        }).first();

        if (result) {
            const chunksCount = await db.from(getChunksTableName(this.id)).where(
                { source: result.id }
            ).count("id");
            result.chunksCount = Number(chunksCount[0].count) || 0;
        }

        return result;
    }

    public getItems = async (
        {
            filters,
            fields
        }: {
            filters?: any[],
            fields?: string[]
        }): Promise<Item[]> => {

        // Note this method does not apply access control, the developer that uses
        // it is responsible for applying access control themselves. This is on 
        // to expose a method to retrieve items for internal user.
        const { db } = await postgresClient();
        let query = db.from(getTableName(this.id)).select(fields || "*");
        const tableDefinition = contextToTableDefinition(this)
        query = applyFilters(query, filters || [], tableDefinition);
        const items = await query;
        return items;
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

                const { db } = await postgresClient();

                // Load the full record here so we make sure we have all the fields
                // needed for generating embeddings, which is not guaranteed if for
                // example the item in the input parameters comes from a graphql query
                // with a limited set of fields.
                const record = await db.from(getTableName(this.id)).where({ id: item.id }).first();
                if (!record) {
                    throw new Error("Item not found.")
                }

                item = record;

                const queue = await this.embedder.queue;
                if (queue?.queue.name) {
                    console.log("[EXULU] embedder is in queue mode, scheduling job.")
                    const job = await bullmqDecorator({
                        timeoutInSeconds: queue.timeoutInSeconds || 180,
                        label: `${this.embedder.name}`,
                        embedder: this.embedder.id,
                        context: this.id,
                        backoff: queue.backoff || {
                            type: 'exponential',
                            delay: 2000,
                        },
                        retries: queue.retries || 2,
                        inputs: item,
                        item: item.id,
                        queue: queue.queue,
                        user: user,
                        role: role,
                        trigger: trigger || "agent",
                    })

                    return {
                        id: item.id!,
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
            table.text('external_id').unique();
            table.text('created_by');
            table.text('ttl')
            table.text('rights_mode').defaultTo(this.configuration?.defaultRightsMode ?? "private");
            table.integer('textlength');
            table.text('source');
            table.timestamp('embeddings_updated_at')
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
            category: "contexts",
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
                    limit: 50,
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

export type STATISTICS_LABELS = "tool" | "agent" | "flow" | "api" | "claude-code" | "user" | "processor"
export type ExuluStatistic = {
    name: string,
    label: string,
    type: STATISTICS_TYPE,
    trigger: STATISTICS_LABELS,
    total: number,
}

export type ExuluStatisticParams = Omit<ExuluStatistic, "total" | "name" | "type">

export const updateStatistic = async (statistic: Omit<ExuluStatistic, "total"> & { count?: number, user?: number, role?: string, project?: string }) => {

    const currentDate = new Date().toISOString().split('T')[0];
    const { db } = await postgresClient();

    const existing = await db.from("tracking").where({
        ...(statistic.user ? { user: statistic.user } : {}),
        ...(statistic.role ? { role: statistic.role } : {}),
        ...(statistic.project ? { project: statistic.project } : {}),
        name: statistic.name,
        label: statistic.label,
        type: statistic.type,
        createdAt: currentDate
    }).first();

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
            ...(statistic.role ? { role: statistic.role } : {}),
            ...(statistic.project ? { project: statistic.project } : {}),
        })
    } else {
        await db.from("tracking").update({
            total: db.raw("total + ?", [statistic.count ?? 1]),
        }).where({
            id: existing.id,
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