/* 
This file serves as the export and entry
point for the npm package @exulu/backend.
*/

import "dotenv/config";
import { redisClient } from "./redis/client";
export { ExuluApp } from "./exulu/app/index.ts";
import { authentication } from "./auth/auth";
export { queues as ExuluQueues } from "./bullmq/queues";
import { RecursiveChunker } from "./chunking/recursive";
export { ExuluEmbedder } from "./exulu/embedder.ts"
export { ExuluContext } from "./exulu/context.ts"
export { ExuluTool } from "./exulu/tool"
export { ExuluReranker } from "./exulu/reranker"
export { ExuluEval } from "./exulu/evals"
import { SentenceChunker } from "./chunking/sentence";
import { RecursiveRules } from "./chunking/types/recursive";
import { execute as initDb } from "./postgres/init-db";
import { generateApiKey } from "./auth/generate-key";
import { create } from "./exulu/otel";
import { ExuluContext } from "./exulu/context.ts";
import CryptoJS from "crypto-js";
import { postgresClient } from "./postgres/client";
import { type Variable } from "@EXULU_TYPES/models/variable";
import {
  gpt5MiniAgent,
  gpt5agent,
  gpt5proAgent,
  gpt5CodexAgent,
  gpt5NanoAgent,
  gpt41Agent,
  gpt41MiniAgent,
  gpt4oAgent,
  gpt4oMiniAgent,
} from "./templates/agents/openai/gpt";
import {
  claudeSonnet4Agent,
  claudeOpus4Agent,
  claudeSonnet45Agent,
} from "./templates/agents/anthropic/claude";
import {
  vertexGemini25FlashAgent,
  vertexGemini3ProAgent,
  vertexGemini25ProAgent,
} from "./templates/agents/google/vertex";
import { gptOss120bAgent, llama38bAgent, llama3370bAgent } from "./templates/agents/cerebras";
import type { Item } from "@EXULU_TYPES/models/item";
export type { Item as ExuluItem };

export const ExuluJobs = {
  redis: redisClient,
};

export const ExuluDefaultAgents = {
  anthropic: {
    opus4: claudeOpus4Agent,
    sonnet4: claudeSonnet4Agent,
    sonnet45: claudeSonnet45Agent,
  },
  cerebras: {
    gptOss120b: gptOss120bAgent,
    llama38b: llama38bAgent,
    llama3370b: llama3370bAgent,
  },
  google: {
    vertexGemini25Flash: vertexGemini25FlashAgent,
    vertexGemini25Pro: vertexGemini25ProAgent,
    vertexGemini3Pro: vertexGemini3ProAgent,
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
    gpt4oMini: gpt4oMiniAgent,
  },
};

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
  },
};

export const ExuluAuthentication = {
  authenticate: authentication,
}

export const ExuluOtel = {
  create: ({
    SIGNOZ_ACCESS_TOKEN,
    SIGNOZ_TRACES_URL,
    SIGNOZ_LOGS_URL,
  }: {
    SIGNOZ_ACCESS_TOKEN: string;
    SIGNOZ_TRACES_URL: string;
    SIGNOZ_LOGS_URL: string;
  }) => {
    return create({
      SIGNOZ_ACCESS_TOKEN,
      SIGNOZ_TRACES_URL,
      SIGNOZ_LOGS_URL,
    });
  },
};

export {
  STATISTICS_TYPE_ENUM as EXULU_STATISTICS_TYPE_ENUM,
  type STATISTICS_TYPE as EXULU_STATISTICS_TYPE,
} from "@EXULU_TYPES/enums/statistics";
export {
  JOB_STATUS_ENUM as EXULU_JOB_STATUS_ENUM,
  type JOB_STATUS as EXULU_JOB_STATUS,
} from "@EXULU_TYPES/enums/jobs";

export const ExuluDatabase = {
  init: async ({ contexts }: { contexts: ExuluContext[] }) => {
    await initDb({ contexts });
  },
  update: async ({ contexts }: { contexts: ExuluContext[] }) => {
    await initDb({ contexts });
  },
  api: {
    key: {
      generate: async (name: string, email: string) => {
        return await generateApiKey(name, email);
      },
    },
  },
};

export const ExuluChunkers = {
  sentence: SentenceChunker,
  recursive: {
    function: RecursiveChunker,
    rules: RecursiveRules,
  },
};
