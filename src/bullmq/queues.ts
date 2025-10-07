import { Queue } from 'bullmq';
import { redisServer } from "./server"
import { BullMQOtel } from "bullmq-otel";

// Used for workflows and embedders
class ExuluQueues {
    queues: {
        queue: Queue,
        ratelimit: number
        concurrency: number
    }[]
    constructor() {
        this.queues = []
    }

    queue(name: string): {
        queue: Queue,
        ratelimit: number
        concurrency: number
    } | undefined {
        return this.queues.find(x => x.queue?.name === name) as {
            queue: Queue,
            ratelimit: number
            concurrency: number
        } | undefined
    }

    // name: string
    // concurrency: global concurrency for the queue
    // ratelimit: maximum number of jobs per second
    // Rate limit is set on workers (see workers.ts), even global rate limits,
    // that is a bit counter-intuitive. Since queues are registered using .user
    // method of ExuluQueues we need to store the desired rate limit on the queue
    // here so we can use the value when creating workers for the queue instance
    // as there is no way to store a rate limit value natively on a bullm queue.
    use = async (
        name: string,
        concurrency: number = 1,
        ratelimit: number = 1
    ): Promise<{
        queue: Queue,
        ratelimit: number
        concurrency: number
    }> => {
        const existing = this.queues.find(x => x.queue?.name === name);
        if (existing) {
            const globalConcurrency = await existing.queue.getGlobalConcurrency();
            if (globalConcurrency !== concurrency) {
                await existing.queue.setGlobalConcurrency(concurrency);
            }
            return {
                queue: existing.queue,
                ratelimit,
                concurrency
            };
        }

        if (!redisServer.host?.length || !redisServer.port?.length) {
            console.error(`[EXULU] no redis server configured, but you are trying to use a queue ( ${name}), likely in an agent or embedder (look for ExuluQueues.use() ).`)
            throw new Error(`[EXULU] no redis server configured.`)
        }
        const newQueue = new Queue(
            `${name}`,
            {
                connection: redisServer,
                telemetry: new BullMQOtel("simple-guide"),
            }
        );
        await newQueue.setGlobalConcurrency(concurrency);
        this.queues.push({
            queue: newQueue,
            ratelimit,
            concurrency
        })
        return {
            queue: newQueue,
            ratelimit,
            concurrency
        }
    }
}

export const queues = new ExuluQueues()