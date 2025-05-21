import { type Express, type Request, type Response } from "express";
import { type ExuluAgent, ExuluContext, ExuluEmbedder, type ExuluTool, ExuluWorkflow, type SourceDocument } from "./classes.ts";
import { rateLimiter } from "./rate-limiter.ts";
import { bullmqDecorator } from "./decoraters/bullmq.ts";
import { requestValidators } from "./route-validators";
import { zerialize } from "zodex";
import { queues } from "../bullmq/queues.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import { postgresClient } from "../postgres/client.ts";
import { VectorMethodEnum, type VectorMethod } from "@EXULU_TYPES/models/vector-methods.ts";
import express from 'express';
import { ApolloServer } from '@apollo/server';
const Papa = require("papaparse");
import cors from 'cors';
import 'reflect-metadata'
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types.ts";
import { createSDL } from "./utils/graphql.ts";
import type { Knex } from "knex";
import { expressMiddleware } from '@as-integrations/express5';
import { agentsSchema, jobsSchema, rolesSchema, usersSchema } from "../postgres/core-schema.ts";
import { createUppyRoutes } from "./uppy.ts";

export const global_queues = {
    logs_cleaner: "logs-cleaner"
}

const createRecurringJobs = async () => {
    const recurringJobSchedulersLogs: Array<{ name: string; pattern: string; ttld?: string; opts?: any }> = [];

    const queue = queues.use(global_queues.logs_cleaner);

    recurringJobSchedulersLogs.push({
        name: global_queues.logs_cleaner,
        pattern: '0 10 * * * *',
        ttld: '30 days',
        opts: {
            backoff: 3,
            attempts: 5,
            removeOnFail: 1000,
        },
    })

    await queue.upsertJobScheduler(
        'logs-cleaner-scheduler',
        { pattern: '0 10 * * * *' }, // every 10 minutes
        {
            name: global_queues.logs_cleaner,
            data: { ttld: 30 }, // time to live in days
            opts: {
                backoff: 3,
                attempts: 5,
                removeOnFail: 1000,
            },
        },
    );

    console.log("Recurring job schedulers:")
    console.table(recurringJobSchedulersLogs);

    return queue;
}

export type ExuluTableDefinition = {
    name: {
        plural: string,
        singular: string,
    },
    fields: {
        name: string,
        type: ExuluFieldTypes | "reference" | "date" | "json" | "uuid",
        index?: boolean,
        required?: boolean,
        default?: any,
        references?: {
            table: string,
            field: string,
            onDelete: "CASCADE" | "SET NULL" | "NO ACTION"
        }
    }[]
}

export const createExpressRoutes = async (
    app: Express,
    agents: ExuluAgent[],
    embedders: ExuluEmbedder[],
    tools: ExuluTool[],
    workflows: ExuluWorkflow[],
    contexts: ExuluContext[],
) => {
    const routeLogs: Array<{ route: string; method: string; note?: string }> = [];
    // Add route logs instead of individual console.logs

    var corsOptions = {
        origin: '*',
        optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
    }
    app.use(cors(corsOptions));

    console.log(`
    ███████╗██╗  ██╗██╗   ██╗██╗      ██╗   ██╗
    ██╔════╝╚██╗██╔╝██║   ██║██║      ██║   ██║
    █████╗   ╚███╔╝ ██║   ██║██║      ██║   ██║
    ██╔══╝   ██╔██╗ ██║   ██║██║      ██║   ██║
    ███████╗██╔╝ ██╗╚██████╔╝███████╗╚██████╔╝
    ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝ 
    `);

    console.log("Agents:")
    console.table(agents.map(agent => {
        return {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            slug: "/agents/" + agent.id,
            active: true,
        }
    }))

    console.log("Contexts:")
    console.table(contexts.map(context => {
        const sources = context.sources.get();
        return {
            id: context.id,
            name: context.name,
            description: context.description,
            embedder: context.embedder.name,
            slug: "/contexts/" + context.id,
            active: context.active,
            sources: Array.isArray(sources) ? sources.length : 0,
            sources_details: Array.isArray(sources) ? sources.map(source => `${source.name} (${source.id})`).join(', ') : 'No sources'
        }
    }))

    routeLogs.push(
        { route: "/agents", method: "GET", note: "List all agents" },
        { route: "/agents/:id", method: "GET", note: "Get specific agent" },
        { route: "/workflows", method: "GET", note: "List all workflows" },
        { route: "/workflows/:id", method: "GET", note: "Get specific workflow" },
        { route: "/contexts", method: "GET", note: "List all contexts" },
        { route: "/contexts/:id", method: "GET", note: "Get specific context" },
        { route: "/contexts/statistics", method: "GET", note: "Get context statistics" },
        { route: "/tools", method: "GET", note: "List all tools" },
        { route: "/tools/:id", method: "GET", note: "Get specific tool" },
        { route: "/statistics/timeseries", method: "POST", note: "Get time series statistics" },
        { route: "/statistics/totals", method: "POST", note: "Get totals statistics" },
        { route: "/items/:context", method: "POST", note: "Create new item in context" },
        { route: "/items/:context", method: "GET", note: "Get items from context" },
        { route: "/items/export/:context", method: "GET", note: "Export items from context" },
        { route: "/graphql", method: "POST", note: "GraphQL endpoint" },
    );

    await createRecurringJobs();

    const schema = createSDL([usersSchema, rolesSchema, agentsSchema, jobsSchema]);

    interface GraphqlContext {
        db: Knex;
        req: Request;
    }

    const server = new ApolloServer<GraphqlContext>({ schema, introspection: true });

    // Note you must call `start()` on the `ApolloServer`
    // instance before passing the instance to `expressMiddleware`
    await server.start();

    app.use(
        "/graphql",
        cors(),
        express.json(),
        expressMiddleware(server, {
            context: async ({ req }) => {
                const authenticationResult = await requestValidators.authenticate(req);
                if (!authenticationResult.user?.id) {
                    throw new Error(authenticationResult.message);
                }
                const { db } = await postgresClient();
                return {
                    req,
                    db
                };
            },
        }),
    );

    app.get(`/agents`, async (req: Request, res: Response) => {
        // todo add auth
        res.status(200).json(agents)
    })
    app.get(`/agents/:id`, async (req: Request, res: Response) => {

        const { db } = await postgresClient();
        // todo add auth
        const id = req.params.id;
        if (!id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }
        const agent = await db.from("agents").where({ id }).first();
        if (!agent) {
            res.status(400).json({
                message: "Agent not found in database."
            })
            return;
        }
        console.log("[EXULU] agent", agent)
        const backend = agents.find(a => a.id === agent.backend);
        if (!backend) {
            res.status(400).json({
                message: "Backend for provided agent not found."
            })
            return;
        }

        const tools = agent.tools?.map(id => {
            const tool = backend.tools?.find(t => t.id === id);
            if (!tool) {
                return null;
            }
            return tool;
        }).filter(tool => tool !== null) as ExuluTool[];

        res.status(200).json({
            ...agent,
            ...{
                slug: backend.slug,
                rateLimit: backend.rateLimit,
                streaming: backend.streaming,
                capabilities: backend.capabilities,
                // todo add contexts
                tools
            }
        })
    })

    app.get("/tools", async (req: Request, res: Response) => {
        // todo add auth
        res.status(200).json(tools.map(tool => ({
            id: tool.id,
            description: tool.description,
            type: tool.type || "tool",
            inputSchema: tool.inputSchema ? zerialize(tool.inputSchema as any) : null,
            outputSchema: tool.outputSchema ? zerialize(tool.outputSchema as any) : null
        })))
    })

    app.get("/tools/:id", async (req: Request, res: Response) => {
        // todo add auth  
        const id = req.params.id;
        if (!id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }
        const tool = tools.find(tool => tool.id === id);
        if (!tool) {
            res.status(400).json({
                message: "Tool not found."
            })
            return;
        }
        res.status(200).json(tool)
    })

    const deleteItem = async ({
        id,
        external_id,
        contextId
    }: {
        id?: string;
        external_id?: string;
        contextId: string;
    }) => {
        if (!contextId) {
            throw new Error("Missing context in request.")
        }

        if (!id && !external_id) {
            throw new Error("Missing id or external_id in request.")
        }
        // todo add auth
        const { db } = await postgresClient();
        const context = contexts.find( context => context.id === contextId)
        if (!context) {
            throw new Error("Context not found in registry.")
        }

        const exists = await context.tableExists();

        if (!exists) {
            throw new Error("Table with name " + context.getTableName() + " does not exist.")
        }

        const mutation = db.from(context.getTableName())
            .delete()
            .returning("id");

        if (id) {
            mutation.where({ id })
        }

        if (external_id) {
            mutation.where({ external_id })
        }

        const result = await mutation;

        return result;
    }

    app.delete("/items/:context/:id", async (req: Request, res: Response) => {
        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }
        const result = await deleteItem({
            id: req.params.id,
            contextId: req.params.context
        })
        res.status(200).json(result);
    })

    app.delete("/items/:context/external/:id", async (req: Request, res: Response) => {
        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }
        const result = await deleteItem({
            external_id: req.params.id,
            contextId: req.params.context
        })
        res.status(200).json(result);
    })

    app.get("/items/:context/:id", async (req: Request, res: Response) => {

        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }

        if (!req.params.id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }
        // todo add auth
        const { db } = await postgresClient();
        const context = contexts.find( context => context.id === req.params.context)

        if (!context) {
            res.status(400).json({
                message: "Context not found in registry."
            })
            return;
        }

        const item = await db.from(context.getTableName())
            .where({ id: req.params.id })
            .select("*")
            .first();

        if (!item) {
            res.status(404).json({
                message: "Item not found."
            })
            return;
        }

        console.log("[EXULU] chunks table name.", context.getChunksTableName())

        const chunks = await db.from(context.getChunksTableName())
            .where({ source: req.params.id })
            .select("id", "content", "source", "embedding", "chunk_index", "created_at", "updated_at");

        console.log("[EXULU] chunks", chunks)

        res.status(200).json({
            ...item,
            chunks: chunks.map((chunk: any) => ({
                id: chunk.id,
                content: chunk.content,
                source: chunk.source,
                index: chunk.chunk_index,
                embedding: chunk.embedding?.length > 0 ? JSON.parse(chunk.embedding)?.length : null,
                createdAt: chunk.created_at,
                updatedAt: chunk.updated_at
            }))
        });

    })

    app.post("/items/:context/:id", async (req: Request, res: Response) => {

        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }

        if (!req.params.id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const context = contexts.find( context => context.id === req.params.context)
        if (!context) {
            res.status(400).json({
                message: "Context not found in registry."
            })
            return;
        }

        const exists = await context.tableExists();

        if (!exists) {
            await context.createItemsTable();
        }

        const result = await context.updateItem(authenticationResult.user.id, req.params.id, req.body);

        res.status(200).json({
            message: "Item updated successfully.",
            id: result
        });

    })

    app.post("/items/:context", async (req: Request, res: Response) => {

        try {
            if (!req.params.context) {
                res.status(400).json({
                    message: "Missing context in request."
                })
                return;
            }

            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            const context = contexts.find( context => context.id === req.params.context)

            if (!context) {
                res.status(400).json({
                    message: "Context not found in registry."
                })
                return;
            }

            const exists = await context.tableExists();

            if (!exists) {
                await context.createItemsTable();
            }

            const result = await context.insertItem(authenticationResult.user.id, req.body, !!req.body.upsert);

            res.status(200).json({
                message: "Item created successfully.",
                id: result
            });
        } catch (error: any) {
            res.status(500).json({
                message: error?.message || "An error occurred while creating the item."
            })
        }
    })

    app.get("/items/:context", async (req: Request, res: Response) => {

        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }

        let limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
        let page = req.query.page ? parseInt(req.query.page as string) : 1;

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const context = contexts.find( context => context.id === req.params.context)
        if (!context) {
            res.status(400).json({
                message: "Context not found in registry."
            })
            return;
        }

        const exists = await context.tableExists();

        if (!exists) {
            await context.createItemsTable();
        }

        if (req.query.method && !Object.values(VectorMethodEnum).includes(req.query.method as VectorMethod)) {
            res.status(400).json({
                message: "Invalid vector lookup method, must be one of: " + Object.values(VectorMethodEnum).join(", ")
            })
            return;
        }

        const result = await context.getItems({
            page,
            limit,
            archived: req.query.archived === "true",
            name: typeof req.query.name === "string" ? req.query.name : undefined,
            method: req.query.method ? req.query.method as VectorMethod : undefined,
            query: req.query.query ? req.query.query as string : undefined,
            statistics: {
                label: context.name,
                trigger: "api"
            }
        })

        res.status(200).json(result);
    })


    routeLogs.push({
        route: "/items/:context",
        method: "DELETE",
        note: `Delete all embeddings for a context.`
    });
    app.delete(`items/:context`, async (req: Request, res: Response) => {
        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }
        const context = contexts.find( context => context.id === req.params.context)
        if (!context) {
            res.status(400).json({
                message: "Context not found in registry."
            })
            return;
        }

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        // todo check if super admin

        await context.deleteAll()
        res.status(200).json({
            message: "All embeddings deleted."
        })
    })

    // DELETE EMBEDDING
    routeLogs.push({
        route: `/items/:context/:id`,
        method: "DELETE",
        note: `Delete specific embedding for a context.`
    });
    app.delete(`items/:context/:id`, async (req: Request, res: Response) => {
        const id = req.params.id;
        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }
        const context = contexts.find( context => context.id === req.params.context)
        if (!context) {
            res.status(400).json({
                message: "Context not found in registry."
            })
            return;
        }
        if (!id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        await context.deleteOne(id)
        res.status(200).json({
            message: "Embedding deleted."
        })
    })

    app.post("/statistics/timeseries", async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { db } = await postgresClient();

        const type: STATISTICS_TYPE = req.body.type;

        if (!Object.values(STATISTICS_TYPE_ENUM).includes(type)) {
            res.status(400).json({
                message: "Invalid type, must be one of: " + Object.values(STATISTICS_TYPE_ENUM).join(", ")
            })
            return;
        }

        let from: Date = new Date(req.body.from);
        let to: Date = new Date(req.body.to);

        if (!from || !to) {
            // set to default 7 days ago
            from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            to = new Date();
        }

        const results: any = await db.from("statistics").where({
            name: "count",
            type: type,
            createdAt: {
                $gte: from,
                $lte: to
            }
        }).select("*");

        // check if between from and to for each day we have a result, if not add 0
        const dates: Date[] = [];
        for (let i = 0; i < (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24); i++) {
            dates.push(new Date(from.getTime() + i * (1000 * 60 * 60 * 24)));
        }

        const data: { date: Date; count: number }[] = dates.map(date => {
            const result = results.find(result => result.date === date);
            if (result) {
                return result;
            }
            return {
                date: date,
                count: 0
            };
        });
        res.status(200).json({
            data,
            filter: {
                from,
                to
            }
        });
    })

    app.post("/statistics/totals", async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { db } = await postgresClient();

        let from: Date = new Date(req.body.from);
        let to: Date = new Date(req.body.to);

        if (!from || !to) {
            // set to default 7 days ago
            from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            to = new Date();
        }

        let promises = Object.values(STATISTICS_TYPE_ENUM).map(async (type: string) => {
            // get the sum of the total for the given type and date range
            const result = await db.from("statistics")
                .where("name", "count")
                .andWhere("type", type)
                .andWhere("createdAt", ">=", from)
                .andWhere("createdAt", "<=", to)
                .select("SUM(total) as total");
            return {
                [type]: result[0]?.total || 0
            }
        });

        const results = await Promise.all(promises);
        res.status(200).json({
            data: { ...Object.assign({}, ...results) },
            filter: {
                from,
                to
            }
        });
    })

    app.get("/contexts/statistics", async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { db } = await postgresClient();

        const statistics = await db("statistics")
        .where("name", "count")
        .andWhere("type", "context.retrieve")
        .sum("total as total").first()

        const response = await db('jobs')
            .select(db.raw(`to_char("createdAt", 'YYYY-MM-DD') as date`))
            .count('* as count')
            .where('type', 'embedder')
            .groupByRaw(`to_char("createdAt", 'YYYY-MM-DD')`)
            .then(rows => ({
                jobs: rows
            }));

        console.log({ response })

        // Get total count of jobs of type "embedder"

        let jobs = [];
        if (response[0]) {
            jobs = response[0].jobs.map(job => ({
                date: job.id,
                count: job.count
            }));
        }

        const embeddingsCountResult = await db('jobs')
            .where('type', 'embedder')
            .count('* as count')
            .first();

        res.status(200).json({
            active: contexts.filter(context => context.active).length,
            inactive: contexts.filter(context => !context.active).length,
            sources: contexts.reduce((acc, context) => acc + context.sources.get().length, 0),
            queries: statistics?.total || 0,
            jobs: jobs,
            totals: {
                embeddings: embeddingsCountResult?.count || 0
            }
        })
    })

    app.get(`/contexts/:id`, async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const id = req.params.id;
        if (!id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }
        const context = contexts.find( context => context.id === id);
        if (!context) {
            res.status(400).json({
                message: "Context not found."
            })
            return;
        }
        // todo get list of agents using this context as a tool
        // from the database (each agent in mongodb has a list of tools)
        res.status(200).json({
            ...{
                id: context.id,
                name: context.name,
                description: context.description,
                embedder: context.embedder.name,
                slug: "/contexts/" + context.id,
                active: context.active,
                fields: context.fields,
                sources: context.sources.get().map(source => ({
                    id: source.id,
                    name: source.name,
                    description: source.description,
                    updaters: source.updaters.map(updater => ({
                        id: updater.id,
                        slug: updater.slug,
                        type: updater.type,
                        configuration: updater.configuration
                    }))
                }))
            },
            agents: [] // todo
        })
    })

    app.get(`/items/export/:context`, async (req: Request, res: Response) => {

        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const context = contexts.find( context => context.id === req.params.context);
        if (!context) {
            res.status(400).json({
                message: "Context not found."
            })
            return;
        }
        const items = await context.getItems({
            page: 1, // todo add pagination
            limit: 500
        });
        const csv = Papa.unparse(items);

        const ISOTime = new Date().toISOString();
        res.status(200).attachment(`${context.name}-items-export-${ISOTime}.csv`).send(csv)
    })

    app.get(`/contexts`, async (req: Request, res: Response) => {

        console.log("contexts!!")
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        console.log("contexts", contexts?.length)

        res.status(200).json(contexts.map(context => ({
            id: context.id,
            name: context.name,
            description: context.description,
            embedder: context.embedder.name,
            slug: "/contexts/" + context.id,
            active: context.active,
            fields: context.fields,
            sources: context.sources.get().map(source => ({
                id: source.id,
                name: source.name,
                description: source.description,
                updaters: source.updaters.map(updater => ({
                    id: updater.id,
                    slug: updater.slug,
                    type: updater.type,
                    configuration: updater.configuration
                }))
            }))
        })))
    })

    app.get(`/workflows`, async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        res.status(200).json(workflows.map(workflow => ({
            id: workflow.id,
            name: workflow.name,
            slug: workflow.slug,
            enable_batch: workflow.enable_batch,
            queue: workflow.queue?.name,
            inputSchema: workflow.inputSchema ? zerialize(workflow.inputSchema as any) : null
        })))
    })

    app.get(`/workflows/:id`, async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const id = req.params.id;
        if (!id) {
            res.status(400).json({
                message: "Missing id in request."
            })
            return;
        }
        const workflow = workflows.find(workflow => workflow.id === id)
        if (!workflow) {
            res.status(400).json({
                message: "Workflow not found."
            })
            return;
        }
        res.status(200).json({
            ...workflow,
            queue: workflow.queue?.name,
            inputSchema: workflow.inputSchema ? zerialize(workflow.inputSchema as any) : null,
            workflow: undefined
        })
    })

    contexts.forEach(context => {
        const sources = context.sources.get();
        if (!Array.isArray(sources)) {
            return;
        }
        sources.forEach(source => {
            source.updaters.forEach(updater => {
                if (!updater.slug) return;
                if (
                    updater.type === "webhook" ||
                    updater.type === "manual"
                ) {
                    routeLogs.push({
                        route: `${updater.slug}/${updater.type}/:context`,
                        method: "POST",
                        note: `Webhook updater for ${context.name}`
                    });

                    app.post(`${updater.slug}/${updater.type}/:context`, async (req: Request, res: Response) => {

                        const { context: id } = req.params;
                        if (!id) {
                            res.status(400).json({
                                message: "Missing context id in request."
                            })
                            return;
                        }

                        const context = contexts.find(context => context.id === id);
                        if (!context) {
                            res.status(400).json({
                                message: `Context for provided id: ${id} not found.`
                            })
                            return;
                        }

                        if (!context.embedder.queue) {
                            res.status(500).json({ detail: 'No queue set for embedder.' });
                            return;
                        }

                        const authenticationResult = await requestValidators.authenticate(req);
                        if (!authenticationResult.user?.id) {
                            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                            return;
                        }

                        const requestValidationResult = requestValidators.embedders(req, updater.configuration)

                        if (requestValidationResult.error) {
                            res.status(requestValidationResult.code || 500).json({ detail: `${requestValidationResult.message}` });
                            return;
                        }

                        const documents = await updater.fn(req.body.configuration)

                        const batches: SourceDocument[][] = [];
                        for (let i = 0; i < documents.length; i += context.embedder.batchSize) {
                            batches.push(documents.slice(i, i + context.embedder.batchSize));
                        }

                        let promises: Promise<any>[] = [];
                        if (batches.length > 0) {
                            promises = batches.map(documents => {
                                return bullmqDecorator({
                                    label: `Job running context '${context.name}' with embedder '${context.embedder.name}' for '${req.body.label}'`,
                                    type: "embedder",
                                    embedder: context.embedder.id,
                                    updater: updater.id,
                                    context: context.id,
                                    trigger: updater.type,
                                    source: source.id,
                                    inputs: req.body.inputs,
                                    ...(updater.configuration && { configuration: req.body.configuration }),
                                    documents: documents,
                                    queue: context.embedder.queue!,
                                    user: authenticationResult.user!.id
                                })
                            })
                        }

                        const jobs = await Promise.all(promises);

                        res.status(200).json(jobs);
                        return;
                    })
                }
            })
        })
    })

    agents.forEach(agent => {
        const slug = agent.slug as string;
        if (!slug) return;

        routeLogs.push({
            route: slug + "/:instance",
            method: "POST",
            note: `Agent endpoint for ${agent.id}`
        });
        // The instance is the object in mongodb that uses this agent
        // as the backend. It allows for multiple instances of the same agent
        // to be used in parallel, with different configurations.
        app.post(slug + "/:instance", async (req: Request, res: Response) => {

            const instance = req.params.instance;
            if (!instance) {
                res.status(400).json({
                    message: "Missing instance in request."
                })
                return;
            }

            const { db } = await postgresClient();
            const agentInstance = await db.from("agents").where({
                id: instance
            }).first();

            if (!agentInstance) {
                res.status(400).json({
                    message: "Agent instance not found."
                })
                return;
            }

            // For agents we dont use bullmq jobs, instead we use a rate limiter to
            // allow responses in real time while managing availability of infrastructure
            // or provider limits.

            // todo add "configuration" object to backend agent, and allow setting agent instance
            // specific configurations that overwrite the global ones.
            // todo allow setting agent instance specific configurations that overwrite the global ones
            // todo display rate limit message in the chat UI

            if (agent.rateLimit) {
                const limit = await rateLimiter(
                    agent.rateLimit.name || agent.id,
                    agent.rateLimit.rate_limit.time,
                    agent.rateLimit.rate_limit.limit,
                    1
                )

                if (!limit.status) {
                    res.status(429).json({
                        message: 'Rate limit exceeded.',
                        retryAfter: limit.retryAfter,
                    })
                    return;
                }
            }

            const stream = req.headers['stream'] || false;
            const requestValidationResult = requestValidators.agents(req)

            if (requestValidationResult.error) {
                res.status(requestValidationResult.code || 500).json({ detail: `${requestValidationResult.message}` });
                return;
            }

            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            // todo add authentication based on thread id to guarantee privacy
            // todo validate req.body data structure
            if (!!stream) {
                const chatClient = await agent.chat(agentInstance.id)
                if (!chatClient) {
                    res.status(500).json({
                        message: "Agent instantiation not successful."
                    })
                    return;
                }
                const { textStream } = await chatClient.stream(req.body.messages, {
                    threadId: `${req.body.threadId}`, // conversation id
                    resourceId: `${req.body.resourceId}`, // user id
                    ...(agent.outputSchema && { output: agent.outputSchema }),
                    maxRetries: 2, // todo make part of ExuluAgent class
                    maxSteps: 5, // todo make part of ExuluAgent class
                    onError: error => console.error("[EXULU] chat stream error.", error),
                    onFinish: ({ response, usage }) => console.info(
                        "[EXULU] chat stream finished.",
                        usage
                    )
                })

                // Returns a response that can be used by the "useChat" hook
                // on the client side from the vercel "ai" SDK.
                for await (const delta of textStream) {
                    // Client's useChat is configured to use streamProtocol 'text', so we can 
                    // send text deltas directly without SSE framing.
                    res.write(`data: ${delta}\n\n`);
                }
                res.end();
                return

            } else {
                const response = await agent.chat.generate(req.body.messages, {
                    resourceId: `${authenticationResult.user.id}`,
                    output: agent.outputSchema,
                    threadId: `${req.body.threadId}`, // conversation id
                    maxRetries: 2, // todo make part of ExuluAgent class
                    maxSteps: 5 // todo make part of ExuluAgent class
                })

                res.status(200).json(response)
                return;

            }
        })
    })



    workflows.forEach(workflow => {
        routeLogs.push({
            route: workflow.slug,
            method: "POST",
            note: `Execute workflow ${workflow.name}`
        });
        app.post(`${workflow.slug}`, async (req: Request, res: Response) => {

            if (!workflow.queue) {
                res.status(500).json({ detail: 'No queue set for workflow.' });
                return;
            }

            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            const requestValidationResult = requestValidators.workflows(req)

            if (requestValidationResult.error) {
                res.status(requestValidationResult.code || 500).json({ detail: `${requestValidationResult.message}` });
                return;
            }

            const inputs = await preprocessInputs(req.body.inputs);

            if (workflow.queue) {

                const job = await bullmqDecorator({
                    label: `Job running '${workflow.name}' for '${req.body.label}'`,
                    agent: req.body.agent,
                    workflow: workflow.id,
                    type: "workflow",
                    inputs,
                    session: req.body.session,
                    queue: workflow.queue,
                    user: authenticationResult.user.id
                })

                res.status(200).json({
                    "job": {
                        "status": "waiting",
                        "name": job.name,
                        "queue": workflow.queue.name,
                        "redisId": job.redis,
                        "jobId": job.id
                    },
                    "output": {}
                });
                return;
            }

            const { runId, start, watch } = workflow.workflow.createRun();

            console.log("[EXULU] running workflow with inputs.", inputs)

            const output = await start({
                triggerData: {
                    ...inputs,
                    user: authenticationResult.user.id
                }
            });

            const failedSteps = Object.entries(output.results)
                .filter(([_, step]) => step.status === "failed")
                .map(([id, step]: any) => `${id}: ${step.error}`);

            if (failedSteps.length > 0) {
                const message = `Workflow has failed steps: ${failedSteps.join('\n - ')}`;
                throw new Error(message)
            }
            res.status(200).json({
                "job": {},
                "output": output
            });
            return;
            // todo batch mode
        });
    })

    await createUppyRoutes(app)

    // Output all routes in table format at the end
    console.log("Routes:")
    console.table(routeLogs);
}

const preprocessInputs = async (data: any) => {
    for (const key in data) {
        if (key.includes("exulu_file_")) {
            const url = await getPresignedFileUrl(data[key]);
            const newKey = key.replace("exulu_file_", "");
            data[newKey] = url;
            delete data[key];
        } else if (Array.isArray(data[key])) {
            for (let i = 0; i < data[key].length; i++) {
                if (typeof data[key][i] === "object") {
                    await preprocessInputs(data[key][i]);
                }
            }
        } else if (typeof data[key] === "object") {
            await preprocessInputs(data[key]);
        }
    }
    return data;
};

const getPresignedFileUrl = async (key: string) => {
    if (!process.env.NEXT_PUBLIC_UPLOAD_URL) {
        throw new Error("Missing process.env.NEXT_PUBLIC_UPLOAD_URL")
    }
    if (!process.env.INTERNAL_SECRET) {
        throw new Error("Missing process.env.NEXT_PUBLIC_UPLOAD_URL")
    }
    console.log(`[EXULU] fetching presigned url for file with key: ${key}`)
    let url = `${process.env.NEXT_PUBLIC_UPLOAD_URL}/s3/download?key=${key}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Internal-Key": process.env.INTERNAL_SECRET,
        },
    });
    const json = await response.json()
    if (!json.url) {
        throw new Error(`Could not generate presigned url for file with key: ${key}`)
    }
    console.log(`[EXULU] presigned url for file with key: ${key}, generated: ${json.url}`)
    return json.url;
};