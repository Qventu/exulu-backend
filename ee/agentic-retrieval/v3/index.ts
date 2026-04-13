import { z } from "zod";
import { createBashTool } from "bash-tool";
import type { LanguageModel } from "ai";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import { checkLicense } from "@EE/entitlements";
import { ContextSampler } from "./context-sampler";
import { classifyQuery } from "./classifier";
import { createRetrievalTools } from "./tools";
import { STRATEGIES } from "./strategies";
import { runAgentLoop } from "./agent-loop";
import { TrajectoryLogger } from "./trajectory";
import type { AgenticRetrievalOutput, QueryType } from "./types";

// Module-level sampler — shared across all tool instances so the cache is warm
// across requests within the same process.
const sampler = new ContextSampler();

async function* executeV3({
  query,
  contexts,
  reranker,
  model,
  user,
  role,
  customInstructions,
}: {
  query: string;
  contexts: ExuluContext[];
  reranker?: ExuluReranker;
  model: LanguageModel;
  user?: User;
  role?: string;
  customInstructions?: string;
}): AsyncGenerator<AgenticRetrievalOutput> {
  // ── 1. Sample example records from each context (cached) ──────────────────
  console.log("[EXULU] v3 — sampling contexts");
  const samples = await sampler.getSamples(contexts, user, role);

  // ── 2. Classify query (single fast LLM call) ──────────────────────────────
  console.log("[EXULU] v3 — classifying query");
  let classification;
  try {
    classification = await classifyQuery(query, contexts, samples, model);
  } catch (err) {
    console.warn("[EXULU] v3 — classification failed, falling back to exploratory:", err);
    classification = {
      queryType: "exploratory" as QueryType,
      language: "eng",
      suggestedContextIds: [],
    };
  }
  console.log("[EXULU] v3 — classified as:", classification);

  // ── 3. Select strategy ────────────────────────────────────────────────────
  const strategy = STRATEGIES[classification.queryType];

  // Build context guidance: the classifier is a priority hint, not a hard filter.
  // All contexts remain available so the agent can fall back if suggested ones miss.
  const suggestedIds = classification.suggestedContextIds;
  const fallbackIds = contexts
    .filter((c) => !suggestedIds.includes(c.id))
    .map((c) => c.id);
  const contextGuidance =
    suggestedIds.length > 0
      ? `Suggested priority contexts: [${suggestedIds.join(", ")}]. Also available: [${fallbackIds.join(", ")}]. Custom instructions may require searching additional or all contexts — follow them.`
      : `All contexts available: [${contexts.map((c) => c.id).join(", ")}].`;

  // ── 4. Initialize tools ───────────────────────────────────────────────────
  const bashToolkit = await createBashTool({ files: {} });

  const retrievalTools = createRetrievalTools({
    contexts, // ALL contexts — agent decides which to search based on context guidance
    user,
    role,
    updateVirtualFiles: (files) => bashToolkit.sandbox.writeFiles(files),
  });

  // Build the tool set for this strategy
  const activeTools: Record<string, any> = {};
  for (const name of strategy.retrieval_tools) {
    if (name in retrievalTools) {
      activeTools[name] = retrievalTools[name as keyof typeof retrievalTools];
    }
  }
  if (strategy.include_bash) {
    Object.assign(activeTools, bashToolkit.tools);
  }

  // ── 5. Set up trajectory logging ──────────────────────────────────────────
  const trajectory = new TrajectoryLogger(query, classification);

  // ── 6. Run agent loop ─────────────────────────────────────────────────────
  let finalOutput: AgenticRetrievalOutput | undefined;
  let executionError: Error | undefined;

  try {
    for await (const output of runAgentLoop({
      query,
      strategy,
      tools: activeTools,
      model,
      reranker,
      contextGuidance,
      customInstructions,
      classification,
      onStepComplete: (step) => trajectory.recordStep(step),
    })) {
      finalOutput = output;
      yield output;
    }
  } catch (err) {
    executionError = err as Error;
    console.error("[EXULU] v3 — agent loop error:", err);
    throw err;
  } finally {
    if (finalOutput) {
      const trajectoryFile = await trajectory.finalize(finalOutput, !executionError, executionError);
      if (trajectoryFile) {
        finalOutput.trajectoryFile = trajectoryFile;
      }
    }
  }
}

/**
 * Creates the v3 ExuluTool for agentic context retrieval.
 *
 * Compared to v2:
 * - Single LLM call per step (vs two in v2)
 * - Query classification upfront → strategy-based step budget (1–3 vs hardcoded 2)
 * - Context example records sampled at init and cached
 * - Strategy-specific instructions and tool sets
 */
export function createAgenticRetrievalToolV3({
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
    id: "agentic_context_search",
    name: "Agentic Context Search",
    description: `Intelligent context search with query classification, strategy-based retrieval, and virtual filesystem filtering. Searches: ${contextNames}`,
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
        name: "reranker",
        description: "Reranker to use for result ranking",
        type: "string",
        default: "none",
      },
      {
        name: "reasoning_model",
        description: "By default the agentic retrieval tool uses the model from the agent calling the tool, but you can overwrite this here for the reasoning phase",
        type: "string",
        default: "",
      },
      {
        name: "search_model",
        description: "By default the agentic retrieval tool uses the model from the agent calling the tool, but you can overwrite this here for the search phase",
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
      
      /* ROADMAP:
      const app = exuluApp.get();
      let reasoningModel: LanguageModel | undefined = model;
      let searchModel: LanguageModel | undefined = model;

      
       if (toolVariablesConfig?.reasoning_model) {
        reasoningModel = app.provider(toolVariablesConfig.reasoning_model)?.model?.create({});
        if (!reasoningModel) {
          throw new Error("Reasoning model not found");
        }
      }

      if (toolVariablesConfig?.search_model) {
        searchModel = app.provider(toolVariablesConfig.search_model);
        if (!searchModel) {
          throw new Error("Search model not found");
        }
      } */

      if (!model) {
        throw new Error("Model is required for executing the agentic retrieval tool");
      }
      let activeContexts = contexts;
      let configuredReranker: ExuluReranker | undefined;
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

        const rerankerId = toolVariablesConfig["reranker"];
        if (rerankerId && rerankerId !== "none") {
          configuredReranker = rerankers.find((r) => r.id === rerankerId);
        }
      }

      const combinedInstructions = [
        configInstructions ? `Configuration instructions: ${configInstructions}` : "",
        adminInstructions ? `Admin instructions: ${adminInstructions}` : "",
        userInstructions ? `User instructions: ${userInstructions}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      for await (const output of executeV3({
        query,
        contexts: activeContexts,
        reranker: configuredReranker,
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
