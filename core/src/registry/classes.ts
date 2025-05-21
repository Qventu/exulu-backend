import { ZodSchema } from "zod";
import { Queue } from "bullmq";
import { Agent as MastraAgent, Workflow as MastraWorkflow, type ToolAction } from "@mastra/core";
import { z } from "zod"
import * as fs from 'fs';
import * as path from 'path';
import { Job } from "bullmq";
import type { LanguageModelV1 } from "ai";
import { Memory } from "@mastra/memory";
import { PostgresStore, PgVector } from "@mastra/pg";
import { type STATISTICS_TYPE, STATISTICS_TYPE_ENUM } from "@EXULU_TYPES/enums/statistics";
import { postgresClient } from "../postgres/client";
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";
import type { Item } from "@EXULU_TYPES/models/item";
import type { VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import pgvector from 'pgvector/knex'; // DONT REMOVE THIS
import { bullmqDecorator } from "./decoraters/bullmq";
import { mapType } from "./utils/map-types";
import { sanitizeName } from "./utils/sanitize-name";

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
    model: LanguageModelV1,
    memory?: {
        lastMessages: number,
        vector: boolean;
        semanticRecall: {
            topK: number,
            messageRange: number
        }
    },
}

export class ExuluAgent {

    public id: string;
    public name: string;
    public description: string = "";
    public slug: string = "";
    public streaming: boolean = false;
    public type: "agent" | "workflow";
    public outputSchema?: ZodSchema;
    public rateLimit?: RateLimiterRule;
    public config: ExuluAgentConfig;
    private memory: Memory | undefined;
    public tools?: ExuluTool[];
    public capabilities: {
        tools: boolean,
        images: string[],
        files: string[],
        audio: string[],
        video: string[]
    }
    constructor({ id, name, description, outputSchema, config, rateLimit, type, capabilities, tools }: {
        id: string,
        name: string,
        type: "agent" | "workflow",
        description: string,
        config: ExuluAgentConfig,
        outputSchema?: ZodSchema,
        rateLimit?: RateLimiterRule,
        capabilities: {
            tools: boolean,
            images: string[],
            files: string[],
            audio: string[],
            video: string[]
        },
        tools?: ExuluTool[]
    }) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.description = description;
        this.outputSchema = outputSchema;
        this.rateLimit = rateLimit;
        this.config = config;
        this.capabilities = capabilities;
        this.slug = `/agents/${generateSlug(this.name)}/run`

        if (config?.memory) {
            const connectionString = `postgresql://${process.env.POSTGRES_DB_USER}:${process.env.POSTGRES_DB_PASSWORD}@${process.env.POSTGRES_DB_HOST}:${process.env.POSTGRES_DB_PORT}/exulu`;
            this.memory = new Memory({
                storage: new PostgresStore({
                    host: process.env.POSTGRES_DB_HOST || "",
                    port: parseInt(process.env.POSTGRES_DB_PORT || '5432'),
                    user: process.env.POSTGRES_DB_USER || "",
                    database: "exulu", // putting it into an own database that is not managed by exulu
                    password: process.env.POSTGRES_DB_PASSWORD || "",
                    ssl: process.env.POSTGRES_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
                }),
                ...(config?.memory.vector ? { vector: new PgVector(connectionString) } : {}),
                options: {
                    lastMessages: config?.memory.lastMessages || 10,
                    semanticRecall: {
                        topK: config?.memory.semanticRecall.topK || 3,
                        messageRange: config?.memory.semanticRecall.messageRange || 2,
                    },
                },
            });
        }
    }

    public chat = async (id: string) => {

        const { db } = await postgresClient();
        
        const agent: any = await db.from("agents").select("*").where("id", "=", id).first();
        if (!agent) {
            throw new Error("Agent not found")
        }

        let tools = {};

        // for each tool id stored in the mongodb configuration
        // for this agent, check if the tool exists in the exulu registry
        // if it does, add it to the tools object.
        agent.tools?.forEach(({ name }) => { // todo
            const tool = this.tools?.find(t => t.name === name)
            if (!tool) {
                return;
            }
            return tool;
        })

        updateStatistic({
            name: "count",
            label: this.name,
            type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
            trigger: "agent"
        })

        return new MastraAgent({
            name: this.config.name,
            instructions: this.config.instructions,
            model: this.config.model,
            tools,
            memory: this.memory ? this.memory : undefined,
        })

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

    public async generateFromQuery(query: string, statistics?: {
        label: string,
        trigger: string
    }): VectorGenerationResponse {

        if (statistics) {
            // todo fix the statistics upsert!
            // Without blocking the main thread, upsert an entry 
            // into mongdb of type ExuluStatistic.
            // console.log("updating statistic")
            // updateStatistic({
            //     name: "count",
            //     label: statistics.label,
            //     type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
            //     trigger: statistics.trigger,
            //     count: 1
            // })
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

    public async generateFromDocument(input: Item, statistics?: {
        label: string,
        trigger: string
    }): VectorGenerationResponse {

        if (statistics) {
            // todo fix the statistics upsert!
            // Without blocking the main thread, upsert an entry 
            // into mongdb of type ExuluStatistic.
            // console.log("updating statistic")
            // updateStatistic({
            //     name: "count",
            //     label: statistics.label,
            //     type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
            //     trigger: statistics.trigger,
            //     count: 1
            // })
        }

        if (!this.chunker) {
            throw new Error("Chunker not found for embedder " + this.name)
        }

        console.log("generating chunks")

        if (!input.id) {
            throw new Error("Item id is required for generating embeddings.")
        }

        const output = await this.chunker(input as Item & { id: string }, this.maxChunkSize)

        console.log("generating embeddings")

        return await this.generateEmbeddings(output)
    };

}

export class ExuluWorkflow {

    public id: string;
    public name: string;
    public description: string = "";
    public enable_batch: boolean = false;
    public slug: string = "";
    public queue: Queue | undefined;
    public workflow: MastraWorkflow;
    public inputSchema?: ZodSchema;

    constructor({ id, name, description, workflow, queue, enable_batch, inputSchema }: {
        id: string,
        name: string,
        description: string,
        workflow: MastraWorkflow,
        queue?: Queue,
        inputSchema?: ZodSchema,
        enable_batch: boolean
    }) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.enable_batch = enable_batch;
        this.slug = `/workflows/${generateSlug(this.name)}/run`
        this.queue = queue;
        this.inputSchema = inputSchema;
        this.workflow = workflow;
    }

}

export class ExuluLogger {
    private readonly logPath: string;
    private readonly job: Job;

    constructor(job: Job, logsDir: string) {
        this.job = job;
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        this.logPath = path.join(logsDir, `${job.id}_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    }

    async write(message: string, level: "INFO" | "ERROR" | "WARNING"): Promise<void> {
        // Append newline to message if it doesn't have one
        const logMessage = message.endsWith('\n') ? message : message + '\n';

        try {
            await fs.promises.appendFile(this.logPath, `[EXULU][${level}] - ${new Date().toISOString()}: ${logMessage}`);
        } catch (error) {
            console.error(`Error writing to log file ${this.job.id}:`, error);
            throw error;
        }
    }
}

type AddSourceArgs = Omit<ExuluSourceConstructorArgs, "context">;

export class ExuluTool {
    public id: string;
    public name: string;
    public description: string;
    public inputSchema?: ZodSchema;
    public outputSchema?: ZodSchema;
    public type: "context" | "function";
    private _execute: ToolAction['execute']

    constructor({ id, name, description, inputSchema, outputSchema, type, execute }: {
        id: string,
        name: string,
        description: string,
        inputSchema?: ZodSchema,
        outputSchema?: ZodSchema,
        type: "context" | "function",
        execute: ToolAction['execute']
    }) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.inputSchema = inputSchema;
        this.outputSchema = outputSchema;
        this.type = type;
        this._execute = execute;
    }

    public execute = async (inputs: any) => {
        if (!this._execute) {
            throw new Error("Tool has no execute function.");
        }
        updateStatistic({
            name: "count",
            label: this.name,
            type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
            trigger: "agent"
        })
        return await this._execute(inputs);
    }
}

type ExuluContextFieldDefinition = {
    name: string,
    type: ExuluFieldTypes
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
    private configuration: {
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
            if (key === "name" || key === "description" || key === "external_id" || key === "tags" || key === "source" || key === "textLength" || key === "upsert") {
                return;
            }
            console.log("this.fields", this.fields)
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
            if (key === "name" || key === "description" || key === "external_id" || key === "tags" || key === "source" || key === "textLength" || key === "upsert") {
                return;
            }
            console.log("this.fields", this.fields)
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

            console.log("inserting chunks")
            await db.from(this.getChunksTableName()).insert(chunks.map(chunk => ({
                source,
                content: chunk.content,
                chunk_index: chunk.index,
                embedding: pgvector.toSql(chunk.vector)
            })))
        }

        return {
            id: result[0].id,
            job: undefined
        };
    }

    public getItems = async ({
        statistics,
        limit,
        page,
        name,
        archived,
        query,
        method
    }: {
        statistics?: {
            label: string,
            trigger: string
        },
        page: number,
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

            itemsQuery.limit(limit * 5) // for semantic search we increase the scope, so we can rerank the results

            // Without blocking the main thread, upsert an entry 
            // into mongdb of type ExuluStatistic.
            if (statistics) {
                updateStatistic({
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

            // Count is irrelevant here as vector search does
            // not exclude any items, but merely sorts them.
            itemsQuery.leftJoin(chunksTable, function () {
                this.on(chunksTable + ".source", "=", mainTable + ".id")
            })

            itemsQuery.select(chunksTable + ".id")
            itemsQuery.select(chunksTable + ".source")
            itemsQuery.select(chunksTable + ".content")
            itemsQuery.select(chunksTable + ".chunk_index")
            itemsQuery.select(chunksTable + ".created_at")
            itemsQuery.select(chunksTable + ".updated_at")

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
                                    key !== "chunk_index"
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
            table.string("name", 100);
            table.text('description');
            table.string('tags', 100);
            table.boolean('archived').defaultTo(false);
            table.string('external_id', 100);
            table.integer('textLength');
            table.string('source', 100);
            for (const field of this.fields) {
                const { type, name } = field;
                if (!type || !name) {
                    continue;
                }
                mapType(table, type, sanitizeName(name));
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
            id: `${this.name} context`,
            name: `${this.name} context`,
            type: "context",
            inputSchema: z.object({
                query: z.string(),
            }),
            outputSchema: z.object({
                // todo check if result format is still correct based on above getItems function
                results: z.array(z.object({
                    count: z.number(),
                    results: z.array(z.object({
                        id: z.string(),
                        content: z.string(),
                        metadata: z.record(z.any())
                    })),
                    errors: z.array(z.string()).optional()
                }))
            }),
            description: `Gets information from the context called: ${this.name}. The context description is: ${this.description}.`,
            execute: async ({ context }: any) => {
                // todo make trigger more specific with the agent name
                return await this.getItems({
                    page: 1,
                    limit: 10,
                    query: context.query,
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
    trigger: string,
    total: number,
    timeseries: {
        date: string,
        count: number
    }[]
}

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

const updateStatistic = async (statistic: Omit<ExuluStatistic, "timeseries" | "total"> & { count?: number }) => {
    const currentDate = new Date().toISOString().split('T')[0];
    const { db } = await postgresClient();
    // Update a specific statistic by name, label and type for a particular day.
    // If the statistic does not exist, it will be created.
    // If the statistic exists, it will be updated by incrementing the total count.
    await db.from("statistics").update({
        total: db.raw("total + ?", [statistic.count ?? 1]),
        timeseries: db.raw("CASE WHEN date = ? THEN array_append(timeseries, ?) ELSE timeseries END", [currentDate, { date: currentDate, count: statistic.count ?? 1 }])
    }).where({
        name: statistic.name,
        label: statistic.label,
        type: statistic.type
    }).onConflict("name").merge();

}