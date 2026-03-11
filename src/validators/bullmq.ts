import type { BullMqJobData } from "@EE/queues/decorator";

export const bullmq = {
  validate: (id: string | undefined, data: BullMqJobData): void => {
    if (!data) {
      throw new Error(`Missing job data for job ${id}.`);
    }

    if (!data.type) {
      throw new Error(`Missing property "type" in data for job ${id}.`);
    }

    if (!data.inputs) {
      throw new Error(`Missing property "inputs" in data for job ${id}.`);
    }

    if (
      data.type !== "embedder" &&
      data.type !== "workflow" &&
      data.type !== "processor" &&
      data.type !== "eval_run" &&
      data.type !== "eval_function" &&
      data.type !== "source"
    ) {
      throw new Error(
        `Property "type" in data for job ${id} must be of value "embedder", "workflow", "processor", "eval_run", "eval_function" or "source".`,
      );
    }

    if (
      !data.workflow &&
      !data.embedder &&
      !data.processor &&
      !data.eval_run_id &&
      !data.eval_functions?.length &&
      !data.source
    ) {
      throw new Error(
        `Either a workflow, embedder, processor, eval_run, eval_functions or source must be set for job ${id}.`,
      );
    }
  },
};
