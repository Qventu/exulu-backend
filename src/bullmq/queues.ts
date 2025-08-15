import { Queue } from 'bullmq';
import { redisServer } from "./server"

export class ExuluQueues {
    queues: Queue[]
    constructor() {
        this.queues = []
    }

    queue(name: string): Queue | undefined {
        return this.queues.find(x => x.name === name)
    }

    use(name: string): Queue {
        // todo check if same name queue trying to register with different parameters, if so throw error
        const existing = this.queues.find(x => x.name === name);
        if (existing) {
            return existing;
        }
        if (!redisServer.host?.length || !redisServer.port?.length) {
            console.error(`[EXULU] no redis server configured, but you are trying to use a queue ( ${name}), likely in an agent or embedder (look for ExuluQueues.use() ).`)
            throw new Error(`[EXULU] no redis server configured.`)
        }
        const newQueue = new Queue(`${name}`, { connection: redisServer });
        this.queues.push(newQueue)
        return newQueue
    }
}

export const queues = new ExuluQueues()