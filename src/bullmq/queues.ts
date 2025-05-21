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
        const newQueue = new Queue(`${name}`, { connection: redisServer });
        this.queues.push(newQueue)
        return newQueue
    }
}

export const queues = new ExuluQueues()