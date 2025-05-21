import type {Job} from "bullmq";

export const validateJob = (job: Job) => {
    if (!job.data) {
        throw new Error(`Missing job data for job ${job.id}.`)
    }

    if (!job.data.type) {
        throw new Error(`Missing property "type" in data for job ${job.id}.`)
    }

    if (!job.data.function) {
        throw new Error(`Missing property "function" in data for job ${job.id}.`)
    }

    if (!job.data.inputs) {
        throw new Error(`Missing property "inputs" in data for job ${job.id}.`)
    }

    if (job.data.type !== "embedder" && job.data.type !== "workflow") {
        throw new Error(`Property "type" in data for job ${job.id} must be of value "embedder" or "agent".`)
    }

    if (
        job.data.type === "workflow" &&
        job.data.function !== "execute"
    ) {
        throw new Error(`Property "function" in data for job ${job.id} must be of value "execute" when using type "workflow".`)
    }

    if (
        job.data.type === "embedder" &&
        job.data.function !== "upsert" &&
        job.data.function !== "delete" &&
        job.data.function !== "retrieve"
    ) {
        throw new Error(`Property "function" in data for job ${job.id} must be of value "upsert", "delete" or "retrieve" when using type "embedder".`)
    }

    if (!job.data.id) {
        throw new Error(`Property "id" in data for job ${job.id} missing.`)
    }

    return job;
}