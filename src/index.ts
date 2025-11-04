import 'dotenv/config'
import { redisClient } from "./redis/client"
import { validateJob } from "./bullmq/validators"
export { ExuluContext, ExuluEmbedder, ExuluAgent, ExuluTool, ExuluEval, type ExuluQueueConfig, type ExuluEvalMetadata, type ExuluEvalTokenMetadata, /* ExuluMcpToolsClient */ } from "./registry/classes"
export { ExuluApp } from "./registry/index"
export { authentication as ExuluAuthentication } from "./auth/auth"
export { queues as ExuluQueues } from "./bullmq/queues"
export { logMetadata } from "./registry/log-metadata"
import { RecursiveChunker } from "./chunking/recursive";
import { SentenceChunker } from "./chunking/sentence";
import { RecursiveRules } from "./chunking/types/recursive";
import { execute as initDb } from "./postgres/init-db"
import { generateApiKey } from './auth/generate-key'
import { create } from './registry/otel'
import type { ExuluContext } from './registry/classes'
import { codeStandardsContext } from './templates/contexts/code-standards'
import { outputsContext } from './templates/contexts/outputs'
import CryptoJS from 'crypto-js';
import { postgresClient } from './postgres/client'
import { type Variable } from '@EXULU_TYPES/models/variable'
import { gpt5MiniAgent, gpt5agent, gpt5proAgent, gpt5CodexAgent, gpt5NanoAgent, gpt41Agent, gpt41MiniAgent, gpt4oAgent, gpt4oMiniAgent } from './templates/agents/openai/gpt'
import { claudeSonnet4Agent, claudeOpus4Agent, claudeSonnet45Agent } from './templates/agents/anthropic/claude'

export const ExuluJobs = {
    redis: redisClient,
    jobs: {
        validate: validateJob
    }
}

export const ExuluDefaultContexts = {
    codeStandards: codeStandardsContext,
    outputs: outputsContext
}

export const ExuluDefaultAgents = {
    anthropic: {
        opus4: claudeOpus4Agent,
        sonnet4: claudeSonnet4Agent,
        sonnet45: claudeSonnet45Agent
    },
    openai: {
        gpt5Mini: gpt5MiniAgent,
        gpt5: gpt5agent,
        gpt5pro: gpt5proAgent,
        gpt5Codex: gpt5CodexAgent,
        gpt5Nano: gpt5NanoAgent,
        gpt41: gpt41Agent,
        gpt41Mini: gpt41MiniAgent,
        gpt4o: gpt4oAgent,
        gpt4oMini: gpt4oMiniAgent
    }
}

export const ExuluVariables = {
    get: async (name: string) => {
        const { db } = await postgresClient();
        let variable: Variable | undefined = await db.from("variables").where({ name: name }).first();
        if (!variable) {
            throw new Error(`Variable ${name} not found.`);
        }
        if (variable.encrypted) {
            const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
            variable.value = bytes.toString(CryptoJS.enc.Utf8);
        }
        return variable.value;
    }
}

export const ExuluUtils = {
    batch: async ({
        fn,
        size,
        inputs,
        delay,
        retries
    }: {
        fn: (data: any) => Promise<any>;
        size: number;
        inputs: any[];
        delay: number;
        retries: {
            max: number;
            delays: number[];
        }
    }): Promise<any[]> => {
        if (!size) {
            size = 10;
        }
        if (!inputs) {
            throw new Error("Inputs are required.");
        }
        if (!delay) {
            delay = 0;
        }
        let results: any[] = [];
        let lastBatchTime = 0;

        for (let start = 0; start < inputs.length; start += size) {
            const currentTime = Date.now();
            const timeSinceLastBatch = currentTime - lastBatchTime;
            if (timeSinceLastBatch < delay * 1000) {
                console.log("[EXULU] Utils function, waiting for", delay - timeSinceLastBatch, "seconds")
                await new Promise(resolve => setTimeout(resolve, delay * 1000 - timeSinceLastBatch));
            }
            lastBatchTime = Date.now();
            console.log(`[EXULU] Utils function, processing batch ${start / size + 1} of ${Math.ceil(inputs.length / size)} (${Math.min(start + 1, inputs.length)}-${Math.min(start + size, inputs.length)} of ${inputs.length})`);
            const end = start + size > inputs.length ? inputs.length : start + size;

            const slicedResults = await Promise.all(inputs.slice(start, end).map((data, i) => {
                if (retries?.max) {
                    return ExuluUtils.retry({
                        fn: async () => {
                            return await fn(data)
                        },
                        retries: retries.max,
                        delays: retries.delays
                    });
                } else {
                    return fn(data);
                }

            }));

            results = [
                ...results,
                ...slicedResults,
            ]
        }
        return results;
    },
    retry: async ({
        fn,
        retries,
        delays
    }: {
        fn: () => Promise<any>;
        retries?: number;
        delays?: number[];
    }) => {
        if (!retries) {
            retries = 3;
        }
        if (!delays) {
            delays = [1000, 5000, 10000];
        }
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                console.error(`[EXULU] Util function, retry attempt ${i + 1} failed:`, error);
                if (i >= retries - 1) {
                    throw error;
                }
                if (!delays[i]) {
                    delays[i] = delays[delays.length - 1] || 10000; // default to the last provided delay or 10 seconds
                }
                const delay = delays && delays[i] ? delays[i] : 10000;
                console.log(`[EXULU] Util function, retrying in ${delay! / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}


export const ExuluOtel = {
    create: ({
        SIGNOZ_ACCESS_TOKEN,
        SIGNOZ_TRACES_URL,
        SIGNOZ_LOGS_URL
    }: {
        SIGNOZ_ACCESS_TOKEN: string;
        SIGNOZ_TRACES_URL: string;
        SIGNOZ_LOGS_URL: string;
    }) => {
        return create({
            SIGNOZ_ACCESS_TOKEN,
            SIGNOZ_TRACES_URL,
            SIGNOZ_LOGS_URL
        })
    }
}

export { STATISTICS_TYPE_ENUM as EXULU_STATISTICS_TYPE_ENUM, type STATISTICS_TYPE as EXULU_STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics"
export { JOB_STATUS_ENUM as EXULU_JOB_STATUS_ENUM, type JOB_STATUS as EXULU_JOB_STATUS } from "@EXULU_TYPES/enums/jobs"

export const db = {
    init: async ({
        contexts
    }: {
        contexts: ExuluContext[]
    }) => {
        await initDb({ contexts })
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