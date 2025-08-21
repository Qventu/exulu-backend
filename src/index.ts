import 'dotenv/config'
import { redisClient } from "./redis/client"
import { validateJob } from "./bullmq/validators"
export { ExuluContext, ExuluEmbedder, ExuluSource, ExuluAgent, ExuluTool, ExuluEval, ExuluZodFileType } from "./registry/classes"
export { ExuluApp } from "./registry/index"
export { type Job as ExuluJob } from "@EXULU_TYPES/models/job"
export { ExuluLogger } from "./registry/classes"
export { authentication as ExuluAuthentication } from "./auth/auth"
export { queues as ExuluQueues } from "./bullmq/queues"
import { RecursiveChunker } from "./chunking/recursive";
import { SentenceChunker } from "./chunking/sentence";
import { RecursiveRules } from "./chunking/types/recursive";
import { execute as initDb } from "./postgres/init-db"
import { generateApiKey } from './auth/generate-key'

export const ExuluJobs = {
    redis: redisClient,
    jobs: {
        validate: validateJob
    }
}

export { STATISTICS_TYPE_ENUM as EXULU_STATISTICS_TYPE_ENUM, type STATISTICS_TYPE as EXULU_STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics"
export { JOB_STATUS_ENUM as EXULU_JOB_STATUS_ENUM, type JOB_STATUS as EXULU_JOB_STATUS } from "@EXULU_TYPES/enums/jobs"

export const db = {
    init: async () => {
        await initDb()
    },
    api: {
        key: {
            generate: async (name: string, email: string) => {
                return await generateApiKey(name, email)
            }
        }
    }
}

export const ExuluChunkers = {
    sentence: SentenceChunker,
    recursive: {
        function: RecursiveChunker,
        rules: RecursiveRules
    }
}