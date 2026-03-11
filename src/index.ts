/* 
This file serves as the export and entry
point for the npm package.
*/

import "dotenv/config";
import { redisClient } from "./redis/client";
export { ExuluApp } from "./exulu/app/index.ts";
import { authentication } from "./auth/auth";
export { queues as ExuluQueues } from "@EE/queues/queues.ts";
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
import { MarkdownChunker } from "@EE/markdown";
import {
  gpt5MiniProvider,
  gpt5Provider,
  gpt5proProvider,
  gpt5CodexProvider,
  gpt5NanoProvider,
  gpt41Provider,
  gpt41MiniProvider,
  gpt4oProvider,
  gpt4oMiniProvider,
} from "./templates/providers/openai/gpt";
import {
  claudeSonnet4Provider,
  claudeOpus4Provider,
  claudeSonnet45Provider,
} from "./templates/providers/anthropic/claude";
import {
  vertexGemini25FlashProvider,
  vertexGemini3ProProvider,
  vertexGemini25ProProvider,
} from "./templates/providers/google/vertex";
import { gptOss120bProvider, llama38bProvider, llama3370bProvider } from "./templates/providers/cerebras";
import type { Item } from "@EXULU_TYPES/models/item";
import { documentProcessor } from "@EE/documents/processing/doc_processor.ts";
export type { Item as ExuluItem };

export const ExuluJobs = {
  redis: redisClient,
};

export const ExuluDefaultProviders = {
  anthropic: {
    opus4: claudeOpus4Provider,
    sonnet4: claudeSonnet4Provider,
    sonnet45: claudeSonnet45Provider,
  },
  cerebras: {
    gptOss120b: gptOss120bProvider,
    llama38b: llama38bProvider,
    llama3370b: llama3370bProvider,
  },
  google: {
    vertexGemini25Flash: vertexGemini25FlashProvider,
    vertexGemini25Pro: vertexGemini25ProProvider,
    vertexGemini3Pro: vertexGemini3ProProvider,
  },
  openai: {
    gpt5Mini: gpt5MiniProvider,
    gpt5: gpt5Provider,
    gpt5pro: gpt5proProvider,
    gpt5Codex: gpt5CodexProvider,
    gpt5Nano: gpt5NanoProvider,
    gpt41: gpt41Provider,
    gpt41Mini: gpt41MiniProvider,
    gpt4o: gpt4oProvider,
    gpt4oMini: gpt4oMiniProvider,
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

export const ExuluDocumentProcessor = {
  process: documentProcessor,
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
  markdown: MarkdownChunker,
  recursive: {
    function: RecursiveChunker,
    rules: RecursiveRules,
  },
};
