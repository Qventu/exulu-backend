import { type Express, type Request, type Response } from "express";
import { type ExuluAgent, ExuluContext, type ExuluTool, updateStatistic } from "./classes.ts";
import { rateLimiter } from "./rate-limiter.ts";
import { requestValidators } from "./route-validators";
import { queues } from "../bullmq/queues.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import { postgresClient } from "../postgres/client.ts";
import express from 'express';
import { ApolloServer } from '@apollo/server';
import cors from 'cors';
import 'reflect-metadata'
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types.ts";
import { createSDL, applyAccessControl, RBACResolver } from "./utils/graphql.ts";
import type { Knex } from "knex";
import { expressMiddleware } from '@as-integrations/express5';
import { coreSchemas } from "../postgres/core-schema.ts";
import { createUppyRoutes } from "./uppy.ts";
import { redisServer } from "../bullmq/server.ts";
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache';
import bodyParser from 'body-parser';
import CryptoJS from 'crypto-js';
import { CLAUDE_MESSAGES } from "./utils/claude-messages.ts";
import OpenAI from "openai";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { type Tracer } from "@opentelemetry/api";
import type { ExuluConfig } from "./index.ts";
import type { Logger } from "winston";
import type { Agent } from "@EXULU_TYPES/models/agent.ts"

export const REQUEST_SIZE_LIMIT = '50mb';

export const global_queues = {
    logs_cleaner: "logs-cleaner"
}

const {
    agentsSchema,
    projectsSchema,
    evalResultsSchema,
    jobsSchema,
    agentSessionsSchema,
    agentMessagesSchema,
    rolesSchema,
    usersSchema,
    variablesSchema,
    workflowTemplatesSchema,
    rbacSchema,
    statisticsSchema
} = coreSchemas.get();

const createRecurringJobs = async () => {

    console.log("[EXULU] creating recurring jobs.")
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

    return queue;
}

export type ExuluTableDefinition = {
    type?: "jobs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "items" | "projects",
    id?: string,
    name: {
        plural: "jobs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "projects",
        singular: "job" | "agent_session" | "agent_message" | "eval_result" | "workflow_template" | "tracking" | "rbac" | "user" | "variable" | "role" | "agent" | "project",
    },
    fields: {
        name: string,
        type: ExuluFieldTypes | "date" | "json" | "uuid" | "enum",
        enumValues?: string[],
        index?: boolean,
        required?: boolean,
        default?: any,
        unique?: boolean,
    }[],
    RBAC?: boolean,
    graphql?: boolean,
}

export const createExpressRoutes = async (
    app: Express,
    logger: Logger,
    agents: ExuluAgent[],
    tools: ExuluTool[],
    contexts: ExuluContext[],
    config?: ExuluConfig,
    tracer?: Tracer
): Promise<Express> => {

    console.log("============= agents =============", agents?.length)

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

    if (redisServer.host?.length && redisServer.port?.length) {
        await createRecurringJobs();
    } else {
        console.log("===========================", "[EXULU] no redis server configured, not setting up recurring jobs.", "===========================")
    }

    const schema = createSDL([
        usersSchema(),
        rolesSchema(),
        agentsSchema(),
        projectsSchema(),
        jobsSchema(),
        evalResultsSchema(),
        agentSessionsSchema(),
        agentMessagesSchema(),
        variablesSchema(),
        workflowTemplatesSchema(),
        statisticsSchema(),
        rbacSchema()
    ], contexts, agents, tools);

    interface GraphqlContext {
        db: Knex;
        req: Request;
    }

    const server = new ApolloServer<GraphqlContext>({
        cache: new InMemoryLRUCache(),
        schema,
        introspection: true
    });

    // Note you must call `start()` on the `ApolloServer`
    // instance before passing the instance to `expressMiddleware`

    await server.start();

    app.use(
        "/graphql",
        cors(corsOptions),
        express.json({ limit: REQUEST_SIZE_LIMIT }),
        expressMiddleware(server, {
            context: async ({ req }) => {
                logger.info("================")
                logger.info({
                    message: 'Incoming Request',
                    method: req.method,
                    path: req.path,
                    requestId: 'req-' + Date.now(),
                    ipAddress: req.ip,
                    userAgent: req.get('User-Agent'),
                });
                logger.info("================")
                const authenticationResult = await requestValidators.authenticate(req);
                if (!authenticationResult.user?.id) {
                    throw new Error(authenticationResult.message);
                }
                const { db } = await postgresClient();
                return {
                    req,
                    db,
                    user: authenticationResult.user
                };
            },
        }),
    );

    app.post("/generate/agent/image", async (req: Request, res: Response) => {
        console.log("[EXULU] generate/agent/image", req.body)
        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const { name, description, style } = req.body;
        if (!name || !description) {
            res.status(400).json({
                message: "Missing name or description in request."
            })
            return;
        }

        const { db } = await postgresClient();

        // Look up the variable from the variables table
        const variable = await db.from("variables").where({ name: "OPENAI_IMAGE_GENERATION_API_KEY" }).first();
        if (!variable) {
            res.status(400).json({
                message: "Provider API key variable not found."
            })
            return;
        }

        // Get the API key from the variable (decrypt if encrypted)
        let providerApiKey = variable.value;

        if (!variable.encrypted) {
            res.status(400).json({
                message: "Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys."
            })
            return;
        }

        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            providerApiKey = bytes.toString(CryptoJS.enc.Utf8);
        }

        const openai = new OpenAI({
            apiKey: providerApiKey
        });

        let style_reference = "";
        if (style === "origami") {
            style_reference = "minimalistic origami-style, futuristic robot, portrait, focus on face."
        } else if (style === "anime") {
            style_reference = "minimalistic, make it in the style of a felt puppet, futuristic robot, portrait, focus on face."
        } else if (style === "japanese_anime") {
            style_reference = "minimalistic, make it in the style of japanese anime, futuristic robot, portrait, focus on face."
        } else if (style === "vaporwave") {
            style_reference = "minimalistic, make it in the style of a vaporwave album cover, futuristic robot, portrait, focus on face."
        } else if (style === "lego") {
            style_reference = "minimalistic, make it in the style of LEGO minifigures, futuristic robot, portrait, focus on face."
        } else if (style === "paper_cut") {
            style_reference = "minimalistic, make it in the style of Paper-cut style portrait with color layers, futuristic robot, portrait, focus on face."
        } else if (style === "felt_puppet") {
            style_reference = "minimalistic, make it in the style of a felt puppet, futuristic robot, portrait, focus on face."
        } else if (style === "app_icon") {
            style_reference = "A playful and modern app icon design of a robot, minimal flat vector style, glossy highlights, soft shadows, centered composition, high contrast, vibrant colors, rounded corners, on a transparent background, icon-friendly, no text, no details outside the frame, size is 1024x1024."
        } else if (style === "pixel_art") {
            style_reference = "A pixel art style of a robot, minimal flat vector style, glossy highlights, soft shadows, centered composition, high contrast, vibrant colors, rounded corners, on a transparent background, icon-friendly, no text, no details outside the frame, size is 1024x1024."
        } else if (style === "isometric") {
            style_reference = "3D isometric icon of a robot, centered composition, on a transparent background, no text, no details outside the frame, size is 1024x1024."
        } else {
            style_reference = "A minimalist 3D, robot, portrait, focus on face, floating in space, low-poly design with pastel colors."
        }

        const prompt = `
        A digital portrait of ${name}, visualized as a futuristic robot.  
The robot’s design reflects '${description}', with props, tools, or symbolic objects that represent its expertise or area of work.  
Example: if the agent is a financial analyst, it may hold a stack of papers; if it’s a creative strategist it may be painting on a canvas.  
Style: ${style_reference}.  
The portrait should have a clean background.  
Framing: bust portrait, centered.  
Mood: friendly and intelligent.  
            `;

        const result = await openai.images.generate({
            model: "gpt-image-1",
            prompt,
        });

        // Save the image to a file
        const image_base64 = result.data?.[0]?.b64_json;

        if (!image_base64) {
            res.status(500).json({
                message: "Failed to generate image."
            })
            return;
        }

        const image_bytes = Buffer.from(image_base64, "base64");
        const uuid = randomUUID();
        // check if public directory exists
        if (!fs.existsSync("public")) {
            fs.mkdirSync("public");
        }
        fs.writeFileSync(`public/${uuid}.png`, image_bytes);
        // update the agent with the image
        res.status(200).json({
            message: "Image generated successfully.",
            image: `${process.env.BACKEND}/${uuid}.png`
        });
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

    agents.forEach(agent => {
        const slug = agent.slug as string;
        if (!slug) return;

        app.post(slug + "/:instance", async (req: Request, res: Response) => {

            const instance = req.params.instance;
            if (!instance) {
                res.status(400).json({
                    message: "Missing instance in request."
                })
                return;
            }

            const { db } = await postgresClient();
            const agentInstance: Agent = await db.from("agents").where({
                id: instance
            }).first();
            const agentRbac = await RBACResolver(db, "agent", agentInstance.id, agentInstance.rights_mode || "private");
            agentInstance.RBAC = agentRbac;

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
            const headers: {
                stream: boolean,
                user: string | null,
                session: string | null,
            } = {
                stream: req.headers['stream'] as string === "true" || false,
                user: req.headers['user'] as string || null,
                session: req.headers['session'] as string || null,
            }

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

            const user = authenticationResult.user;

            // Check access rights
            const agentIsPublic = agentInstance.rights_mode === "public";
            const agentByUsers = agentInstance.rights_mode === "users";
            const agentByRoles = agentInstance.rights_mode === "roles";
            const isAgentCreator = agentInstance.created_by === user.id;
            const isAdmin = user.super_admin;
            const isApi = user.type === "api";

            let hasAccessToAgent: "read" | "write" | "none" = "none";

            if (agentIsPublic || isAgentCreator || isAdmin || isApi) {
                hasAccessToAgent = "write"
            }

            if (agentByUsers) {
                hasAccessToAgent = agentInstance.RBAC?.users?.find(x => x.id === user.id)?.rights || "none";
                if (!hasAccessToAgent || hasAccessToAgent === "none" || hasAccessToAgent === "read") {
                    res.status(410).json({
                        message: `Your current user ${user.id} does not have access to this agent.`
                    })
                    return;
                }
            }

            if (agentByRoles) {
                hasAccessToAgent = agentInstance.RBAC?.roles?.find(x => x.id === user.role?.id)?.rights || "none"
                if (!hasAccessToAgent || hasAccessToAgent === "none" || hasAccessToAgent === "read") {
                    res.status(410).json({
                        message: `Your current role ${user.role?.name} does not have access to this agent.`
                    })
                    return;
                }
            }

            let hasAccessToSession: "read" | "write" | "none" = "none";;

            if (headers.session) {
                // Check session RBAC
                const session = await db.from("agents").where({
                    id: instance
                }).first();

                const sessionIsPublic = agentInstance.rights_mode === "public";
                const sessionByUsers = agentInstance.rights_mode === "users";
                const sessionByRoles = agentInstance.rights_mode === "roles";
                const isSessionCreator = agentInstance.created_by === user.id;
                const isAdmin = user.super_admin;
                const isApi = user.type === "api";

                if (sessionIsPublic || isSessionCreator || isAdmin || isApi) {
                    hasAccessToSession = "write"
                }

                if (sessionByUsers) {
                    hasAccessToSession = session.RBAC?.users?.find(x => x.id === user.id)?.rights || "none";
                    if (!hasAccessToSession || hasAccessToSession === "none" || hasAccessToSession === "read") {
                        res.status(410).json({
                            message: `Your current user ${user.id} does not have access to this session.`
                        })
                        return;
                    }
                }
                if (sessionByRoles) {
                    hasAccessToSession = session.RBAC?.roles?.find(x => x.id === user.role?.id)?.rights || "none"
                    if (!hasAccessToSession || hasAccessToSession === "none" || hasAccessToSession === "read") {
                        res.status(410).json({
                            message: `Your current role ${user.role?.name} does not have access to this session.`
                        })
                        return;
                    }
                }
            }

            if (!hasAccessToAgent || hasAccessToAgent === "none") {
                res.status(410).json({
                    message: "You don't have access to this agent."
                })
                return;
            }


            if (!hasAccessToSession || hasAccessToSession === "none") {
                res.status(410).json({
                    message: "You don't have access to this session."
                })
                return;
            }

            if (headers.session && !hasAccessToSession) {
                res.status(410).json({
                    message: "You don't have access to this session."
                })
                return;
            }

            if (
                user.type !== "api" &&
                !user.super_admin &&
                req.body.resourceId !== user.id
            ) {
                res.status(400).json({
                    message: "The provided user id in the resourceId field is not the same as the authenticated user. Only super admins and API users can impersonate other users."
                })
                return;
            }

            console.log("[EXULU] agent tools", agentInstance.tools)

            let enabledTools: ExuluTool[] = agentInstance.tools ? agentInstance.tools.map(
                ({ config, toolId }) => tools.find(({ id }) => id === toolId)
            ).filter(Boolean) as ExuluTool[] : [];

            console.log("[EXULU] available tools", enabledTools?.length)

            // Message specific tools, the user can overwrite to disable specific tools
            // for individual messages.
            const disabledTools = req.body.disabledTools ? req.body.disabledTools : [];
            console.log("[EXULU] disabled tools", disabledTools?.length)
            enabledTools = enabledTools.filter(tool => !disabledTools.includes(tool.id));

            console.log("[EXULU] enabled tools", enabledTools?.length)

            // Get the variable name from user's anthropic_token field
            const variableName = agentInstance.providerApiKey;

            // Look up the variable from the variables table
            const variable = await db.from("variables").where({ name: variableName }).first();
            if (!variable) {
                res.status(400).json({
                    message: "Provider API key variable not found."
                })
                return;
            }

            // Get the API key from the variable (decrypt if encrypted)
            let providerApiKey = variable.value;

            if (!variable.encrypted) {
                res.status(400).json({
                    message: "Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys."
                })
                return;
            }

            if (variable.encrypted) {
                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                providerApiKey = bytes.toString(CryptoJS.enc.Utf8);
            }

            // todo add authentication based on thread id to guarantee privacy
            // todo validate req.body data structure
            if (!!headers.stream) {
                await agent.generateStream({
                    express: {
                        res,
                        req,
                    },
                    user: user?.id,
                    role: user?.role?.id,
                    session: headers.session as string,
                    message: req.body.message,
                    tools: enabledTools,
                    providerApiKey,
                    toolConfigs: agentInstance.tools,
                    statistics: {
                        label: agent.name,
                        trigger: "agent"
                    }
                })
                // Returns a response that can be used by the "useChat" hook
                // on the client side from the vercel "ai" SDK.

                return;
            } else {
                const response = await agent.generateSync({
                    user: user?.id,
                    session: headers.session as string,
                    role: user?.role?.id,
                    message: req.body.message,
                    tools: enabledTools,
                    providerApiKey,
                    toolConfigs: agentInstance.tools,
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

    if (
        config?.fileUploads?.s3region &&
        config?.fileUploads?.s3key &&
        config?.fileUploads?.s3secret &&
        config?.fileUploads?.s3Bucket
    ) {
        await createUppyRoutes(app, config)
    } else {
        console.log("[EXULU] skipping uppy file upload routes, because no S3 compatible region, key or secret is set in ExuluApp instance.")
    }

    const TARGET_API = 'https://api.anthropic.com';

    // This route basically passes the request 1:1 to the Anthropic API, but we can
    // inject tools into the request body, publish data to audit logs and implement
    // custom authentication logic from the IMP UI.
    app.use('/gateway/anthropic/:id', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {
        const path = req.url;
        const url = `${TARGET_API}${path}`;
        // const fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
        // console.log('[PROXY] Manual proxy to:', url);
        // console.log('[PROXY] Path:', path);
        // console.log('[PROXY] Full URL:', fullUrl);
        // console.log('[PROXY] Method:', req.method);
        // console.log('[PROXY] Headers:', Object.keys(req.headers));
        // console.log('[PROXY] Request body length:', req.body ? req.body.length : 0);
        // console.log('[PROXY] Request model name:', req.body.model);
        // console.log('[PROXY] Request stream:', req.body.stream);
        // console.log('[PROXY] Request messages:', req.body.messages?.length);
        // console.log('[PROXY] Request id:', req.params.id);

        try {

            // console.log('[PROXY] Request body tools array length:', req.body.tools?.length);

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
                console.log("[EXULU] failed authentication result", authenticationResult)
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            const { db } = await postgresClient();

            let query = db('agents');
            query.select("*");
            query = applyAccessControl(agentsSchema(), authenticationResult.user, query);
            query.where({ id: req.params.id });
            const agent = await query.first();

            if (!agent) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
\x1b[41m -- Agent ${req.params.id} not found or you do not have access to it. --
\x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            console.log("[EXULU] anthropic proxy called for agent:", agent?.name)

            if (!process.env.NEXTAUTH_SECRET) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_nextauth_secret);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (!agent.providerApiKey) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.not_enabled);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // Get the variable name from agent's providerApiKey field
            const variableName = agent.providerApiKey;

            // Look up the variable from the variables table
            const variable = await db.from("variables").where({ name: variableName }).first();
            if (!variable) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.anthropic_token_variable_not_found);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // Get the API key from the variable (decrypt if encrypted)
            let anthropicApiKey = variable.value;

            if (!variable.encrypted) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.anthropic_token_variable_not_encrypted);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (variable.encrypted) {
                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                anthropicApiKey = bytes.toString(CryptoJS.enc.Utf8);
            }

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

            // Send the request to the anthropic api.
            const response = await fetch(url, {
                method: req.method,
                headers: headers,
                body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
            });

            await updateStatistic({
                name: "count",
                label: "Claude Code",
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: "claude-code",
                count: 1,
                user: authenticationResult.user?.id,
                role: authenticationResult.user.role?.id
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
                    res.write(chunk);
                }
                res.end();
                return;
            }

            const data = await response.arrayBuffer();
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

    app.use(express.static('public'))

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
    if (!process.env.NEXT_BACKEND) {
        throw new Error("Missing process.env.NEXT_BACKEND")
    }
    if (!process.env.INTERNAL_SECRET) {
        throw new Error("Missing process.env.NEXT_BACKEND")
    }
    console.log(`[EXULU] fetching presigned url for file with key: ${key}`)
    let url = `${process.env.NEXT_BACKEND}/s3/download?key=${key}`;
    const response = await fetch(url, {
        method: "GET",
        headers: {
            "Content-Type": "application/json",
            "Internal-Key": process.env.INTERNAL_SECRET,
        },
    });
    const json: any = await response.json()
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