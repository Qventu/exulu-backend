import { ZodSchema } from "zod";
import { Queue } from "bullmq";
import { z } from "zod"
import * as fs from 'fs';
import * as path from 'path';
import { type Job as ExuluJob } from "@EXULU_TYPES/models/job";
import { generateObject, generateText, type LanguageModelV1, type Message, streamText, tool, type Tool } from "ai";
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
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { ExuluEvalUtils } from "../evals/utils";
import CryptoJS from 'crypto-js';

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

const convertToolsArrayToObject = (tools: ExuluTool[] | undefined, configs: ExuluAgentToolConfig[] | undefined, providerApiKey: string): Record<string, Tool> => {
    if (!tools) return {};
    const sanitizedTools = tools ? tools.map(tool => ({
        ...tool,
        name: sanitizeToolName(tool.name)
    })) : [];

    console.log("[EXULU] Sanitized tools", sanitizedTools)

    const askForConfirmation: Tool = {
        description: 'Ask the user for confirmation.',
        parameters: z.object({
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
        create: ({ apiKey }: { apiKey: string }) => LanguageModelV1 // LanguageModelV1
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
    type: "agent" | "workflow" | "custom";
    description: string;
    config?: ExuluAgentConfig | undefined;
    capabilities?: {
        tools: boolean;
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

    public id: string;
    public name: string;
    public description: string = "";
    public slug: string = "";
    public type: "agent" | "workflow" | "custom";
    public streaming: boolean = false;
    public rateLimit?: RateLimiterRule;
    public config?: ExuluAgentConfig | undefined;
    // private memory: Memory | undefined; // TODO do own implementation
    public evals?: ExuluAgentEval[];
    public model?: {
        create: ({ apiKey }: { apiKey: string }) => LanguageModelV1 // LanguageModelV1
    };
    public capabilities: {
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
        return this.config?.model?.create({ apiKey: "" })?.provider || ""
    }

    get modelName(): string {
        return this.config?.model?.create({ apiKey: "" })?.modelId || ""
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
            execute: async ({ prompt, config, providerApiKey }: any) => {
                return await this.generateSync({
                    prompt: prompt,
                    providerApiKey: providerApiKey,
                    statistics: {
                        label: "",
                        trigger: "tool"
                    }
                })
            },
        });
    }

    generateSync = async ({ messages, prompt, tools, statistics, toolConfigs, providerApiKey }: {
        messages?: Message[], prompt?: string, tools?: ExuluTool[], statistics?: ExuluStatisticParams, toolConfigs?: ExuluAgentToolConfig[], providerApiKey: string
    }) => {

        if (!this.model) {
            throw new Error("Model is required for streaming.")
        }

        if (!this.config) {
            throw new Error("Config is required for generating.")
        }

        if (prompt && messages) {
            throw new Error("Prompt and messages cannot be provided at the same time.")
        }

        const model = this.model.create({
            apiKey: providerApiKey
        })

        const { text } = await generateText({
            model: model, // Should be a LanguageModelV1
            system: "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.",
            messages: messages,
            prompt: prompt,
            maxRetries: 2,
            tools: convertToolsArrayToObject(tools, toolConfigs, providerApiKey),
            maxSteps: 5,
        });

        if (statistics) {
            await updateStatistic({
                name: "count",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: 1
            })
        }

        return text;
    }

    generateStream = ({ messages, prompt, tools, statistics, toolConfigs, providerApiKey }: {
        messages?: Message[], prompt?: string, tools?: ExuluTool[], statistics?: ExuluStatisticParams, toolConfigs?: ExuluAgentToolConfig[], providerApiKey: string
    }) => {

        if (!this.model) {
            throw new Error("Model is required for streaming.")
        }

        if (!this.config) {
            throw new Error("Config is required for generating.")
        }

        if (prompt && messages) {
            throw new Error("Prompt and messages cannot be provided at the same time.")
        }

        const model = this.model.create({
            apiKey: providerApiKey
        })

        console.log("[EXULU] Model provider key", providerApiKey)

        console.log("[EXULU] Tool configs", toolConfigs)

        return streamText({
            model: model, // Should be a LanguageModelV1
            messages: messages,
            prompt: prompt,
            system: "You are a helpful assistant. When you use a tool to answer a question do not explicitly comment on the result of the tool call unless the user has explicitly you to do something with the result.",
            maxRetries: 2,
            tools: convertToolsArrayToObject(tools, toolConfigs, providerApiKey),
            maxSteps: 5,
            onError: error => console.error("[EXULU] chat stream error.", error),
            onFinish: async ({ response, usage }) => {
                console.info(
                    "[EXULU] chat stream finished.",
                    usage
                )
                if (statistics) {
                    await updateStatistic({
                        name: "count",
                        label: statistics.label,
                        type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                        trigger: statistics.trigger,
                        count: 1
                    })
                }
            }
        });
    }
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

    public async generateFromQuery(query: string, statistics?: ExuluStatisticParams): VectorGenerationResponse {

        if (statistics) {
            await updateStatistic({
                name: "count",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: 1
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

    public async generateFromDocument(input: Item, statistics?: ExuluStatisticParams): VectorGenerationResponse {

        if (statistics) {
            await updateStatistic({
                name: "count",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: 1
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

export type ExuluWorkflowStep = {
    id: string,
    name: string,
    description: string,
    inputSchema: ZodSchema;
    retries?: number;
    fn: ({
        inputs,
        job,
        user,
        logger
    }: {
        inputs: any,
        user?: string,
        logger: ExuluLogger,
        job?: ExuluJob
    }) => Promise<any>
}

export class ExuluWorkflow {

    public id: string;
    public name: string;
    public description: string = "";
    public enable_batch: boolean = false;
    public slug: string = "";
    public queue: Queue | undefined;
    public steps: Array<ExuluWorkflowStep>;

    constructor({ id, name, description, steps, queue, enable_batch }: {
        id: string,
        name: string,
        description: string,
        steps: Array<ExuluWorkflowStep>,
        queue?: Queue,
        enable_batch: boolean
    }) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.enable_batch = enable_batch;
        this.slug = `/workflows/${generateSlug(this.name)}/run`
        this.queue = queue;
        this.steps = steps;
    }

    public start = async ({
        inputs: initialInputs,
        user,
        logger,
        job,
        session,
        agent,
        label
    }: {
        inputs: any, user?: string, logger: ExuluLogger, job?: ExuluJob, session?: string, agent?: string, label?: string
    }): Promise<any> => { // todo infer type of input from the inputschema of the step
        // Run the this.steps functions sequentially, providing the 
        // output of each step as the input of the next step.
        let inputs: any;
        // todo store result into the jobs table (set to "started" if job.status is not yet "started"), if no job is provided, create a new one and
        // set the status here, update it later with the result(s)

        const { db } = await postgresClient();

        if (!job?.id) {
            logger.write(`Creating new job for workflow ${this.name} with inputs: ${JSON.stringify(initialInputs)}`, "INFO")
            const result = await db('jobs')
                .insert({
                    status: JOB_STATUS_ENUM.active,
                    name: `Job running '${this.name}' for '${label}'`,
                    agent,
                    workflow: this.id,
                    type: "workflow",
                    steps: this.steps?.length || 0,
                    inputs: initialInputs,
                    session,
                    user
                })
                .returning(["id", "status"])
            job = result[0];
            logger.write(`Created new job for workflow ${this.name}, job id: ${job?.id}`, "INFO")
        }

        if (!job) {
            throw new Error("Job not found, or failed to be created.")
        }

        if (job.status !== JOB_STATUS_ENUM.active) {
            await db('jobs')
                .update({
                    status: JOB_STATUS_ENUM.active,
                    inputs: initialInputs
                })
                .where({ id: job?.id })
                .returning("id");
        }

        const runStep = async (step: ExuluWorkflowStep, inputs: any) => {
            let result: any;
            try {
                result = await step.fn({
                    inputs: inputs,
                    logger,
                    job: job,
                    user: user
                });
                return result;

            } catch (error: any) {
                logger.write(`Step ${step.name} failed with error: ${error.message}`, "ERROR")
                if (step.retries && step.retries > 0) {
                    logger.write(`Retrying step ${step.name} with ${step.retries} retries left`, "INFO")
                    step.retries--;
                    let result = await runStep(step, inputs);
                    return result;
                }
                logger.write(`Step ${step.name} failed with error: ${error.message}`, "ERROR")
                throw error;
            }
        }

        let final: any;

        try {
            for (let i = 0; i < this.steps.length; i++) {

                const step = this.steps[i];

                if (!step) {
                    throw new Error("Step not found.")
                }

                if (i === 0) {
                    inputs = initialInputs;
                }

                logger.write(`Running step ${step.name} with inputs: ${JSON.stringify(inputs)}`, "INFO")
                // todo allow storing each step as an interim result in an own table which is linked to the job
                let result = await runStep(step, inputs);
                inputs = result;
                logger.write(`Step ${step.name} output: ${JSON.stringify(result)}`, "INFO")

                final = result;
            }

            await db('jobs')
                .update({
                    status: JOB_STATUS_ENUM.completed,
                    result: JSON.stringify(final),
                    finished_at: db.fn.now()
                })
                .where({ id: job?.id })
                .returning("id");

            return final;

        } catch (error: any) {
            logger.write(`Workflow ${this.name} failed with error: ${error.message} for job ${job?.id}`, "ERROR")
            await db('jobs')
                .update({
                    status: JOB_STATUS_ENUM.failed,
                    result: JSON.stringify({
                        error: error.message || error,
                        stack: error.stack || "No stack trace available"
                    })
                })
                .where({ id: job?.id })
                .returning("id");
            throw error;
        }

    }
}

export class ExuluLogger {
    private readonly logPath?: string;
    private readonly job?: ExuluJob;

    constructor(job?: ExuluJob, logsDir?: string) {
        this.job = job;
        if (logsDir && job) {
            // Create logs directory if it doesn't exist
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            this.logPath = path.join(logsDir, `${job.id}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
        }
    }

    async write(message: string, level: "INFO" | "ERROR" | "WARNING"): Promise<void> {
        // Append newline to message if it doesn't have one
        const logMessage = message.endsWith('\n') ? message : message + '\n';

        if (!this.logPath) {
            switch (level) {
                case "INFO":
                    console.log(message)
                    break;
                case "WARNING":
                    console.warn(message)
                    break;
                case "ERROR":
                    console.error(message)
                    break;
            }
            return;
        }

        try {
            await fs.promises.appendFile(this.logPath, `[EXULU][${level}] - ${new Date().toISOString()}: ${logMessage}`);
        } catch (error) {
            console.error(`Error writing to log file ${this.job ? this.job.id : "unknown job"}:`, error);
            throw error;
        }
    }
}

type AddSourceArgs = Omit<ExuluSourceConstructorArgs, "context">;

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
            niah: ({ label, model, needles, testDocument, contextlengths }: { label: string, model: LanguageModelV1, needles: { question: string, answer: string }[], testDocument: string, contextlengths: (5000 | 30000 | 50000 | 128000)[] }): ExuluEvalRunnerInstance => {
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

const calculateStatistics = (items: any[], method: VectorMethod): {
    average: number,
    total: number
} => {
    let methodProperty = "";

    if (method === "l1Distance") {
        methodProperty = "l1_distance";
    }

    if (method === "l2Distance") {
        methodProperty = "l2_distance";
    }

    if (method === "hammingDistance") {
        methodProperty = "hamming_distance";
    }

    if (method === "jaccardDistance") {
        methodProperty = "jaccard_distance";
    }

    if (method === "maxInnerProduct") {
        methodProperty = "inner_product";
    }

    if (method === "cosineDistance") {
        methodProperty = "cosine_distance";
    }

    const average = items.reduce((acc, item) => {
        return acc + item[methodProperty];
    }, 0) / items.length;

    const total = items.reduce((acc, item) => {
        return acc + item[methodProperty];
    }, 0);

    return {
        average,
        total
    }
}

export class ExuluTool {
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
            parameters: inputSchema || z.object({}),
            execute: execute
        });
    }
}

type ExuluContextFieldDefinition = {
    name: string,
    type: ExuluFieldTypes
    unique?: boolean
}

export class ExuluContext {

    public id: string;
    public name: string;
    public active: boolean;
    public fields: ExuluContextFieldDefinition[]
    public rateLimit?: RateLimiterRule;
    public description: string;
    public embedder: ExuluEmbedder
    public queryRewriter?: (query: string) => Promise<string>;
    public resultReranker?: (results: any[]) => Promise<any[]>; // todo typings
    private _sources: ExuluSource[] = [];
    public configuration: {
        calculateVectors: "manual" | "onUpdate" | "onInsert" | "always"
    };

    constructor({ id, name, description, embedder, active, rateLimit, fields, queryRewriter, resultReranker, configuration }: {
        id: string,
        name: string,
        fields: ExuluContextFieldDefinition[],
        description: string,
        embedder: ExuluEmbedder,
        active: boolean,
        rateLimit?: RateLimiterRule,
        queryRewriter?: (query: string) => Promise<string>,
        resultReranker?: (results: any[]) => Promise<any[]>,
        configuration?: {
            calculateVectors: "manual" | "onUpdate" | "onInsert" | "always"
        }
    }) {
        this.id = id;
        this.name = name;
        this.fields = fields || [];
        this.configuration = configuration || {
            calculateVectors: "manual"
        };
        this.description = description;
        this.embedder = embedder;
        this.active = active;
        this.rateLimit = rateLimit;
        this._sources = [];
        this.queryRewriter = queryRewriter;
        this.resultReranker = resultReranker;
    }

    public deleteOne = async (id: string): VectorOperationResponse => {
        // todo
        // delete the item
        // also delete any chunks in the chunks table
        // @ts-ignore
        return {}
    }

    public deleteAll = async (): VectorOperationResponse => {
        // todo
        // delete all items
        // also delete all chunks in the chunks table
        // @ts-ignore
        return {}
    }

    public getTableName = () => {
        return sanitizeName(this.name) + "_items";
    }

    public getChunksTableName = () => {
        return sanitizeName(this.name) + "_chunks";
    }

    public tableExists = async () => {
        const { db } = await postgresClient();
        const tableExists = await db.schema.hasTable(this.getTableName());
        return tableExists;
    }

    public async updateItem(user: string, id: string, item: Item): Promise<{
        id: string,
        job?: string
    }> {

        if (!id) {
            throw new Error("Id is required for updating an item.")
        }

        const { db } = await postgresClient();

        Object.keys(item).forEach(key => {
            if (key === "name" || key === "description" || key === "external_id" || key === "tags" || key === "source" || key === "textLength" || key === "upsert" || key === "archived") {
                return;
            }
            const field = this.fields.find(field => field.name === key);
            if (!field) {
                throw new Error("Trying to uppdate value for field '" + key + "' that does not exist on the context fields definition. Available fields: " + this.fields.map(field => sanitizeName(field.name)).join(", ") + " ,name, description, external_id")
            }
        })

        delete item.id; // not allowed to update id
        delete item.created_at; // not allowed to update created_at
        delete item.upsert;
        item.updated_at = db.fn.now();

        const result = await db.from(this.getTableName())
            .where({ id })
            .update(item)
            .returning("id");

        if (
            this.configuration.calculateVectors === "onUpdate" ||
            this.configuration.calculateVectors === "always"
        ) {

            if (this.embedder.queue?.name) {
                console.log("[EXULU] embedder is in queue mode, scheduling job.")
                const job = await bullmqDecorator({
                    label: `Job running '${this.embedder.name}' for '${item.name} (${item.id}).'`,
                    embedder: this.embedder.id,
                    type: "embedder",
                    inputs: item,
                    queue: this.embedder.queue,
                    user: user
                })
                return {
                    id: result[0].id,
                    job: job.id
                };
            }

            const { id: source, chunks } = await this.embedder.generateFromDocument({
                ...item,
                id: id
            }, {
                label: this.name,
                trigger: "agent"
            })

            const exists = await db.schema.hasTable(this.getChunksTableName());
            if (!exists) {
                await this.createChunksTable();
            }

            // first delete all chunks with source = id
            await db.from(this.getChunksTableName()).where({ source }).delete();

            // then insert the new / updated chunks
            await db.from(this.getChunksTableName()).insert(chunks.map(chunk => ({
                source,
                content: chunk.content,
                chunk_index: chunk.index,
                embedding: pgvector.toSql(chunk.vector)
            })))

            await db.from(this.getTableName()).where({ id }).update({
                embeddings_updated_at: new Date().toISOString()
            }).returning("id")
        }

        return {
            id: result[0].id,
            job: undefined
        };
    }

    public async insertItem(user: string, item: Item, upsert: boolean = false): Promise<{
        id: string,
        job?: string
    }> {

        if (!item.name) {
            throw new Error("Name field is required.")
        }

        const { db } = await postgresClient();

        if (item.external_id) {
            const existingItem = await db.from(this.getTableName()).where({ external_id: item.external_id }).first();
            if (existingItem && !upsert) {
                throw new Error("Item with external id " + item.external_id + " already exists.")
            }
            if (existingItem && upsert) {
                await this.updateItem(user, existingItem.id, item);
                return existingItem.id;
            }
        }

        if (upsert && item.id) {
            const existingItem = await db.from(this.getTableName()).where({ id: item.id }).first();
            if (existingItem && upsert) {
                await this.updateItem(user, existingItem.id, item);
                return existingItem.id;
            }
        }

        Object.keys(item).forEach(key => {
            if (key === "name" || key === "description" || key === "external_id" || key === "tags" || key === "source" || key === "textLength" || key === "upsert" || key === "archived") {
                return;
            }
            const field = this.fields.find(field => field.name === key);
            if (!field) {
                throw new Error("Trying to insert value for field '" + key + "' that does not exist on the context fields definition. Available fields: " + this.fields.map(field => sanitizeName(field.name)).join(", ") + " ,name, description, external_id")
            }
        })
        delete item.id; // not allowed to update id
        delete item.upsert;
        const result = await db.from(this.getTableName()).insert({
            ...item,
            id: db.fn.uuid(),
            created_at: db.fn.now(),
            updated_at: db.fn.now()
        }).returning("id");

        if (
            this.configuration.calculateVectors === "onInsert" ||
            this.configuration.calculateVectors === "always"
        ) {
            if (this.embedder.queue?.name) {
                console.log("[EXULU] embedder is in queue mode, scheduling job.")
                const job = await bullmqDecorator({
                    label: `Job running '${this.embedder.name}' for '${item.name} (${item.id}).'`,
                    embedder: this.embedder.id,
                    type: "embedder",
                    inputs: item,
                    queue: this.embedder.queue,
                    user: user
                })

                return {
                    id: result[0].id,
                    job: job.id
                };
            }

            console.log("[EXULU] embedder is not in queue mode, calculating vectors directly.")
            const { id: source, chunks } = await this.embedder.generateFromDocument({
                ...item,
                id: result[0].id
            }, {
                label: this.name,
                trigger: "agent"
            })

            const exists = await db.schema.hasTable(this.getChunksTableName());
            if (!exists) {
                await this.createChunksTable();
            }

            console.log("[EXULU] Inserting chunks.")
            await db.from(this.getChunksTableName()).insert(chunks.map(chunk => ({
                source,
                content: chunk.content,
                chunk_index: chunk.index,
                embedding: pgvector.toSql(chunk.vector)
            })))

            await db.from(this.getTableName()).where({ id: result[0].id }).update({
                embeddings_updated_at: new Date().toISOString()
            }).returning("id")
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

        const mainTable = this.getTableName();
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
                    embedder: this.embedder.name
                },
                items: items
            };
        }

        if (typeof query === "string") {

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
                    trigger: statistics.trigger
                })
            }
            if (this.queryRewriter) {
                query = await this.queryRewriter(query);
            }

            const chunksTable = this.getChunksTableName();

            itemsQuery.leftJoin(chunksTable, function () {
                this.on(chunksTable + ".source", "=", mainTable + ".id")
            })

            itemsQuery.select(chunksTable + ".id as chunk_id")
            itemsQuery.select(chunksTable + ".source")
            itemsQuery.select(chunksTable + ".content")
            itemsQuery.select(chunksTable + ".chunk_index")
            itemsQuery.select(chunksTable + ".created_at as chunk_created_at")
            itemsQuery.select(chunksTable + ".updated_at as chunk_updated_at")

            const { chunks } = await this.embedder.generateFromQuery(query)

            if (!chunks?.[0]?.vector) {
                throw new Error("No vector generated for query.")
            }

            const vector = chunks[0].vector;
            const vectorStr = `ARRAY[${vector.join(",")}]`;
            const vectorExpr = `${vectorStr}::vector`; // => ARRAY[0.1,0.2,0.3]::vector

            switch (method) {
                case "l1Distance":
                    itemsQuery.select(db.raw(`?? <-> ${vectorExpr} as l1_distance`, [`${chunksTable}.embedding`]));
                    itemsQuery.orderByRaw(db.raw(`?? <-> ${vectorExpr} ASC`, [`${chunksTable}.embedding`]));
                    break;

                case "l2Distance":
                    itemsQuery.select(db.raw(`?? <-> ${vectorExpr} as l2_distance`, [`${chunksTable}.embedding`]));
                    itemsQuery.orderByRaw(db.raw(`?? <-> ${vectorExpr} ASC`, [`${chunksTable}.embedding`]));
                    break;

                case "hammingDistance":
                    itemsQuery.select(db.raw(`?? <#> ${vectorExpr} as hamming_distance`, [`${chunksTable}.embedding`]));
                    itemsQuery.orderByRaw(db.raw(`?? <#> ${vectorExpr} ASC`, [`${chunksTable}.embedding`]));
                    break;

                case "jaccardDistance":
                    itemsQuery.select(db.raw(`?? <#> ${vectorExpr} as jaccard_distance`, [`${chunksTable}.embedding`]));
                    itemsQuery.orderByRaw(db.raw(`?? <#> ${vectorExpr} ASC`, [`${chunksTable}.embedding`]));
                    break;

                case "maxInnerProduct":
                    itemsQuery.select(db.raw(`?? <#> ${vectorExpr} as inner_product`, [`${chunksTable}.embedding`]));
                    itemsQuery.orderByRaw(db.raw(`?? <#> ${vectorExpr} ASC`, [`${chunksTable}.embedding`]));
                    break;

                case "cosineDistance":
                default:
                    itemsQuery.select(db.raw(`1 - (?? <#> ${vectorExpr}) as cosine_distance`, [`${chunksTable}.embedding`]));
                    itemsQuery.orderByRaw(db.raw(`1 - (?? <#> ${vectorExpr}) DESC`, [`${chunksTable}.embedding`]));
                    break;
            }


            // todo allow for receiving "name" req.query param to filter by specific
            // properties of items. I.e. name=John Doe will filter items where the name
            // field is equal to John Doe.

            let items = await itemsQuery;
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
                                    key !== "l1_distance" &&
                                    key !== "l2_distance" &&
                                    key !== "hamming_distance" &&
                                    key !== "jaccard_distance" &&
                                    key !== "inner_product" &&
                                    key !== "cosine_distance" &&
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
                            ...(method === "l1Distance" && { l1_distance: item.l1_distance }),
                            ...(method === "l2Distance" && { l2_distance: item.l2_distance }),
                            ...(method === "hammingDistance" && { hamming_distance: item.hamming_distance }),
                            ...(method === "jaccardDistance" && { jaccard_distance: item.jaccard_distance }),
                            ...(method === "maxInnerProduct" && { inner_product: item.inner_product }),
                            ...(method === "cosineDistance" && { cosine_distance: item.cosine_distance })
                        }]
                    });
                    acc.push(seenSources.get(item.source));
                } else {
                    seenSources.get(item.source).chunks.push({
                        content: item.content,
                        chunk_index: item.chunk_index,
                        ...(method === "l1Distance" && { l1_distance: item.l1_distance }),
                        ...(method === "l2Distance" && { l2_distance: item.l2_distance }),
                        ...(method === "hammingDistance" && { hamming_distance: item.hamming_distance }),
                        ...(method === "jaccardDistance" && { jaccard_distance: item.jaccard_distance }),
                        ...(method === "maxInnerProduct" && { inner_product: item.inner_product }),
                        ...(method === "cosineDistance" && { cosine_distance: item.cosine_distance })
                    });
                }
                return acc;
            }, []);

            items.forEach(item => {
                if (!item.chunks?.length) {
                    return;
                }
                const {
                    average,
                    total
                } = calculateStatistics(item.chunks, method ?? "cosineDistance");
                item.averageRelevance = average;
                item.totalRelevance = total;
            })

            // todo if query && resultReranker, rerank the results
            if (this.resultReranker && query) {
                items = await this.resultReranker(items);
            }

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
                items: items
            };
        }


    }

    public createItemsTable = async () => {
        const { db } = await postgresClient();
        const tableName = this.getTableName();
        console.log("[EXULU] Creating table: " + tableName);
        return await db.schema.createTable(tableName, (table) => {
            console.log("[EXULU] Creating fields for table.", this.fields);
            table.uuid("id").primary().defaultTo(db.fn.uuid());
            table.text("name");
            table.text('description');
            table.text('tags');
            table.boolean('archived').defaultTo(false);
            table.text('external_id');
            table.integer('textLength');
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
        const tableName = this.getChunksTableName();
        console.log("[EXULU] Creating table: " + tableName);
        return await db.schema.createTable(tableName, (table) => {
            table.uuid("id").primary().defaultTo(db.fn.uuid());
            table.uuid("source").references("id").inTable(this.getTableName());
            table.text("content");
            table.integer("chunk_index");
            table.specificType('embedding', `vector(${this.embedder.vectorDimensions})`);
            table.timestamps(true, true);
        });
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
            execute: async ({ query }: any) => {
                // todo make trigger more specific with the agent name
                return await this.getItems({
                    page: 1,
                    limit: 10,
                    query: query,
                    statistics: {
                        label: this.name,
                        trigger: "agent"
                    }
                })
            },
        });
    }

    public sources = {
        add: (inputs: AddSourceArgs): ExuluSource => {
            const source = new ExuluSource({
                ...inputs,
                context: this.id
            })
            this._sources.push(source);
            return source;
        },
        get: (id?: string): ExuluSource[] | (ExuluSource | undefined) => {
            if (id) {
                return this._sources.find(source => source.id === id);
            }
            return this._sources ?? [];
        }
    }
}

/**
 * @param updaters - Defines how this source decides when and which data to send to the embedder for updating vectors
 * @param updaters.type - The type of update mechanism:
 *   - "manual": Will be shown in the Exulu frontend UI via a Button for manual triggering
 *   - "cron": Will automatically update on a schedule
 *   - "webhook": Will update when triggered by an external webhook
 * @param updaters.fn - The function that handles the update logic
 * @param configuration - Defines fields shown in the UI that admins can set for each instance of the Source
 *   This allows reusing logic while exposing configurable variables (e.g. a "query" field)
 *   that admins can set differently for different instances in the UI
 */
type ExuluSourceConstructorArgs = {
    id: string,
    name: string,
    description: string,
    updaters: ExuluSourceUpdaterArgs[],
    context: string
}

export type SourceDocument = {
    id: string,
    content: string,
    metadata?: Record<string, any>
}

type ExuluSourceUpdaterArgs = {
    id: string,
    type: "manual" | "cron" | "webhook",
    fn: (configuration: Record<string, any>) => Promise<SourceDocument[]>,
    configuration: Record<string, {
        type: "string" | "number" | "query"
        example: string
    }>
}

export type ExuluStatistic = {
    name: string,
    label: string,
    type: STATISTICS_TYPE,
    trigger: "tool" | "agent" | "flow" | "api" | "claude-code",
    total: number,
}

export type ExuluStatisticParams = Omit<ExuluStatistic, "total" | "name" | "type">

export type ExuluSourceUpdater = ExuluSourceUpdaterArgs & {
    slug?: string,
}

export class ExuluSource {
    public id: string;
    public name: string;
    public description: string;
    public updaters: ExuluSourceUpdater[]
    public context: string;

    constructor({ id, name, description, updaters, context }: ExuluSourceConstructorArgs) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.context = context;
        this.updaters = updaters.map(updater => {
            if (updater.type === "webhook") {
                return {
                    ...updater,
                    slug: `/contexts/${context}/sources/${this.id}/${updater.id}/webhook`
                }
            }
            return updater;
        })

    }
}

export const updateStatistic = async (statistic: Omit<ExuluStatistic, "total"> & { count?: number }) => {
    const currentDate = new Date().toISOString().split('T')[0];
    const { db } = await postgresClient();

    const existing = await db.from("statistics").where({
        name: statistic.name,
        label: statistic.label,
        type: statistic.type,
        createdAt: currentDate
    }).first();

    // Update a specific statistic by name, label and type for a particular day.
    // If the statistic does not exist, it will be created.
    // If the statistic exists, it will be updated by incrementing the total count.
    if (!existing) {
        await db.from("statistics").insert({
            name: statistic.name,
            label: statistic.label,
            type: statistic.type,
            total: statistic.count ?? 1,
            createdAt: currentDate
        })
    } else {
        await db.from("statistics").update({
            total: db.raw("total + ?", [statistic.count ?? 1]),
        }).where({
            name: statistic.name,
            label: statistic.label,
            type: statistic.type,
            createdAt: currentDate
        })
    }

}