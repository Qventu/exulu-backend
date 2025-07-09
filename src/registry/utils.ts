import { Job as BullmqJob } from "bullmq";
import { type Job as ExuluJob } from "@EXULU_TYPES/models/job";
import { ExuluLogger, ExuluWorkflow } from "./classes.ts";

export const bullmq = {
    validate: (bullmqJob: BullmqJob): void => {
        if (!bullmqJob.data) {
            throw new Error(`Missing job data for job ${bullmqJob.id}.`)
        }

        if (!bullmqJob.data.type) {
            throw new Error(`Missing property "type" in data for job ${bullmqJob.id}.`)
        }

        if (!bullmqJob.data.inputs) {
            throw new Error(`Missing property "inputs" in data for job ${bullmqJob.id}.`)
        }

        if (bullmqJob.data.type !== "embedder" && bullmqJob.data.type !== "workflow") {
            throw new Error(`Property "type" in data for job ${bullmqJob.id} must be of value "embedder" or "workflow".`)
        }
        
        if (!bullmqJob.data.workflow && !bullmqJob.data.embedder) {
            throw new Error(`Property "backend" in data for job ${bullmqJob.id} missing. Job  data: ${JSON.stringify(bullmqJob)}`)
        }
    },
    process: {
        workflow: async (bullmqJob: BullmqJob, exuluJob: ExuluJob, workflow: ExuluWorkflow | undefined, logsDir: string): Promise<{
            inputData?: any;
            result?: any;
            steps: any;
        }> => {

            if (!workflow) {
                throw new Error(`Workflow function with id: ${bullmqJob.data.backend} not found in registry.`)
            }

            console.log("[EXULU] starting workflow with job inputs.", bullmqJob.data.inputs)

            const logger = new ExuluLogger(exuluJob, logsDir)

            const output = await workflow.start({
                job: exuluJob,
                inputs: bullmqJob.data.inputs,
                user: bullmqJob.data.user,
                logger,
                session: bullmqJob.data.session,
                agent: bullmqJob.data.agent,
                label: bullmqJob.data.label
            });

            await logger.write(`Workflow completed. ${JSON.stringify(output)}`, "INFO");
            return output;
        },
    }
}
