import type { ExuluBullMqDecoratorData, ExuluJobType } from "./decoraters/bullmq.ts";

export const bullmq = {
    validate: (id: string | undefined, data: ExuluBullMqDecoratorData & { type: ExuluJobType }): void => {
        if (!data) {
            throw new Error(`Missing job data for job ${id}.`)
        }

        if (!data.type) {
            throw new Error(`Missing property "type" in data for job ${id}.`)
        }

        if (!data.inputs) {
            throw new Error(`Missing property "inputs" in data for job ${id}.`)
        }

        if (data.type !== "embedder" && data.type !== "workflow") {
            throw new Error(`Property "type" in data for job ${id} must be of value "embedder" or "workflow".`)
        }
        
        if (!data.workflow && !data.embedder) {
            throw new Error(`Either a workflow or embedder must be set for job ${id}.`)
        }
    }
}
