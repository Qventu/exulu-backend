import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";

/** API shape for a registered queue offered to the routine editor. */
export interface AvailableQueue {
  name: string;
}

/**
 * Maps registered queue configs to the API shape offered to the routine editor.
 * Sourced from `exuluApp.get().queues()` — the exact set the run paths validate
 * against, so a value offered here can never fail queue lookup at run time.
 *
 * `excludeNames` drops built-in/system queues (the global `eval_runs` /
 * `email_intake` queues) that a user must never target for a routine run, while
 * leaving them in `queues()` for worker creation and run-path validation.
 *
 * Returns [] on any failure (e.g. the app/Redis is not initialized).
 */
export function resolveAvailableQueues(
  getQueues: () => ExuluQueueConfig[],
  excludeNames: Iterable<string> = [],
): AvailableQueue[] {
  const excluded = new Set(excludeNames);
  try {
    return getQueues()
      .map((config) => ({ name: config.queue.name }))
      .filter((queue) => !excluded.has(queue.name));
  } catch {
    return [];
  }
}
