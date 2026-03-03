import type { Job, JobState } from "bullmq";
import { ExuluQueues } from "src";

export async function getJobsByQueueName(
    queueName: string,
    statusses?: JobState[],
    page?: number,
    limit?: number,
  ): Promise<{
    jobs: Job[];
    count: number;
  }> {
    const queue = ExuluQueues.list.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    const config = await queue.use();
    const startIndex = (page || 1) - 1;
    const endIndex = startIndex - 1 + (limit || 100);
    const jobs = await config.queue.getJobs(
      statusses || [],
      startIndex,
      endIndex,
      false,
    );
    const counts = await config.queue.getJobCounts(...(statusses || []));
    let total = 0;
    if (counts) {
      total = Object.keys(counts).reduce(
        (acc, key) => acc + (counts[key] || 0),
        0,
      );
    }
    return {
      jobs,
      count: total,
    };
  }
  