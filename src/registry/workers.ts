import IORedis from "ioredis";
import { redisServer } from "../bullmq/server";
import { Job, Worker } from "bullmq";
import { bullmq } from "./utils";
import { ExuluContext } from "./classes";
import * as fs from 'fs';
import path from "path";
import { global_queues } from "./routes";
import { postgresClient } from "../postgres/client";
import type { ExuluBullMqDecoratorData, ExuluJobType } from "./decoraters/bullmq";
import { type Tracer } from "@opentelemetry/api";
import type { Logger } from "winston";
export const defaultLogsDir = path.join(process.cwd(), 'logs');

let redisConnection: IORedis;

export const createWorkers = async (queues: string[], logger: Logger, contexts: ExuluContext[], _logsDir?: string, tracer?: Tracer) => {
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

    const logsDir = _logsDir || defaultLogsDir;

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

                        const result =await context.createAndUpsertEmbeddings(data.inputs, data.user, {
                            label: embedder.name,
                            trigger: data.trigger
                        });

                        return result;
                    }

                    if (bullmqJob.data.type === "workflow") {

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
            { connection: redisConnection })

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

    const logsCleaner = createLogsCleanerWorker(logsDir);
    workers.push(logsCleaner);

    return workers;
}

const createLogsCleanerWorker = (logsDir: string) => {
    const logsCleaner = new Worker(
        global_queues.logs_cleaner,
        async job => {

            console.log(`[EXULU] recurring job ${job.id}.`)
            const folder = fs.readdirSync(logsDir);
            const files = folder.filter(file => file.endsWith('.log'));

            const now = new Date();
            const daysToKeep = job.data.ttld;
            const dateToKeep = new Date(now.getTime() - daysToKeep * 24 * 60 * 60 * 1000);

            files.forEach(file => {
                const filePath = path.join(logsDir, file);
                const fileStats = fs.statSync(filePath);
                if (fileStats.mtime < dateToKeep) {
                    fs.unlinkSync(filePath);
                }
            });
        },
        { connection: redisConnection }
    )

    logsCleaner.on('completed', (job, returnvalue: any) => {
        console.log(`[EXULU] completed logs cleaner ${job.id}.`, returnvalue)
    });

    logsCleaner.on('failed', (job, error: Error, prev: string) => {
        if (job?.id) {
            console.error(`[EXULU] failed logs cleaner ${job.id}.`)
        }
        console.error(`[EXULU] job error logs cleaner.`, error)
    });

    return logsCleaner;
}