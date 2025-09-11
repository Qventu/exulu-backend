import { Queue } from "bullmq";
import type { STATISTICS_LABELS } from "../classes.ts";
import { v4 as uuidv4 } from 'uuid';

export type ExuluJobType = "embedder" | "workflow"

export type ExuluBullMqDecoratorData = {
    queue: Queue,
    label: string,
    embedder?: string,
    inputs: any,
    user?: number,
    role?: string,
    trigger: STATISTICS_LABELS,
    workflow?: string,
    item?: string,
    context?: string
}

export const bullmqDecorator = async ({
    queue,
    label,    
    embedder,
    inputs,
    user,
    role,
    trigger,
    workflow,
    item,
    context
}: ExuluBullMqDecoratorData) => {

    if (embedder && workflow) {
        throw new Error("Cannot have both embedder and workflow in the same job.")
    }

    if (workflow && item) {
        throw new Error("Cannot have both workflow and item in the same job.")
    }

    let type: ExuluJobType = "embedder";

    if (workflow) {
        type = "workflow";
    }

    const redisId = uuidv4();
    const job = await queue.add(`${embedder || workflow}`, {
        label,
        ...(embedder && { embedder }),
        type: `${type}`,
        inputs,
        ...(user && { user }),
        ...(role && { role }),
        ...(trigger && { trigger }),
        ...(workflow && { workflow }),
        ...(item && { item }),
        ...(context && { context })
    },
        {
            jobId: redisId,
        },
    )

    return {
        ...job,
        redis: job.id,
    };
}