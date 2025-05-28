import IORedis from "ioredis";
import { redisServer } from "../bullmq/server";
import { Worker } from "bullmq";
import { bullmq } from "./utils";
import { ExuluContext, ExuluEmbedder, ExuluSource, ExuluWorkflow } from "./classes";
import * as fs from 'fs';
import path from "path";
import { global_queues } from "./routes";
import { postgresClient } from "../postgres/client";
export const defaultLogsDir = path.join(process.cwd(), 'logs');

let redisConnection: IORedis;

export const createWorkers = async (queues: string[], contexts: ExuluContext[], embedders: ExuluEmbedder[], workflows: ExuluWorkflow[], _logsDir?: string) => {
    // Initializes any required workers for processing embedder
    // and agent jobs in the defined queues by checking the registry.

    if (!redisServer.host || !redisServer.port) {
        console.error("[EXULU] you are trying to start workers, but no redis server is configured in the environment.")
        throw new Error("No redis server configured in the environment, so cannot start workers.")
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
            async job => {
                const { db } = await postgresClient()
                try {

                    bullmq.validate(job);

                    if (job.data.type === "embedder") {

                        if (!job.data.updater) {
                            throw new Error("No updater set for embedder job.");
                        }

                        const context = contexts.find(context => context.id === job.data.context)

                        if (!context) {
                            throw new Error(`Context ${job.data.context} not found in the registry.`);
                        }

                        if (!job.data.embedder) {
                            throw new Error(`No embedder set for embedder job.`);
                        }

                        const embedder = embedders.find(embedder => embedder.id === job.data.embedder)

                        if (!embedder) {
                            throw new Error(`Embedder ${job.data.embedder} not found in the registry.`);
                        }

                        if (!job.data.source) {
                            throw new Error("No source set for embedder job.");
                        }

                        const source = context.sources.get(job.data.source)

                        if (!source) {
                            throw new Error(`Source ${job.data.source} not found in the registry.`);
                        }

                        if (!job.data.updater) {
                            throw new Error("No updater set for embedder job.");
                        }

                        const updater = (source as ExuluSource).updaters.find(updater => updater.id === job.data.updater)

                        if (!updater) {
                            throw new Error(`Updater ${job.data.updater} not found in the registry.`);
                        }

                        if (!job.data.documents) {
                            throw new Error("No input documents set for embedder job.");
                        }

                        if (!Array.isArray(job.data.documents)) {
                            throw new Error("Input documents must be an array.");
                        }

                        // todo fix this
                        const result = await embedder.upsert(job.data.context, job.data.documents, {
                            label: context.name,
                            trigger: job.data.trigger || "unknown"
                        });


                        const mongoRecord = await db.from("jobs").where({ redis: job.id }).first();
                        if (!mongoRecord) {
                            throw new Error("Job not found in the database.");
                        }

                        const finishedAt = new Date();
                        const duration = (finishedAt.getTime() - new Date(mongoRecord.createdAt).getTime()) / 1000;
                        await db.from("jobs").where({ redis: job.id }).update({
                            status: "completed",
                            finishedAt,
                            duration,
                            result: JSON.stringify(result)
                        });
                        return result;
                    }

                    if (job.data.type === "workflow") {

                        const workflow = workflows.find(workflow => workflow.id === job.data.workflow)

                        if (!workflow) {
                            throw new Error(`Workflow ${job.data.workflow} not found in the registry.`);
                        }

                        const result = await bullmq.process.workflow(job, workflow, logsDir)

                        const mongoRecord = await db.from("jobs").where({ redis: job.id }).first();
                        if (!mongoRecord) {
                            throw new Error("Job not found in the database.");
                        }
                        const finishedAt = new Date();
                        const duration = (finishedAt.getTime() - new Date(mongoRecord.createdAt).getTime()) / 1000;

                        await db.from("jobs").where({ redis: job.id }).update({
                            status: "completed",
                            finishedAt,
                            duration,
                            result: JSON.stringify(result)
                        });
                        return result

                    }

                } catch (error: unknown) {
                    await db.from("jobs").where({ redis: job.id }).update({
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