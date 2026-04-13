import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { LanguageModel } from "ai";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import { checkLicense } from "@EE/entitlements";
import { createTools } from "./tools";
import { buildSystemPrompt } from "./system-prompt";
import { runAgentLoop } from "./agent-loop";
import type { AgenticRetrievalOutput } from "./types";

async function* executeV4({
  query,
  contexts,
  model,
  user,
  role,
  customInstructions,
}: {
  query: string;
  contexts: ExuluContext[];
  model: LanguageModel;
  user?: User;
  role?: string;
  customInstructions?: string;
}): AsyncGenerator<AgenticRetrievalOutput> {
  // Per-call temp directory — cleaned up after the loop finishes
  const sessionId = randomUUID();
  const sessionDir = path.join(os.tmpdir(), `exulu-v4-${sessionId}`);

  console.log("[EXULU] v4 — starting observe-infer-act retrieval");

  const tools = createTools({ contexts, user, role, sessionDir });
  const systemPrompt = buildSystemPrompt(contexts, customInstructions);

  let finalOutput: AgenticRetrievalOutput | undefined;

  try {
    for await (const output of runAgentLoop({
      query,
      systemPrompt,
      tools,
      model,
    })) {
      finalOutput = output;
      yield output;
    }
  } finally {
    // Best-effort cleanup of temp files
    fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }

  if (finalOutput) {
    console.log(
      `[EXULU] v4 — done. steps=${finalOutput.steps.length} chunks=${finalOutput.chunks.length} tokens=${finalOutput.totalTokens}`,
    );
  }
}

/**
 * Creates the V4 ExuluTool for agentic context retrieval.
 *
 * V4 uses an observe-infer-act loop with two primitive tools:
 * - execute_query: raw PostgreSQL SELECT via db.raw (with embed() helper for semantic search)
 * - grep: iterative search on large result files
 *
 * Unlike V3, there is no upfront query classification or strategy routing.
 * The agent writes its own SQL and decides when it has found enough information.
 */
export function createAgenticRetrievalToolV4({
  contexts,
  instructions: adminInstructions,
  rerankers,
  user,
  role,
  model,
}: {
  contexts: ExuluContext[];
  rerankers: ExuluReranker[];
  user?: User;
  role?: string;
  model?: LanguageModel;
  instructions?: string;
}): ExuluTool | undefined {
  const license = checkLicense();
  if (!license["agentic-retrieval"]) {
    console.warn("[EXULU] Not licensed for agentic retrieval");
    return undefined;
  }

  const contextNames = contexts.map((c) => c.id).join(", ");

  return new ExuluTool({
    id: "agentic_context_search_v4",
    name: "Agentic Context Search (V4)",
    description: `Observe-infer-act retrieval using raw SQL. Searches: ${contextNames}`,
    category: "contexts",
    needsApproval: false,
    type: "context",
    config: [
      {
        name: "instructions",
        description: "Custom instructions for the retrieval agent",
        type: "string",
        default: "",
      },
      {
        name: "reasoning_model",
        description:
          "Override the model used by the retrieval agent (default: inherits from calling agent)",
        type: "string",
        default: "",
      },
      ...contexts.map((ctx) => ({
        name: ctx.id,
        description: `Enable search in "${ctx.name}". ${ctx.description}`,
        type: "boolean" as const,
        default: true,
      })),
    ],
    inputSchema: z.object({
      query: z.string().describe("The question or query to answer"),
      userInstructions: z
        .string()
        .optional()
        .describe("Additional instructions from the user to guide retrieval"),
    }),
    execute: async function* ({
      query,
      userInstructions,
      toolVariablesConfig,
    }: {
      query: string;
      userInstructions?: string;
      toolVariablesConfig?: Record<string, any>;
    }) {
      if (!model) {
        throw new Error("Model is required for executing the agentic retrieval tool");
      }

      let activeContexts = contexts;
      let configInstructions = "";

      if (toolVariablesConfig) {
        configInstructions = toolVariablesConfig["instructions"] ?? "";

        activeContexts = contexts.filter(
          (ctx) =>
            toolVariablesConfig[ctx.id] === true ||
            toolVariablesConfig[ctx.id] === "true" ||
            toolVariablesConfig[ctx.id] === 1,
        );
        if (activeContexts.length === 0) activeContexts = contexts;
      }

      const combinedInstructions = [
        configInstructions ? `Configuration instructions: ${configInstructions}` : "",
        adminInstructions ? `Admin instructions: ${adminInstructions}` : "",
        userInstructions ? `User instructions: ${userInstructions}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      for await (const output of executeV4({
        query,
        contexts: activeContexts,
        model,
        user,
        role,
        customInstructions: combinedInstructions || undefined,
      })) {
        yield { result: JSON.stringify(output) };
      }
    },
  });
}
