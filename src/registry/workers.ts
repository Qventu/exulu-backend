import IORedis from "ioredis";
import { redisServer } from "../bullmq/server";
import { Job, Worker, type JobState } from "bullmq";
import { bullmq, getEnabledTools, loadAgent } from "./utils";
import { ExuluAgent, ExuluContext, ExuluEval, ExuluStorage, ExuluTool, getTableName, updateStatistic, type ExuluQueueConfig, type STATISTICS_LABELS } from "./classes";
import { postgresClient } from "../postgres/client";
import type { BullMqJobData } from "./decoraters/bullmq";
import { type Tracer } from "@opentelemetry/api";
import type { ExuluConfig } from ".";
import { v4 as uuidv4 } from 'uuid';
import { type UIMessage } from "ai";
import CryptoJS from 'crypto-js';
import type { Agent } from "@EXULU_TYPES/models/agent.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { User } from "@EXULU_TYPES/models/user";
import type { EvalRun } from "@EXULU_TYPES/models/eval-run";
import type { TestCase } from "@EXULU_TYPES/models/test-case";
import { logMetadata } from "./log-metadata";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import type { EvalRunEvalFunction } from "@EXULU_TYPES/models/eval-run";

let redisConnection: IORedis;

// Global handlers to prevent process crashes from unhandled errors
// This is critical for BullMQ workers to properly mark jobs as failed
let unhandledRejectionHandlerInstalled = false;

const installGlobalErrorHandlers = () => {
    if (unhandledRejectionHandlerInstalled) return;

    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
        console.error('[EXULU] Unhandled Promise Rejection detected! This would have crashed the worker.', {
            reason: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined,
        });
        // Don't exit - let the worker continue and BullMQ will handle job failure
    });

    process.on('uncaughtException', (error: Error) => {
        console.error('[EXULU] Uncaught Exception detected! This would have crashed the worker.', {
            error: error.message,
            stack: error.stack,
        });
        // Don't exit for database timeouts and similar recoverable errors
        // Only exit for truly fatal errors
        if (error.message.includes('FATAL') || error.message.includes('Cannot find module')) {
            console.error('[EXULU] Fatal error detected, exiting process.');
            process.exit(1);
        }
    });

    unhandledRejectionHandlerInstalled = true;
    console.log('[EXULU] Global error handlers installed to prevent worker crashes');
};

export const createWorkers = async (
    agents: ExuluAgent[],
    queues: ExuluQueueConfig[],
    config: ExuluConfig,
    contexts: ExuluContext[],
    evals: ExuluEval[],
    tools: ExuluTool[],
    tracer?: Tracer
) => {
    console.log("[EXULU] creating workers for " + queues?.length + " queues.");
    console.log("[EXULU] queues", queues.map(q => q.queue.name));
    // Initializes any required workers for processing embedder
    // and agent jobs in the defined queues by checking the registry.

    // Install global error handlers to prevent crashes
    installGlobalErrorHandlers();

    // Increase max listeners to accommodate multiple workers (each adds SIGINT/SIGTERM listeners)
    // Each worker adds 2 listeners (SIGINT + SIGTERM), so set to queues.length * 2 + buffer
    process.setMaxListeners(Math.max(queues.length * 2 + 5, 15));

    if (!redisServer.host || !redisServer.port) {
        console.error("[EXULU] you are trying to start worker, but no redis server is configured in the environment.")
        throw new Error("No redis server configured in the environment, so cannot start worker.")
    }

    if (!redisConnection) {

        let url = ""
        if (redisServer.username) {
            url = `redis://${redisServer.username}:${redisServer.password}@${redisServer.host}:${redisServer.port}`
        } else {
            url = `redis://${redisServer.host}:${redisServer.port}`
        }

        redisConnection = new IORedis(url, {
            enableOfflineQueue: true,
            retryStrategy: function (times: number) {
                return Math.max(Math.min(Math.exp(times), 20000), 1000);
            },
            maxRetriesPerRequest: null
        });
    }

    const workers = queues.map(queue => {

        console.log(`[EXULU] creating worker for queue ${queue.queue.name}.`)

        const worker = new Worker(
            `${queue.queue.name}`,
            async (bullmqJob: Job): Promise<{
                result: any,
                metadata: any
            }> => {

                console.log("[EXULU] starting execution for job", logMetadata(bullmqJob.name, {
                    name: bullmqJob.name,
                    jobId: bullmqJob.id,
                    status: await bullmqJob.getState(),
                    type: bullmqJob.data.type,
                }));

                const { db } = await postgresClient();

                // Type casting data here, couldn't get it to merge
                // on the main object while keeping auto completion.
                const data: BullMqJobData = bullmqJob.data;

                const timeoutInSeconds = data.timeoutInSeconds || queue.timeoutInSeconds || 600;
                // Create timeout promise with proper error handling
                const timeoutMs = timeoutInSeconds * 1000;
                let timeoutHandle: NodeJS.Timeout;
                const timeoutPromise: Promise<{
                    result: any,
                    metadata: any
                }> = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        const timeoutError = new Error(`Timeout for job ${bullmqJob.id} reached after ${timeoutInSeconds}s`);
                        console.error(`[EXULU] ${timeoutError.message}`);
                        reject(timeoutError);
                    }, timeoutMs);
                });

                // Wrap the actual work in a promise
                const workPromise: Promise<{
                    result: any,
                    metadata: any
                }> = (async () => {
                    try {
                        console.log(`[EXULU] Job ${bullmqJob.id} - Log file: logs/jobs/job-${bullmqJob.id}.log`);
                        bullmq.validate(bullmqJob.id, data);

                        if (data.type === "embedder") {

                            console.log("[EXULU] running an embedder job.", logMetadata(bullmqJob.name));

                            const label = `embedder-${bullmqJob.name}`;

                            await db.from("job_results").insert({
                                job_id: bullmqJob.id,
                                label: label,
                                state: await bullmqJob.getState(),
                                result: null,
                                metadata: {}
                            });

                            const context = contexts.find(context => context.id === data.context)

                            if (!context) {
                                throw new Error(`Context ${data.context} not found in the registry.`);
                            }

                            if (!data.embedder) {
                                throw new Error(`No embedder set for embedder job.`);
                            }

                            const embedder = contexts.find(context => context.embedder?.id === data.embedder)

                            if (!embedder) {
                                throw new Error(`Embedder ${data.embedder} not found in the registry.`);
                            }

                            const result = await context.createAndUpsertEmbeddings(data.inputs, config, data.user, {
                                label: embedder.name,
                                trigger: data.trigger
                            }, data.role, bullmqJob.id);

                            return {
                                result,
                                metadata: {}
                            };

                        }

                        if (data.type === "processor") {

                            console.log("[EXULU] running a processor job, job name: ", bullmqJob.name, " job id: ", bullmqJob.id, " job data: ", data, " job queue: ", bullmqJob.queueName);

                            const label = `processor-${bullmqJob.name}`;

                            await db.from("job_results").insert({
                                job_id: bullmqJob.id,
                                label: label,
                                state: await bullmqJob.getState(),
                                result: null,
                                metadata: {}
                            });

                            const context = contexts.find(context => context.id === data.context)

                            if (!context) {
                                throw new Error(`Context ${data.context} not found in the registry.`);
                            }

                            if (!data.inputs.id) {
                                throw new Error(`[EXULU] Item not set for processor in context ${context.id}, running in job ${bullmqJob.id}.`);
                            }

                            if (!context.processor) {
                                throw new Error(`Tried to run a processor job for context ${context.id}, but no processor is set.`);
                            }

                            const exuluStorage = new ExuluStorage({ config });

                            console.log("[EXULU] POS 2 -- EXULU CONTEXT PROCESS FIELD")
                            const processorResult = await context.processor.execute({
                                item: data.inputs,
                                user: data.user,
                                role: data.role,
                                utils: {
                                    storage: exuluStorage,
                                },
                                exuluConfig: config
                            });

                            if (!processorResult) {
                                throw new Error(`[EXULU] Processor in context ${context.id}, running in job ${bullmqJob.id} did not return an item.`);
                            }

                            // The field key is used to define a processor, but is
                            // not part of the database, so remove it here before
                            // we upadte the item in the db.
                            delete processorResult.field;

                            // Update the item in the db with the processor result
                            await db.from(getTableName(context.id)).where({
                                id: processorResult.id
                            }).update({
                                ...processorResult,
                                last_processed_at: new Date().toISOString()
                            });

                            let jobs: string[] = [];
                            if (context.processor?.config?.generateEmbeddings) {
                                // If the processor was configured to automatically trigger
                                // the generation of embeddings, we trigger it here.
                                // IMPORTANT: We need to fetch the complete item from the database
                                // to ensure we have all fields (especially external_id) for embeddings
                                const fullItem = await db.from(getTableName(context.id)).where({
                                    id: processorResult.id
                                }).first();

                                if (!fullItem) {
                                    throw new Error(`[EXULU] Item ${processorResult.id} not found after processor update in context ${context.id}`);
                                }

                                const { job: embeddingsJob } = await context.embeddings.generate.one({
                                    item: fullItem,
                                    user: data.user,
                                    role: data.role,
                                    trigger: "processor",
                                    config
                                });

                                if (embeddingsJob) {
                                    jobs.push(embeddingsJob);
                                }
                            }

                            return {
                                result: processorResult,
                                metadata: {
                                    jobs: jobs.length > 0 ? jobs.join(",") : undefined
                                }
                            };
                        }

                        if (data.type === "eval_run") {

                            console.log("[EXULU] running an eval run job.", logMetadata(bullmqJob.name));

                            const label = `eval-run-${data.eval_run_id}-${data.test_case_id}`;

                            const existingResult = await db.from("job_results").where({ label: label }).first();

                            if (existingResult) {
                                // update existing
                                console.log("[EXULU] found existing job result, so ")
                                await db.from("job_results").where({ label: label }).update({
                                    job_id: bullmqJob.id,
                                    label: label,
                                    state: await bullmqJob.getState(),
                                    result: null,
                                    metadata: {},
                                    tries: existingResult.tries + 1
                                });
                            } else {
                                await db.from("job_results").insert({
                                    job_id: bullmqJob.id,
                                    label: label,
                                    state: await bullmqJob.getState(),
                                    result: null,
                                    metadata: {},
                                    tries: 1
                                });
                            }

                            const {
                                agentInstance,
                                backend: agentBackend,
                                user,
                                evalRun,
                                testCase,
                                messages: inputMessages,
                            } = await validateEvalPayload(data, agents);

                            const retries = 3;
                            let attempts = 0;

                            // todo allow setting queue on agent backend and then create a job with type "agent"
                            const promise = new Promise<{
                                messages: UIMessage[],
                                metadata: {
                                    tokens: {
                                        totalTokens: number,
                                        reasoningTokens: number,
                                        inputTokens: number,
                                        outputTokens: number,
                                        cachedInputTokens: number,
                                    },
                                    duration: number,
                                }
                            }>(async (resolve, reject) => {
                                while (attempts < retries) {
                                    try {
                                        const messages = await processUiMessagesFlow({
                                            agents,
                                            agentInstance,
                                            agentBackend,
                                            inputMessages,
                                            contexts,
                                            user,
                                            tools,
                                            config
                                        });
                                        resolve(messages);
                                        break;
                                    } catch (error: unknown) {
                                        console.error(`[EXULU] error processing UI messages flow for agent ${agentInstance.name} (${agentInstance.id}).`, logMetadata(bullmqJob.name, {
                                            error: error instanceof Error ? error.message : String(error),
                                        }))
                                        attempts++;
                                        if (attempts >= retries) {
                                            reject(error);
                                        }
                                        await new Promise(resolve => setTimeout(resolve, 2000));
                                    }
                                }
                            });

                            const result = await promise;
                            const messages = result.messages;
                            const metadata = result.metadata;

                            const evalFunctions: EvalRunEvalFunction[] = evalRun.eval_functions;

                            let evalFunctionResults: {
                                test_case_id: string,
                                eval_run_id: string,
                                eval_function_id: string,
                                result: number,
                            }[] = [];

                            for (const evalFunction of evalFunctions) {

                                const evalMethod = evals.find(e => e.id === evalFunction.id);

                                if (!evalMethod) {
                                    throw new Error(`Eval function ${evalFunction.id} not found in the registry, check your code and make sure the eval function is registered correctly.`);
                                }

                                let result: number | undefined;

                                // If queue is defined, schedule the sub-task, and wait for it to 
                                // complete by polling it every 5 seconds.
                                if (evalMethod.queue) {
                                    const queue = await evalMethod.queue;
                                    const jobData: BullMqJobData = {
                                        ...data,
                                        type: "eval_function",
                                        eval_functions: [{
                                            id: evalFunction.id,
                                            config: evalFunction.config || {},
                                        }],
                                        // updating the input messages with the messages we want to run the eval 
                                        // function on, which are the output messages from the agent.
                                        inputs: messages
                                    }

                                    const redisId = uuidv4();
                                    const job = await queue.queue.add("eval_function", jobData, {
                                        jobId: redisId,
                                        // Setting it to 3 as a sensible default, as
                                        // many AI services are quite unstable.
                                        attempts: queue.retries || 3, // todo make this configurable?
                                        removeOnComplete: 5000,
                                        removeOnFail: 5000,
                                        backoff: queue.backoff || {
                                            type: 'exponential',
                                            delay: 2000,
                                        },
                                    });

                                    if (!job.id) {
                                        throw new Error(`Tried to add job to queue ${queue.queue.name} but failed to get the job ID.`);
                                    }

                                    result = await pollJobResult({ queue, jobId: job.id });

                                    const evalFunctionResult = {
                                        test_case_id: testCase.id,
                                        eval_run_id: evalRun.id,
                                        eval_function_id: evalFunction.id,
                                        eval_function_name: evalFunction.name,
                                        eval_function_config: evalFunction.config || {},
                                        result: result || 0
                                    }

                                    console.log(`[EXULU] eval function ${evalFunction.id} result: ${result}`, logMetadata(bullmqJob.name, {
                                        result: result || 0,
                                    }));

                                    evalFunctionResults.push(evalFunctionResult);

                                    // If queue is not defined, execute the eval function directly.
                                    // and use the result immediately below.
                                } else {

                                    result = await evalMethod.run(
                                        agentInstance,
                                        agentBackend,
                                        testCase,
                                        messages,
                                        evalFunction.config || {}
                                    )

                                    const evalFunctionResult = {
                                        test_case_id: testCase.id,
                                        eval_run_id: evalRun.id,
                                        eval_function_id: evalFunction.id,
                                        result: result || 0,
                                    }

                                    evalFunctionResults.push(evalFunctionResult);

                                    console.log(`[EXULU] eval function ${evalFunction.id} result: ${result}`, logMetadata(bullmqJob.name, {
                                        result: result || 0,
                                    }));
                                }
                            }

                            const scores = evalFunctionResults.map(result => result.result);

                            console.log("[EXULU] Exulu eval run scores for test case: " + testCase.id, scores)

                            let score = 0;
                            switch (data.scoring_method?.toLowerCase()) {
                                case "median":
                                    console.log("[EXULU] Calculating median score")
                                    score = getMedian(scores);
                                    break;
                                case "average":
                                    console.log("[EXULU] Calculating average score")
                                    score = getAverage(scores);
                                    break;
                                case "sum":
                                    console.log("[EXULU] Calculating sum score")
                                    score = getSum(scores);
                                    break;
                                default:
                                    console.log("[EXULU] Calculating average score")
                                    score = getAverage(scores);
                            }

                            return {
                                result: score,
                                metadata: {
                                    messages,
                                    function_results: [
                                        ...evalFunctionResults
                                    ],
                                    ...metadata
                                }
                            };
                        }

                        if (data.type === "eval_function") {
                            console.log("[EXULU] running an eval function job.", logMetadata(bullmqJob.name));

                            if (data.eval_functions?.length !== 1) {
                                throw new Error(`Expected 1 eval function for eval function job, got ${data.eval_functions?.length}.`);
                            }

                            const label = `eval-function-${data.eval_run_id}-${data.test_case_id}-${data.eval_functions?.[0]?.id}`;

                            const existingResult = await db.from("job_results").where({ label: label }).first();

                            if (existingResult) {

                                // update existing
                                await db.from("job_results").where({ label: label }).update({
                                    job_id: bullmqJob.id,
                                    label: label,
                                    state: await bullmqJob.getState(),
                                    result: null,
                                    metadata: {},
                                    tries: existingResult.tries + 1
                                });

                            } else {

                                await db.from("job_results").insert({
                                    job_id: bullmqJob.id,
                                    label: label,
                                    state: await bullmqJob.getState(),
                                    result: null,
                                    metadata: {},
                                    tries: 1
                                });

                            }

                            const {
                                evalRun,
                                agentInstance,
                                backend,
                                testCase,
                                messages: inputMessages,
                            } = await validateEvalPayload(data, agents);

                            const evalFunctions: {
                                id: string
                                config: Record<string, any>
                            }[] = evalRun.eval_functions;

                            let result: number | undefined;

                            for (const evalFunction of evalFunctions) {
                                // todo run the eval execute function using the input.messages array and return the numerical result
                                const evalMethod = evals.find(e => e.id === evalFunction.id);

                                if (!evalMethod) {
                                    throw new Error(`Eval function ${evalFunction.id} not found in the registry, check your code and make sure the eval function is registered correctly.`);
                                }

                                result = await evalMethod.run(
                                    agentInstance,
                                    backend,
                                    testCase,
                                    inputMessages,
                                    evalFunction.config || {}
                                )
                                console.log(`[EXULU] eval function ${evalFunction.id} result: ${result}`, logMetadata(bullmqJob.name, {
                                    result: result || 0,
                                }));
                            }

                            return {
                                result,
                                metadata: {}
                            };
                        }

                        if (data.type === "source") {

                            console.log("[EXULU] running a source job.", logMetadata(bullmqJob.name));

                            if (!data.source) {
                                throw new Error(`No source id set for source job.`);
                            }

                            if (!data.context) {
                                throw new Error(`No context id set for source job.`);
                            }

                            const context = contexts.find(c => c.id === data.context);

                            if (!context) {
                                throw new Error(`Context ${data.context} not found in the registry.`);
                            }

                            const source = context.sources.find(s => s.id === data.source);

                            if (!source) {
                                throw new Error(`Source ${data.source} not found in the context ${context.id}.`);
                            }

                            const result = await source.execute(data.inputs);

                            let jobs: string[] = [];
                            let items: string[] = [];

                            for (const item of result) {
                                const { item: createdItem, job } = await context.createItem(
                                    item,
                                    config,
                                    data.user,
                                    data.role,
                                    (item.external_id || item.id) ? true : false
                                );
                                if (job) {
                                    jobs.push(job);
                                    console.log(`[EXULU] Scheduled job through source update job for item ${createdItem.id} (Job ID: ${job})`, logMetadata(bullmqJob.name, {
                                        item: createdItem,
                                        job: job,
                                    }));
                                }
                                if (createdItem.id) {
                                    items.push(createdItem.id);
                                    console.log(`[EXULU] created item through source update job ${createdItem.id}`, logMetadata(bullmqJob.name, {
                                        item: createdItem,
                                    }));
                                }
                            }

                            await updateStatistic({
                                name: "count",
                                label: source.id,
                                type: STATISTICS_TYPE_ENUM.SOURCE_UPDATE as STATISTICS_TYPE,
                                trigger: "api",
                                count: 1,
                                user: data?.user,
                                role: data?.role
                            })

                            return {
                                result,
                                metadata: {
                                    jobs,
                                    items,
                                }
                            };
                        }

                        throw new Error(`Invalid job type: ${data.type} for job ${bullmqJob.name}.`);

                    } catch (error: unknown) {
                        console.error(`[EXULU] job failed.`, error instanceof Error ? error.message : String(error))
                        throw error;
                    }
                })();

                // Race between work and timeout with proper cleanup
                try {
                    const result = await Promise.race([workPromise, timeoutPromise]);
                    // Clear timeout if work completes successfully
                    clearTimeout(timeoutHandle!);
                    return result;
                } catch (error: unknown) {
                    // Clear timeout on error
                    clearTimeout(timeoutHandle!);
                    console.error(`[EXULU] job ${bullmqJob.id} failed (error caught in race handler).`, error instanceof Error ? error.message : String(error));
                    throw error;
                }
            },
            {
                autorun: true,
                connection: redisConnection,
                concurrency: queue.concurrency?.worker || 1,
                removeOnComplete: { count: 1000 },
                removeOnFail: { count: 5000 },
                ...(queue.ratelimit && {
                    limiter: {
                        max: queue.ratelimit,
                        duration: 1000
                    }
                }),
            })

        worker.on('completed', async (job, returnvalue: {
            result: any,
            metadata: any
        }) => {
            console.log(`[EXULU] completed job ${job.id}.`, returnvalue);

            const { db } = await postgresClient();

            await db.from("job_results").where({ job_id: job.id }).update({
                state: JOB_STATUS_ENUM.completed,
                result: returnvalue.result != null ? JSON.stringify(returnvalue.result) : null,
                metadata: returnvalue.metadata != null ? JSON.stringify(returnvalue.metadata) : null,
            });
        });

        worker.on('failed', async (job, error: Error, prev: string) => {
            if (job?.id) {

                const { db } = await postgresClient();

                console.error(`[EXULU] failed job ${job.id}.`, error);

                await db.from("job_results").where({ job_id: job.id }).update({
                    state: JOB_STATUS_ENUM.failed,
                    error,
                });
                return;
            }
            console.error(`[EXULU] job failed.`, job?.name ? logMetadata(job.name, {
                error: error instanceof Error ? error.message : String(error),
            }) : error);
        });

        worker.on('error', (error: Error) => {
            console.error(`[EXULU] worker error.`, error)
        });

        worker.on('progress', (job, progress) => {
            console.log(`[EXULU] job progress ${job.id}.`, logMetadata(job.name, {
                progress: progress,
            }));
        });


        const gracefulShutdown = async (signal) => {
            console.log(`Received ${signal}, closing server...`);
            await worker.close();
            // Other asynchronous closings
            process.exit(0);
        }

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        return worker;
    })

    return workers;
}

const validateEvalPayload = async (data: BullMqJobData, agents: ExuluAgent[]): Promise<{
    agentInstance: Agent,
    backend: ExuluAgent,
    user: User,
    testCase: TestCase,
    evalRun: EvalRun,
    messages: UIMessage[],
}> => {

    if (!data.eval_run_id) {
        throw new Error(`No eval run ID set for eval job.`);
    }

    if (!data.test_case_id) {
        throw new Error(`No test case ID set for eval job.`);
    }

    if (!data.user) {
        throw new Error(`No user set for eval job.`);
    }

    if (!data.role) {
        throw new Error(`No role set for eval job.`);
    }

    if (!data.agent_id) {
        throw new Error(`No agent ID set for eval job.`);
    }

    if (!data.inputs?.length) {
        throw new Error(`No inputs set for eval job, expected array of UIMessage objects.`);
    }

    const { db } = await postgresClient();

    const evalRun = await db.from("eval_runs").where({ id: data.eval_run_id }).first();

    if (!evalRun) {
        throw new Error(`Eval run ${data.eval_run_id} not found in the database.`);
    }

    const agentInstance = await loadAgent(evalRun.agent_id);

    if (!agentInstance) {
        throw new Error(`Agent ${evalRun.agent_id} not found in the database.`);
    }

    const backend = agents.find(a => a.id === agentInstance.backend);

    if (!backend) {
        throw new Error(`Backend ${agentInstance.backend} not found in the database.`);
    }

    const user = await db.from("users").where({ id: data.user }).first();

    if (!user) {
        throw new Error(`User ${data.user} not found in the database.`);
    }

    const testCase = await db.from("test_cases").where({ id: data.test_case_id }).first();

    if (!testCase) {
        throw new Error(`Test case ${data.test_case_id} not found in the database.`);
    }

    return {
        agentInstance,
        backend,
        user,
        testCase,
        evalRun,
        messages: data.inputs,
    };
}

const pollJobResult = async ({ queue, jobId }: { queue: ExuluQueueConfig, jobId: string }): Promise<any> => {
    let attempts = 0;
    let timeoutInSeconds = queue.timeoutInSeconds || 180;
    const startTime = Date.now();

    let result: any;
    while (true) {
        attempts++;

        const job = await Job.fromId(queue.queue, jobId);
        if (!job) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
        }

        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > timeoutInSeconds * 1000) {
            throw new Error(`Job ${job.id} timed out after ${timeoutInSeconds} seconds for job eval function job ${job.name}.`);
        }
        console.log(`[EXULU] polling eval function job ${job.name} for state... (attempt ${attempts})`);
        const jobState: JobState = await job.getState() as JobState;
        console.log(`[EXULU] eval function job ${job.name} state: ${jobState}`);
        if (jobState === "failed") {
            throw new Error(`Job ${job.name} (${job.id}) failed with error: ${job.failedReason}.`);
        }
        if (jobState === "completed") {
            console.log(`[EXULU] eval function job ${job.name} completed, getting result from database...`);
            const { db } = await postgresClient();
            const entry = await db.from("job_results").where({ job_id: job.id }).first();

            console.log("[EXULU] eval function job ${job.name} result", entry);
            result = entry?.result;
            if (
                result === undefined ||
                result === null ||
                result === ""
            ) {
                throw new Error(`Eval function ${job.id} result not found in database 
                    for job eval function job ${job.name}. Entry data from DB: ${JSON.stringify(entry)}.`);
            }
            console.log(`[EXULU] eval function ${job.id} result: ${result}`);
            break;
        }
        // Wait for 2 seconds before polling again
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return result;
}

const processUiMessagesFlow = async ({
    agents,
    agentInstance,
    agentBackend,
    inputMessages,
    contexts,
    user,
    tools,
    config,
}: {
    agents: ExuluAgent[],
    agentInstance: Agent,
    agentBackend: ExuluAgent,
    inputMessages: UIMessage[],
    contexts: ExuluContext[],
    user: User,
    tools: ExuluTool[],
    config: ExuluConfig,
}): Promise<{
    messages: UIMessage[],
    metadata: {
        tokens: {
            totalTokens: number,
            reasoningTokens: number,
            inputTokens: number,
            outputTokens: number,
            cachedInputTokens: number,
        },
        duration: number,
    },
}> => {

    console.log("[EXULU] processing UI messages flow for agent.");
    console.log("[EXULU] input messages", inputMessages);

    // If queue is not defined, execute the eval function directly
    console.log("[EXULU] agent tools", agentInstance.tools?.map(x => x.name + " (" + x.id + ")"))

    const disabledTools = [];
    let enabledTools: ExuluTool[] = await getEnabledTools(agentInstance, tools, disabledTools, agents, user)

    console.log("[EXULU] enabled tools", enabledTools?.map(x => x.name + " (" + x.id + ")"))

    // Get the variable name from user's anthropic_token field
    const variableName = agentInstance.providerapikey;

    // Look up the variable from the variables table
    const { db } = await postgresClient();

    let providerapikey: string | undefined;

    if (variableName) {
        const variable = await db.from("variables").where({ name: variableName }).first();
        if (!variable) {
            throw new Error(`Provider API key variable not found for agent ${agentInstance.name} (${agentInstance.id}).`);
        }

        // Get the API key from the variable (decrypt if encrypted)
        providerapikey = variable.value;

        if (!variable.encrypted) {
            throw new Error(`Provider API key variable not encrypted for agent ${agentInstance.name} (${agentInstance.id}), for security reasons you are only allowed to use encrypted variables for provider API keys.`);
        }

        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            providerapikey = bytes.toString(CryptoJS.enc.Utf8);
        }

    }

    // Remove placeholder agent response before sending
    const messagesWithoutPlaceholder = inputMessages.filter(
        (message) => (message.metadata as any)?.type !== "placeholder"
    );

    console.log("[EXULU] messages without placeholder", messagesWithoutPlaceholder);

    // Iterate through the conversation
    let index = 0;
    let messageHistory: {
        messages: UIMessage[],
        metadata: {
            tokens: {
                totalTokens: number,
                reasoningTokens: number,
                inputTokens: number,
                outputTokens: number,
                cachedInputTokens: number,
            },
            duration: number,
        },
    } = {
        messages: [],
        metadata: {
            tokens: {
                totalTokens: 0,
                reasoningTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
            },
            duration: 0,
        }
    }

    for (const currentMessage of messagesWithoutPlaceholder) {

        console.log("[EXULU] running through the conversation");
        console.log("[EXULU] current index", index);
        console.log("[EXULU] current message", currentMessage);
        console.log("[EXULU] message history", messageHistory);

        const statistics = {
            label: agentInstance.name,
            trigger: "agent" as STATISTICS_LABELS
        }

        messageHistory = await new Promise<{
            messages: UIMessage[],
            metadata: {
                tokens: {
                    totalTokens: number,
                    reasoningTokens: number,
                    inputTokens: number,
                    outputTokens: number,
                    cachedInputTokens: number,
                },
                duration: number,
            },
        }>(async (resolve, reject) => {

            const startTime = Date.now();

            try {

                const result = await agentBackend.generateStream({
                    contexts,
                    user,
                    instructions: agentInstance.instructions,
                    session: undefined,
                    previousMessages: messageHistory.messages,
                    message: currentMessage,
                    currentTools: enabledTools,
                    allExuluTools: tools,
                    providerapikey,
                    toolConfigs: agentInstance.tools,
                    exuluConfig: config
                })

                console.log("[EXULU] consuming stream for agent.");
                const stream = result.stream.toUIMessageStream({
                    messageMetadata: ({ part }) => {
                        console.log("[EXULU] part", part.type);
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
                        console.error("[EXULU] Ui message stream error.", error);
                        reject(error);
                        return `Ui message stream error: ${error instanceof Error ? error.message : String(error)}`;
                    },
                    onFinish: async ({ messages, isContinuation, responseMessage }) => {
                        const metadata = messages[messages.length - 1]?.metadata as any;
                        console.log('[EXULU] Stream finished with messages:', messages);
                        console.log('[EXULU] Stream metadata', metadata);
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
                        resolve({
                            messages,
                            metadata: {
                                tokens: {
                                    totalTokens: messageHistory.metadata.tokens.totalTokens + metadata?.totalTokens,
                                    reasoningTokens: messageHistory.metadata.tokens.reasoningTokens + metadata?.reasoningTokens,
                                    inputTokens: messageHistory.metadata.tokens.inputTokens + metadata?.inputTokens,
                                    outputTokens: messageHistory.metadata.tokens.outputTokens + metadata?.outputTokens,
                                    cachedInputTokens: messageHistory.metadata.tokens.cachedInputTokens + metadata?.cachedInputTokens,
                                },
                                duration: messageHistory.metadata.duration + (Date.now() - startTime),
                            }
                        });
                    },
                })

                // Consume the stream to ensure it runs to completion & triggers onFinish
                for await (const message of stream) {
                    console.log("[EXULU] message", message);
                }

            } catch (error: unknown) {
                console.error(`[EXULU] error generating stream for agent ${agentInstance.name} (${agentInstance.id}).`, error)
                reject(error)
            }
        })
        index++;
    }
    console.log("[EXULU] finished processing UI messages flow for agent, messages result", messageHistory);
    return messageHistory;

}

function getMedian(arr: number[]): number {
    if (arr.length === 0) return 0; // Handle empty array

    // Step 1: Sort the array
    const sortedArr = arr.slice().sort((a, b) => a - b);

    const mid = Math.floor(sortedArr.length / 2);

    // Step 2 & 3: Compute median
    if (sortedArr.length % 2 !== 0) {
        // Odd length
        return sortedArr[mid]!;
    } else {
        // Even length
        return (sortedArr[mid - 1]! + sortedArr[mid]!) / 2;
    }
}

function getSum(arr: number[]): number {
    if (arr.length === 0) return 0; // Handle empty array
    return arr.reduce((a, b) => a + b, 0);
}

function getAverage(arr: number[]): number {
    if (arr.length === 0) return 0; // Handle empty array
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}