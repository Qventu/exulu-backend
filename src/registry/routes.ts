import { type Express, type Request, type Response } from "express";
import { errorHandler, type ExuluAgent, ExuluContext, type ExuluTool, updateStatistic } from "./classes.ts";
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
import { checkAgentRateLimit, checkRecordAccess, getEnabledTools, loadAgent } from "./utils.ts";
import { convertToModelMessages, createIdGenerator, createUIMessageStream, jsonSchema, pipeTextStreamToResponse, pipeUIMessageStreamToResponse, readUIMessageStream, streamText, validateUIMessages, type ModelMessage, type Tool, type UIMessage } from "ai";
export const REQUEST_SIZE_LIMIT = '50mb';
import { z } from "zod";
import { MetadataDirective } from "@aws-sdk/client-s3";

import proxy from 'express-http-proxy';

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
    type?: "jobs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "items" | "projects" | "project_items",
    id?: string,
    name: {
        plural: "jobs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "projects" | "project_items",
        singular: "job" | "agent_session" | "agent_message" | "eval_result" | "workflow_template" | "tracking" | "rbac" | "user" | "variable" | "role" | "agent" | "project" | "project_item",
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
    contexts: ExuluContext[] | undefined,
    config?: ExuluConfig,
    tracer?: Tracer,
    filesContext?: ExuluContext
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
    Intelligence Management Platform

    `);

    if (redisServer.host?.length && redisServer.port?.length) {
        await createRecurringJobs();
    } else {
        console.log("[EXULU] no redis server configured, not setting up recurring jobs.")
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
    ], contexts ?? [], agents, tools);

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

            console.log("[EXULU] enabled tools", enabledTools?.map(x => x.name + " (" + x.id + ")"))

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
                await agent.generateStream({
                    express: {
                        res,
                        req,
                    },
                    contexts: contexts,
                    user,
                    instructions: agentInstance.instructions,
                    session: headers.session as string,
                    message: req.body.message,
                    currentTools: enabledTools,
                    allExuluTools: tools,
                    providerapikey,
                    toolConfigs: agentInstance.tools,
                    exuluConfig: config,
                    filesContext,
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
                    user,
                    instructions: agentInstance.instructions,
                    session: headers.session as string,
                    message: req.body.message,
                    contexts: contexts,
                    currentTools: enabledTools,
                    allExuluTools: tools,
                    providerapikey,
                    exuluConfig: config,
                    toolConfigs: agentInstance.tools,
                    filesContext,
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
        console.log("[EXULU] Coding request!!!")
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

            console.log("[EXULU] Authenticated call", authenticationResult.user?.email)

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

            console.log("[EXULU] Agent loaded", agent.name)

            const backend = agents.find(x => x.id === agent.backend)

            if (!backend) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
                    \x1b[41m -- Agent ${agent.name} does not have a exulu backend setup, or the exulu backend that was assigned no longer exists. --
                    \x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            console.log("[EXULU] Backend loaded", backend.id)

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
            let providerapikey = variable.value;

            if (!variable.encrypted) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.anthropic_token_variable_not_encrypted);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (variable.encrypted) {
                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                providerapikey = bytes.toString(CryptoJS.enc.Utf8);
            }

            // todo get enabled tools from agent and add them to the request body
            // todo build logic to execute tool calls 

            // Set the anthropic api key in the headers.
            const headers = {
                'x-api-key': providerapikey,
                'anthropic-version': '2023-06-01',
                'content-type': req.headers['content-type'] || 'application/json'
            };

            // Copy relevant headers
            if (req.headers['accept']) headers['accept'] = req.headers['accept'];
            if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

            console.log("agent", agent.name)
            const model = backend.model?.create({
                apiKey: providerapikey
            })

            if (!model) {
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
                    \x1b[41m -- Could not create language model instance fro agent ${agent.name}. --
                    \x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // The vercel ai sdk expects the system messages to be a single string
            const systemMessagesConcatenated = req.body.system.map(x => x.text).join("\n\n\n");

            let messages = convertClaudeCodeMessagesToVercelAISdkMessages(
                req.body.messages
            )

            const tools: Record<string, Tool> = convertClaudeCodeToolsToVercelAISdkTools(
                req.body.tools
            )

            console.log("STREAMING TEXT")
            const result = streamText({
                model: model, // Should be a LanguageModelV1
                // TIP FOR DEBUGGING IF YOU RUN INTO ISSUES / ERRORS REGARDING THE MESSAGES FORMAT. STORE THE 'raw' VARIABLE TO A FILE (fs.write)
                // AND COPY THE CONTENT INTO THE messages: BELOW, TYPESCRIPT WILL TELL YOU WHAT IS WRONG WHICH IS USUALLY EASIER TO READ THAN THE
                // ERROR OUTPUT IN THE LOGS.
                messages: messages,
                system: systemMessagesConcatenated || "",
                // prepareStep could be used here to set the model for the first step or change other params
                maxOutputTokens: req.body.max_tokens,
                temperature: req.body.temperature,
                maxRetries: 2,
                providerOptions: {
                    metadata: {
                        user_id: req.body.metadata?.user_id
                    }
                },
                tools,
                onFinish: data => console.log("[EXULU] Finished stream"),
                onError: error => console.error("[EXULU] chat stream error.", error),
                // stopWhen: [stepCountIs(1)],
            });

            // consume the stream to ensure it runs to completion & triggers onFinish
            // even when the client response is aborted:
            let allChunks = [];
            result.consumeStream(); // no await

            const responses: any[] = [];
            try {
                for await (const uiMessage of readUIMessageStream({
                    stream: result.toUIMessageStream(),
                })) {
                    console.log('Streaming chunk:', uiMessage);
                    const message = {
                        type: "message",
                        role: uiMessage.role,
                        content: uiMessage.parts.map((part: any) => {
                            if (part.type.includes("tool-")) {
                                const type = part.type;
                                part.type = "tool_use";
                                part.name = type.replace("tool-", "");
                                part.id = part.toolCallId
                            }
                            return part;
                        })
                    }
                    responses.push(message);
                    console.log('Wrote message to response', message);
                }
            } catch (err) {
                console.error("Stream error:", err);
            } finally {
                const jsonString = JSON.stringify(responses[responses.length - 1]);
                const arrayBuffer = new TextEncoder().encode(jsonString).buffer;
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

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


    // inject tools into the request body, publish data to audit logs and implement
    // custom authentication logic from the IMP UI.
    app.use('/gateway/:id', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {
        console.log("[EXULU] Coding request!!!", req.body)
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

            console.log("[EXULU] Authenticated call", authenticationResult.user?.email)

            const { db } = await postgresClient();

            let query = db('agents');
            query.select("*");
            query = applyAccessControl(agentsSchema(), authenticationResult.user, query);
            query.where({ id: req.params.id });
            const agent = await query.first();

            console.log("[EXULU] Agent loaded", agent)

            if (!agent) {
                console.error("[EXULU] Agent not found", agent)
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
\x1b[41m -- Agent ${req.params.id} not found or you do not have access to it. --
\x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            console.log("[EXULU] Agent loaded", agent.name)

            const backend = agents.find(x => x.id === agent.backend)

            console.log("[EXULU] Backend loaded", backend)

            if (!backend) {
                console.error("[EXULU] Backend not found", backend)
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
                    \x1b[41m -- Agent ${agent.name} does not have a exulu backend setup, or the exulu backend that was assigned no longer exists. --
                    \x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            console.log("[EXULU] Backend loaded", backend.id)

            if (!process.env.NEXTAUTH_SECRET) {
                console.error("[EXULU] Missing NEXTAUTH_SECRET", process.env.NEXTAUTH_SECRET)
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_nextauth_secret);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (!agent.providerapikey) {
                return res.status(400).json({
                    message: "API Key not set for agent"
                })
            }

            // Get the variable name from agent's providerapikey field
            const variableName = agent.providerapikey;

            // Look up the variable from the variables table
            const variable = await db.from("variables").where({ name: variableName }).first();
            if (!variable) {
                pipeUIMessageStreamToResponse({
                    response: res,
                    stream: createUIMessageStream<any>({
                        execute: ({ writer }) => {
                            writer.write({
                                type: 'data-error',
                                data: { message: 'API Key not set for agent', level: 'error' },
                                transient: true, // This part won't be added to message history
                            });
                        }
                    })
                })
                return;
            }

            console.log("[EXULU] Variable loaded", variable)

            // Get the API key from the variable (decrypt if encrypted)
            let providerapikey = variable.value;

            if (!variable.encrypted) {
                console.error("[EXULU] Variable not encrypted", variable)
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.anthropic_token_variable_not_encrypted);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (variable.encrypted) {
                const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                providerapikey = bytes.toString(CryptoJS.enc.Utf8);
            }

            // todo get enabled tools from agent and add them to the request body
            // todo build logic to execute tool calls 

            // Set the anthropic api key in the headers.
            const headers = {
                'x-api-key': providerapikey,
                'anthropic-version': '2023-06-01',
                'content-type': req.headers['content-type'] || 'application/json'
            };

            // Copy relevant headers
            if (req.headers['accept']) headers['accept'] = req.headers['accept'];
            if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

            console.log("agent", agent.name)
            const model = backend.model?.create({
                apiKey: providerapikey
            })

            console.log("[EXULU] Model loaded", model)

            if (!model) {
                console.error("[EXULU] Model not loaded", model)
                const arrayBuffer = createCustomAnthropicStreamingMessage(`
                    \x1b[41m -- Could not create language model instance for agent ${agent.name}. --
                    \x1b[0m`);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            console.log("STREAMING TEXT")

            const tools: Record<string, Tool> = convertClaudeCodeToolsToVercelAISdkTools(
                req.body.tools
            )

            const result = streamText({
                model: model, // Should be a LanguageModelV1
                // TIP FOR DEBUGGING IF YOU RUN INTO ISSUES / ERRORS REGARDING THE MESSAGES FORMAT. STORE THE 'raw' VARIABLE TO A FILE (fs.write)
                // AND COPY THE CONTENT INTO THE messages: BELOW, TYPESCRIPT WILL TELL YOU WHAT IS WRONG WHICH IS USUALLY EASIER TO READ THAN THE
                // ERROR OUTPUT IN THE LOGS.
                messages: req.body.messages,
                // prepareStep could be used here to set the model for the first step or change other params
                maxOutputTokens: req.body.max_tokens,
                temperature: req.body.temperature,
                maxRetries: 2,
                providerOptions: {
                    metadata: {
                        user_id: req.body.metadata?.user_id
                    }
                },
                tools,
                onFinish: data => console.log("[EXULU] Finished stream"),
                onError: error => console.error("[EXULU] chat stream error.", error),
                // stopWhen: [stepCountIs(1)],
            });

            // consume the stream to ensure it runs to completion & triggers onFinish
            // even when the client response is aborted:
            result.consumeStream(); // no await

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            for await (const uiMessage of readUIMessageStream({
                stream: result.toUIMessageStream()
            })) {
                for (const part of uiMessage.parts) {
                    if (part.type === "text" && part.state === "done") {
                        const safePart = {
                            type: "text",
                            text: part.text,
                            state: "done",
                            providerMetadata: part.providerMetadata ?? null
                        };
                        console.log("safePart", safePart)
                        res.write(JSON.stringify(safePart) + "\n");
                    }

                }
            }

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


    app.use('/proxy/:id', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {
        console.log("[EXULU] Proxy route!", req.body)
        const path = req.url;
        const url = `${TARGET_API}${path}`;
        console.log("[EXULU] Proxy url!", url)
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

            console.log("[EXULU] anthropic proxy called for agent:", agent)

            if (!process.env.NEXTAUTH_SECRET) {
                console.error("[EXULU] Missing NEXTAUTH_SECRET", process.env.NEXTAUTH_SECRET)
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.missing_nextauth_secret);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            if (!agent.providerapikey) {
                console.error("[EXULU] Missing providerApiKey", agent.providerapikey)
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.not_enabled);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // Get the variable name from agent's providerApiKey field
            const variableName = agent.providerapikey;

            // Look up the variable from the variables table
            const variable = await db.from("variables").where({ name: variableName }).first();
            if (!variable) {
                console.error("[EXULU] Missing variable", variableName)
                const arrayBuffer = createCustomAnthropicStreamingMessage(CLAUDE_MESSAGES.anthropic_token_variable_not_found);
                res.setHeader('Content-Type', 'application/json');
                res.end(Buffer.from(arrayBuffer));
                return;
            }

            // Get the API key from the variable (decrypt if encrypted)
            let anthropicApiKey = variable.value;

            if (!variable.encrypted) {
                console.error("[EXULU] Missing variable", variableName)
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

            console.log("[EXULU] Proxy response!", response)

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

                    console.log("[EXULU] Proxy chunk!", value)

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

    // inject tools into the request body, publish data to audit logs and implement
    // custom authentication logic from the IMP UI.
    app.use('/test', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {
        console.log("[EXULU] Test route!", req.body)
        res.status(200).json({ message: "Hello, world!" })
    });


    app.use(express.static('public'))

    return app;
}

const convertClaudeCodeToolsToVercelAISdkTools = (tools: any[]) => {
    const result: Record<string, Tool> = {};
    for (const tool of tools) {
        const mySchema = jsonSchema(tool.input_schema);
        tools[tool.name] = {
            id: tool.name,
            name: tool.name,
            description: tool.description,
            inputSchema: mySchema,
        }
    }
    return result;
}

const convertClaudeCodeMessagesToVercelAISdkMessages = (messages: any[]) => {
    // Things we fix here:
    // - Vercel AI sdk does not allow id's on the message
    // - It always requires a role, so we set it to assistant if not provided
    // - It expects a role of 'tool' if the parts have a type of tool_result
    // - We filter out step-start parts
    // - We make sure reasoning is not an empty string
    // - tool_use is called 'tool-call' in the vercel ai sdk
    // - tool_result is called 'tool-result' in the vercel ai sdk
    // - tool_use_id is called 'toolCallId' in the vercel ai sdk
    // - tool_result in the claude code parts does not include the
    // tool name, so we retrieve it from the tool_use part, which 
    // does include the name (matching it via the toolCallId)
    let raw = messages.map(msg => {
        if (!msg.role) {
            msg.role = "assistant"
        }
        delete msg.id
        if (!Array.isArray(msg.content)) {
            return {
                role: msg.role,
                content: msg.content
            }
        }
        if (msg.content.some(part => part.type === "tool_result")) {
            msg.role = "tool"
        }
        let parts = msg.content.map(part => {
            if (part.type === "step-start") {
                return undefined;
            }
            if (part.type === "reasoning") {
                const content = part.text?.length > 1 ? part.text : part.content
                return {
                    type: "reasoning",
                    text: content || "No reasoning content provided"
                }
            }
            if (part.type === "tool_use") {
                part.type = "tool-call"
            }
            if (part.type === "tool_result") {
                part.type = "tool-result"
                part.output = {
                    type: "text",
                    value: part.text || part.content
                }
                // if an output is provided, vercel does
                // not allow setting text and content as well
                part.text = null;
                part.content = null;
                if (!part.name && part.tool_use_id) {
                    // Try to find in the othe msg parts for a part
                    // with the same tool_use_id and a name set
                    const allParts = raw.map(x => x.content).flat();
                    const result = allParts.find(x => {
                        return x.toolCallId === part.tool_use_id && x.name
                    })
                    console.log("FIND RESULT!!!!", result)
                    if (result) {
                        part.name = result.name;
                    } else {
                        part.name = "..."
                    }
                }
            }
            if (part.tool_use_id) {
                part.toolCallId = part.tool_use_id
                delete part.tool_use_id
            }
            return {
                type: part.type,
                ...(part.text || part.content ? { text: part.text || part.content } : {}),
                ...(part.toolCallId ? { toolCallId: part.toolCallId } : {}),
                ...(part.name ? { toolName: part.name } : {}),
                ...(part.input ? { input: part.input } : {}),
                ...(part.output ? { output: part.output } : {}),
                ...(part.cache_control?.type ? {
                    providerOptions: {
                        anthropic: { cacheControl: { type: part.cache_control?.type } },
                    }
                } : {})
            }
        })
        parts = parts.filter(part => part !== undefined);
        return {
            role: msg.role,
            id: msg.id,
            content: parts
        }
    })
    raw = raw.filter(msg => msg !== undefined);
    return raw;
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