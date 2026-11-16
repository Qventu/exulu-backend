import type { User } from "@EXULU_TYPES/models/user";

type Level = "read" | "write";

export type QueueAccessDeps = {
  /** Built-in system queues (global_queues): never offered to routines. */
  globalQueueNames: Iterable<string>;
  /** Names of the queues the contexts' processors, embedders and sources run on. */
  contextQueueNames: () => Promise<Set<string>>;
};

const has = (granted: unknown, level: Level) => granted === "write" || (level === "read" && granted === "read");

/**
 * Who may see or act on a BullMQ queue through the generic GraphQL queue/job
 * operations. The rule mirrors the pages that show a queue panel:
 * - routines (`/workflows`, gated by role.workflows): a routine can be put on
 *   any non-global queue, so routine permission covers all of those;
 * - knowledge (`/data`, gated by role.agents until a knowledge role exists):
 *   the queues of the contexts' processors, embedders and sources;
 * - evals (role.evals): the global `eval_runs` queue.
 * Other global queues (email intake, import) are super-admin only. API keys get
 * no bypass, like runEval / workflowTriggers: they pass through their role.
 */
export async function assertQueueAccess(
  opts: { user: User | undefined; queue: string; level: Level },
  deps: QueueAccessDeps,
): Promise<void> {
  const { user, queue, level } = opts;
  if (user?.super_admin === true) return;
  const role = user?.role as Record<string, unknown> | undefined;
  const isGlobal = new Set(deps.globalQueueNames).has(queue);
  let allowed = false;
  if (role) {
    if (isGlobal) {
      allowed = queue === "eval_runs" && has(role.evals, level);
    } else {
      allowed =
        has(role.workflows, level) || (has(role.agents, level) && (await deps.contextQueueNames()).has(queue));
    }
  }
  if (!allowed) {
    throw new Error(
      `You don't have permission to ${level === "write" ? "manage" : "view"} the queue "${queue}". ` +
        `Required: super_admin or ${level} access to the page that owns it.`,
    );
  }
}

type QueueHandle = { use: () => Promise<{ queue: any }> };

/**
 * drainQueue / pauseQueue / resumeQueue / deleteJob / retryJob. Each checks
 * access (write) BEFORE touching the queue: retryJob re-enqueues a job's data
 * verbatim, i.e. it re-runs the job as its original user.
 */
export function createQueueMutationResolvers(
  deps: QueueAccessDeps & { getQueue: (name: string) => QueueHandle | undefined },
): Record<string, (parent: unknown, args: any, context: any) => Promise<{ success: true }>> {
  const open = async (args: any, context: any) => {
    if (!args.queue) {
      throw new Error("Queue name is required");
    }
    await assertQueueAccess({ user: context?.user, queue: args.queue, level: "write" }, deps);
    const queue = deps.getQueue(args.queue);
    if (!queue) {
      throw new Error("Queue not found");
    }
    return (await queue.use()).queue;
  };
  const requireId = (args: any) => {
    if (!args.id) {
      throw new Error("Job ID is required");
    }
  };

  return {
    /**
     * Drains the queue, i.e., removes all jobs that are waiting
     * or delayed, but not active, completed or failed.
     */
    drainQueue: async (_, args, context) => {
      await (await open(args, context)).drain();
      return { success: true };
    },
    pauseQueue: async (_, args, context) => {
      await (await open(args, context)).pause();
      return { success: true };
    },
    resumeQueue: async (_, args, context) => {
      await (await open(args, context)).resume();
      return { success: true };
    },
    deleteJob: async (_, args, context) => {
      requireId(args);
      await (await open(args, context)).remove(args.id);
      return { success: true };
    },
    // KB-5: generic job retry. Re-enqueues a FRESH job with the same name +
    // data (rather than BullMQ's job.retry(), which only works for failed jobs)
    // so it's robust across states and leaves a clean audit trail. Optionally
    // removes the original.
    retryJob: async (_, args, context) => {
      requireId(args);
      const queue = await open(args, context);
      const job = await queue.getJob(args.id);
      if (!job) {
        throw new Error("Job not found");
      }
      await queue.add(job.name, job.data);
      if (args.deleteOriginal) {
        await queue.remove(args.id);
      }
      return { success: true };
    },
  };
}
