import { Queue } from "bullmq";
import type { STATISTICS_LABELS } from "../classes.ts";
import { v4 as uuidv4 } from 'uuid';

export type ExuluJobType = "embedder" | "workflow" | "eval" | "processor"

export type ExuluBullMqDecoratorData = {
    queue: Queue,
    label: string,
    embedder?: string,
    processor?: string,
    inputs: any,
    user?: number,
    role?: string,
    trigger: STATISTICS_LABELS,
    workflow?: string,
    evaluation?: string,
    item?: string,
    context?: string
    retries?: number,
}

export const bullmqDecorator = async ({
    queue,
    label,    
    embedder,
    processor,
    inputs,
    evaluation,
    user,
    role,
    trigger,
    workflow,
    item,
    context,
    retries
}: ExuluBullMqDecoratorData) => {

    const types = [
        embedder,
        workflow,
        processor,
        eval
    ]

    if (types.filter(type => type).length > 1) {
        throw new Error("Cannot have multiple types in the same job, must be one of the following: embedder, workflow, processor or eval.")
    }

    let type: ExuluJobType = "embedder";

    if (workflow) {
        type = "workflow";
    }

    if (processor) {
        type = "processor";
    }

    if (evaluation) {
        type = "eval";
    }

    if (embedder) {
        type = "embedder";
    }

    const redisId = uuidv4();
    const job = await queue.add(`${embedder || workflow || processor || evaluation}`, {
        label,
        type: `${type}`,
        inputs,
        ...(user && { user }),
        ...(role && { role }),
        ...(trigger && { trigger }),
        ...(workflow && { workflow }),
        ...(embedder && { embedder }),
        ...(processor && { processor }),
        ...(evaluation && { evaluation }),
        ...(item && { item }),
        ...(context && { context })
    },
        {
            jobId: redisId,
            // Setting it to 3 as a sensible default, as
            // many AI services are quite unstable.
            attempts: retries || 3, // todo make this configurable?
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
        },
    )

    return {
        ...job,
        redis: job.id,
    };
}