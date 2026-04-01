import IORedis from "ioredis";
import { redisServer } from "@EE/queues/server.ts";
import { Job, Worker, type JobState } from "bullmq";
import { bullmq } from "@SRC/validators/bullmq.ts";
import { getEnabledTools } from "@SRC/utils/enabled-tools.ts";
import { ExuluStorage } from "@SRC/exulu/storage.ts";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config.ts";
import { getTableName, type ExuluContext } from "@SRC/exulu/context.ts";
import type { ExuluReranker } from "@SRC/exulu/reranker.ts";
import type { ExuluEval } from "@SRC/exulu/evals.ts";
import type { ExuluTool } from "@SRC/exulu/tool.ts";
import { postgresClient } from "@SRC/postgres/client";
import type { BullMqJobData } from "@EE/queues/decorator.ts";
import { type Tracer } from "@opentelemetry/api";
import { v4 as uuidv4 } from "uuid";
import { type UIMessage } from "ai";
import CryptoJS from "crypto-js";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { User } from "@EXULU_TYPES/models/user";
import type { EvalRun } from "@EXULU_TYPES/models/eval-run";
import type { TestCase } from "@EXULU_TYPES/models/test-case";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import type { EvalRunEvalFunction } from "@EXULU_TYPES/models/eval-run";
import type { ExuluWorkflow } from "@EXULU_TYPES/workflow.ts";
import type { STATISTICS_LABELS } from "@EXULU_TYPES/statistics.ts";
import { sanitizeToolName } from "@SRC/utils/sanitize-tool-name.ts";
import type { ExuluConfig } from "@SRC/exulu/app/index.ts";
import { updateStatistic } from "@SRC/exulu/statistics";
import type { ExuluProvider } from "@SRC/exulu/provider.ts";
import { exuluApp } from "@SRC/exulu/app/singleton";

let redisConnection: IORedis;

// Global handlers to prevent process crashes from unhandled errors
// This is critical for BullMQ workers to properly mark jobs as failed
let unhandledRejectionHandlerInstalled = false;

// Connection pool health monitoring
let poolMonitoringInterval: NodeJS.Timeout | undefined;

const startPoolMonitoring = () => {
  if (poolMonitoringInterval) return;

  poolMonitoringInterval = setInterval(async () => {
    try {
      const { db } = await postgresClient();
      const poolStats = (db.client as any).pool;

      if (poolStats) {
        const used = poolStats.numUsed?.() || 0;
        const free = poolStats.numFree?.() || 0;
        const pending = poolStats.numPendingAcquires?.() || 0;
        const total = used + free;

        console.log("[EXULU] Connection pool health check:", {
          used,
          free,
          pending,
          total,
          utilization: total > 0 ? `${Math.round((used / total) * 100)}%` : "0%",
        });

        // Warn if pool is under pressure
        if (pending > 10) {
          console.warn(
            `[EXULU] WARNING: ${pending} jobs waiting for database connections. Consider increasing pool size or reducing worker concurrency.`,
          );
        }
      }
    } catch (error) {
      console.error("[EXULU] Error checking pool health:", error);
    }
  }, 30000); // Check every 30 seconds
};

const installGlobalErrorHandlers = () => {
  if (unhandledRejectionHandlerInstalled) return;

  process.on("unhandledRejection", (reason: any) => {
    console.error(
      "[EXULU] Unhandled Promise Rejection detected! This would have crashed the worker.",
      {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      },
    );
    // Don't exit - let the worker continue and BullMQ will handle job failure
  });

  process.on("uncaughtException", (error: Error) => {
    console.error("[EXULU] Uncaught Exception detected! This would have crashed the worker.", {
      error: error.message,
      stack: error.stack,
    });
    // Don't exit for database timeouts and similar recoverable errors
    // Only exit for truly fatal errors
    if (error.message.includes("FATAL") || error.message.includes("Cannot find module")) {
      console.error("[EXULU] Fatal error detected, exiting process.");
      process.exit(1);
    }
  });

  unhandledRejectionHandlerInstalled = true;
  console.log("[EXULU] Global error handlers installed to prevent worker crashes");
};

// Track if shutdown is in progress to prevent duplicate shutdown attempts
let isShuttingDown = false;

export const createWorkers = async (
  providers: ExuluProvider[],
  queues: ExuluQueueConfig[],
  config: ExuluConfig,
  contexts: ExuluContext[],
  rerankers: ExuluReranker[],
  evals: ExuluEval[],
  tools: ExuluTool[],
  tracer?: Tracer,
) => {
  console.log("[EXULU] creating workers for " + queues?.length + " queues.");
  console.log(
    "[EXULU] queues",
    queues.map((q) => q.queue.name),
  );
  // Initializes any required workers for processing embedder
  // and agent jobs in the defined queues by checking the registry.

  // Install global error handlers to prevent crashes
  installGlobalErrorHandlers();

  // Start connection pool monitoring
  startPoolMonitoring();

  // Increase max listeners to accommodate multiple workers
  // We only add 2 signal handlers total (not per worker), so this is conservative
  process.setMaxListeners(Math.max(15, process.getMaxListeners()));

  if (!redisServer.host || !redisServer.port) {
    console.error(
      "[EXULU] you are trying to start worker, but no redis server is configured in the environment.",
    );
    throw new Error("No redis server configured in the environment, so cannot start worker.");
  }

  if (!redisConnection) {
    let url = "";
    if (redisServer.username) {
      url = `redis://${redisServer.username}:${redisServer.password}@${redisServer.host}:${redisServer.port}`;
    } else {
      url = `redis://${redisServer.host}:${redisServer.port}`;
    }

    redisConnection = new IORedis(url, {
      enableOfflineQueue: true,
      retryStrategy: function (times: number) {
        return Math.max(Math.min(Math.exp(times), 20000), 1000);
      },
      maxRetriesPerRequest: null,
    });
  }

  const workers = queues.map((queue) => {
    console.log(`[EXULU] creating worker for queue ${queue.queue.name}.`);

    const worker = new Worker(
      `${queue.queue.name}`,
      async (
        bullmqJob: Job,
      ): Promise<{
        result: any;
        metadata: any;
      }> => {
        console.log("[EXULU] starting execution for job", {
          name: bullmqJob.name,
          jobId: bullmqJob.id,
          status: await bullmqJob.getState(),
          type: bullmqJob.data.type,
        });

        // For long-running processor jobs, set up progress heartbeat to prevent stalling
        let progressInterval: NodeJS.Timeout | undefined;
        if (bullmqJob.data.type === "processor") {
          // Update progress every 25 seconds to keep the job alive
          // This prevents BullMQ from marking the job as stalled during long-running operations
          progressInterval = setInterval(async () => {
            try {
              await bullmqJob.updateProgress({
                status: "processing",
                timestamp: new Date().toISOString(),
              });
              console.log(`[EXULU] Job ${bullmqJob.id} heartbeat sent to prevent stalling`);
            } catch (error) {
              console.error(`[EXULU] Error updating job progress:`, error);
            }
          }, 25000); // Update every 25 seconds (less than the default 30s stalled interval)
        }

        // Acquire database connection with retry logic for high concurrency scenarios
        let db: any;
        let retries = 3;
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            const client = await postgresClient();
            db = client.db;

            // Log pool stats for monitoring
            const poolStats = (db.client as any).pool;
            if (poolStats) {
              console.log(`[EXULU] Connection pool stats for job ${bullmqJob.id}:`, {
                size: poolStats.numUsed?.() || 0,
                available: poolStats.numFree?.() || 0,
                pending: poolStats.numPendingAcquires?.() || 0,
              });
            }
            break;
          } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.error(
              `[EXULU] Failed to acquire database connection (attempt ${attempt}/${retries}) for job ${bullmqJob.id}:`,
              lastError.message,
            );

            if (attempt < retries) {
              // Exponential backoff: 500ms, 1000ms, 2000ms
              const backoffMs = 500 * Math.pow(2, attempt - 1);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }
        }

        if (!db) {
          throw new Error(
            `Failed to acquire database connection after ${retries} attempts: ${lastError?.message}`,
          );
        }

        // Type casting data here, couldn't get it to merge
        // on the main object while keeping auto completion.
        const data: BullMqJobData = bullmqJob.data;

        const timeoutInSeconds = data.timeoutInSeconds || queue.timeoutInSeconds || 600;
        // Create timeout promise with proper error handling
        const timeoutMs = timeoutInSeconds * 1000;
        let timeoutHandle: NodeJS.Timeout;
        const timeoutPromise: Promise<{
          result: any;
          metadata: any;
        }> = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            const timeoutError = new Error(
              `Timeout for job ${bullmqJob.id} reached after ${timeoutInSeconds}s`,
            );
            console.error(`[EXULU] ${timeoutError.message}`);
            reject(timeoutError);
          }, timeoutMs);
        });

        // Wrap the actual work in a promise
        const workPromise: Promise<{
          result: any;
          metadata: any;
        }> = (async () => {
          try {
            console.log(
              `[EXULU] Job ${bullmqJob.id} - Log file: logs/jobs/job-${bullmqJob.id}.log`,
            );
            bullmq.validate(bullmqJob.id, data);

            if (data.type === "embedder") {
              console.log("[EXULU] running an embedder job.", bullmqJob.name);

              const label = `embedder-${bullmqJob.name}`;

              await db.from("job_results").insert({
                job_id: bullmqJob.id,
                label: label,
                state: await bullmqJob.getState(),
                result: null,
                metadata: {},
              });

              const context = contexts.find((context) => context.id === data.context);

              if (!context) {
                throw new Error(`Context ${data.context} not found in the registry.`);
              }

              if (!data.embedder) {
                throw new Error(`No embedder set for embedder job.`);
              }

              const embedder = contexts.find((context) => context.embedder?.id === data.embedder);

              if (!embedder) {
                throw new Error(`Embedder ${data.embedder} not found in the registry.`);
              }

              const result = await context.createAndUpsertEmbeddings(
                data.inputs,
                config,
                data.user,
                {
                  label: embedder.name,
                  trigger: data.trigger,
                },
                data.role,
                bullmqJob.id,
              );

              return {
                result,
                metadata: {},
              };
            }

            if (data.type === "processor") {
              console.log(
                "[EXULU] running a processor job, job name: ",
                bullmqJob.name,
                " job id: ",
                bullmqJob.id,
                " job data: ",
                data,
                " job queue: ",
                bullmqJob.queueName,
              );

              const label = `processor-${bullmqJob.name}`;

              await db.from("job_results").insert({
                job_id: bullmqJob.id,
                label: label,
                state: await bullmqJob.getState(),
                result: null,
                metadata: {},
              });

              const context = contexts.find((context) => context.id === data.context);

              if (!context) {
                throw new Error(`Context ${data.context} not found in the registry.`);
              }

              if (!data.inputs.id) {
                throw new Error(
                  `[EXULU] Item not set for processor in context ${context.id}, running in job ${bullmqJob.id}.`,
                );
              }

              if (!context.processor) {
                throw new Error(
                  `Tried to run a processor job for context ${context.id}, but no processor is set.`,
                );
              }

              const exuluStorage = new ExuluStorage({ config });

              if (context.processor.filter) {
                const result = await context.processor.filter({
                  item: data.inputs,
                  user: data.user,
                  role: data.role,
                  utils: {
                    storage: exuluStorage,
                  },
                  exuluConfig: config,
                });
          
                if (!result) {
                  console.log("[EXULU] Item filtered out by processor, skipping processing execution...");
                  return {
                    result: "Item filtered out by processor, skipping processing execution...", // last message
                    metadata: {
                      item: {
                        name: data.inputs?.name,
                        id: data.inputs?.id,
                        external_id: data.inputs?.external_id
                      }
                    },
                  };
                }
              }

              console.log("[EXULU] POS 2 -- EXULU CONTEXT PROCESS FIELD", data.inputs);
              let processorResult = await context.processor.execute({
                item: data.inputs,
                user: data.user,
                role: data.role,
                utils: {
                  storage: exuluStorage,
                },
                exuluConfig: config,
              });

              if (!processorResult) {
                throw new Error(
                  `[EXULU] Processor in context ${context.id}, running in job ${bullmqJob.id} did not return an item.`,
                );
              }

              // The field key is used to define a processor, but is
              // not part of the database, so remove it here before
              // we upadte the item in the db.
              delete processorResult.field;

              // Memory optimization: For large processor results (e.g., documents),
              // extract only the fields we need for the database update to avoid
              // keeping the entire large object in memory
              const updateData = { ...processorResult };

              // Update the item in the db with the processor result
              await db
                .from(getTableName(context.id))
                .where({
                  id: processorResult.id,
                })
                .update({
                  ...updateData,
                  last_processed_at: new Date().toISOString(),
                });

              // Clear the updateData to help GC
              Object.keys(updateData).forEach(key => {
                delete (updateData as any)[key];
              });

              let jobs: string[] = [];
              if (context.processor?.config?.generateEmbeddings) {
                // If the processor was configured to automatically trigger
                // the generation of embeddings, we trigger it here.
                // IMPORTANT: We need to fetch the complete item from the database
                // to ensure we have all fields (especially external_id) for embeddings
                const fullItem = await db
                  .from(getTableName(context.id))
                  .where({
                    id: processorResult.id,
                  })
                  .first();

                if (!fullItem) {
                  throw new Error(
                    `[EXULU] Item ${processorResult.id} not found after processor update in context ${context.id}`,
                  );
                }

                const { job: embeddingsJob } = await context.embeddings.generate.one({
                  item: fullItem,
                  user: data.user,
                  role: data.role,
                  trigger: "processor",
                  config,
                });

                if (embeddingsJob) {
                  jobs.push(embeddingsJob);
                }
              }

              // Create minimal return object to reduce memory footprint
              const result = {
                result: { id: processorResult.id },
                metadata: {
                  jobs: jobs.length > 0 ? jobs.join(",") : undefined,
                },
              };

              // Clear large objects to help natural GC
              // Setting to null breaks references, allowing V8 to collect on next cycle
              processorResult = null as any;

              // Log memory usage for monitoring without forcing GC
              const memUsage = process.memoryUsage();
              console.log(
                `[EXULU] Memory after processor job ${bullmqJob.id}: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
              );

              return result;
            }

            if (data.type === "workflow") {
              console.log("[EXULU] running a workflow job.", bullmqJob.name);

              const label = `workflow-run-${data.workflow}`;

              await db.from("job_results").insert({
                job_id: bullmqJob.id,
                label: label,
                state: await bullmqJob.getState(),
                result: null,
                metadata: {},
                tries: 1,
              });

              const {
                agent,
                provider,
                user,
                messages: inputMessages,
              } = await validateWorkflowPayload(data, providers);

              const retries = 3;
              let attempts = 0;

              // todo allow setting queue on agent provider and then create a job with type "agent"
              const promise = new Promise<{
                messages: UIMessage[];
                metadata: {
                  tokens: {
                    totalTokens: number;
                    reasoningTokens: number;
                    inputTokens: number;
                    outputTokens: number;
                    cachedInputTokens: number;
                  };
                  duration: number;
                };
              }>(async (resolve, reject) => {
                while (attempts < retries) {
                  try {
                    const messages = await processUiMessagesFlow({
                      providers,
                      agent,
                      provider,
                      inputMessages,
                      contexts,
                      rerankers,
                      user,
                      tools,
                      config,
                      variables: data.inputs,
                    });
                    resolve(messages);
                    break;
                  } catch (error: unknown) {
                    console.error(
                      `[EXULU] error processing UI messages flow for agent ${agent.name} (${agent.id}).`,
                      error instanceof Error ? error.message : String(error),
                    );
                    attempts++;
                    if (attempts >= retries) {
                      reject(new Error(error instanceof Error ? error.message : String(error)));
                    }
                    await new Promise((resolve) => setTimeout((resolve) => resolve(true), 2000));
                  }
                }
              });

              const result = await promise;
              const messages = result.messages;
              const metadata = result.metadata;

              return {
                result: messages[messages.length - 1], // last message
                metadata: {
                  messages,
                  ...metadata,
                },
              };
            }

            if (data.type === "eval_run") {
              console.log("[EXULU] running an eval run job.", bullmqJob.name);

              const label = `eval-run-${data.eval_run_id}-${data.test_case_id}`;

              const existingResult = await db.from("job_results").where({ label: label }).first();

              if (existingResult) {
                // update existing
                console.log("[EXULU] found existing job result, so ");
                await db
                  .from("job_results")
                  .where({ label: label })
                  .update({
                    job_id: bullmqJob.id,
                    label: label,
                    state: await bullmqJob.getState(),
                    result: null,
                    metadata: {},
                    tries: existingResult.tries + 1,
                  });
              } else {
                await db.from("job_results").insert({
                  job_id: bullmqJob.id,
                  label: label,
                  state: await bullmqJob.getState(),
                  result: null,
                  metadata: {},
                  tries: 1,
                });
              }

              const {
                agent,
                provider,
                user,
                evalRun,
                testCase,
                messages: inputMessages,
              } = await validateEvalPayload(data, providers);

              const retries = 3;
              let attempts = 0;

              // todo allow setting queue on agent Provider and then create a job with type "agent"
              const promise = new Promise<{
                messages: UIMessage[];
                metadata: {
                  tokens: {
                    totalTokens: number;
                    reasoningTokens: number;
                    inputTokens: number;
                    outputTokens: number;
                    cachedInputTokens: number;
                  };
                  duration: number;
                };
              }>(async (resolve, reject) => {
                while (attempts < retries) {
                  try {
                    const messages = await processUiMessagesFlow({
                      providers,
                      agent,
                      provider,
                      inputMessages,
                      contexts,
                      rerankers,
                      user,
                      tools,
                      config,
                    });
                    resolve(messages);
                    break;
                  } catch (error: unknown) {
                    console.error(
                      `[EXULU] error processing UI messages flow for agent ${agent.name} (${agent.id}).`,
                      error instanceof Error ? error.message : String(error),
                    );
                    attempts++;
                    if (attempts >= retries) {
                      reject(new Error(error instanceof Error ? error.message : String(error)));
                    }
                    await new Promise((resolve) => setTimeout((resolve) => resolve(true), 2000));
                  }
                }
              });

              const result = await promise;
              const messages = result.messages;
              const metadata = result.metadata;

              const evalFunctions: EvalRunEvalFunction[] = evalRun.eval_functions;

              let evalFunctionResults: {
                test_case_id: string;
                eval_run_id: string;
                eval_function_id: string;
                result: number;
              }[] = [];

              for (const evalFunction of evalFunctions) {
                const evalMethod = evals.find((e) => e.id === evalFunction.id);

                if (!evalMethod) {
                  throw new Error(
                    `Eval function ${evalFunction.id} not found in the registry, check your code and make sure the eval function is registered correctly.`,
                  );
                }

                let result: number | undefined;

                // If queue is defined, schedule the sub-task, and wait for it to
                // complete by polling it every 5 seconds.
                if (evalMethod.queue) {
                  const queue = await evalMethod.queue;
                  const jobData: BullMqJobData = {
                    ...data,
                    type: "eval_function",
                    eval_functions: [
                      {
                        id: evalFunction.id,
                        config: evalFunction.config || {},
                      },
                    ],
                    // updating the input messages with the messages we want to run the eval
                    // function on, which are the output messages from the agent.
                    inputs: messages,
                  };

                  const redisId = uuidv4();
                  const job = await queue.queue.add("eval_function", jobData, {
                    jobId: redisId,
                    // Setting it to 3 as a sensible default, as
                    // many AI services are quite unstable.
                    attempts: queue.retries || 3, // todo make this configurable?
                    removeOnComplete: 5000,
                    removeOnFail: 5000,
                    backoff: queue.backoff || {
                      type: "exponential",
                      delay: 2000,
                    },
                  });

                  if (!job.id) {
                    throw new Error(
                      `Tried to add job to queue ${queue.queue.name} but failed to get the job ID.`,
                    );
                  }

                  result = await pollJobResult({ queue, jobId: job.id });

                  const evalFunctionResult = {
                    test_case_id: testCase.id,
                    eval_run_id: evalRun.id,
                    eval_function_id: evalFunction.id,
                    eval_function_name: evalFunction.name,
                    eval_function_config: evalFunction.config || {},
                    result: result || 0,
                  };

                  console.log(`[EXULU] eval function ${evalFunction.id} result: ${result}`, {
                    result: result || 0,
                  });

                  evalFunctionResults.push(evalFunctionResult);

                  // If queue is not defined, execute the eval function directly.
                  // and use the result immediately below.
                } else {
                  result = await evalMethod.run(
                    agent,
                    provider,
                    testCase,
                    messages,
                    evalFunction.config || {},
                  );

                  const evalFunctionResult = {
                    test_case_id: testCase.id,
                    eval_run_id: evalRun.id,
                    eval_function_id: evalFunction.id,
                    result: result || 0,
                  };

                  evalFunctionResults.push(evalFunctionResult);

                  console.log(`[EXULU] eval function ${evalFunction.id} result: ${result}`, {
                    result: result || 0,
                  });
                }
              }

              const scores = evalFunctionResults.map((result) => result.result);

              console.log("[EXULU] Exulu eval run scores for test case: " + testCase.id, scores);

              let score = 0;
              switch (data.scoring_method?.toLowerCase()) {
                case "median":
                  console.log("[EXULU] Calculating median score");
                  score = getMedian(scores);
                  break;
                case "average":
                  console.log("[EXULU] Calculating average score");
                  score = getAverage(scores);
                  break;
                case "sum":
                  console.log("[EXULU] Calculating sum score");
                  score = getSum(scores);
                  break;
                default:
                  console.log("[EXULU] Calculating average score");
                  score = getAverage(scores);
              }

              return {
                result: score,
                metadata: {
                  messages,
                  function_results: [...evalFunctionResults],
                  ...metadata,
                },
              };
            }

            if (data.type === "eval_function") {
              console.log("[EXULU] running an eval function job.", bullmqJob.name);

              if (data.eval_functions?.length !== 1) {
                throw new Error(
                  `Expected 1 eval function for eval function job, got ${data.eval_functions?.length}.`,
                );
              }

              const label = `eval-function-${data.eval_run_id}-${data.test_case_id}-${data.eval_functions?.[0]?.id}`;

              const existingResult = await db.from("job_results").where({ label: label }).first();

              if (existingResult) {
                // update existing
                await db
                  .from("job_results")
                  .where({ label: label })
                  .update({
                    job_id: bullmqJob.id,
                    label: label,
                    state: await bullmqJob.getState(),
                    result: null,
                    metadata: {},
                    tries: existingResult.tries + 1,
                  });
              } else {
                await db.from("job_results").insert({
                  job_id: bullmqJob.id,
                  label: label,
                  state: await bullmqJob.getState(),
                  result: null,
                  metadata: {},
                  tries: 1,
                });
              }

              const {
                evalRun,
                agent,
                provider,
                testCase,
                messages: inputMessages,
              } = await validateEvalPayload(data, providers);

              const evalFunctions: {
                id: string;
                config: Record<string, any>;
              }[] = evalRun.eval_functions;

              let result: number | undefined;

              for (const evalFunction of evalFunctions) {
                // todo run the eval execute function using the input.messages array and return the numerical result
                const evalMethod = evals.find((e) => e.id === evalFunction.id);

                if (!evalMethod) {
                  throw new Error(
                    `Eval function ${evalFunction.id} not found in the registry, check your code and make sure the eval function is registered correctly.`,
                  );
                }

                result = await evalMethod.run(
                  agent,
                  provider,
                  testCase,
                  inputMessages,
                  evalFunction.config || {},
                );
                console.log(`[EXULU] eval function ${evalFunction.id} result: ${result}`, {
                  result: result || 0,
                });
              }

              return {
                result,
                metadata: {},
              };
            }

            if (data.type === "source") {
              console.log("[EXULU] running a source job.", bullmqJob.name);

              if (!data.source) {
                throw new Error(`No source id set for source job.`);
              }

              if (!data.context) {
                throw new Error(`No context id set for source job.`);
              }

              const context = contexts.find((c) => c.id === data.context);

              if (!context) {
                throw new Error(`Context ${data.context} not found in the registry.`);
              }

              const source = context.sources.find((s) => s.id === data.source);

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
                  item.external_id || item.id ? true : false,
                );
                if (job) {
                  jobs.push(job);
                  console.log(
                    `[EXULU] Scheduled job through source update job for item ${createdItem.id} (Job ID: ${job})`,
                    {
                      item: createdItem,
                      job: job,
                    },
                  );
                }
                if (createdItem.id) {
                  items.push(createdItem.id);
                  console.log(`[EXULU] created item through source update job ${createdItem.id}`, {
                    item: createdItem,
                  });
                }
              }

              await updateStatistic({
                name: "count",
                label: source.id,
                type: STATISTICS_TYPE_ENUM.SOURCE_UPDATE as STATISTICS_TYPE,
                trigger: "api",
                count: 1,
                user: data?.user,
                role: data?.role,
              });

              return {
                result,
                metadata: {
                  jobs,
                  items,
                },
              };
            }

            throw new Error(`Invalid job type: ${data.type} for job ${bullmqJob.name}.`);
          } catch (error: unknown) {
            console.error(
              `[EXULU] job failed.`,
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        })();

        // Race between work and timeout with proper cleanup
        try {
          const result = await Promise.race([workPromise, timeoutPromise]);
          // Clear timeout if work completes successfully
          clearTimeout(timeoutHandle!);
          // Clear progress interval for processor jobs
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          return result;
        } catch (error: unknown) {
          // Clear timeout on error
          clearTimeout(timeoutHandle!);
          // Clear progress interval for processor jobs
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          console.error(
            `[EXULU] job ${bullmqJob.id} failed (error caught in race handler).`,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      },
      {
        autorun: true,
        connection: redisConnection,
        concurrency: queue.concurrency?.worker || 1,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
        // Configure settings for long-running jobs (especially processor jobs)
        // lockDuration: How long a worker can hold a job before it's considered stalled
        // Set to 5 minutes to accommodate CPU-intensive operations
        lockDuration: 300000, // 5 minutes in milliseconds
        // stalledInterval: How often to check for stalled jobs
        // Set to 2 minutes to reduce false positives for long-running operations
        stalledInterval: 120000, // 2 minutes in milliseconds
        maxStalledCount: 1,
        ...(queue.ratelimit && {
          limiter: {
            max: queue.ratelimit,
            duration: 1000,
          },
        }),
      },
    );

    worker.on(
      "completed",
      async (
        job,
        returnvalue: {
          result: any;
          metadata: any;
        },
      ) => {
        console.log(`[EXULU] completed job ${job.id}.`, returnvalue);

        const { db } = await postgresClient();

        await db
          .from("job_results")
          .where({ job_id: job.id })
          .update({
            state: JOB_STATUS_ENUM.completed,
            result: returnvalue.result != null ? JSON.stringify(returnvalue.result) : null,
            metadata: returnvalue.metadata != null ? JSON.stringify(returnvalue.metadata) : null,
          });
      },
    );

    worker.on("failed", async (job, error: Error, prev: string) => {
      if (job?.id) {
        const { db } = await postgresClient();

        console.error(`[EXULU] failed job ${job.id}.`, error);

        await db.from("job_results").where({ job_id: job.id }).update({
          state: JOB_STATUS_ENUM.failed,
          error,
        });
        return;
      }
      console.error(
        `[EXULU] job failed.`,
        job?.name
          ? {
              error: error instanceof Error ? error.message : String(error),
            }
          : error,
      );
      throw error;
    });

    worker.on("error", (error: Error) => {
      console.error(`[EXULU] worker error.`, error);
      throw error;
    });

    worker.on("progress", (job, progress) => {
      console.log(`[EXULU] job progress ${job.id}.`, job.name, {
        progress: progress,
      });
    });

    return worker;
  });

  // Centralized graceful shutdown handler - only attached ONCE for all workers
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
      console.log(`[EXULU] Shutdown already in progress, ignoring additional ${signal}`);
      return;
    }

    isShuttingDown = true;
    console.log(`[EXULU] Received ${signal}, shutting down gracefully...`);

    try {
      // Clear pool monitoring interval
      if (poolMonitoringInterval) {
        clearInterval(poolMonitoringInterval);
        poolMonitoringInterval = undefined;
      }

      // Close all workers concurrently with timeout
      console.log(`[EXULU] Closing ${workers.length} worker(s)...`);
      const closePromises = workers.map(async (worker, index) => {
        try {
          // Wait for current job to finish, but timeout after 30 seconds
          await Promise.race([
            worker.close(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Worker close timeout")), 30000),
            ),
          ]);
          console.log(`[EXULU] Worker ${index + 1} closed successfully`);
        } catch (error) {
          console.error(`[EXULU] Error closing worker ${index + 1}:`, error);
        }
      });

      await Promise.allSettled(closePromises);

      // Close Redis connection
      if (redisConnection) {
        console.log(`[EXULU] Closing Redis connection...`);
        await redisConnection.quit();
      }

      // Close database connection pool
      try {
        const { db } = await postgresClient();
        if (db?.client) {
          console.log(`[EXULU] Closing database connection pool...`);
          await db.client.destroy();
        }
      } catch (error) {
        console.error(`[EXULU] Error closing database:`, error);
      }

      console.log(`[EXULU] Graceful shutdown complete`);
      process.exit(0);
    } catch (error) {
      console.error(`[EXULU] Error during graceful shutdown:`, error);
      process.exit(1);
    }
  };

  // Register shutdown handlers ONCE for all workers
  process.once("SIGINT", () => gracefulShutdown("SIGINT"));
  process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

  return workers;
};

export const validateWorkflowPayload = async (
  data: BullMqJobData,
  providers: ExuluProvider[],
): Promise<{
  agent: ExuluAgent;
  provider: ExuluProvider;
  user: User;
  workflow: ExuluWorkflow;
  variables: Record<string, any>;
  messages: UIMessage[];
}> => {
  if (!data.workflow) {
    throw new Error(`No workflow ID set for workflow job.`);
  }

  if (!data.user) {
    throw new Error(`No user set for workflow job.`);
  }

  if (!data.role) {
    throw new Error(`No role set for workflow job.`);
  }

  const { db } = await postgresClient();

  const workflow = await db.from("workflow_templates").where({ id: data.workflow }).first();

  if (!workflow) {
    throw new Error(`Workflow ${data.workflow} not found in the database.`);
  }

  const agent = await exuluApp.get().agent(workflow.agent);

  if (!agent) {
    throw new Error(`Agent ${workflow.agent} not found in the database.`);
  }

  const provider = providers.find((a) => a.id === agent.provider);

  if (!provider) {
    throw new Error(`Provider ${agent.provider} not found in the database.`);
  }

  const user = await db.from("users").where({ id: data.user }).first();

  if (!user) {
    throw new Error(`User ${data.user} not found in the database.`);
  }

  return {
    agent,
    provider,
    user,
    workflow,
    variables: data.inputs,
    messages: workflow.steps_json,
  };
};

const validateEvalPayload = async (
  data: BullMqJobData,
  providers: ExuluProvider[],
): Promise<{
  agent: ExuluAgent;
  provider: ExuluProvider;
  user: User;
  testCase: TestCase;
  evalRun: EvalRun;
  messages: UIMessage[];
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

  const agent = await exuluApp.get().agent(evalRun.agent_id);

  if (!agent) {
    throw new Error(`Agent ${evalRun.agent_id} not found in the database.`);
  }

  const provider = providers.find((a) => a.id === agent.provider);

  if (!provider) {
    throw new Error(`Provider ${agent.provider} not found in the database.`);
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
    agent,
    provider,
    user,
    testCase,
    evalRun,
    messages: data.inputs,
  };
};

const pollJobResult = async ({
  queue,
  jobId,
}: {
  queue: ExuluQueueConfig;
  jobId: string;
}): Promise<any> => {
  let attempts = 0;
  let timeoutInSeconds = queue.timeoutInSeconds || 180;
  const startTime = Date.now();

  let result: any;
  while (true) {
    attempts++;

    const job = await Job.fromId(queue.queue, jobId);
    if (!job) {
      await new Promise((resolve) => setTimeout((resolve) => resolve(true), 2000));
      continue;
    }

    const elapsedTime = Date.now() - startTime;
    if (elapsedTime > timeoutInSeconds * 1000) {
      throw new Error(
        `Job ${job.id} timed out after ${timeoutInSeconds} seconds for job eval function job ${job.name}.`,
      );
    }
    console.log(`[EXULU] polling eval function job ${job.name} for state... (attempt ${attempts})`);
    const jobState: JobState = (await job.getState()) as JobState;
    console.log(`[EXULU] eval function job ${job.name} state: ${jobState}`);
    if (jobState === "failed") {
      throw new Error(`Job ${job.name} (${job.id}) failed with error: ${job.failedReason}.`);
    }
    if (jobState === "completed") {
      console.log(
        `[EXULU] eval function job ${job.name} completed, getting result from database...`,
      );
      const { db } = await postgresClient();
      const entry = await db.from("job_results").where({ job_id: job.id }).first();

      console.log("[EXULU] eval function job ${job.name} result", entry);
      result = entry?.result;
      if (result === undefined || result === null || result === "") {
        throw new Error(`Eval function ${job.id} result not found in database 
                    for job eval function job ${job.name}. Entry data from DB: ${JSON.stringify(entry)}.`);
      }
      console.log(`[EXULU] eval function ${job.id} result: ${result}`);
      break;
    }
    // Wait for 2 seconds before polling again
    await new Promise((resolve) => setTimeout((resolve) => resolve(true), 2000));
  }
  return result;
};

export const processUiMessagesFlow = async ({
  providers,
  agent,
  provider,
  inputMessages,
  contexts,
  rerankers,
  user,
  tools,
  config,
  variables,
}: {
  providers: ExuluProvider[];
  agent: ExuluAgent;
  provider: ExuluProvider;
  inputMessages: UIMessage[];
  contexts: ExuluContext[];
  rerankers: ExuluReranker[];
  user: User;
  tools: ExuluTool[];
  config: ExuluConfig;
  variables?: Record<string, any>;
}): Promise<{
  messages: UIMessage[];
  metadata: {
    tokens: {
      totalTokens: number;
      reasoningTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
    };
    duration: number;
  };
}> => {
  console.log("[EXULU] processing UI messages flow for agent.");
  console.log("[EXULU] input messages", inputMessages);

  // If queue is not defined, execute the eval function directly
  console.log(
    "[EXULU] agent tools",
    agent.tools?.map((x) => x.name + " (" + x.id + ")"),
  );

  const disabledTools = [];
  let enabledTools: ExuluTool[] = await getEnabledTools(
    agent,
    tools,
    contexts,
    rerankers,
    disabledTools,
    providers,
    user,
  );

  console.log(
    "[EXULU] enabled tools",
    enabledTools?.map((x) => x.name + " (" + x.id + ")"),
  );

  // Get the variable name from user's anthropic_token field
  const variableName = agent.providerapikey;

  // Look up the variable from the variables table
  const { db } = await postgresClient();

  let providerapikey: string | undefined;

  if (variableName) {
    const variable = await db.from("variables").where({ name: variableName }).first();
    if (!variable) {
      throw new Error(
        `Provider API key variable not found for agent ${agent.name} (${agent.id}).`,
      );
    }

    // Get the API key from the variable (decrypt if encrypted)
    providerapikey = variable.value;

    if (!variable.encrypted) {
      throw new Error(
        `Provider API key variable not encrypted for agent ${agent.name} (${agent.id}), for security reasons you are only allowed to use encrypted variables for provider API keys.`,
      );
    }

    if (variable.encrypted) {
      const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
      providerapikey = bytes.toString(CryptoJS.enc.Utf8);
    }
  }

  // Remove placeholder agent response before sending
  const messagesWithoutPlaceholder = inputMessages.filter(
    (message) => (message.metadata as any)?.type !== "placeholder",
  );

  console.log("[EXULU] messages without placeholder", messagesWithoutPlaceholder);

  // Iterate through the conversation
  let index = 0;
  let messageHistory: {
    messages: UIMessage[];
    metadata: {
      tokens: {
        totalTokens: number;
        reasoningTokens: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
      };
      duration: number;
    };
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
    },
  };

  console.log("[EXULU] variables", variables);
  for (const currentMessage of messagesWithoutPlaceholder) {
    console.log("[EXULU] running through the conversation");
    console.log("[EXULU] current index", index);
    console.log("[EXULU] current message", currentMessage);
    console.log("[EXULU] message history", messageHistory);

    // Identify {variable_name} in the current message parts
    // Replace them with the values in variables
    // If any are missing, throw an error
    for (const part of currentMessage.parts) {
      if (part.type === "text") {
        const text = part.text;
        const variableNames = [...text.matchAll(/{([^}]+)}/g)].map((match) => match[1]);
        if (variableNames) {
          for (const variableName of variableNames) {
            if (!variableName) {
              continue;
            }
            console.log("[EXULU] variableName", variableName);
            const variableValue = variables?.[variableName];
            console.log("[EXULU] variableValue", variableValue);
            if (variableValue) {
              part.text = part.text.replaceAll(`{${variableName}}`, variableValue);
            } else {
              throw new Error(
                `Value for variable ${variableName} not provided in variables for processing message flow. Either remove it from the messages, or provide it as an argument.`,
              );
            }
          }
        }
      }
    }

    const statistics = {
      label: agent.name,
      trigger: "agent" as STATISTICS_LABELS,
    };

    messageHistory = await new Promise<{
      messages: UIMessage[];
      metadata: {
        tokens: {
          totalTokens: number;
          reasoningTokens: number;
          inputTokens: number;
          outputTokens: number;
          cachedInputTokens: number;
        };
        duration: number;
      };
    }>(async (resolve, reject) => {
      const startTime = Date.now();

      try {
        const result = await provider.generateStream({
          contexts,
          rerankers,
          agent: agent,
          user,
          approvedTools: tools.map((tool) => "tool-" + sanitizeToolName(tool.name)),
          instructions: agent.instructions,
          session: undefined,
          previousMessages: messageHistory.messages,
          message: currentMessage,
          currentTools: enabledTools,
          allExuluTools: tools,
          providerapikey,
          toolConfigs: agent.tools,
          exuluConfig: config,
        });

        console.log("[EXULU] consuming stream for agent.");
        const stream = result.stream.toUIMessageStream({
          messageMetadata: ({ part }) => {
            console.log("[EXULU] part", part.type);
            if (part.type === "finish") {
              return {
                totalTokens: part.totalUsage.totalTokens,
                reasoningTokens: part.totalUsage.reasoningTokens,
                inputTokens: part.totalUsage.inputTokens,
                outputTokens: part.totalUsage.outputTokens,
                cachedInputTokens: part.totalUsage.cachedInputTokens,
              };
            }
            return undefined;
          },
          originalMessages: result.originalMessages,
          sendReasoning: true,
          sendSources: true,
          onError: (error) => {
            console.error("[EXULU] Ui message stream error.", error);
            reject(new Error(error instanceof Error ? error.message : String(error)));
            return `Ui message stream error: ${error instanceof Error ? error.message : String(error)}`;
          },
          onFinish: async ({ messages }) => {
            const metadata = messages[messages.length - 1]?.metadata as any;
            console.log("[EXULU] Stream finished with messages:", messages);
            console.log("[EXULU] Stream metadata", metadata);
            await Promise.all([
              updateStatistic({
                name: "count",
                label: statistics.label,
                type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                trigger: statistics.trigger,
                count: 1,
                user: user.id,
                role: user?.role?.id,
              }),
              ...(metadata?.inputTokens
                ? [
                    updateStatistic({
                      name: "inputTokens",
                      label: statistics.label,
                      type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                      trigger: statistics.trigger,
                      count: metadata?.inputTokens,
                      user: user.id,
                      role: user?.role?.id,
                    }),
                  ]
                : []),
              ...(metadata?.outputTokens
                ? [
                    updateStatistic({
                      name: "outputTokens",
                      label: statistics.label,
                      type: STATISTICS_TYPE_ENUM.AGENT_RUN as STATISTICS_TYPE,
                      trigger: statistics.trigger,
                      count: metadata?.outputTokens,
                    }),
                  ]
                : []),
            ]);
            resolve({
              messages,
              metadata: {
                tokens: {
                  totalTokens: messageHistory.metadata.tokens.totalTokens + metadata?.totalTokens,
                  reasoningTokens:
                    messageHistory.metadata.tokens.reasoningTokens + metadata?.reasoningTokens,
                  inputTokens: messageHistory.metadata.tokens.inputTokens + metadata?.inputTokens,
                  outputTokens:
                    messageHistory.metadata.tokens.outputTokens + metadata?.outputTokens,
                  cachedInputTokens:
                    messageHistory.metadata.tokens.cachedInputTokens + metadata?.cachedInputTokens,
                },
                duration: messageHistory.metadata.duration + (Date.now() - startTime),
              },
            });
          },
        });

        // Consume the stream to ensure it runs to completion & triggers onFinish
        for await (const message of stream) {
          console.log("[EXULU] message", message);
        }
      } catch (error: unknown) {
        console.error(
          `[EXULU] error generating stream for agent ${agent.name} (${agent.id}).`,
          error,
        );
        reject(new Error(error instanceof Error ? error.message : String(error)));
      }
    });
    index++;
  }
  console.log(
    "[EXULU] finished processing UI messages flow for agent, messages result",
    messageHistory,
  );
  return messageHistory;
};

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
