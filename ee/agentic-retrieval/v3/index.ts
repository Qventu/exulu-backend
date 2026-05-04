import { z } from "zod";
import { createBashTool } from "bash-tool";
import type { LanguageModel, Tool } from "ai";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import { ExuluTool } from "@SRC/exulu/tool";
import type { User } from "@EXULU_TYPES/models/user";
import { checkLicense } from "@EE/entitlements";
import { ContextSampler } from "./context-sampler";
import { classifyQuery } from "./classifier";
import { createRetrievalTools, parseGlobalItemIds } from "./tools";
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
  logTrajectory,
  sessionId,
  preselectedItemIds,
}: {
  query: string;
  contexts: ExuluContext[];
  reranker?: ExuluReranker;
  model: LanguageModel;
  user?: User;
  role?: string;
  customInstructions?: string;
  logTrajectory?: boolean;
  sessionId?: string;
  preselectedItemIds?: string[];
}): AsyncGenerator<AgenticRetrievalOutput> {
  // ── 1. Parse preselected item IDs (global format: "<context_id>/<item_id>") ─
  const preselectedByContext = preselectedItemIds?.length
    ? parseGlobalItemIds(preselectedItemIds)
    : undefined;

  // When preselection is active, restrict to only contexts that have selected items
  const activeContexts = preselectedByContext?.size
    ? contexts.filter((c) => preselectedByContext.has(c.id))
    : contexts;

  // ── 2. Sample example records from each context (cached) ──────────────────
  console.log("[EXULU] v3 — sampling contexts");
  const samples = await sampler.getSamples(activeContexts, user, role);

  // ── 3. Classify query (single fast LLM call) ──────────────────────────────
  console.log("[EXULU] v3 — classifying query");
  let classification;
  try {
    classification = await classifyQuery(query, activeContexts, samples, model);
  } catch (err) {
    console.warn("[EXULU] v3 — classification failed, falling back to exploratory:", err);
    classification = {
      queryType: "exploratory" as QueryType,
      language: "eng",
      suggestedContextIds: [],
    };
  }
  console.log("[EXULU] v3 — classified as:", classification);

  // ── 4. Select strategy ────────────────────────────────────────────────────
  const strategy = STRATEGIES[classification.queryType];

  // Build context guidance: the classifier is a priority hint, not a hard filter.
  // All contexts remain available so the agent can fall back if suggested ones miss.
  const suggestedIds = classification.suggestedContextIds;
  const fallbackIds = activeContexts
    .filter((c) => !suggestedIds.includes(c.id))
    .map((c) => c.id);
  const contextBase =
    suggestedIds.length > 0
      ? `Suggested priority contexts: [${suggestedIds.join(", ")}]. Also available: [${fallbackIds.join(", ")}]. Custom instructions may require searching additional or all contexts — follow them.`
      : `All contexts available: [${activeContexts.map((c) => c.id).join(", ")}].`;

  const preselectedNote = preselectedByContext?.size
    ? `\nSCOPE CONSTRAINT: Retrieval is scoped to preselected items/contexts. Per context: ${[...preselectedByContext.entries()].map(([ctx, ids]) => ids === null ? `${ctx} (full context)` : `${ctx} (${ids.length} item${ids.length === 1 ? "" : "s"})`).join(", ")}. All tools enforce this scope automatically. For full-context entries you may search freely; for item-restricted entries do NOT use search_items_by_name for discovery — go directly to search_content or save_search_results.`
    : "";

  const contextGuidance = contextBase + preselectedNote;

  // ── 5. Initialize tools ───────────────────────────────────────────────────
  const bashToolkit = await createBashTool({ files: {} });

  const retrievalTools = createRetrievalTools({
    contexts: activeContexts,
    user,
    role,
    updateVirtualFiles: (files) => bashToolkit.sandbox.writeFiles(files),
    preselectedItemsByContext: preselectedByContext,
  });

  // Build the tool set for this strategy
  const activeTools: Record<string, Tool> = {};
  for (const name of strategy.retrieval_tools) {
    if (name in retrievalTools) {
      activeTools[name] = retrievalTools[name as keyof typeof retrievalTools];
    }
  }
  if (strategy.include_bash) {
    Object.assign(activeTools, bashToolkit.tools);
  }

  // ── 6. Set up trajectory logging ──────────────────────────────────────────
  const trajectory = new TrajectoryLogger(query, classification, undefined, preselectedItemIds);

  // ── 7. Run agent loop ─────────────────────────────────────────────────────
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
      sessionId,
      onStepComplete: (step) => trajectory.recordStep(step),
      onTrajectoryStep: (data) => trajectory.recordRichStep(data),
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
      const trajectoryFile = await trajectory.finalize(finalOutput, !executionError, executionError, logTrajectory);
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
  preselectedItemIds,
}: {
  contexts: ExuluContext[];
  rerankers: ExuluReranker[];
  user?: User;
  role?: string;
  model?: LanguageModel;
  instructions?: string;
  preselectedItemIds?: string[];
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
        name: "managed_context",
        description: "Makes sure the user defines which items from which contexts the agentic retrieval tool will search in",
        type: "boolean",
        default: false,
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
      {
        name: "require_preselected_contexts",
        description: "Require the user to preselect contexts before executing the tool, meaning the user will be asked to select the contexts they want to search in",
        type: "boolean",
        default: false,
      },
      {
        name: "log_trajectories",
        description: "Save a detailed markdown + JSON log of every retrieval execution to disk. Useful for debugging and evaluation.",
        type: "boolean",
        default: false,
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
      confirmedContextIds: z
        .array(z.string())
        .optional()
        .describe(
          "Knowledge base IDs explicitly confirmed by the user to be used in the retrieval. " +
          "When presen only searches these contexts. "
        )
    }),
    execute: async function* ({
      query,
      userInstructions,
      confirmedContextIds,
      toolVariablesConfig,
      sessionID,
    }: {
      query: string;
      userInstructions?: string;
      confirmedContextIds?: string[];
      toolVariablesConfig?: Record<string, any>;
      sessionID?: string;
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
        yield { result: "Model is required for executing the agentic retrieval tool" };
        return;
      }

      let activeContexts = contexts;
      let configuredReranker: ExuluReranker | undefined;
      let configInstructions = "";
      let logTrajectory = false;
      let requiresPreselectedContexts = false;
      let managedContextEnabled = false;

      if (toolVariablesConfig) {
        configInstructions = toolVariablesConfig["instructions"] ?? "";
        logTrajectory =
          toolVariablesConfig["log_trajectories"] === true ||
          toolVariablesConfig["log_trajectories"] === "true";

        managedContextEnabled = toolVariablesConfig["managed_context"] === true || toolVariablesConfig["managed_context"] === "true";

        activeContexts = contexts.filter(
          (ctx) =>
            toolVariablesConfig[ctx.id] === true ||
            toolVariablesConfig[ctx.id] === "true" ||
            toolVariablesConfig[ctx.id] === 1,
        );
        if (activeContexts.length === 0) activeContexts = contexts;

        requiresPreselectedContexts = toolVariablesConfig["require_preselected_contexts"] === true || toolVariablesConfig["require_preselected_contexts"] === "true";

        const rerankerId = toolVariablesConfig["reranker"];
        
        if (rerankerId && rerankerId !== "none") {
          configuredReranker = rerankers.find((r) => r.id === rerankerId);
        }
      }

      console.log("[EXULU] Managed context enabled:", managedContextEnabled);
      console.log("[EXULU] Preselected item IDs:", preselectedItemIds);

      if (managedContextEnabled && !preselectedItemIds?.length) {
        console.log("[EXULU] Managed context was enabled for the agentic retrieval tool. This means that the user must preselect items that the agentic retrieval tool will search in, please notify the user to preselect items before executing the tool.");
        yield { result: "Managed context was enabled for the agentic retrieval tool. This means that the user must preselect items that the agentic retrieval tool will search in, please notify the user to preselect items before executing the tool." };
        return;
      }

      if (requiresPreselectedContexts && !confirmedContextIds?.length && !preselectedItemIds?.length) {
        console.log("[EXULU] The user must choose between the available contexts before executing the tool. The available contexts are: " + activeContexts.map((c) => c.id).join(", ") + ". If the question_ask tool is available use that to ask the user which contexts they want to search in, otherwise just ask them in plain text.");
        yield { result: "The user must choose between the available contexts before executing the tool, the available contexts are: " + activeContexts.map((c) => c.id).join(", ") + ". If the question_ask tool is available use that to ask the user which contexts they want to search in, otherwise just ask them in plain text." };
        return;
      }

      if (confirmedContextIds?.length) {
        const confirmed = new Set(confirmedContextIds);
        const filtered = activeContexts.filter((c) => confirmed.has(c.id));
        if (filtered.length > 0) activeContexts = filtered;
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
        logTrajectory,
        sessionId: sessionID,
        preselectedItemIds,
      })) {
        yield { result: JSON.stringify(output) };
      }
      return;
    },
  });
}
