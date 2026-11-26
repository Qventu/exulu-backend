import { queues as ExuluQueues, global_queues } from "@EE/queues/queues";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { CHANNEL_JOB_TIMEOUT_SECONDS } from "./act";

/**
 * Inbound channel messages. Both callers (ExuluApp's boot-time registration and the
 * webhook's enqueue) go through this helper so the parameters cannot drift; `register`
 * is idempotent per queue name.
 */
export const CHANNEL_QUEUE_CONCURRENCY = { worker: 5, queue: 10 };
export const CHANNEL_QUEUE_RATELIMIT = 10;

export function registerChannelQueue(): { use: () => Promise<ExuluQueueConfig> } {
  return ExuluQueues.register(
    global_queues.channel_inbound,
    CHANNEL_QUEUE_CONCURRENCY,
    CHANNEL_QUEUE_RATELIMIT,
    CHANNEL_JOB_TIMEOUT_SECONDS,
  );
}
