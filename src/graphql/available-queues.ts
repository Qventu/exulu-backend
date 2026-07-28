import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";

/** API shape for a registered queue offered to the routine editor. */
export interface AvailableQueue {
  name: string;
}

/**
 * Maps registered queue configs to the API shape. Sourced from
 * `exuluApp.get().queues()` — the exact set the run paths validate against, so
 * a value offered here can never fail queue lookup at run time. Returns [] on
 * any failure (e.g. the app/Redis is not initialized in this process).
 */
export function resolveAvailableQueues(
  getQueues: () => ExuluQueueConfig[],
): AvailableQueue[] {
  try {
    return getQueues().map((config) => ({ name: config.queue.name }));
  } catch {
    return [];
  }
}
