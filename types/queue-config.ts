import { Queue } from "bullmq";

export type ExuluQueueConfig = {
    queue: Queue;
    ratelimit: number;
    timeoutInSeconds?: number; // 3 minutes default
    concurrency: {
        worker: number;
        queue: number;
    };
    retries?: number;
    backoff?: {
        type: "exponential" | "linear";
        delay: number; // in milliseconds
    };
};

/**
 * The subset of a server-side import job's BullMQ data that worker-deps.ts
 * needs to build RunImportDeps. The real queued payload is still a
 * BullMqJobData (ee/queues/decorator.ts, whose `type` is a plain `string`
 * and already carries jobResultId/context/user/role as optional fields) --
 * this narrower type exists so the "import" branch in ee/workers.ts can
 * destructure those fields without pulling in the broader, EE-only shape.
 */
export type ImportJobData = {
    type: "import";
    jobResultId: string;
    context: string;
    user?: number;
    role?: string;
};