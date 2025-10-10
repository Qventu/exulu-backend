import { type Express, type Request, type Response } from "express";
import { type ExuluAgent, ExuluContext, type ExuluTool, type STATISTICS_LABELS, updateStatistic } from "./classes.ts";
import { requestValidators } from "./route-validators";
import { queues } from "../bullmq/queues.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import { postgresClient } from "../postgres/client.ts";
import express from 'express';
import { ApolloServer } from '@apollo/server';
import cors from 'cors';
import 'reflect-metadata'
import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types.ts";
import { createSDL, applyAccessControl } from "./utils/graphql.ts";
import type { Knex } from "knex";
import { expressMiddleware } from '@as-integrations/express5';
import { coreSchemas } from "../postgres/core-schema.ts";
import { createUppyRoutes } from "./uppy.ts";
import { redisServer } from "../bullmq/server.ts";
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache';
import bodyParser from 'body-parser';
import CryptoJS from 'crypto-js';
import OpenAI from "openai";
import fs from "fs";
import { randomUUID } from "node:crypto";
import { type Tracer } from "@opentelemetry/api";
import type { ExuluConfig } from "./index.ts";
import { checkAgentRateLimit, checkRecordAccess, getEnabledTools, loadAgent } from "./utils.ts";
import { jsonSchema, type Tool } from "ai";
export const REQUEST_SIZE_LIMIT = '50mb';
import proxy from 'express-http-proxy';
import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MESSAGES } from "./utils/claude-messages.ts";


export const global_queues = {
    logs_cleaner: "logs-cleaner"
}

const {
    agentsSchema,
    projectsSchema,
    testCasesSchema,
    evalSetsSchema,
    evalRunsSchema,
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

    const queue = await queues.use(global_queues.logs_cleaner);

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

    await queue.queue.upsertJobScheduler(
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
    type?: "test_cases" | "eval_sets" | "eval_runs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "items" | "projects" | "project_items",
    id?: string,
    name: {
        plural: "test_cases" | "eval_sets" | "eval_runs" | "agent_sessions" | "agent_messages" | "eval_results" | "workflow_templates" | "tracking" | "rbac" | "users" | "variables" | "roles" | "agents" | "projects" | "project_items",
        singular: "test_case" | "eval_set" | "eval_run" | "agent_session" | "agent_message" | "eval_result" | "workflow_template" | "tracking" | "rbac" | "user" | "variable" | "role" | "agent" | "project" | "project_item",
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
        evalRunsSchema(),
        evalSetsSchema(),
        testCasesSchema(),
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
                console.info("[EXULU] Incoming graphql request", {
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
                });
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

    // Eval run endpoint - creates one job per test case for running the agent
    // Worker will then create child jobs for each eval function
    app.post("/evals/run/:id", async (req: Request, res: Response) => {
        console.log("[EXULU] /evals/run/:id", req.params.id);

        const authenticationResult = await requestValidators.authenticate(req);
        if (!authenticationResult.user?.id) {
            res.status(authenticationResult.code || 500).json({ detail: `${authenticationResult.message}` });
            return;
        }

        const user = authenticationResult.user;
        const evalRunId = req.params.id;

        // Check user has evals write access or is super admin
        if (!user.super_admin && (!user.role || user.role.evals !== "write")) {
            res.status(403).json({
                message: "You don't have permission to run evals. Required: super_admin or evals write access."
            });
            return;
        }

        const { db } = await postgresClient();

        // Fetch the eval run
        const evalRun = await db.from("eval_runs").where({ id: evalRunId }).first();
        if (!evalRun) {
            res.status(404).json({
                message: "Eval run not found."
            });
            return;
        }

        // Check RBAC access to eval run
        const hasAccessToEvalRun = await checkRecordAccess(evalRun, "write", user);
        if (!hasAccessToEvalRun) {
            res.status(403).json({
                message: "You don't have access to this eval run."
            });
            return;
        }

        // Get test case IDs and eval function IDs from eval run
        const testCaseIds = evalRun.test_case_ids ? (typeof evalRun.test_case_ids === 'string' ? JSON.parse(evalRun.test_case_ids) : evalRun.test_case_ids) : [];
        const evalFunctionIds = evalRun.eval_function_ids ? (typeof evalRun.eval_function_ids === 'string' ? JSON.parse(evalRun.eval_function_ids) : evalRun.eval_function_ids) : [];

        if (!testCaseIds || testCaseIds.length === 0) {
            res.status(400).json({
                message: "No test cases selected for this eval run."
            });
            return;
        }

        if (!evalFunctionIds || evalFunctionIds.length === 0) {
            res.status(400).json({
                message: "No eval functions selected for this eval run."
            });
            return;
        }

        // Fetch test cases
        const testCases = await db.from("test_cases").whereIn("id", testCaseIds);
        if (testCases.length === 0) {
            res.status(404).json({
                message: "No test cases found."
            });
            return;
        }

        // Load the agent instance to validate it exists
        const agentInstance = await loadAgent(evalRun.agentId);
        if (!agentInstance) {
            res.status(404).json({
                message: "Agent instance not found."
            });
            return;
        }

        // Use a general eval queue for the main eval jobs
        const evalQueue = await queues.use("evals");

        // Create one job per test case
        const jobIds: string[] = [];

        for (const testCase of testCases) {
            // Check for duplicate job (same eval run ID + test case ID combo)
            const existingJobs = await evalQueue.queue.getJobs(["waiting", "active", "delayed", "paused"]);
            const duplicateJob = existingJobs.find(job =>
                job.data.evalRunId === evalRunId &&
                job.data.testCaseId === testCase.id &&
                job.data.type === "eval"
            );

            if (duplicateJob) {
                console.log(`[EXULU] Skipping duplicate job for eval run ${evalRunId} and test case ${testCase.id}`);
                continue;
            }

            // Create job with type "eval" - worker will handle running agent + creating eval function jobs
            const job = await evalQueue.queue.add(`eval-${testCase.id}`, {
                type: "eval",
                evalRunId,
                testCaseId: testCase.id,
                evalFunctionIds, // Array of eval function IDs - worker will create child jobs for these
                agentId: evalRun.agentId,
                inputs: testCase.inputs,
                expected_output: testCase.expected_output,
                expected_tools: testCase.expected_tools,
                expected_knowledge_sources: testCase.expected_knowledge_sources,
                expected_agent_tools: testCase.expected_agent_tools,
                config: evalRun.config,
                scoring_method: evalRun.scoring_method,
                pass_threshold: evalRun.pass_threshold,
                user: user.id,
                role: user.role?.id
            });

            jobIds.push(job.id as string);
        }

        res.status(200).json({
            message: `Created ${jobIds.length} eval jobs.`,
            jobIds,
            evalRunId,
            testCaseCount: testCases.length,
            evalFunctionCount: evalFunctionIds.length
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

    // Route exposes some parts of the ExuluApp instance config options
    // via API so the frontend can show UI messages based on what is
    // enabled, for example if workers are disabled, a message is shown
    // on the evals page that they need to be configured before running evals.
    app.get("/config", async (req: Request, res: Response) => {
        res.status(200).json({
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

    app.use('/xxx/anthropic/:id', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), proxy(
        (req, res, next) => {
            return "https://api.anthropic.com"
        }, {
        limit: '50mb',
        memoizeHost: false,
        preserveHostHdr: true,
        secure: false,
        reqAsBuffer: true,
        proxyReqBodyDecorator: function (bodyContent, srcReq) {
            return bodyContent;
        }, userResDecorator: function (proxyRes, proxyResData, userReq, userRes) {
            console.log("[EXULU] Proxy response!", proxyResData)
            proxyResData = proxyResData.toString(); console.log("[EXULU] Proxy response string!", proxyResData)
            return proxyResData;
        }, proxyReqPathResolver: (req) => {
            const prefix = `/gateway/anthropic/${req.params.id}`;
            let path = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url;
            if (!path.startsWith('/')) path = '/' + path;
            console.log("[EXULU] Provider path:", path);
            return path;
        },
        proxyReqOptDecorator: function (proxyReqOpts, srcReq) {
            return new Promise(async (resolve, reject) => {
                try {
                    const authenticationResult = await requestValidators.authenticate(srcReq);
                    if (!authenticationResult.user?.id) {
                        console.log("[EXULU] failed authentication result", authenticationResult)
                        reject(authenticationResult.message)
                        return;
                    }
                    console.log("[EXULU] Authenticated call", authenticationResult.user?.email)
                    const { db } = await postgresClient();
                    let query = db('agents'); query.select("*");
                    query = applyAccessControl(agentsSchema(), authenticationResult.user, query);
                    query.where({ id: srcReq.params.id });
                    const agent = await query.first();
                    if (!agent) {
                        reject(new Error("Agent with id " + srcReq.params.id + " not found."))
                        return;
                    }
                    console.log("[EXULU] Agent loaded", agent.name)
                    const backend = agents.find(x => x.id === agent.backend)
                    if (!process.env.NEXTAUTH_SECRET) {
                        reject(new Error("Missing NEXTAUTH_SECRET"))
                        return;
                    }
                    if (!agent.providerapikey) {
                        reject(new Error("API Key not set for agent"))
                        return;
                    }
                    const variableName = agent.providerapikey;
                    const variable = await db.from("variables").where({ name: variableName }).first();
                    console.log("[EXULU] Variable loaded", variable)
                    let providerapikey = variable.value;
                    if (!variable.encrypted) {
                        reject(new Error("API Key not encrypted for agent"))
                        return;
                    }
                    if (variable.encrypted) {
                        const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
                        providerapikey = bytes.toString(CryptoJS.enc.Utf8);
                    }
                    console.log("[EXULU] Provider API key", providerapikey)
                    proxyReqOpts.headers['x-api-key'] = providerapikey;
                    proxyReqOpts.rejectUnauthorized = false
                    delete proxyReqOpts.headers['provider'];
                    const url = new URL("https://api.anthropic.com");
                    proxyReqOpts.headers['host'] = url.host;
                    proxyReqOpts.headers['anthropic-version'] = '2023-06-01';
                    console.log("[EXULU] Proxy request headers", proxyReqOpts.headers)
                    resolve(proxyReqOpts);
                } catch (error: any) {
                    console.error("[EXULU] Proxy error", error)
                    reject(error)
                }
            })
        }
    }));

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
    app.use('/gateway/anthropic/:id', express.raw({ type: '*/*', limit: REQUEST_SIZE_LIMIT }), async (req, res) => {

        try {

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

            const user = authenticationResult.user;

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

            for await (const event of client.messages.stream(req.body) as AsyncIterable<{
                type: string,
                index: number,
                message?: {
                    id: string,
                    type: string,
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
                console.log("[EXULU] Event", event)
                if (event.message?.usage) {
                    // todo register token usage in database (summarize them for this stream and then send to statistics once)
                    // todo check against rate limit
                }
                if (event.message?.id) {
                    tokens[event.message.id] = {
                        input_tokens: event.message.usage.input_tokens,
                        cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens,
                        cache_read_input_tokens: event.message.usage.cache_read_input_tokens,
                        output_tokens: event.message.usage.output_tokens,
                    };
                }
                const msg = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
                res.write(msg);
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
                    role: user?.role?.id
                }),
                ...(totalInputTokens ? [
                    updateStatistic({
                        name: "inputTokens",
                        label: statistics.label,
                        type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                        trigger: statistics.trigger,
                        count: totalInputTokens,
                        user: user.id,
                        role: user?.role?.id
                    })] : []
                ),
                ...(totalOutputTokens ? [
                    updateStatistic({
                        name: "outputTokens",
                        label: statistics.label,
                        type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                        trigger: statistics.trigger,
                        count: totalOutputTokens,
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