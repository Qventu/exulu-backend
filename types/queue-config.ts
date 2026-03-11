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