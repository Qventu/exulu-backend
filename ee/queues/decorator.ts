import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import type { UIMessage } from "ai";
import type { STATISTICS_LABELS } from "@EXULU_TYPES/statistics";
import { postgresClient } from "@SRC/postgres/client";
import { maybePruneJobResults } from "./prune-job-results";

type ExuluJobType = "embedder" | "workflow" | "eval" | "processor";

type ExuluBullMqDecoratorData = {
  queue: Queue;
  label: string;
  embedder?: string;
  processor?: string;
  inputs: any;
  user?: number;
  role?: string;
  trigger: STATISTICS_LABELS;
  workflow?: string;
  evaluation?: string;
  item?: string;
  context?: string;
  retries?: number;
  backoff?: {
    type: "exponential" | "linear";
    delay: number; // in milliseconds
  };
  timeoutInSeconds: number;
};

export type BullMqJobData = {
  label: string;
  type: string;
  source?: string;
  inputs: any;
  timeoutInSeconds: number;
  user?: number;
  role?: string;
  trigger: STATISTICS_LABELS;
  messages?: UIMessage[];
  eval_run_id?: string;
  eval_run_name?: string;
  test_case_id?: string;
  test_case_name?: string;
  eval_functions?: {
    id: string;
    config: Record<string, any>;
  }[];
  agent_id?: string;
  expected_output?: string;
  expected_tools?: string[];
  expected_knowledge_sources?: string[];
  expected_agent_tools?: string[];
  config?: Record<string, any>;
  scoring_method?: string;
  pass_threshold?: number;
  workflow?: string;
  embedder?: string;
  processor?: string;
  evaluation?: string;
  item?: string;
  context?: string;
};

export const bullmqDecorator = async ({
  queue,
  label,
  embedder,
  processor,
  inputs,
  evaluation,
  user,
  role,
  trigger,
  workflow,
  item,
  context,
  retries,
  backoff,
  timeoutInSeconds,
}: ExuluBullMqDecoratorData) => {
  const types = [embedder, workflow, processor, evaluation];

  if (types.filter((type) => type).length > 1) {
    throw new Error(
      "Cannot have multiple types in the same job, must be one of the following: embedder, workflow, processor or eval.",
    );
  }

  let type: ExuluJobType = "embedder";

  if (workflow) {
    type = "workflow";
  }

  if (processor) {
    type = "processor";
  }

  if (evaluation) {
    type = "eval";
  }

  if (embedder) {
    type = "embedder";
  }

  const jobData: BullMqJobData = {
    label,
    type: `${type}`,
    timeoutInSeconds: timeoutInSeconds || 180, // 3 minutes default
    inputs,
    ...(user && { user }),
    ...(role && { role }),
    ...(trigger && { trigger }),
    ...(workflow && { workflow }),
    ...(embedder && { embedder }),
    ...(processor && { processor }),
    ...(evaluation && { evaluation }),
    ...(item && { item }),
    ...(context && { context }),
  };

  const redisId = uuidv4();

  // Knowledge V2 (KB-7): record the job in job_results at ENQUEUE time (state
  // "waiting") for processor/embedder jobs, so the item detail page can detect
  // jobs that are queued-but-not-yet-started (which it couldn't if the row was
  // only written at worker pickup). Inserted BEFORE queue.add so the row is
  // guaranteed present before any worker can grab the job (no insert/update
  // race). The worker-start update + completed/failed handlers drive the row
  // through active → completed/failed, all keyed by this job_id.
  if ((type === "processor" || type === "embedder") && context) {
    try {
      const { db } = await postgresClient();
      const itemId =
        item == null
          ? null
          : typeof item === "object"
            ? ((item as { id?: unknown }).id ?? null)
            : item;
      await db.from("job_results").insert({
        job_id: redisId,
        label,
        state: "waiting",
        type,
        item: itemId == null ? null : String(itemId),
        context: String(context),
        result: null,
        metadata: {},
      });
      // Bound the table: every Nth added row, prune the oldest terminal rows.
      void maybePruneJobResults(db);
    } catch (err) {
      console.error("[EXULU] enqueue job_results insert failed", err);
    }
  }

  const job = await queue.add(`${embedder || workflow || processor || evaluation}`, jobData, {
    jobId: redisId,
    // Setting it to 3 as a sensible default, as
    // many AI services are quite unstable.
    attempts: retries || 3, // todo make this configurable?
    removeOnComplete: 5000,
    removeOnFail: 10000,
    backoff: backoff || {
      type: "exponential",
      delay: 2000,
    },
  });

  return {
    ...job,
    redis: job.id,
  };
};
