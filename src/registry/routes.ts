import { type Express, type Request, type Response } from "express";
import { type ExuluAgent, ExuluContext, ExuluEmbedder, ExuluLogger, type ExuluTool, ExuluWorkflow, type SourceDocument, updateStatistic } from "./classes.ts";
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
import * as Papa from 'papaparse';
import cors from 'cors';
import 'reflect-metadata'
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types.ts";
import { createSDL } from "./utils/graphql.ts";
import type { Knex } from "knex";
import { expressMiddleware } from '@as-integrations/express5';
import { agentsSchema, evalResultsSchema, jobsSchema, agentSessionsSchema, agentMessagesSchema, rolesSchema, usersSchema, workflowSchema } from "../postgres/core-schema.ts";
import { createUppyRoutes } from "./uppy.ts";
import { redisServer } from "../bullmq/server.ts";
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache';
import bodyParser from 'body-parser';
import CryptoJS from 'crypto-js';
import { CLAUDE_MESSAGES } from "./utils/claude-messages.ts";

export const REQUEST_SIZE_LIMIT = '50mb';

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
        type: ExuluFieldTypes | "date" | "json" | "uuid",
        index?: boolean,
        required?: boolean,
        default?: any,
    }[]
}

export const createExpressRoutes = async (
    app: Express,
    agents: ExuluAgent[],
    tools: ExuluTool[],
    workflows: ExuluWorkflow[],
    contexts: ExuluContext[],
): Promise<Express> => {
    const routeLogs: Array<{ route: string; method: string; note?: string }> = [];
    // Add route logs instead of individual console.logs

    // todo make this more secure / configurable
    var corsOptions = {
        origin: '*',
        exposedHeaders: "*",
        allowedHeaders: "*",
        optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
    }

    // important to set the limit here, otherwise the proxy will 
    // fail for large requests such as those from Claude Code
    app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));
    app.use(cors(corsOptions));
    app.use(bodyParser.urlencoded({ extended: true, limit: REQUEST_SIZE_LIMIT }))
    app.use(bodyParser.json({ limit: REQUEST_SIZE_LIMIT }))

    console.log(`
    ███████╗██╗  ██╗██╗   ██╗██╗      ██╗   ██╗
    ██╔════╝╚██╗██╔╝██║   ██║██║      ██║   ██║
    █████╗   ╚███╔╝ ██║   ██║██║      ██║   ██║
    ██╔══╝   ██╔██╗ ██║   ██║██║      ██║   ██║
    ███████╗██╔╝ ██╗╚██████╔╝███████╗╚██████╔╝
    ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝ ╚═════╝ 
    Intelligence Management Platform

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

    if (redisServer.host?.length && redisServer.port?.length) {
        await createRecurringJobs();
    } else {
        console.log("===========================", "[EXULU] no redis server configured, not setting up recurring jobs.", "===========================")
    }

    const schema = createSDL([usersSchema, rolesSchema, agentsSchema, jobsSchema, workflowSchema, evalResultsSchema, agentSessionsSchema, agentMessagesSchema]);

    interface GraphqlContext {
        db: Knex;
        req: Request;
    }

    console.log("[EXULU] graphql server")
    const server = new ApolloServer<GraphqlContext>({
        cache: new InMemoryLRUCache(),
        schema,
        introspection: true
    });

    // Note you must call `start()` on the `ApolloServer`
    // instance before passing the instance to `expressMiddleware`
    console.log("[EXULU] starting graphql server")
    await server.start();

    console.log("[EXULU] graphql server started")
    app.use(
        "/graphql",
        cors(corsOptions),
        express.json({ limit: REQUEST_SIZE_LIMIT }),
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

    app.get(`/providers`, async (req: Request, res: Response) => {
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }
        res.status(200).json(agents)
    })

    app.get(`/agents`, async (req: Request, res: Response) => {
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }
        const { db } = await postgresClient();
        const agentsFromDb = await db.from("agents").select("*");
        res.status(200).json( agentsFromDb.map((agent: any) => {
            const backend = agents.find(a => a.id === agent.backend);
            if (!backend) {
                return null;
            }
            return {
                name: agent.name,
                id: agent.id,
                description: agent.description,
                provider: backend?.model?.provider,
                model: backend?.model?.modelId,
                active: agent.active,
                public: agent.public,
                type: agent.type,
                slug: backend?.slug,
                rateLimit: backend?.rateLimit,
                streaming: backend?.streaming,
                capabilities: backend?.capabilities,
                // todo add contexts
                availableTools: tools,
                enabledTools: agent.tools
            }
        }).filter(Boolean))
    })

    app.get(`/agents/:id`, async (req: Request, res: Response) => {
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }
        const { db } = await postgresClient();
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

        res.status(200).json({
            ...{
                name: agent.name,
                id: agent.id,
                description: agent.description,
                provider: backend?.model?.provider,
                model: backend?.model?.modelId,
                active: agent.active,
                public: agent.public,
                type: agent.type,
                slug: backend?.slug,
                rateLimit: backend?.rateLimit,
                streaming: backend?.streaming,
                capabilities: backend?.capabilities,
                // todo add contexts
                availableTools: tools,
                enabledTools: agent.tools
            }
        })
    })

    app.get("/tools", async (req: Request, res: Response) => {
        // todo add auth

        res.status(200).json(tools.map(tool => ({
            id: tool.id,
            name: tool.name,
            description: tool.description,
            type: tool.type || "tool",
            inputSchema: tool.inputSchema ? zerialize(tool.inputSchema as any) : null,
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
    }): Promise<{} | null> => {
        if (!contextId) {
            throw new Error("Missing context in request.")
        }

        if (!id && !external_id) {
            throw new Error("Missing id or external_id in request.")
        }
        // todo add auth
        const { db } = await postgresClient();
        const context = contexts.find(context => context.id === contextId)
        if (!context) {
            throw new Error("Context not found in registry.")
        }

        const exists = await context.tableExists();

        if (!exists) {
            throw new Error("Table with name " + context.getTableName() + " does not exist.")
        }

        const query = db.from(context.getTableName())
            .select("id");

        if (id) {
            query.where({ id })
        }
        if (external_id) {
            query.where({ external_id })
        }

        const item = await query.first();

        if (!item) {
            return null;
        }

        const chunks = await db.from(context.getChunksTableName())
            .where({ source: item.id })
            .select("id");

        if (chunks.length > 0) {
            // delete chunks first
            await db.from(context.getChunksTableName())
                .where({ source: item.id })
                .delete();
        }

        const mutation = db.from(context.getTableName())
            .where({ id: item.id })
            .delete()
            .returning("id");

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
        if (!result) {
            res.status(200).json({
                message: "Item not found."
            });
            return;
        }
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
        if (!result) {
            res.status(200).json({
                message: "Item not found."
            });
            return;
        }
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
        const context = contexts.find(context => context.id === req.params.context)

        if (!context) {
            res.status(400).json({
                message: "Context not found in registry."
            })
            return;
        }

        const itemsTableExists = await context.tableExists();

        if (!itemsTableExists) {
            await context.createItemsTable()
        }

        const chunksTableExists = await db.schema.hasTable(context.getChunksTableName());
        if (!chunksTableExists) {
            await context.createChunksTable();
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

        const context = contexts.find(context => context.id === req.params.context)
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
            console.log("[EXULU] post items")
            if (!req.params.context) {
                res.status(400).json({
                    message: "Missing context in request."
                })
                return;
            }

            if (!req.body) {
                res.status(400).json({
                    message: "Missing body in request."
                })
                return;
            }

            if (!req.body.name) {
                res.status(400).json({
                    message: "Missing in body of request."
                })
                return;
            }

            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            const context = contexts.find(context => context.id === req.params.context)

            if (!context) {
                console.error("[EXULU] context not found in registry.", req.params.context)
                res.status(400).json({
                    message: "Context not found in registry."
                })
                return;
            }

            console.log("[EXULU] context", context)

            const exists = await context.tableExists();

            if (!exists) {
                console.log("[EXULU] context table does not exist, creating it.")
                await context.createItemsTable();
            }

            console.log("[EXULU] inserting item", req.body)
            const result = await context.insertItem(authenticationResult.user.id, req.body, !!req.body.upsert);

            console.log("[EXULU] result", result)

            res.status(200).json({
                message: "Item created successfully.",
                id: result
            });
        } catch (error: any) {
            console.error("[EXULU] error upserting item", error)
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
        let sort = req.query.sort ? req.query.sort as string : "created_at";
        let order = req.query.order ? req.query.order as string : "desc";

        if (sort && !["created_at", "embeddings_updated_at"].includes(sort)) {
            res.status(400).json({
                message: "Invalid sort field, must be one of: createdAt, embeddings_updated_at"
            })
            return;
        }

        if (order && !["desc", "asc"].includes(order)) {
            res.status(400).json({
                message: "Invalid order, must be one of: desc, asc"
            })
            return;
        }

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const context = contexts.find(context => context.id === req.params.context)
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
            sort: sort as "created_at" | "embeddings_updated_at",
            order: order as "desc" | "asc",
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
        const context = contexts.find(context => context.id === req.params.context)
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

    console.log("[EXULU] delete embedding by id")
    app.delete(`items/:context/:id`, async (req: Request, res: Response) => {
        const id = req.params.id;
        if (!req.params.context) {
            res.status(400).json({
                message: "Missing context in request."
            })
            return;
        }
        const context = contexts.find(context => context.id === req.params.context)
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

    // Ping route that can be used to check if the request
    // is authenticated and the server is running.
    app.get("/ping", async (req: Request, res: Response) => {
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(200).json({
                authenticated: false
            })
            return;
        }
        res.status(200).json({
            authenticated: true
        })
    })

    console.log("[EXULU] statistics timeseries")
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

        const query = db.from("statistics").select("*");

        query.where("name", "count")
        query.andWhere("type", type)
        query.andWhere("createdAt", ">=", from)
        query.andWhere("createdAt", "<=", to)

        const results: any = await query;

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

    console.log("[EXULU] statistics totals")
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
                .sum("total as total");
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

    console.log("[EXULU] contexts statistics")
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

    console.log("[EXULU] context by id")
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
        const context = contexts.find(context => context.id === id);
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
                configuration: context.configuration,
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

    console.log("[EXULU] items export by context")
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

        const context = contexts.find(context => context.id === req.params.context);
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

    console.log("[EXULU] contexts get list")
    app.get(`/contexts`, async (req: Request, res: Response) => {

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

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

    console.log("[EXULU] workflows get list")
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
            inputSchema: workflow.steps[0]?.inputSchema ? zerialize(workflow.steps[0].inputSchema as any) : null
        })))
    })

    console.log("[EXULU] workflow by id")
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
            inputSchema: workflow.steps[0]?.inputSchema ? zerialize(workflow.steps[0].inputSchema as any) : null,
            workflow: undefined
        })
    })

    console.log("[EXULU] contexts")
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

                        /* const { context: id } = req.params;
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

                        const jobs = await Promise.all(promises); */

                        res.status(200).json([]);
                        return;
                    })
                }
            })
        })
    })

    console.log("[EXULU] agents")
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
                console.log("[EXULU] rate limiting agent.", agent.rateLimit)
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

            console.log("[EXULU] agent tools", agentInstance.tools)

            const enabledTools = agentInstance.tools.map(tool => tools.find(({ id }) => id === tool)).filter(Boolean)

            console.log("[EXULU] enabled tools", enabledTools)

            // todo add authentication based on thread id to guarantee privacy
            // todo validate req.body data structure
            if (!!stream) {
                const result = agent.generateStream({
                    messages: req.body.messages,
                    tools: enabledTools,
                    statistics: {
                        label: agent.name,
                        trigger: "agent"
                    }
                })
                // Returns a response that can be used by the "useChat" hook
                // on the client side from the vercel "ai" SDK.
                result.pipeDataStreamToResponse(res);
                return;
            } else {
                const response = await agent.generateSync({
                    messages: req.body.messages,
                    tools: enabledTools.map(),
                    statistics: {
                        label: agent.name,
                        trigger: "agent"
                    }
                })
                res.status(200).json(response)
                return;

            }
        })
    })

    console.log("[EXULU] workflows")
    workflows.forEach(workflow => {
        routeLogs.push({
            route: workflow.slug,
            method: "POST",
            note: `Execute workflow ${workflow.name}`
        });
        app.post(`${workflow.slug}`, async (req: Request, res: Response) => {

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
                    steps: workflow.steps?.length || 0,
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

            console.log("[EXULU] running workflow with inputs.", inputs)
            const logger = new ExuluLogger()

            const result = await workflow.start({
                inputs,
                user: authenticationResult.user.id,
                logger,
                session: req.body.session,
                agent: req.body.agent,
                label: req.body.label
            });

            res.status(200).json({
                "job": {},
                "output": result
            });
            return;
            // todo batch mode
        });
    })

    if (
        process.env.COMPANION_S3_REGION &&
        process.env.COMPANION_S3_KEY &&
        process.env.COMPANION_S3_SECRET
    ) {
        await createUppyRoutes(app)
    } else {
        console.log("[EXULU] skipping uppy file upload routes, because no S3 compatible region, key or secret is set in the environment.")
    }

    // Output all routes in table format at the end
    console.log("Routes:")
    console.table(routeLogs);

    const TARGET_API = 'https://api.anthropic.com';

    // This route basically passes the request 1:1 to the Anthropic API, but we can
    // inject tools into the request body, publish data to audit logs and implement
    // custom authentication logic from the IMP UI.
    app.use('/gateway/anthropic/:id', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {

        const path = req.url;
        const url = `${TARGET_API}${path}`;

        console.log('[PROXY] Manual proxy to:', url);
        console.log('[PROXY] Method:', req.method);
        console.log('[PROXY] Headers:', Object.keys(req.headers));
        console.log('[PROXY] Request body length:', req.body ? req.body.length : 0);
        console.log('[PROXY] Request model name:', req.body.model);
        console.log('[PROXY] Request stream:', req.body.stream);
        console.log('[PROXY] Request messages:', req.body.messages?.length);

        try {

            console.log('[PROXY] Request body tools array length:', req.body.tools?.length);

            // TODO
            /* We can create a special config page for Claude code on the IMP UI which 
               lists all Tool Definitions and allows switching them on / off for Claude 
               Code. In the proxy, we then inject these tools into the Claude Code Request, 
               and if the last part of the response includes a message with content[index]
               .type === tool_use and name === the name of the tool we defined, we call our 
               tool, and return the response, inject it into the content array and continue it.
               This way we can use the tools in Claude Code, and we can use the tools in the IMP UI.
            */
            // Todo deal with auth, allow tagging API keys in Exulu so different users
            //   can use different API keys based on roles etc...

            if (!req.body.tools) {
                req.body.tools = [];
            }

            // Authenticate the user, and exchange the user token for an anthropic token.
            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            console.log("[EXULU] authentication result", authenticationResult)

            const { db } = await postgresClient();
            // Todo check if user has access to agent via their role
            const agent = await db.from("agents").where({
                id: req.params.id
            }).first();

            if (!agent) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
\x1b[41m -- Agent ${req.params.id} not found or you do not have access to it. --
\x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            console.log("[EXULU] agent", agent?.name)

            if (!process.env.NEXTAUTH_SECRET) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_nextauth_secret);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (!authenticationResult.user?.anthropic_token) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.not_enabled);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // Decrypt the anthropic token.
            const bytes = CryptoJS.AES.decrypt(authenticationResult.user?.anthropic_token, process.env.NEXTAUTH_SECRET);
            const anthropicApiKey = bytes.toString(CryptoJS.enc.Utf8);

            // todo get enabled tools from agent and add them to the request body
            // todo build logic to execute tool calls 

            // Set the anthropic api key in the headers.
            const headers = {
                'x-api-key': anthropicApiKey,
                'anthropic-version': '2023-06-01',
                'content-type': req.headers['content-type'] || 'application/json'
            };

            // Copy relevant headers
            if (req.headers['accept']) headers['accept'] = req.headers['accept'];
            if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

            console.log("[EXULU] anthropic api key", anthropicApiKey)

            // Send the request to the anthropic api.
            const response = await fetch(url, {
                method: req.method,
                headers: headers,
                body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
            });

            console.log('[PROXY] Response:', response);
            console.log('[PROXY] Response:', response.body);

            await updateStatistic({
                name: "count",
                label: "Claude Code",
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: "claude-code",
                count: 1
            })

            // Copy response headers
            response.headers.forEach((value, key) => {
                res.setHeader(key, value);
            });

            res.status(response.status);

            // Handle streaming vs non-streaming
            const isStreaming = response.headers.get('content-type')?.includes('text/event-stream')

            if (isStreaming && !response?.body) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_body);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (isStreaming) {
                const reader = response.body!.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    console.log('[PROXY] Chunk:', chunk);
                    res.write(chunk);
                }
                res.end();
                return;
            }

            const data = await response.arrayBuffer();
            console.log('[PROXY] Data:', data);
            res.end(Buffer.from(data));

        } catch (error: any) {
            console.error('[PROXY] Manual proxy error:', error);
            if (!res.headersSent) {
                if (error?.message === "Invalid token") {
                    res.status(500).json({ error: "Authentication error, please check your IMP token and try again." });
                } else {
                    res.status(500).json({ error: error.message });
                }
            }
        }
    });

    return app;
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

const createCustomAnthropicStreamingMessage = (message: string) => {
    const responseData = {
        type: "message",
        content: [
            {
                type: "text",
                text: message
            }
        ]
    };
    const jsonString = JSON.stringify(responseData);
    const arrayBuffer = new TextEncoder().encode(jsonString).buffer;
    return arrayBuffer;
}