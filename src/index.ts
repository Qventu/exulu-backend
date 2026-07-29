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
export { defaultChunker } from "./exulu/chunker.ts"
export type { ChunkerOperation, ChunkerResponse } from "./exulu/chunker.ts"
export type { ExuluContextEmbedder } from "./exulu/context.ts"
export type { ExuluAgent } from "@EXULU_TYPES/models/agent.ts"
export { ExuluContext } from "./exulu/context.ts"
export { ExuluReadApi } from "./exulu/read-api.ts";
export { postgresClient } from "./postgres/client";
export type { VectorSearchChunkResult } from "./graphql/resolvers/vector-search.ts";
export { ExuluTool } from "./exulu/tool"
export type {
  ExuluAuthConfig,
  ExuluOauthConfig,
  ExuluUserCredentialsConfig,
  CredentialField,
  ExuluOauthToolContext,
  ExuluCredentialsToolContext,
} from "./exulu/auth/types"
export type { AuditEvent } from "./exulu/audit/event";
export type { AuditConfig } from "./exulu/audit/config";
export type { AuditLogger } from "./exulu/audit/logger";
export { ExuluEval } from "./exulu/evals"
// For script/CLI consumers that resolve models/embeddings against a proxy managed by a
// separately running server process (same mechanism the worker boot path uses).
export { enableLiteLLMClientMode } from "./exulu/litellm/supervisor.ts"
import { SentenceChunker } from "./chunking/sentence";
import { RecursiveRules } from "./chunking/types/recursive";
import { execute as initExuluDb } from "./postgres/init-exulu-db";
import { initLitellmDb } from "./postgres/init-litellm-db";
import { generateApiKey } from "./auth/generate-key";
import { create } from "./exulu/otel";
import { ExuluContext } from "./exulu/context.ts";
import CryptoJS from "crypto-js";
import { postgresClient } from "./postgres/client";
import { type Variable } from "@EXULU_TYPES/models/variable";
import { MarkdownChunker } from "@EE/chunking/markdown";
import type { Item } from "@EXULU_TYPES/models/item";
export type { Item as ExuluItem };

// Python integration exports
import {
  setupPythonEnvironment,
  isPythonEnvironmentSetup,
  validatePythonEnvironment,
  getPythonSetupInstructions,
} from './utils/python-setup';
import { documentProcessor } from "@EE/python/documents/processing/doc_processor.ts";
import { rerank } from "./exulu/reranker";
import { createAgenticRetrievalTool } from "@EE/agentic-retrieval/pipeline/index.ts";

export const ExuluJobs = {
  redis: redisClient,
};

export const ExuluDefaultTools = {
  agentic: {
    retrieval: {
      create: {
        pipeline: createAgenticRetrievalTool
      }
    },
  },
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
};

export const ExuluAuthentication = {
  authenticate: authentication,
}

export const ExuluDocumentProcessor = {
  process: documentProcessor,
}

export const ExuluReranker = {
  rerank,
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
  init: async ({ contexts, litellm }: { contexts: ExuluContext[], litellm?: boolean }) => {
    await initExuluDb({ contexts });
    if (litellm !== false) {
      await initLitellmDb();
    }
  },
  update: async ({ contexts, litellm }: { contexts: ExuluContext[], litellm?: boolean }) => {
    await initExuluDb({ contexts });
    if (litellm !== false) {
      await initLitellmDb();
    }
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

export const ExuluPython = {
  setup: setupPythonEnvironment,
  check: isPythonEnvironmentSetup,
  validate: validatePythonEnvironment,
  instructions: getPythonSetupInstructions,
}

export { CredentialInvalidError } from "./exulu/auth/errors";
