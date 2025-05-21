
import { redisClient } from "./redis/client"
import { validateJob } from "./bullmq/validators"
import { execute as initDb } from "./postgres/init-db"

export { ExuluContext, ExuluEmbedder, ExuluSource, ExuluWorkflow, ExuluAgent, ExuluTool, ExuluZodFileType } from "./registry/classes"
export { ExuluApp } from "./registry/index"
export { authentication as ExuluAuthentication  } from "./auth/auth"
export { queues as ExuluQueues } from "./bullmq/queues"
export const ExuluJobs = {
    redis: redisClient,
    jobs: {
        validate: validateJob
    }
}

export const ExuluDatabase = {
    init: async () => {
        await initDb()
    }
}