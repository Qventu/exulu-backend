import { Queue } from "bullmq";
import type { SourceDocument } from "../classes.ts";
import { postgresClient } from "../../postgres/client.ts";
import { v4 as uuidv4 } from 'uuid';

export const bullmqDecorator = async ({
    label,
    type,
    workflow,
    embedder,
    inputs,
    queue,
    user,
    agent,
    session,
    configuration,
    updater,
    context,
    source,
    documents,
    trigger,
    item
}: {
    label: string,
    embedder?: string,
    trigger?: string,
    updater?: string,
    workflow?: string,
    item?: string,
    session?: string,
    context?: string,
    source?: string,
    documents?: SourceDocument[],
    type: "workflow" | "embedder"
    configuration?: Record<string, {
        type: "string" | "number" | "query"
        example: string
    }>
    agent?: string
    inputs: any,
    queue: Queue,
    user: String
}) => {

    const redisId = uuidv4();
    const job = await queue.add(`${embedder || workflow}`, {
        type: `${type}`,
        ...(embedder && { embedder }),
        ...(workflow && { workflow }),
        ...(configuration && { configuration }),
        ...(updater && { updater }),
        ...(context && { context }),
        ...(source && { source }),
        ...(documents && { documents }),
        ...(trigger && { trigger }),
        ...(item && { item }),
        agent: agent,
        user: user,
        inputs,
        session
    },
        {
            jobId: redisId,
        },
    )

    const { db } = await postgresClient()

    const now = new Date();
    console.log("[EXULU] scheduling new job", inputs)
    const insertData = {
        name: `${label}`,
        redis: job.id,
        status: "waiting",
        type,
        inputs,
        agent,
        item,
        createdAt: now,
        updatedAt: now,
        user,
        session,
        ...(embedder && { embedder }),
        ...(workflow && { workflow }),
        ...(configuration && { configuration }),
        ...(updater && { updater }),
        ...(context && { context }),
        ...(source && { source }),
        ...(documents && { documents: documents.map(doc => doc.id) }),
        ...(trigger && { trigger })
    };

    // Upsert by redis key
    await db('jobs')
        .insert(insertData)
        .onConflict('redis') // upsert by redis key
        .merge({
            ...insertData,
            updatedAt: now // Only updatedAt changes on updates
        });

    const doc = await db.from("jobs").where({ redis: job.id }).first();

    if (!doc?.id) {
        throw new Error('Failed to get job ID after insert/update');
    }

    console.log("[EXULU] created job", doc?.id)

    return {
        ...job,
        id: doc?.id,
        redis: job.id,
    };
}