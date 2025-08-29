import { ZodSchema } from "zod";
import { Job, Queue } from "bullmq";
import { z } from "zod"
import * as fs from 'fs';
import * as path from 'path';
import { convertToModelMessages, createIdGenerator, generateObject, generateText, type LanguageModel, streamText, tool, type Tool, type UIMessage, validateUIMessages, stepCountIs, hasToolCall } from "ai";
import { type STATISTICS_TYPE, STATISTICS_TYPE_ENUM } from "@EXULU_TYPES/enums/statistics";
import { EVAL_TYPES_ENUM } from "@EXULU_TYPES/enums/eval-types";
import { postgresClient } from "../postgres/client";
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";
import type { Item } from "@EXULU_TYPES/models/item";
import type { VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import pgvector from 'pgvector/knex'; // DONT REMOVE THIS
import { bullmqDecorator } from "./decoraters/bullmq";
import { mapType } from "./utils/map-types";
import { sanitizeName } from "./utils/sanitize-name";
import { ExuluEvalUtils } from "../evals/utils";
import CryptoJS from 'crypto-js';
import { type Request, type Response } from "express";
import { trace } from "@opentelemetry/api";

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

const convertToolsArrayToObject = (tools: ExuluTool[] | undefined, configs: ExuluAgentToolConfig[] | undefined, providerApiKey: string, user?: string, role?: string): Record<string, Tool> => {
    if (!tools) return {};
    const sanitizedTools = tools ? tools.map(tool => ({
        ...tool,
        name: sanitizeToolName(tool.name)
    })) : [];

    console.log("[EXULU] Sanitized tools", sanitizedTools)

    const askForConfirmation: Tool = {
        description: 'Ask the user for confirmation.',
        inputSchema: z.object({
            message: z.string().describe('The message to ask for confirmation.'),
        }),
    }

    return {
        ...sanitizedTools?.reduce(
            (prev, cur) =>
            ({
                ...prev, [cur.name]: {
                    ...cur.tool,
                    execute: async (inputs: any, options: any) => {
                        if (!cur.tool?.execute) {
                            console.error("[EXULU] Tool execute function is undefined.", cur.tool)
                            throw new Error("Tool execute function is undefined.")
                        }
                        let config = configs?.find(config => config.toolId === cur.id);

                        if (config) {
                            config = await hydrateVariables(config || []);
                        }

                        console.log("[EXULU] Config", config)

                        return await cur.tool.execute({
                            ...inputs,
                            // Convert config to object format if a config object 
                            // is available, after we added the .value property
                            // by hydrating it from the variables table.
                            providerApiKey: providerApiKey,
                            user: user,
                            role: role,
                            config: config ? config.config.reduce((acc, curr) => {
                                acc[curr.name] = curr.value;
                                return acc;
                            }, {}) : {}
                        }, options);
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

export const ExuluZodFileType = ({
    name,
    label,
    description,
    allowedFileTypes
}: {
    name: string, label: string, description: string, allowedFileTypes: (
        ".mp4" |
        ".m4a" |
        ".mp3" |
        ".pdf" |
        ".jpeg" |
        ".png" |
        ".plain" |
        ".mpeg" |
        ".wav" |
        ".docx" |
        ".xlsx" |
        ".xls" |
        ".csv" |
        ".pptx" |
        ".ppt"
    )[]
}) => {
    return z.object({
        [`exulu_file_${name}`]: z.string().describe(JSON.stringify({
            label: label,
            isFile: true,
            description: description,
            allowedFileTypes: allowedFileTypes
        }))
    });
}

export type ExuluAgentConfig = {
    name: string,
    instructions: string,
    model: {
        create: ({ apiKey }: { apiKey: string }) => LanguageModel
    },
    outputSchema?: ZodSchema;
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

export type ExuluAgentEval = {
    runner: ExuluEvalRunnerInstance,
}

interface ExuluAgentParams {
    id: string;
    name: string;
    type: "agent" | "custom";
    description: string;
    config?: ExuluAgentConfig | undefined;
    capabilities?: {
        text: boolean;
        images: string[];
        files: string[];
        audio: string[];
        video: string[];
    };
    evals?: ExuluAgentEval[];
    outputSchema?: ZodSchema;
    rateLimit?: RateLimiterRule;
}

interface ExuluAgentToolConfig {
    toolId: string,
    config: {
        name: string,
        variable: string // is a variable name
        value?: any // fetched on demand from the database based on the variable name
    }[]
}

export class ExuluAgent {

    // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or 
    // underscores and be a max length of 80 characters and at least 5 characters long.
    // The ID is used for storing references to agents so it is important it does not change.
    public id: string;
    public name: string;
    public description: string = "";
    public slug: string = "";
    public type: "agent" | "custom";
    public streaming: boolean = false;
    public rateLimit?: RateLimiterRule;
    public config?: ExuluAgentConfig | undefined;
    // private memory: Memory | undefined; // TODO do own implementation
    public evals?: ExuluAgentEval[];
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
    constructor({ id, name, description, config, rateLimit, capabilities, type, evals }: ExuluAgentParams) {
        this.id = id;
        this.name = name;
        this.evals = evals;
        this.description = description;
        this.rateLimit = rateLimit;
        this.config = config;
        this.type = type;
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
    public tool = (): ExuluTool => {
        return new ExuluTool({
            id: this.id,
            name: `${this.name}`,
            type: "agent",
            inputSchema: z.object({
                prompt: z.string(),
            }),
            description: `A function that calls an AI agent named: ${this.name}. The agent does the following: ${this.description}.`,
            config: [],
            execute: async ({ prompt, config, providerApiKey, user, role }: any) => {
                return await this.generateSync({
                    prompt: prompt,
                    providerApiKey: providerApiKey,
                    user: user,
                    role: role,
                    statistics: {
                        label: "",
                        trigger: "tool"
                    }
                })
            },
        });
    }

    generateSync = async ({ prompt, user, role, session, message, tools, statistics, toolConfigs, providerApiKey }: {
        prompt?: string,
        user?: string,
        role?: string,
        session?: string,
        message?: UIMessage,
        tools?: ExuluTool[],
        statistics?: ExuluStatisticParams,
        toolConfigs?: ExuluAgentToolConfig[],
        providerApiKey: string,
    }) => {

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

        const model = this.model.create({
            apiKey: providerApiKey
        })

        let messages: UIMessage[] = [];
        if (message && session && user) {
            // load the previous messages from the server:
            const previousMessages = await getAgentMessages({
                session,
                user,
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

        console.log("[EXULU] Model provider key", providerApiKey)

        console.log("[EXULU] Tool configs", toolConfigs)


        if (prompt) {
            const { text } = await generateText({
                model: model, // Should be a LanguageModelV1
                system: "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.",
                prompt: prompt,
                maxRetries: 2,
                tools: convertToolsArrayToObject(tools, toolConfigs, providerApiKey, user, role),
                stopWhen: [stepCountIs(5)],
            });

            if (statistics) {
                await updateStatistic({
                    name: "count",
                    label: statistics.label,
                    type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                    trigger: statistics.trigger,
                    count: 1,
                    user: user,
                    role: role
                })
            }

            return text;
        }
        if (messages) {
            const { text } = await generateText({
                model: model, // Should be a LanguageModelV1
                system: "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.",
                messages: convertToModelMessages(messages),
                maxRetries: 2,
                tools: convertToolsArrayToObject(tools, toolConfigs, providerApiKey, user, role),
                stopWhen: [stepCountIs(5)],
            });

            if (statistics) {
                await updateStatistic({
                    name: "count",
                    label: statistics.label,
                    type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                    trigger: statistics.trigger,
                    count: 1,
                    user: user,
                    role: role
                })
            }

            return text;
        }
    }

    generateStream = async ({ express, user, role, session, message, tools, statistics, toolConfigs, providerApiKey }: {
        express: {
            res: Response,
            req: Request,
        },
        user: string, role: string, session: string, message?: UIMessage, tools?: ExuluTool[], statistics?: ExuluStatisticParams, toolConfigs?: ExuluAgentToolConfig[], providerApiKey: string
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
            apiKey: providerApiKey
        })

        let messages: UIMessage[] = [];
        // load the previous messages from the server:
        const previousMessages = await getAgentMessages({
            session,
            user,
            limit: 50,
            page: 1
        })

        const previousMessagesContent = previousMessages.map((message) => JSON.parse(message.content));
        // validate messages
        messages = await validateUIMessages({
            // append the new message to the previous messages:
            messages: [...previousMessagesContent, message],
        });


        console.log("[EXULU] Model provider key", providerApiKey)

        console.log("[EXULU] Tool configs", toolConfigs)

        const result = streamText({
            model: model, // Should be a LanguageModelV1
            messages: convertToModelMessages(messages),
            system: "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.",
            maxRetries: 2,
            tools: convertToolsArrayToObject(tools, toolConfigs, providerApiKey, user, role),
            onError: error => console.error("[EXULU] chat stream error.", error),
            stopWhen: [stepCountIs(5)],
        });

        // consume the stream to ensure it runs to completion & triggers onFinish
        // even when the client response is aborted:
        result.consumeStream(); // no await

        result.pipeUIMessageStreamToResponse(express.res, {
            originalMessages: messages,
            sendReasoning: true,
            generateMessageId: createIdGenerator({
                prefix: 'msg_',
                size: 16,
            }),
            onFinish: async ({ messages }) => {
                console.info(
                    "[EXULU] chat stream finished.",
                    messages
                )
                // save chat
                await saveChat({
                    session,
                    user,
                    messages
                })
                if (statistics) {
                    await updateStatistic({
                        name: "count",
                        label: statistics.label,
                        type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                        trigger: statistics.trigger,
                        count: 1,
                        user: user,
                        role: role
                    })
                }
            },
        });
        return;
    }
}

// todo check how to deal with pagination
const getAgentMessages = async ({ session, user, limit, page }: { session: string, user: string, limit: number, page: number }) => {
    const { db } = await postgresClient();
    const messages = await db.from("agent_messages").where({ session, user }).limit(limit).offset(page * limit);
    return messages;
}

const saveChat = async ({ session, user, messages }: { session: string, user: string, messages: UIMessage[] }) => {
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

type ChunkerOperation = (item: Item & { id: string }, maxChunkSize: number) => Promise<ChunkerResponse>

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
    public queue?: Queue;
    private generateEmbeddings: VectorGenerateOperation;
    public vectorDimensions: number;
    public maxChunkSize: number;
    public chunker: ChunkerOperation;
    constructor({ id, name, description, generateEmbeddings, queue, vectorDimensions, maxChunkSize, chunker }: {
        id: string,
        name: string,
        description: string,
        generateEmbeddings: VectorGenerateOperation,
        chunker: ChunkerOperation,
        queue?: Queue,
        vectorDimensions: number,
        maxChunkSize: number
    }) {
        this.id = id;
        this.name = name;
        this.vectorDimensions = vectorDimensions;
        this.maxChunkSize = maxChunkSize;
        this.chunker = chunker;
        this.slug = `/embedders/${generateSlug(this.name)}/run`
        this.queue = queue;
        this.generateEmbeddings = generateEmbeddings;
    }

    public async generateFromQuery(query: string, statistics?: ExuluStatisticParams, user?: string, role?: string): VectorGenerationResponse {

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

    public async generateFromDocument(input: Item, statistics?: ExuluStatisticParams, user?: string, role?: string): VectorGenerationResponse {

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

        const output = await this.chunker(input as Item & { id: string }, this.maxChunkSize)

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
    rights_mode?: 'private' | 'users' | 'roles' | 'public'
    RBAC?: {
        users?: Array<{ id: string; rights: 'read' | 'write' }>
        roles?: Array<{ id: string; rights: 'read' | 'write' }>
    }
    variables?: WorkflowVariable[]
    steps_json?: WorkflowStep[]
}

type ExuluEvalRunnerInstance = {
    name: string,
    description: string,
    testcases: ExuluEvalInput[],
    run: ExuluEvalRunner
}

type ExuluEvalRunner = ({ data, runner }: {
    data: ExuluEvalInput, runner: {
        agent?: ExuluAgent & { providerApiKey: string },
        workflow?: ExuluWorkflow
    }
}) => Promise<{
    score: number,
    comment: string
}>

export type ExuluEvalInput = {
    prompt?: string,
    inputs?: any,
    result?: string,
    category?: string,
    metadata?: Record<string, any>,
    duration?: number, // provides the duration of the output generation
    reference?: string,
}

export class ExuluEval {
    public name: string;
    public description: string;

    constructor({ name, description }: {
        name: string,
        description: string
    }) {
        this.name = name;
        this.description = description;
    }

    public create = {
        LlmAsAJudge: {
            niah: ({ label, model, needles, testDocument, contextlengths }: { label: string, model: LanguageModel, needles: { question: string, answer: string }[], testDocument: string, contextlengths: (5000 | 30000 | 50000 | 128000)[] }): ExuluEvalRunnerInstance => {
                return {
                    name: this.name,
                    description: this.description,
                    testcases: ExuluEvalUtils.niahTestSet({
                        label,
                        contextlengths: contextlengths || [5000, 30000, 50000, 128000],
                        needles,
                        testDocument
                    }),
                    run: async ({ data, runner }) => {

                        if (runner.workflow) {
                            throw new Error("Workflows are not supported for the needle in a haystack eval.")
                        }

                        if (!runner.agent) {
                            throw new Error("Agent is required for the needle in a haystack eval.")
                        }

                        // TWO CASES:
                        // 1. running via CLI, provided with pre-defined inputs, to run the agent on.
                        // 2. Running as part of a job that has been triggered by the system based on pre-defined
                        // eval trigger rules.

                        // Output provided by the previously run agent.
                        if (!data.result) {
                            if (!data.prompt) {
                                throw new Error("Prompt is required for running an agent.")
                            }

                            const { db } = await postgresClient();
                            // Get the variable name from user's anthropic_token field
                            const variableName = runner.agent.providerApiKey;

                            // Look up the variable from the variables table
                            const variable = await db.from("variables").where({ name: variableName }).first();
                            if (!variable) {
                                throw new Error(`Provider API key for variable "${runner.agent.providerApiKey}" not found.`)
                            }

                            // Get the API key from the variable (decrypt if encrypted)
                            let providerApiKey = variable.value;

                            if (!variable.encrypted) {
                                throw new Error(`Provider API key for variable "${runner.agent.providerApiKey}" is not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys.`)
                            }

                            if (variable.encrypted) {
                                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                                providerApiKey = bytes.toString(CryptoJS.enc.Utf8);
                            }

                            const result = await runner.agent.generateSync({
                                prompt: data.prompt,
                                providerApiKey
                            })
                            data.result = result;
                        }

                        const { object } = await generateObject({
                            model: model,
                            maxRetries: 3,
                            schema: z.object({
                                correctnessScore: z.number(),
                                comment: z.string(),
                            }),
                            prompt: `You are checking if the below "actual_answers" contain the correct information as
                            presented in the "correct_answers" section to calculate the correctness score.
    
                            The correctness score should be a number between 0 and 1. 1 is the highest score.

                            For example if the actual_answers contains 1 answer of the ${needles.length} correct_answers, the 
                            score should be ${1 / needles.length}. If the actual_answers contain 2 correct answers, the 
                            score should be ${2 / needles.length} etc.. if the actual_answers contains all the correct answers, the 
                            score should be 1 and if the actual_answers contains none of the correct answers, the score should be 0.
    
                            You can ignore small differences in the actual_answers and the correct_answers such as spelling mistakes, 
                            punctuation, etc., if the content of the actual answer is still correct.

                            Also provide a comment on how you came to your conclusion.
                            
                            <actual_answers>
                            ${data.result}
                            </actual_answers>
                            
                            <correct_answers>
                            ${needles.map((needle, index) => `- ${index + 1}: ${needle.answer}`).join("\n")}
                            </correct_answers>`
                        });

                        console.log("[EXULU] eval result", object)

                        const { db } = await postgresClient();
                        await db('eval_results').insert({
                            input: data.prompt,
                            output: data.result,
                            duration: data.duration,
                            result: object.correctnessScore,
                            agent_id: runner.agent.id || undefined,
                            eval_type: EVAL_TYPES_ENUM.llm_as_judge,
                            eval_name: this.name,
                            comment: object.comment,
                            category: data.category,
                            metadata: data.metadata,
                            createdAt: db.fn.now(),
                            updatedAt: db.fn.now()
                        });

                        return {
                            score: object.correctnessScore,
                            comment: object.comment
                        };
                    }
                }
            }
        }
    }

}

export class ExuluTool {

    // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or 
    // underscores and be a max length of 80 characters and at least 5 characters long.
    // The ID is used for storing references to tools so it is important it does not change.
    public id: string;
    public name: string;
    public description: string;
    public inputSchema?: ZodSchema;
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
        inputSchema?: ZodSchema,
        type: "context" | "function" | "agent",
        config: {
            name: string,
            description: string
        }[],
        execute: (inputs: any) => Promise<any>
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
            execute: execute
        });
    }
}

type ExuluContextFieldDefinition = {
    name: string,
    type: ExuluFieldTypes
    unique?: boolean
}


export const getTableName = (id: string) => {
    return sanitizeName(id) + "_items";
}

export const getChunksTableName = (id: string) => {
    return sanitizeName(id) + "_chunks";
}

export type ExuluRightsMode = "private" | "users" | "roles" | "public" | "projects"


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
        user?: string, 
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
        }, {
            label: statistics?.label || this.name,
            trigger: statistics?.trigger || "agent"
        }, user, role)

        const exists = await db.schema.hasTable(getChunksTableName(this.id));
        if (!exists) {
            await this.createChunksTable();
        }

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

    public async updateItem(user: string, item: Item, role?: string, trigger?: STATISTICS_LABELS): Promise<{
        id: string,
        job?: string
    }> {

        if (!item.id) {
            throw new Error("Id is required for updating an item.")
        }

        const { db } = await postgresClient();

        Object.keys(item).forEach(key => {
            if (key === "id" || key === "name" || key === "description" || key === "external_id" || key === "tags" || key === "source" || key === "textlength" || key === "upsert" || key === "archived") {
                return;
            }
            const field = this.fields.find(field => sanitizeName(field.name) === sanitizeName(key));
            if (!field) {
                throw new Error("Trying to update value for field '" + key + "' that does not exist on the context fields definition. Available fields: " + this.fields.map(field => sanitizeName(field.name)).join(", ") + " ,name, description, external_id")
            }
        })

        const payloadWithSanitizedPropertyNames: Item = {}

        Object.keys(item).forEach(key => {
            payloadWithSanitizedPropertyNames[sanitizeName(key)] = item[key];
        })

        const id = payloadWithSanitizedPropertyNames.id;
        delete payloadWithSanitizedPropertyNames.id; // not allowed to update id
        delete payloadWithSanitizedPropertyNames.created_at; // not allowed to update created_at
        delete payloadWithSanitizedPropertyNames.upsert;
        payloadWithSanitizedPropertyNames.updated_at = db.fn.now();

        const result = await db.from(getTableName(this.id))
            .where({ id: id })
            .update(payloadWithSanitizedPropertyNames)
            .returning("id");

        if (
            this.embedder && (
                this.configuration.calculateVectors === "onUpdate" ||
                this.configuration.calculateVectors === "always"
            )
        ) {
            const { job } = await this.embeddings.generate.one({
                item: {
                    ...item,
                    id: result[0].id
                },
                user,
                role: role,
                trigger: trigger || "agent"
            });
            return {
                id: result[0].id,
                job
            };
        }

        return {
            id: result[0].id,
            job: undefined
        };
    }

    public embeddings = {
        generate: {
            one: async ({
                item,
                user,
                role,
                trigger
            }: {
                item: Item,
                user?: string,
                role?: string,
                trigger: STATISTICS_LABELS
            }): Promise<{
                id: string,
                job?: string,
                chunks?: number
            }> => {
        
                if (!this.embedder) {
                    throw new Error("Embedder is not set for this context.")
                }
        
                if (!item.id) {
                    throw new Error("Item id is required for generating embeddings.")
                }
        
                if (this.embedder.queue?.name) {
                    console.log("[EXULU] embedder is in queue mode, scheduling job.")
                    const job = await bullmqDecorator({
                        label: `${this.embedder.name}`,
                        embedder: this.embedder.id,
                        context: this.id,
                        inputs: item,
                        item: item.id,
                        queue: this.embedder.queue,
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
                return await this.createAndUpsertEmbeddings(item, user, {
                    label: this.embedder.name,
                    trigger: trigger || "agent"
                }, role, undefined);
            },
            all: async (context: ExuluContext, userId?: string, roleId?: string) => {

                const exists = await context.tableExists();

                if (!exists) {
                    await context.createItemsTable();
                }

                const chunksTableExists = await context.chunksTableExists();
                if (!chunksTableExists && context.embedder) {
                    await context.createChunksTable();
                }

                const { db } = await postgresClient();

                const items = await db.from(getTableName(context.id))
                    .select("*");

                const jobs: string[] = [];

                // Safeguard against too many items
                if (
                    !context.embedder?.queue?.name &&
                    items.length > 2000
                ) {
                    throw new Error(`Embedder is not in queue mode, cannot generate embeddings for more than 
                        2.000 items at once, if you need to generate embeddings for more items please configure 
                        the embedder to use a queue. You can configure the embedder to use a queue by setting 
                        the queue property in the embedder configuration.`)
                }

                for (const item of items) {
                    const { job } = await context.embeddings.generate.one({
                        item,
                        user: userId,
                        role: roleId,
                        trigger: "api"
                    });
                    if (job) {
                        jobs.push(job);
                    }
                }

                return jobs || [];

            }
        }
    }

    public async insertItem(user: string, item: Item, upsert: boolean = false, role?: string, trigger?: STATISTICS_LABELS): Promise<{
        id: string,
        job?: string
    }> {

        if (!item.name) {
            throw new Error("Name field is required.")
        }

        const { db } = await postgresClient();

        if (item.external_id) {
            const existingItem = await db.from(getTableName(this.id)).where({ external_id: item.external_id }).first();
            if (existingItem && !upsert) {
                throw new Error("Item with external id " + item.external_id + " already exists.")
            }
            if (existingItem && upsert) {
                await this.updateItem(user, {
                    ...item,
                    id: existingItem.id
                }, role, trigger);
                return existingItem.id;
            }
        }

        if (upsert && item.id) {
            const existingItem = await db.from(getTableName(this.id)).where({ id: item.id }).first();
            if (existingItem && upsert) {
                await this.updateItem(user, {
                    ...item,
                    id: existingItem.id
                }, role, trigger);
                return existingItem.id;
            }
        }

        Object.keys(item).forEach(key => {
            if (key === "id" || key === "name" || key === "description" || key === "external_id" || key === "tags" || key === "source" || key === "textlength" || key === "upsert" || key === "archived") {
                return;
            }
            const field = this.fields.find(field => sanitizeName(field.name) === sanitizeName(key));
            if (!field) {
                throw new Error("Trying to insert value for field '" + key + "' that does not exist on the context fields definition. Available fields: " + this.fields.map(field => sanitizeName(field.name)).join(", ") + " ,name, description, external_id")
            }
        })

        const payloadWithSanitizedPropertyNames: Item = {}

        Object.keys(item).forEach(key => {
            payloadWithSanitizedPropertyNames[sanitizeName(key)] = item[key];
        })

        delete payloadWithSanitizedPropertyNames.id; // not allowed to set id
        delete payloadWithSanitizedPropertyNames.upsert;

        const result = await db.from(getTableName(this.id)).insert({
            ...payloadWithSanitizedPropertyNames,
            id: db.fn.uuid(),
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        }).returning("id");

        if (
            this.embedder && (
                this.configuration.calculateVectors === "onInsert" ||
                this.configuration.calculateVectors === "always"
            )
        ) {
            const { job } = await this.embeddings.generate.one({
                item: {
                    ...item,
                    id: result[0].id
                },
                user,
                role: role,
                trigger: trigger || "agent"
            });

            return {
                id: result[0].id,
                job
            };
        }

        return {
            id: result[0].id,
            job: undefined
        };
    }

    public getItems = async ({
        statistics,
        limit,
        sort,
        order,
        page,
        name,
        user,
        role,
        archived,
        query,
        method
    }: {
        statistics?: ExuluStatisticParams,
        page: number,
        sort?: "created_at" | "embeddings_updated_at",
        order?: "desc" | "asc",
        limit: number,
        name?: string,
        user?: string,
        role?: string,
        archived?: boolean,
        query?: string,
        method?: VectorMethod
    }) => {

        if (!query && limit > 500) {
            throw new Error("Limit cannot be greater than 500.")
        }

        if (query && limit > 50) {
            throw new Error("Limit cannot be greater than 50 when using a vector search query.")
        }

        if (page < 1) page = 1;
        if (limit < 1) limit = 10;
        let offset = (page - 1) * limit;

        const mainTable = getTableName(this.id);
        const { db } = await postgresClient();
        const columns = await db(mainTable).columnInfo();

        const totalQuery = db.count('* as count').from(mainTable).first()
        const itemsQuery = db.select(Object.keys(columns).map(column => mainTable + "." + column)).from(mainTable).offset(offset).limit(limit)

        if (sort) {
            itemsQuery.orderBy(sort, order === "desc" ? "desc" : "asc")
        }

        if (typeof name === "string") {
            itemsQuery.whereILike("name", `%${name}%`)
            totalQuery.whereILike("name", `%${name}%`)
        }

        if (typeof archived === "boolean") {
            itemsQuery.where("archived", archived)
            totalQuery.where("archived", archived)
        }

        if (!query) {
            // todo allow for receiving "name" req.query param to filter by specific
            // properties of items. I.e. name=John Doe will filter items where the name
            // field is equal to John Doe.

            const total = await totalQuery;
            let items = await itemsQuery;
            const last = Math.ceil(total.count / limit)

            return {
                pagination: {
                    totalCount: parseInt(total.count),
                    currentPage: page,
                    limit: limit,
                    from: offset,
                    pageCount: last || 1,
                    to: offset + items.length,
                    lastPage: last || 1,
                    nextPage: page + 1 > last ? null : page + 1,
                    previousPage: page - 1 || null,
                },
                filters: {
                    archived: archived,
                    name: name,
                    query: query
                },
                context: {
                    name: this.name,
                    id: this.id,
                    embedder: this.embedder?.name || undefined
                },
                items: items
            };
        }

        if (typeof query === "string" && this.embedder) {

            if (!method) {
                method = "cosineDistance";
            }

            itemsQuery.limit(limit * 5) // for semantic search we increase the scope, so we can rerank the results

            // Without blocking the main thread, upsert an entry 
            // into mongdb of type ExuluStatistic.
            if (statistics) {
                await updateStatistic({
                    name: "count",
                    label: statistics.label,
                    type: STATISTICS_TYPE_ENUM.CONTEXT_RETRIEVE as STATISTICS_TYPE,
                    trigger: statistics.trigger,
                    user: user,
                    role: role
                })
            }
            if (this.queryRewriter) {
                query = await this.queryRewriter(query);
            }

            const chunksTable = getChunksTableName(this.id);

            itemsQuery.leftJoin(chunksTable, function () {
                this.on(chunksTable + ".source", "=", mainTable + ".id")
            })

            itemsQuery.select(chunksTable + ".id as chunk_id")
            itemsQuery.select(chunksTable + ".source")
            itemsQuery.select(chunksTable + ".content")
            itemsQuery.select(chunksTable + ".chunk_index")
            itemsQuery.select(chunksTable + ".created_at as chunk_created_at")
            itemsQuery.select(chunksTable + ".updated_at as chunk_updated_at")

            const { chunks } = await this.embedder.generateFromQuery(query, {
                label: this.name,
                trigger: "agent"
            }, user, role)

            if (!chunks?.[0]?.vector) {
                throw new Error("No vector generated for query.")
            }

            const vector = chunks[0].vector;
            const vectorStr = `ARRAY[${vector.join(",")}]`;
            const vectorExpr = `${vectorStr}::vector`; // => ARRAY[0.1,0.2,0.3]::vector

            const language = (this.configuration.language || 'english');

            let items: any[] = [];

            switch (method) {
                case "tsvector":
                    // rank + filter + sort (DESC)
                    itemsQuery
                        .select(db.raw(
                            `ts_rank(${chunksTable}.fts, websearch_to_tsquery(?, ?)) as fts_rank`,
                            [language, query]
                        ))
                        .whereRaw(
                            `${chunksTable}.fts @@ websearch_to_tsquery(?, ?)`,
                            [language, query]
                        )
                        .orderByRaw(`fts_rank DESC`);
                    items = await itemsQuery;
                    break;

                case "cosineDistance":
                default:
                    // Ensure we don't rank rows without embeddings
                    itemsQuery.whereNotNull(`${chunksTable}.embedding`);

                    // Select cosine *similarity* for display/stats:
                    // similarity = 1 - cosine_distance  (cosine_distance in [0,2])
                    // If you prefer pure distance in your stats, change the alias below accordingly.
                    itemsQuery.select(
                        db.raw(`1 - (${chunksTable}.embedding <=> ${vectorExpr}) AS cosine_distance`)
                    );

                    // Very important: ORDER BY the raw distance expression so pgvector can use the index
                    itemsQuery.orderByRaw(
                        `${chunksTable}.embedding <=> ${vectorExpr} ASC NULLS LAST`
                    );
                    items = await itemsQuery;
                    break;
                case "hybridSearch":

                    // Tunables
                    const matchCount = Math.min(limit * 5, 30);
                    const fullTextWeight = 1.0;
                    const semanticWeight = 1.0;
                    const rrfK = 50;

                    const hybridSQL = `
                    WITH full_text AS (
                      SELECT
                        c.id,
                        c.source,
                        row_number() OVER (
                          ORDER BY ts_rank_cd(c.fts, websearch_to_tsquery(?, ?)) DESC
                        ) AS rank_ix
                      FROM ${chunksTable} c
                      WHERE c.fts @@ websearch_to_tsquery(?, ?)
                      ORDER BY rank_ix
                      LIMIT LEAST(?, 30) * 2
                    ),
                    semantic AS (
                      SELECT
                        c.id,
                        c.source,
                        row_number() OVER (
                          ORDER BY c.embedding <=> ${vectorExpr} ASC
                        ) AS rank_ix
                      FROM ${chunksTable} c
                      WHERE c.embedding IS NOT NULL
                      ORDER BY rank_ix
                      LIMIT LEAST(?, 30) * 2
                    )
                    SELECT
                      m.*,
                      c.id AS chunk_id,
                      c.source,
                      c.content,
                      c.chunk_index,
                      c.created_at AS chunk_created_at,
                      c.updated_at AS chunk_updated_at,
                
                      /* Per-signal scores for introspection */
                      ts_rank(c.fts, websearch_to_tsquery(?, ?)) AS fts_rank,
                      (1 - (c.embedding <=> ${vectorExpr})) AS cosine_distance,
                
                      /* Hybrid RRF score */
                      (
                        COALESCE(1.0 / (? + ft.rank_ix), 0.0) * ?
                        +
                        COALESCE(1.0 / (? + se.rank_ix), 0.0) * ?
                      ) AS hybrid_score
                
                    FROM full_text ft
                    FULL OUTER JOIN semantic se
                      ON ft.id = se.id
                    JOIN ${chunksTable} c
                      ON COALESCE(ft.id, se.id) = c.id
                    JOIN ${mainTable} m
                      ON m.id = c.source
                    ORDER BY hybrid_score DESC
                    LIMIT LEAST(?, 30)
                    OFFSET 0
                  `;

                    const bindings = [
                        // full_text: websearch_to_tsquery(lang, query) in rank and where
                        language, query,
                        language, query,
                        matchCount,                    // full_text limit

                        matchCount,                    // semantic limit

                        // fts_rank (ts_rank) call
                        language, query,

                        // RRF fusion parameters
                        rrfK, fullTextWeight,
                        rrfK, semanticWeight,

                        matchCount                     // final limit
                    ];
                    items = await db.raw(hybridSQL, bindings).then(r => r.rows ?? r);
            }

            console.log("items", items.map(item => item.name + " " + item.id))
            // Filter out duplicate sources, keeping only the first occurrence
            // because the vector search returns multiple chunks for the same
            // source.
            const seenSources = new Map();
            items = items.reduce((acc, item) => {
                if (!seenSources.has(item.source)) {
                    seenSources.set(item.source, {
                        ...Object.fromEntries(
                            Object.keys(item)
                                .filter(key =>
                                    key !== "cosine_distance" &&   // kept per chunk below
                                    key !== "fts_rank" &&          // kept per chunk below
                                    key !== "hybrid_score" &&      // we will compute per item below

                                    key !== "content" &&
                                    key !== "source" &&
                                    key !== "chunk_index" &&
                                    key !== "chunk_id" &&
                                    key !== "chunk_created_at" &&
                                    key !== "chunk_updated_at"
                                )
                                .map(key => [key, item[key]])
                        ),
                        chunks: [{
                            content: item.content,
                            chunk_index: item.chunk_index,
                            ...(method === "cosineDistance" && { cosine_distance: item.cosine_distance }),
                            ...((method === "tsvector" || method === "hybridSearch") && { fts_rank: item.fts_rank }),
                            ...(method === "hybridSearch" && { hybrid_score: item.hybrid_score })
                        }]
                    });
                    acc.push(seenSources.get(item.source));
                } else {
                    seenSources.get(item.source).chunks.push({
                        content: item.content,
                        chunk_index: item.chunk_index,
                        ...(method === "cosineDistance" && { cosine_distance: item.cosine_distance }),
                        ...((method === "tsvector" || method === "hybridSearch") && { fts_rank: item.fts_rank }),
                        ...(method === "hybridSearch" && { hybrid_score: item.hybrid_score })
                    });
                }
                return acc;
            }, []);

            items.forEach(item => {
                if (!item.chunks?.length) { return; }

                if (method === "tsvector") {
                    const ranks = item.chunks
                        .map(c => (typeof c.fts_rank === 'number' ? c.fts_rank : 0));
                    const total = ranks.reduce((a, b) => a + b, 0);
                    const average = ranks.length ? total / ranks.length : 0;
                    item.averageRelevance = average;
                    item.totalRelevance = total;

                } else if (method === "cosineDistance") {
                    let methodProperty = "cosine_distance";
                    const average = item.chunks.reduce((acc, item) => {
                        return acc + item[methodProperty];
                    }, 0) / item.chunks.length;

                    const total = item.chunks.reduce((acc, item) => {
                        return acc + item[methodProperty];
                    }, 0);
                    item.averageRelevance = average;
                    item.totalRelevance = total;

                } else if (method === "hybridSearch") {
                    const scores = item.chunks.map(c => (typeof c.hybrid_score === 'number' ? c.hybrid_score : 0));
                    const total = scores.reduce((a, b) => a + b, 0);
                    const average = scores.length ? total / scores.length : 0;
                    item.averageRelevance = average;
                    item.totalRelevance = total;
                }
            })

            // todo if query && resultReranker, rerank the results
            if (this.resultReranker && query) {
                items = await this.resultReranker(items);
            }

            items = items.slice(0, limit);

            return {
                filters: {
                    archived: archived,
                    name: name,
                    query: query,
                },
                context: {
                    name: this.name,
                    id: this.id,
                    embedder: this.embedder.name
                },
                items
            };
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
            table.text('rights_mode').defaultTo(this.configuration?.defaultRightsMode ?? "private");
            table.integer('textlength');
            table.text('source');
            table.timestamp('embeddings_updated_at')
            for (const field of this.fields) {
                const { type, name, unique } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name), undefined, unique);
            }
            table.timestamps(true, true);
        });
    }

    public createChunksTable = async () => {

        const { db } = await postgresClient();
        const tableName = getChunksTableName(this.id);
        console.log("[EXULU] Creating table: " + tableName);
        await db.schema.createTable(tableName, (table) => {
            if (!this.embedder) {
                throw new Error("Embedder must be set for context " + this.name + " to create chunks table.")
            }
            table.uuid("id").primary().defaultTo(db.fn.uuid());
            table.uuid("source").references("id").inTable(getTableName(this.id));
            table.text("content");
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

            table.timestamps(true, true);
        });

        // HNSW for ANN search (pgvector >= 0.5)
        await db.raw(`
            CREATE INDEX IF NOT EXISTS ${tableName}_embedding_hnsw_cosine
            ON ${tableName}
            USING hnsw (embedding vector_cosine_ops)
            WHERE embedding IS NOT NULL
            WITH (m = 16, ef_construction = 64)
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
                // todo make trigger more specific with the agent name
                return await this.getItems({
                    page: 1,
                    limit: 10,
                    query: query,
                    user: user,
                    role: role,
                    statistics: {
                        label: this.name,
                        trigger: "agent"
                    }
                })
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

export const updateStatistic = async (statistic: Omit<ExuluStatistic, "total"> & { count?: number, user?: string, role?: string }) => {
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

    console.log("!!! existing !!!", existing)

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