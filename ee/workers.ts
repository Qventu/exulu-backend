import IORedis from "ioredis";
import { redisServer } from "@EE/queues/server.ts";
import { guardRedisStartup, logRedisErrors } from "@EE/queues/redis-startup.ts";
import { Job, Worker, type JobState } from "bullmq";
import { bullmq } from "@SRC/validators/bullmq.ts";
import { getEnabledTools } from "@SRC/utils/enabled-tools.ts";
import { ExuluStorage } from "@SRC/exulu/storage.ts";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config.ts";
import { getTableName, type ExuluContext } from "@SRC/exulu/context.ts";
import type { ExuluEval } from "@SRC/exulu/evals.ts";
import type { ExuluTool } from "@SRC/exulu/tool.ts";
import { resolveModel } from "@SRC/exulu/resolve-model.ts";
import { postgresClient } from "@SRC/postgres/client";
import type { BullMqJobData } from "@EE/queues/decorator.ts";
import { maybePruneJobResults } from "@EE/queues/prune-job-results.ts";
import { type Tracer } from "@opentelemetry/api";
import { v4 as uuidv4 } from "uuid";
import { createIdGenerator, type UIMessage } from "ai";
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
import { saveChat, getAgentMessages, generateStream } from "@SRC/exulu/generate-stream";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { handleEmailIntake } from "@SRC/exulu/email-inbound/intake";
import { markStreamActive, clearStreamActive } from "@SRC/exulu/active-streams.ts";
import { messageHasPendingApproval, substituteVariablesInMessage } from "@SRC/exulu/routines/flow-steps.ts";
import { createRunSession } from "@SRC/exulu/routines/run-session.ts";
import { casJobResultState, parseRunMetadata, upsertWorkflowRunStart } from "@SRC/exulu/routines/run-state.ts";
import { findLiteLLMModel } from "@SRC/exulu/litellm/catalog.ts";
import { computeRunCostUsd } from "@SRC/exulu/routines/run-cost.ts";

/**
 * Session-backed runs persist messages at each step boundary, so retries must
 * resume AT the failed step instead of re-running (and re-persisting) earlier
 * ones (spec §5.4). This wrapper carries the failing step index to the
 * workflow handler's retry loop.
 */
export class FlowStepError extends Error {
  public readonly stepIndex: number;
  constructor(stepIndex: number, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "FlowStepError";
    this.stepIndex = stepIndex;
  }
}

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
  queues: ExuluQueueConfig[],
  config: ExuluConfig,
  contexts: ExuluContext[],
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
    // Surface connection errors and FAIL FAST instead of hanging silently when Redis is down:
    // confirm the connection is actually reachable (bounded by REDIS_STARTUP_TIMEOUT_MS) before
    // handing it to the workers, which would otherwise block on their first operation forever.
    logRedisErrors(redisConnection, "worker");
    await guardRedisStartup("workers", () => redisConnection.ping().then(() => undefined), redisConnection);
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

              await upsertJobStart(db, bullmqJob, label, "embedder");

              const context = contexts.find((context) => context.id === data.context);

              if (!context) {
                throw new Error(`Context ${data.context} not found in the registry.`);
              }

              if (!context.embedder) {
                throw new Error(`No embedder configured for context ${data.context}.`);
              }

              const result = await context.createAndUpsertEmbeddings(
                data.inputs,
                config,
                data.user,
                {
                  label: context.embedder.model,
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

              await upsertJobStart(db, bullmqJob, label, "processor");

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
              // fts is a generated column (tsvector GENERATED ALWAYS AS ... STORED)
              // and Postgres rejects any explicit update to it.
              delete processorResult.fts;

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

              // Bookkeeping persisted in job_results.metadata so cancel /
              // retry / approval-resume can re-enqueue without the ephemeral
              // Redis payload (spec §5).
              const runBookkeeping = {
                run_as: { user: data.user, role: data.role },
                inputs: (data.inputs ?? {}) as Record<string, unknown>,
                queue_name: bullmqJob.queueName,
              };

              // Row first (before validation) so a payload/agent failure
              // still surfaces as a failed run row — same as today.
              const started = await upsertWorkflowRunStart(db, {
                jobId: bullmqJob.id!,
                jobResultId: data.jobResultId,
                label,
                state: await bullmqJob.getState(),
                workflow: data.workflow!,
                session: data.session ?? null,
                trigger: data.triggerSource ?? null,
                triggerMetadata: data.triggerMetadata ?? null,
                bookkeeping: runBookkeeping,
                resumeFromIndex: data.resumeFromIndex ?? 0,
              });
              const jobResultId = started.jobResultId;
              let resumeFromIndex = started.resumeFromIndex;

              const {
                agent,
                user,
                workflow,
                messages: inputMessages,
              } = await validateWorkflowPayload(data);

              // Session-backed runs (spec §3.4): reuse the session provided by
              // the enqueuer (email intake / continuation / retry / previous
              // BullMQ attempt), otherwise create one with the routine's rbac
              // snapshot under the run identity.
              let sessionId = started.session ?? undefined;
              if (!sessionId) {
                sessionId = await createRunSession({
                  db,
                  workflow: {
                    id: workflow.id,
                    name: workflow.name,
                    agent: workflow.agent,
                    rights_mode: workflow.rights_mode,
                  },
                  userId: user.id,
                  title: `${workflow.name} — ${new Date().toISOString()}`,
                  trigger: data.triggerSource ?? "api",
                  jobResultId,
                });
                await db.from("job_results").where({ id: jobResultId }).update({ session: sessionId });
              }

              const retries = 3;
              let attempts = 0;

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
                pausedAtStepIndex?: number;
              }>(async (resolve, reject) => {
                while (attempts < retries) {
                  try {
                    // processUiMessagesFlow mutates inputMessages in place (ids
                    // + substituted text) — pass a fresh deep copy each attempt
                    // so a retry/resume never reuses the mutated array.
                    const messages = await processUiMessagesFlow({
                      agent,
                      inputMessages: structuredClone(inputMessages),
                      contexts,
                      user,
                      tools,
                      config,
                      variables: data.inputs,
                      // Tag LLM spend to this routine (cron + ad-hoc share this path).
                      routine: { id: workflow.id, name: workflow.name },
                      sessionId,
                      resumeFromIndex,
                      // Approval-gated tools pause unless the routine opted
                      // back into blanket pre-approval (spec §5.2).
                      respectToolApprovals: workflow.auto_approve_tools !== true,
                    });
                    resolve(messages);
                    break;
                  } catch (error: unknown) {
                    console.error(
                      `[EXULU] error processing UI messages flow for agent ${agent.name} (${agent.id}).`,
                      error instanceof Error ? error.message : String(error),
                    );
                    if (error instanceof FlowStepError) {
                      // Completed steps already persisted their messages —
                      // resume at the failed step (spec §5.4).
                      resumeFromIndex = error.stepIndex;
                    }
                    attempts++;
                    if (attempts >= retries) {
                      // Persist progress so BullMQ attempt-level retries and
                      // retryRoutineRun resume from the failed step.
                      try {
                        await db
                          .from("job_results")
                          .where({ id: jobResultId })
                          .update({
                            metadata: JSON.stringify({
                              ...runBookkeeping,
                              current_step_index: resumeFromIndex,
                            }),
                          });
                      } catch (persistError) {
                        console.error(
                          `[EXULU] failed to persist run progress for job ${bullmqJob.id}.`,
                          persistError,
                        );
                      }
                      reject(new Error(error instanceof Error ? error.message : String(error)));
                    }
                    await new Promise((resolve) => setTimeout(() => resolve(true), 2000));
                  }
                }
              });

              const result = await promise;
              const messages = result.messages;
              const metadata = result.metadata;

              // Token accumulation across pause/resume (spec §5.7): a resumed
              // continuation only counted its own steps — sum with any
              // pre-pause token counts persisted on the row (kept there by
              // upsertWorkflowRunStart's metadata merge). Fresh runs have no
              // prior tokens and pass through unchanged.
              const rowBeforeWrite = await db
                .from("job_results")
                .where({ id: jobResultId })
                .first();
              const priorTokens = parseRunMetadata(rowBeforeWrite?.metadata).tokens as
                | Record<string, number>
                | undefined;
              const tokens = {
                totalTokens: (priorTokens?.totalTokens ?? 0) + metadata.tokens.totalTokens,
                reasoningTokens:
                  (priorTokens?.reasoningTokens ?? 0) + metadata.tokens.reasoningTokens,
                inputTokens: (priorTokens?.inputTokens ?? 0) + metadata.tokens.inputTokens,
                outputTokens: (priorTokens?.outputTokens ?? 0) + metadata.tokens.outputTokens,
                cachedInputTokens:
                  (priorTokens?.cachedInputTokens ?? 0) + metadata.tokens.cachedInputTokens,
              };

              // Approximate per-run $ cost (spec 2026-07-29): recompute from the
              // cumulative token totals × the run model's catalog list price on every
              // persist, so it stays correct across pause/resume. Null when the model
              // has no catalog price — the UI shows "—", not a fabricated $0.
              const modelPrice = await findLiteLLMModel(agent.model ?? "");
              (tokens as Record<string, number | null>).costUsd = computeRunCostUsd(
                tokens.inputTokens,
                tokens.outputTokens,
                modelPrice
                  ? {
                      input_cost_per_million_tokens: modelPrice.input_cost_per_million_tokens,
                      output_cost_per_million_tokens: modelPrice.output_cost_per_million_tokens,
                    }
                  : null,
              );

              if (result.pausedAtStepIndex !== undefined) {
                // Pause is success (spec §5.3): persist progress and flip to
                // waiting_approval synchronously BEFORE returning — the
                // completed-handler CAS (state = active) can then never
                // clobber it. CAS keeps an admin cancel-during-pause intact.
                await db
                  .from("job_results")
                  .where({ id: jobResultId })
                  .update({
                    result:
                      messages.length > 0 ? JSON.stringify(messages[messages.length - 1]) : null,
                    metadata: JSON.stringify({
                      messages,
                      ...metadata,
                      tokens,
                      ...runBookkeeping,
                      current_step_index: result.pausedAtStepIndex,
                    }),
                  });
                await casJobResultState(
                  db,
                  jobResultId,
                  [JOB_STATUS_ENUM.active, JOB_STATUS_ENUM.waiting],
                  JOB_STATUS_ENUM.waiting_approval,
                );
                return {
                  result: messages[messages.length - 1],
                  metadata: {
                    messages,
                    ...metadata,
                    tokens,
                    ...runBookkeeping,
                    current_step_index: result.pausedAtStepIndex,
                  },
                };
              }

              return {
                result: messages[messages.length - 1], // last message
                metadata: {
                  messages,
                  ...metadata,
                  tokens,
                  ...runBookkeeping,
                  current_step_index: inputMessages.length - 1,
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
                user,
                evalRun,
                testCase,
                messages: inputMessages,
              } = await validateEvalPayload(data);

              const retries = 3;
              let attempts = 0;

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
                      agent,
                      inputMessages,
                      contexts,
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
                testCase,
                messages: inputMessages,
              } = await validateEvalPayload(data);

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

            if (data.type === "email_intake") {
              console.log("[EXULU] running a routine webhook intake job.", bullmqJob.name);
              if (!data.inputs?.s3Key || !data.inputs?.triggerId) {
                throw new Error(`Missing s3Key/triggerId for email intake job.`);
              }
              const result = await handleEmailIntake(
                {
                  s3Key: data.inputs.s3Key,
                  triggerId: data.inputs.triggerId,
                  format: data.inputs.format === "json" ? "json" : "eml",
                },
                { config },
              );
              return { result, metadata: {} };
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

        // CAS (spec §5.3): a paused run returns from the handler with state
        // already flipped to waiting_approval, and cancel may have won a race
        // — only an active row may be completed.
        await db
          .from("job_results")
          .where({ job_id: job.id, state: JOB_STATUS_ENUM.active })
          .update({
            state: JOB_STATUS_ENUM.completed,
            result: returnvalue.result != null ? JSON.stringify(returnvalue.result) : null,
            metadata: returnvalue.metadata != null ? JSON.stringify(returnvalue.metadata) : null,
          });

        // Cap the table as rows become terminal (every Nth, idempotent).
        void maybePruneJobResults(db);
      },
    );

    worker.on("failed", async (job, error: Error, prev: string) => {
      if (job?.id) {
        const { db } = await postgresClient();

        console.error(`[EXULU] failed job ${job.id}.`, error);

        // CAS: never clobber a pause (success), an admin cancel, or a
        // completed row — e.g. a BullMQ lock-expiry "failure" arriving after
        // the run already paused for approval.
        await db
          .from("job_results")
          .where({ job_id: job.id })
          .whereNotIn("state", [
            JOB_STATUS_ENUM.waiting_approval,
            JOB_STATUS_ENUM.cancelled,
            JOB_STATUS_ENUM.completed,
          ])
          .update({
            state: JOB_STATUS_ENUM.failed,
            error,
          });

        // Cap the table as rows become terminal (every Nth, idempotent).
        void maybePruneJobResults(db);
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
): Promise<{
  agent: ExuluAgent;
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

  const user = await db.from("users").where({ id: data.user }).first();

  if (!user) {
    throw new Error(`User ${data.user} not found in the database.`);
  }

  return {
    agent,
    user,
    workflow,
    variables: data.inputs,
    messages: workflow.steps_json,
  };
};

const validateEvalPayload = async (
  data: BullMqJobData,
): Promise<{
  agent: ExuluAgent;
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
    await new Promise((resolve) => setTimeout(() => resolve(true), 2000));
  }
  return result;
};

export const processUiMessagesFlow = async ({
  agent,
  inputMessages,
  contexts,
  user,
  tools,
  config,
  variables,
  routine,
  sessionId,
  resumeFromIndex,
  respectToolApprovals,
}: {
  agent: ExuluAgent;
  inputMessages: UIMessage[];
  contexts: ExuluContext[];
  user: User;
  tools: ExuluTool[];
  config: ExuluConfig;
  variables?: Record<string, any>;
  /**
   * Set when this flow is invoked from a workflow_template run (one-shot via
   * runWorkflow or cron via upsertWorkflowSchedule). Forwarded to resolveModel
   * so buildTags() emits routine_id_/routine_name_ alongside user/agent tags
   * for /analytics + /admin/budgets attribution. /chat and /openai-gateway
   * callers leave this undefined — they have no routine context.
   */
  routine?: { id: string; name: string };
  /**
   * Session-backed runs (spec §5.1): persist each step's messages to
   * agent_messages at the step boundary, pass the session to generateStream
   * (which reloads history from the DB per step), and hold the
   * stream-active flag for the session while executing.
   */
  sessionId?: string;
  /** Skip steps before this index (approval resume / retry-from-step). Default 0. */
  resumeFromIndex?: number;
  /**
   * When true, do NOT blanket-approve every tool — approval-gated tools pause
   * the run (pausedAtStepIndex). Routines with auto_approve_tools = true and
   * all legacy callers keep the blanket pre-approval (spec §5.2).
   */
  respectToolApprovals?: boolean;
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
  /** Set when the run paused on an approval-requested tool part (spec §5.3). */
  pausedAtStepIndex?: number;
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
    disabledTools,
    user,
  );

  console.log(
    "[EXULU] enabled tools",
    enabledTools?.map((x) => x.name + " (" + x.id + ")"),
  );

  if (!agent.model) {
    throw new Error(
      `Agent ${agent.name} (${agent.id}) has no model configured.`,
    );
  }

  const resolved = await resolveModel({
    modelId: agent.model,
    user,
    agent: agent,
    routine,
  });

  const resolvedLanguageModel = resolved.languageModel;

  // Remove placeholder agent response before sending
  const messagesWithoutPlaceholder = inputMessages.filter(
    (message) => (message.metadata as any)?.type !== "placeholder",
  );

  console.log("[EXULU] messages without placeholder", messagesWithoutPlaceholder);

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

  const startIndex = resumeFromIndex ?? 0;

  // Resume: prior steps already persisted their messages — reload them so the
  // returned transcript is complete. generateStream reloads its own copy from
  // the session per step; this keeps messageHistory (the return value +
  // previousMessages for headless callers) consistent with it.
  if (sessionId && startIndex > 0) {
    const priorRows = await getAgentMessages({ session: sessionId, includeAllUsers: true });
    messageHistory.messages = priorRows.map(
      (row: { content: string }) => JSON.parse(row.content) as UIMessage,
    );
  }

  if (sessionId) markStreamActive(sessionId);
  try {
    for (let stepIndex = 0; stepIndex < messagesWithoutPlaceholder.length; stepIndex++) {
      const currentMessage = messagesWithoutPlaceholder[stepIndex]!;
      if (stepIndex < startIndex) {
        continue;
      }
      console.log("[EXULU] running through the conversation");
      console.log("[EXULU] current index", stepIndex);
      console.log("[EXULU] current message", currentMessage);
      console.log("[EXULU] message history", messageHistory);

      // steps_json message ids repeat across runs of the same routine, and
      // agent_messages.message_id is globally unique (saveChat merges on it) —
      // persisted run messages need a fresh id per run.
      if (sessionId) {
        currentMessage.id = `wfmsg-${uuidv4()}`;
      }

      // Identify {variable_name} in the current message parts and replace them
      // with the values in variables. Throws when a required value is missing;
      // the auto-provided email variables are empty-safe (spec §4.5).
      substituteVariablesInMessage(currentMessage, variables);

      const statistics = {
        label: agent.name,
        trigger: "agent" as STATISTICS_LABELS,
      };

      try {
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
            const result = await generateStream({
              contexts,
              agent: agent,
              user,
              // Legacy blanket pre-approval unless this run respects
              // approvals (spec §5.2 — auto_approve_tools = false routines).
              approvedTools: respectToolApprovals
                ? undefined
                : tools.map((tool) => "tool-" + sanitizeToolName(tool.name)),
              instructions: agent.instructions,
              session: sessionId,
              previousMessages: messageHistory.messages,
              message: currentMessage,
              currentTools: enabledTools,
              allExuluTools: tools,
              languageModel: resolvedLanguageModel,
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
              // Give each assistant message a real unique id (matches the live
              // chat path in routes.ts). Without this the SDK assigns id "",
              // and saveChat's global message_id upsert collapses every empty-id
              // message onto one frozen-createdAt row — which sorts the tool
              // approval to the top of the transcript and leaves it out of the
              // last-message slot the approval handler acts on (buttons inert).
              generateMessageId: createIdGenerator({
                prefix: "msg_",
                size: 16,
              }),
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
                      totalTokens:
                        messageHistory.metadata.tokens.totalTokens + metadata?.totalTokens,
                      reasoningTokens:
                        messageHistory.metadata.tokens.reasoningTokens + metadata?.reasoningTokens,
                      inputTokens:
                        messageHistory.metadata.tokens.inputTokens + metadata?.inputTokens,
                      outputTokens:
                        messageHistory.metadata.tokens.outputTokens + metadata?.outputTokens,
                      cachedInputTokens:
                        messageHistory.metadata.tokens.cachedInputTokens +
                        metadata?.cachedInputTokens,
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
      } catch (error: unknown) {
        // Carry the failing step so the workflow handler's retry loop resumes
        // here instead of re-running (and re-persisting) earlier steps.
        throw new FlowStepError(stepIndex, error);
      }

      if (sessionId) {
        // Step boundary (spec §5.1): persist the accumulated transcript.
        // saveChat merges on message_id, so re-saving prior messages is
        // idempotent (no duplicates on resume or re-save).
        await saveChat({ session: sessionId, user: user.id, messages: messageHistory.messages });
      }

      if (respectToolApprovals && sessionId) {
        const lastMessage = messageHistory.messages[messageHistory.messages.length - 1];
        if (messageHasPendingApproval(lastMessage)) {
          console.log("[EXULU] run paused for tool approval at step", stepIndex);
          return { ...messageHistory, pausedAtStepIndex: stepIndex };
        }
      }
    }
  } finally {
    if (sessionId) clearStreamActive(sessionId);
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

// KB-7: at worker pickup, advance the enqueue-time job_results row (state
// "waiting", written by the queue decorator) to the live state instead of
// inserting a duplicate. Falls back to an insert for jobs enqueued before
// this change. Used by the processor + embedder handlers; the completed/
// failed worker events then drive the same row to its terminal state.
async function upsertJobStart(
  db: any,
  bullmqJob: { id?: string; data?: any; getState: () => Promise<string> },
  label: string,
  fallbackType: string,
): Promise<void> {
  const state = await bullmqJob.getState();
  const rawItem = bullmqJob.data?.item;
  const itemId =
    rawItem == null ? null : typeof rawItem === "object" ? (rawItem.id ?? null) : rawItem;
  const updated = await db
    .from("job_results")
    .where({ job_id: bullmqJob.id })
    .update({ label, state });
  if (!updated) {
    await db.from("job_results").insert({
      job_id: bullmqJob.id,
      label,
      state,
      result: null,
      metadata: {},
      type: bullmqJob.data?.type ?? fallbackType,
      item: itemId == null ? null : String(itemId),
      context: bullmqJob.data?.context ? String(bullmqJob.data.context) : null,
    });
  }
}
