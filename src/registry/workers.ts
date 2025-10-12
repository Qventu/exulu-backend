import IORedis from "ioredis";
import { redisServer } from "../bullmq/server";
import { Job, Queue, Worker } from "bullmq";
import { bullmq } from "./utils";
import { ExuluContext, ExuluStorage, type ExuluQueueConfig } from "./classes";
import { postgresClient } from "../postgres/client";
import type { ExuluBullMqDecoratorData, ExuluJobType } from "./decoraters/bullmq";
import { type Tracer } from "@opentelemetry/api";
import type { ExuluConfig } from ".";

let redisConnection: IORedis;

export const createWorkers = async (
    queues: ExuluQueueConfig[],
    config: ExuluConfig,
    contexts: ExuluContext[],
    tracer?: Tracer
) => {
    // Initializes any required workers for processing embedder
    // and agent jobs in the defined queues by checking the registry.

    if (!redisServer.host || !redisServer.port) {
        console.error("[EXULU] you are trying to start worker, but no redis server is configured in the environment.")
        throw new Error("No redis server configured in the environment, so cannot start worker.")
    }

    if (!redisConnection) {
        redisConnection = new IORedis({
            ...redisServer,
            maxRetriesPerRequest: null
        });
    }

    const workers = queues.map(queue => {
        console.log(`[EXULU] creating worker for queue ${queue}.`)
        const worker = new Worker(
            `${queue}`,
            async (bullmqJob: Job) => {
                const { db } = await postgresClient()
                try {
                    // Type casting data here, couldn't get it to merge
                    // on the main object while keeping auto completion.
                    const data: ExuluBullMqDecoratorData & { type: ExuluJobType } = bullmqJob.data;

                    bullmq.validate(bullmqJob.id, data);

                    if (data.type === "embedder") {

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

                        return result;

                    }

                    if (data.type === "processor") {
                        const context = contexts.find(context => context.id === data.context)

                        if (!context) {
                            throw new Error(`Context ${data.context} not found in the registry.`);
                        }

                        const field = context.fields.find(field => field.name === data.inputs.field);

                        if (!field) {
                            throw new Error(`Field ${data.inputs.field} not found in the context ${data.context}.`);
                        }

                        if (!field.processor) {
                            throw new Error(`Processor not set for field ${data.inputs.field} in the context ${data.context}.`);
                        }

                        const exuluStorage = new ExuluStorage({ config });

                        if (!data.user) {
                            throw new Error(`User not set for processor job.`);
                        }

                        if (!data.role) {
                            throw new Error(`Role not set for processor job.`);
                        }

                        const result = await field.processor.execute({
                            item: data.inputs,
                            user: data.user,
                            role: data.role,
                            utils: {
                                storage: exuluStorage,
                                items: {
                                    update: context.updateItem
                                }
                            },
                            config
                        });

                        return result;
                    }

                } catch (error: unknown) {
                    await db.from("jobs").where({ redis: bullmqJob.id }).update({
                        status: "failed",
                        finishedAt: new Date(),
                        error: error instanceof Error ? error.message : String(error)
                    });
                    throw new Error(error instanceof Error ? error.message : String(error))
                }
            },
            {
                connection: redisConnection,
                ...(queue.ratelimit && {
                    limiter: {
                        max: queue.ratelimit,
                        duration: 1000
                    }
                }),
            })

        worker.on('completed', (job, returnvalue: any) => {
            console.log(`[EXULU] completed job ${job.id}.`, returnvalue)
        });

        worker.on('failed', (job, error: Error, prev: string) => {
            if (job?.id) {
                console.error(`[EXULU] failed job ${job.id}.`)
            }
            console.error(`[EXULU] job error.`, error)
        });

        worker.on('progress', (job, progress) => {
            console.log(`[EXULU] job progress ${job.id}.`, progress)
        });

        return worker;
    })

    return workers;
}