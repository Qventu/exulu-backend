import { Job } from "bullmq";
import { ExuluLogger, ExuluWorkflow } from "./classes.ts";

export const bullmq = {
    validate: (job: Job): void => {
        if (!job.data) {
            throw new Error(`Missing job data for job ${job.id}.`)
        }

        if (!job.data.type) {
            throw new Error(`Missing property "type" in data for job ${job.id}.`)
        }

        if (!job.data.inputs) {
            throw new Error(`Missing property "inputs" in data for job ${job.id}.`)
        }

        if (job.data.type !== "embedder" && job.data.type !== "workflow") {
            throw new Error(`Property "type" in data for job ${job.id} must be of value "embedder" or "workflow".`)
        }
        
        if (!job.data.workflow && !job.data.embedder) {
            throw new Error(`Property "backend" in data for job ${job.id} missing. Job  data: ${JSON.stringify(job)}`)
        }
    },
    process: {
        workflow: async (job: Job, workflow: ExuluWorkflow | undefined, logsDir: string): Promise<{
            triggerData?: any;
            result?: any;
            results: any;
            runId: string;
            timestamp: number;
            activePaths: any
        }> => {

            if (!workflow) {
                throw new Error(`Workflow function with id: ${job.data.backend} not found in registry.`)
            }
            const { runId, start, watch } = workflow.workflow.createRun();

            console.log("[EXULU] starting workflow with job inputs.", job.data.inputs)

            const logger = new ExuluLogger(job, logsDir)

            const output =  await start({ triggerData: {
                ...job.data.inputs,
                redis: job.id,
                logger
            } });

            const failedSteps = Object.entries(output.results)
            .filter(([_, step]) => step.status === "failed")
            .map(([id, step]: any) => `${id}: ${step.error}`);
         
            if (failedSteps.length > 0) {
                const message = `Workflow has failed steps: ${failedSteps.join('\n - ')}`;
                logger.write(message, "ERROR");
                throw new Error(message)
            }

            await logger.write(`Workflow completed. ${JSON.stringify(output.results)}`, "INFO");
            return output;
        },
    }
}
