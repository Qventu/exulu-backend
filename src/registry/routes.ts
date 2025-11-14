import { type Express, type Request, type Response } from "express";
import { errorHandler, type ExuluAgent, ExuluContext, type ExuluContextFieldDefinition, type ExuluContextFieldProcessor, ExuluEval, type ExuluTool, saveChat, type STATISTICS_LABELS, updateStatistic } from "./classes.ts";
import { requestValidators } from "./route-validators";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import { postgresClient } from "../postgres/client.ts";
import express from 'express';
import { ApolloServer } from '@apollo/server';
import cors from 'cors';
import 'reflect-metadata'
import { createSDL, applyAccessControl } from "./utils/graphql.ts";
import type { Knex } from "knex";
import { expressMiddleware } from '@as-integrations/express5';
import { coreSchemas } from "../postgres/core-schema.ts";
import { createUppyRoutes } from "./uppy.ts";
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache';
import bodyParser from 'body-parser';
import CryptoJS from 'crypto-js';
import OpenAI from "openai";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { type Tracer } from "@opentelemetry/api";
import type { ExuluConfig } from "./index.ts";
import { checkAgentRateLimit, checkRecordAccess, getEnabledTools, loadAgent } from "./utils.ts";
export const REQUEST_SIZE_LIMIT = '50mb';
import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MESSAGES } from "./utils/claude-messages.ts";
import type { Queue } from "bullmq";
import { createIdGenerator } from "ai";
import type { Project } from "@EXULU_TYPES/models/project";
import type { Agent } from "@EXULU_TYPES/models/agent.ts";

export const global_queues = {
    eval_runs: "eval_runs"
}

const {
    agentsSchema,
    projectsSchema,
    jobResultsSchema,
    testCasesSchema,
    evalSetsSchema,
    evalRunsSchema,
    platformConfigurationsSchema,
    agentSessionsSchema,
    agentMessagesSchema,
    rolesSchema,
    usersSchema,
    variablesSchema,
    workflowTemplatesSchema,
    rbacSchema,
    statisticsSchema
} = coreSchemas.get();

export type ExuluTableDefinition = {
    type?: "test_cases" | "eval_sets" | "eval_runs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "items" | "projects" | "project_items" | "platform_configurations" | "job_results",
    id?: string,
    name: {
        plural: "test_cases" | "eval_sets" | "eval_runs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "projects" | "project_items" | "platform_configurations" | "job_results",
        singular: "test_case" | "eval_set" | "eval_run" | "agent_session" | "agent_message" | "eval_result" | "workflow_template" | "tracking" | "rbac" | "user" | "variable" | "role" | "agent" | "project" | "project_item" | "platform_configuration" | "job_result",
    },
    fields: ExuluContextFieldDefinition[],
    RBAC?: boolean,
    graphql?: boolean,
}

export const createExpressRoutes = async (
    app: Express,
    agents: ExuluAgent[],
    tools: ExuluTool[],
    contexts: ExuluContext[] | undefined,
    config: ExuluConfig,
    evals: ExuluEval[],
    tracer?: Tracer,
    queues?: {
        queue: Queue,
        ratelimit: number
        concurrency: number
    }[]
): Promise<Express> => {

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
    Intelligence Management Platform - Server

    `);

    const schema = createSDL([
        usersSchema(),
        rolesSchema(),
        agentsSchema(),
        projectsSchema(),
        jobResultsSchema(),
        evalRunsSchema(),
        platformConfigurationsSchema(),
        evalSetsSchema(),
        testCasesSchema(),
        agentSessionsSchema(),
        agentMessagesSchema(),
        variablesSchema(),
        workflowTemplatesSchema(),
        statisticsSchema(),
        rbacSchema()
    ], contexts ?? [], agents, tools, config, evals, queues || []);

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
                /* console.info("[EXULU] Incoming graphql request", {
                    message: 'Incoming Request',
                    method: req.method,
                    path: req.path,
                    requestId: 'req-' + Date.now(),
                    ipAddress: req.ip,
                    userAgent: req.get('User-Agent'),
                    headers: {
                        "authorization": req.headers['authorization'],
                        'exulu-api-key': req.headers['exulu-api-key'],
                        "origin": req.headers['origin'],
                        "...": "..."
                    }
                }); */
                const authenticationResult = await requestValidators.authenticate(req);
                if (!authenticationResult.user?.id) {
                    console.error("[EXULU] Authentication failed", authenticationResult)
                    throw new Error(authenticationResult.message);
                }
                const { db } = await postgresClient();
                console.log("[EXULU] Graphql call")
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
        let providerapikey = variable.value;

        if (!variable.encrypted) {
            res.status(400).json({
                message: "Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys."
            })
            return;
        }

        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            providerapikey = bytes.toString(CryptoJS.enc.Utf8);
        }

        const openai = new OpenAI({
            apiKey: providerapikey
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

    app.get("/theme", async (req: Request, res: Response) => {
        const { db } = await postgresClient();
        const themeConfig = await db.from("platform_configurations").where({ config_key: "theme_config" }).first();
        if (!themeConfig) {
            res.status(200).json({
                theme: {
                    light: {},
                    dark: {}
                }
            })
            return;
        }
        res.status(200).json({
            theme: themeConfig.config_value
        })
    })

    // Route exposes some parts of the ExuluApp instance config options
    // via API so the frontend can show UI messages based on what is
    // enabled, for example if workers are disabled, a message is shown
    // on the evals page that they need to be configured before running evals.
    app.get("/config", async (req: Request, res: Response) => {
        res.status(200).json({
            authMode: process.env.AUTH_MODE as "password" | "otp",
            MCP: {
                enabled: config?.MCP.enabled
            },
            telemetry: {
                enabled: config?.telemetry?.enabled
            },
            fileUploads: {
                s3endpoint: config?.fileUploads?.s3endpoint
            },
            workers: {
                telemetry: {
                    enabled: config?.workers?.telemetry?.enabled
                },
                redisHost: process.env.REDIS_HOST,
                enabled: config?.workers?.enabled,
            }
        })
    })

    agents.forEach(agent => {
        const slug = agent.slug as string;
        if (!slug) return;

        app.post(slug + "/:instance", async (req: Request, res: Response) => {

            const headers: {
                stream: boolean,
                user: string | null,
                session: string | null,
            } = {
                stream: req.headers['stream'] as string === "true" || false,
                user: req.headers['user'] as string || null,
                session: req.headers['session'] as string || null,
            }

            await checkAgentRateLimit(agent);

            const instance = req.params.instance;
            if (!instance) {
                res.status(400).json({
                    message: "Missing instance in request."
                })
                return;
            }

            const { db } = await postgresClient();

            // For agents we dont use bullmq jobs, instead we use a rate limiter to
            // allow responses in real time while managing availability of infrastructure
            // or provider limits.
            // todo add "configuration" object to backend agent, and allow setting agent instance
            // specific configurations that overwrite the global ones.
            // todo allow setting agent instance specific configurations that overwrite the global ones
            // todo display rate limit message in the chat UI

            const agentInstance = await loadAgent(instance);

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

            const hasAccessToAgent = await checkRecordAccess(agentInstance, "read", user);

            if (!hasAccessToAgent) {
                res.status(401).json({
                    message: "You don't have access to this agent."
                })
                return;
            }

            if (headers.session) {
                // Check session RBAC
                const session = await db.from("agent_sessions").where({
                    id: headers.session
                }).first();
                let hasAccessToSession = await checkRecordAccess(session, "write", user);
                if (!hasAccessToSession) {
                    res.status(401).json({
                        message: "You don't have access to this session."
                    })
                    return;
                }
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

            console.log("[EXULU] agent tools", agentInstance.tools?.map(x => x.name + " (" + x.id + ")"))

            const disabledTools = req.body.disabledTools ? req.body.disabledTools : [];
            let enabledTools: ExuluTool[] = await getEnabledTools(agentInstance, tools, disabledTools, agents, user)

            // Get the variable name from user's anthropic_token field
            const variableName = agentInstance.providerapikey;

            // Look up the variable from the variables table
            const variable = await db.from("variables").where({ name: variableName }).first();
            if (!variable) {
                res.status(400).json({
                    message: "Provider API key variable not found."
                })
                return;
            }

            // Get the API key from the variable (decrypt if encrypted)
            let providerapikey = variable.value;

            if (!variable.encrypted) {
                res.status(400).json({
                    message: "Provider API key variable not encrypted, for security reasons you are only allowed to use encrypted variables for provider API keys."
                })
                return;
            }

            if (variable.encrypted) {
                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                providerapikey = bytes.toString(CryptoJS.enc.Utf8);
            }

            // todo add authentication based on thread id to guarantee privacy
            // todo validate req.body data structure
            if (!!headers.stream) {

                const statistics = {
                    label: agent.name,
                    trigger: "agent" as STATISTICS_LABELS
                }

                const result = await agent.generateStream({
                    contexts: contexts,
                    user,
                    instructions: agentInstance.instructions,
                    session: headers.session as string,
                    message: req.body.message,
                    currentTools: enabledTools,
                    allExuluTools: tools,
                    providerapikey,
                    toolConfigs: agentInstance.tools,
                    exuluConfig: config
                })

                // consume the stream to ensure it runs to completion & triggers onFinish
                // even when the client response is aborted:
                result.stream.consumeStream(); // no await

                result.stream.pipeUIMessageStreamToResponse(res, {
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
                    originalMessages: result.originalMessages,
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
                        if (headers.session) {
                            // But only save the new messages, not the previous ones, otherwise we get duplicates.
                            await saveChat({
                                session: headers.session as string,
                                user: user.id,
                                messages: messages.filter(x => !result.previousMessages.find(y => y.id === x.id))
                            })
                        }
                        const metadata = messages[messages.length - 1]?.metadata as any;
                        console.log("[EXULU] Finished streaming", metadata)
                        console.log("[EXULU] Statistics", {
                            label: agent.name,
                            trigger: "agent"
                        })
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
                // Returns a response that can be used by the "useChat" hook
                // on the client side from the vercel "ai" SDK.

                return;
            } else {
                const response = await agent.generateSync({
                    user,
                    instructions: agentInstance.instructions,
                    session: headers.session as string,
                    inputMessages: [req.body.message],
                    contexts: contexts,
                    currentTools: enabledTools,
                    allExuluTools: tools,
                    providerapikey,
                    exuluConfig: config,
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
        config?.fileUploads &&
        config?.fileUploads?.s3region &&
        config?.fileUploads?.s3key &&
        config?.fileUploads?.s3secret &&
        config?.fileUploads?.s3Bucket
    ) {
        await createUppyRoutes(app, config)
    } else {
        console.log("[EXULU] skipping uppy file upload routes, because no S3 compatible region, key or secret is set in ExuluApp instance.")
    }

    app.get("/config", async (req: Request, res: Response) => {
        res.status(200).json({
            message: "Config fetched successfully.",
            config: {
                workers: {
                    enabled: config?.workers?.enabled || false,
                }
            }
        });
    });


    // This route basically passes the request 1:1 to the Anthropic API, but we can
    // inject tools into the request body, publish data to audit logs and implement
    // custom authentication logic from the IMP UI.
    app.use('/gateway/anthropic/:agent/:project', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {

        try {

            if (!req.body.tools) {
                req.body.tools = [];
            }

            const { db } = await postgresClient();

            // Authenticate the user, and exchange the user token for an anthropic token.
            const authenticationResult = await requestValidators.authenticate(req);
            if (!authenticationResult.user?.id) {
                console.log("[EXULU] failed authentication result", authenticationResult)
                res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
                return;
            }

            const user = authenticationResult.user;

            let agentQuery = db('agents');
            agentQuery.select("*");
            agentQuery = applyAccessControl(agentsSchema(), authenticationResult.user, agentQuery);
            agentQuery.where({ id: req.params.agent });
            const agent: Agent | undefined = await agentQuery.first();

            if (!agent) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
\x1b[41m -- Agent ${req.params.agent} not found or you do not have access to it. --
\x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            let project: Project | null = null;

            if (!req.body.project || req.body.project === "DEFAULT") {
                project = null;
            } else {
                let projectQuery = db('projects');
                projectQuery.select("*");
                projectQuery = applyAccessControl(projectsSchema(), authenticationResult.user, projectQuery);
                projectQuery.where({ id: req.params.project });
                project = await projectQuery.first();

                if (!project) {
                    const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_project);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(Buffer.from(arrayBuffer));
                    return;
                }
            }

            console.log("[EXULU] anthropic proxy called for agent:", agent?.name)

            if (!process.env.NEXTAUTH_SECRET) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_nextauth_secret);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (!agent.providerapikey) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.not_enabled);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // Get the variable name from agent's providerapikey field
            const variableName = agent.providerapikey;

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

            const client = new Anthropic({
                apiKey: anthropicApiKey,
            });

            // console.log("[EXULU] Req.body", req.body)

            // Send the request to the anthropic api.
            // Stream the messages from Anthropic
            const tokens: Record<string, {
                input_tokens: number
                cache_creation_input_tokens: number
                cache_read_input_tokens: number
                output_tokens: number
            }> = {};

            const disabledTools = req.body.disabledTools ? req.body.disabledTools : [];
            let enabledTools: ExuluTool[] = await getEnabledTools(agent, tools, disabledTools, agents, user)

            let system: string | {
                type: "text",
                text: string
            }[] = req.body.system;

            if (Array.isArray(req.body.system)) {
                system = [
                    ...req.body.system,
                    ...(agent ? [
                        {
                            type: "text",
                            text: `
                            You are an agent named: ${agent?.name}
                            Here are some additional instructions for you: ${agent?.instructions}`
                        }
                    ] : []),
                    ...(project ? [
                        {
                            type: "text",
                            text: `Additional information:

                            The project you are working on is: ${project?.name}
                            Here is some additional information about the project: ${project?.description}`
                        }
                    ] : [])
                ]
            } else {
                system = `${req.body.system}\n\n
                ${ agent ? `You are an agent named: ${agent?.name}
                Here are some additional instructions for you: ${agent?.instructions}` : ""}

                ${ project?.id ? `Additional information:

                The project you are working on is: ${project?.name}
                The project description is: ${project?.description}` : ""}
                `;
            }

            for await (const event of client.messages.stream({
                ...req.body,
                system
            }) as AsyncIterable<{
                type: string,
                index: number,
                message?: {
                    id: string,
                    type: string,
                    name: string,
                    input: any,
                    role: string,
                    model: string,
                    content: any[],
                    stop_reason: string | null,
                    stop_sequence: string | null,
                    usage: {
                        input_tokens: number,
                        cache_creation_input_tokens: number,
                        cache_read_input_tokens: number,
                        output_tokens: number,
                        service_tier: string,
                    }
                }
                delta?: {
                    type: string,
                    text: string
                }
            }>) {
                if (event.message?.id) {
                    tokens[event.message.id] = {
                        input_tokens: event.message.usage.input_tokens,
                        cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
                        cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
                        output_tokens: event.message.usage.output_tokens,
                    };
                    // todo check against rate limit for this agent and project
                }

                // We only deal with tools that are prefixed with "exulu_"
                // on the server, other tools are handled by Claude Code
                // client side.
                if (
                    event.message?.type === "tool_use" &&
                    event.message?.name?.includes("exulu_")
                ) {
                    const toolName = event.message?.name;
                    console.log("[EXULU] Using tool", toolName)
                    const inputs = event.message?.input;
                    const id = event.message?.id;

                    const tool: ExuluTool | undefined = enabledTools.find(tool => tool.id === toolName.replace("exulu_", ""));
                    if (!tool || !tool.tool.execute) {
                        console.error("[EXULU] Tool not found or not enabled.", toolName)
                        continue;
                    }

                    const toolResult = await tool.tool.execute(inputs, {
                        toolCallId: id,
                        messages: [{
                            ...event.message,
                            role: "tool"
                        }]
                    });

                    console.log("[EXULU] Tool result", toolResult)

                    const toolResultMessage = {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: id,
                                content: toolResult
                            }
                        ]
                    }

                    res.write(`event: tool_result\ndata: ${JSON.stringify(toolResultMessage)}\n\n`);

                } else {
                    const msg = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
                    res.write(msg);
                }
            }

            let totalInputTokens = 0;
            let totalOutputTokens = 0;
            for (const token of Object.values(tokens)) {
                totalInputTokens += token.input_tokens;
                totalOutputTokens += token.output_tokens;
            }

            const statistics = {
                label: agent.name,
                trigger: "agent" as STATISTICS_LABELS
            }

            await Promise.all([
                updateStatistic({
                    name: "count",
                    label: statistics.label,
                    type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                    trigger: statistics.trigger,
                    count: 1,
                    user: user.id,
                    role: user?.role?.id,
                    ...(project ? { project: project.id } : {})
                }),
                ...(totalInputTokens ? [
                    updateStatistic({
                        name: "inputTokens",
                        label: statistics.label,
                        type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                        trigger: statistics.trigger,
                        count: totalInputTokens,
                        user: user.id,
                        role: user?.role?.id,
                        ...(project ? { project: project.id } : {})
                    })] : []
                ),
                ...(totalOutputTokens ? [
                    updateStatistic({
                        name: "outputTokens",
                        label: statistics.label,
                        type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                        trigger: statistics.trigger,
                        count: totalInputTokens,
                        user: user.id,
                        role: user?.role?.id,
                        ...(project ? { project: project.id } : {})
                    })] : []
                )
            ])

            res.write('event: done\ndata: [DONE]\n\n');
            res.end();

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