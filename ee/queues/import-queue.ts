import { queues as ExuluQueues, global_queues } from "./queues";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";

/**
 * Server-side bulk import (CSV -> items): one job at a time, one context's
 * import running per worker slot -- a bulk import already runs its own
 * bounded concurrency pool internally (src/exulu/import/run-import.ts), so
 * the queue just serializes whole import runs. The 6 h timeout covers a large
 * file streamed + chunk-processed end to end.
 *
 * Both callers (ExuluApp's boot-time registration in src/exulu/app/index.ts
 * and the StartImport/CancelImport resolvers' `getImportQueue()`) go through
 * this one helper so the parameters cannot drift apart -- `register` is
 * idempotent per queue name, so calling it from both is safe.
 */
export const IMPORT_QUEUE_CONCURRENCY = { worker: 1, queue: 1 };
export const IMPORT_QUEUE_RATELIMIT = 1;
export const IMPORT_QUEUE_TIMEOUT_SECONDS = 6 * 3600;

export function registerImportQueue(): { use: () => Promise<ExuluQueueConfig> } {
  return ExuluQueues.register(
    global_queues.import,
    IMPORT_QUEUE_CONCURRENCY,
    IMPORT_QUEUE_RATELIMIT,
    IMPORT_QUEUE_TIMEOUT_SECONDS,
  );
}
