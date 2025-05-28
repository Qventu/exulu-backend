
import { redisClient } from "./redis/client"
import { validateJob } from "./bullmq/validators"
import { execute as initDb } from "./postgres/init-db"
import { generateApiKey } from "./auth/generate-key"
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

export { STATISTICS_TYPE_ENUM as EXULU_STATISTICS_TYPE_ENUM, type STATISTICS_TYPE as EXULU_STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics"

export const ExuluDatabase = {
    init: async () => {
        await initDb()
    },
    generateApiKey: async (name: string, email: string) => {
        return await generateApiKey(name, email)
    }
}