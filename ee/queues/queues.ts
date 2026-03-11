import { Queue } from "bullmq";
import { redisServer } from "./server";
import { BullMQOtel } from "bullmq-otel";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { checkLicense } from "@EE/entitlements";

// Used for workflows and embedders
class ExuluQueues {
  queues: {
    queue: Queue;
    ratelimit: number;
    concurrency: {
      worker: number;
      queue: number;
    };
    timeoutInSeconds: number;
  }[];
  constructor() {
    this.queues = [];
  }

  public list: Map<
    string,
    {
      name: string;
      concurrency: {
        worker: number;
        queue: number;
      };
      ratelimit: number;
      timeoutInSeconds: number;
      use: () => Promise<ExuluQueueConfig>;
    }
  > = new Map(); // list of queue names

  queue(name: string):
    | {
        queue: Queue;
        ratelimit: number;
        concurrency: {
          worker: number;
          queue: number;
        };
      }
    | undefined {
    return this.queues.find((x) => x.queue?.name === name) as
      | {
          queue: Queue;
          ratelimit: number;
          concurrency: {
            worker: number;
            queue: number;
          };
        }
      | undefined;
  }

  // name: string
  // concurrency: global concurrency for the queue
  // ratelimit: maximum number of jobs per second
  // Rate limit is set on workers (see workers.ts), even global rate limits,
  // that is a bit counter-intuitive. Since queues are registered using .user
  // method of ExuluQueues we need to store the desired rate limit on the queue
  // here so we can use the value when creating workers for the queue instance
  // as there is no way to store a rate limit value natively on a bullm queue.
  register = (
    name: string,
    concurrency: {
      worker: number;
      queue: number;
    },
    ratelimit: number = 1,
    timeoutInSeconds: number = 180,
  ): {
    use: () => Promise<ExuluQueueConfig>;
  } => {
    const license = checkLicense();
    if (!license["queues"]) {
      throw new Error(`[EXULU] You are not licensed to use queues so cannot register a queue. Please set your EXULU_ENTERPRISE_LICENSE env variable.`);
    }
    const queueConcurrency = concurrency.queue || 1;
    const workerConcurrency = concurrency.worker || 1;

    const use = async (): Promise<ExuluQueueConfig> => {
      const existing = this.queues.find((x) => x.queue?.name === name);
      if (existing) {
        const globalConcurrency = await existing.queue.getGlobalConcurrency();
        if (globalConcurrency !== queueConcurrency) {
          await existing.queue.setGlobalConcurrency(queueConcurrency);
        }
        return {
          queue: existing.queue,
          ratelimit,
          concurrency: {
            worker: workerConcurrency,
            queue: queueConcurrency,
          },
          timeoutInSeconds,
        };
      }

      if (!redisServer.host?.length || !redisServer.port?.length) {
        console.error(
          `[EXULU] no redis server configured, but you are trying to use a queue ( ${name}), likely in an agent or embedder (look for ExuluQueues.register().use() ).`,
        );
        console.error("Stack trace:");
        console.trace();
        throw new Error(`[EXULU] no redis server configured.`);
      }

      const newQueue = new Queue(`${name}`, {
        connection: {
          ...redisServer,
          enableOfflineQueue: false,
        },
        telemetry: new BullMQOtel("simple-guide"),
      });
      await newQueue.setGlobalConcurrency(queueConcurrency);
      this.queues.push({
        queue: newQueue,
        ratelimit,
        concurrency: {
          worker: workerConcurrency,
          queue: queueConcurrency,
        },
        timeoutInSeconds,
      });
      return {
        queue: newQueue,
        ratelimit,
        concurrency: {
          worker: workerConcurrency,
          queue: queueConcurrency,
        },
        timeoutInSeconds,
      };
    };

    this.list.set(name, {
      name,
      concurrency: {
        worker: workerConcurrency,
        queue: queueConcurrency,
      },
      ratelimit,
      timeoutInSeconds,
      use,
    });

    return {
      use,
    };
  };
}

export const queues = new ExuluQueues();
