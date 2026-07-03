import { z } from "zod";
import type { LanguageModel } from "ai";
import type { ExuluContext } from "@SRC/exulu/context";
import type { User } from "@EXULU_TYPES/models/user";
import { ExuluTool } from "@SRC/exulu/tool";
import { checkLicense } from "@EE/entitlements";
import { resolveReranker } from "@SRC/exulu/resolve-reranker";
import { resolveModel } from "@SRC/exulu/resolve-model";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { parsePipelineConfig, effectiveKbSettings } from "./config";
import { runRoutingPhase } from "./routing";
import { runMemoryPhase } from "./memory";
import { resolveIdentifierPins } from "./prefilter";
import { searchContexts } from "./search";
import { rerankResults } from "./rerank";
import type { AgenticRetrievalOutput, RerankState, ChunkWithScore } from "./types";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";

// ---------------------------------------------------------------------------
// parsePreselectedItems — verbatim copy of parseGlobalItemIds from v3/tools.ts
// (renamed for the pipeline public API)
// ---------------------------------------------------------------------------

/**
 * Parse a list of global preselected IDs into a per-context map.
 *
 * Two supported formats:
 *   "<context_id>/<item_id>" → specific item; value is a non-empty string[]
 *   "<context_id>"           → full context (no item filter); value is null
 *
 * If both a full-context entry and specific-item entries exist for the same
 * context, full-context (null) wins.
 */
export function parsePreselectedItems(globalIds: string[]): Map<string, string[] | null> {
  const map = new Map<string, string[] | null>();
  for (const gid of globalIds) {
    const slashIdx = gid.indexOf("/");
    if (slashIdx === -1) {
      // No slash → entire context selected
      if (gid) map.set(gid, null);
      continue;
    }
    const contextId = gid.slice(0, slashIdx);
    const itemId = gid.slice(slashIdx + 1);
    if (!contextId || !itemId) continue;
    // Full-context entry already wins — don't downgrade to specific items
    if (map.get(contextId) === null) continue;
    const existing = map.get(contextId) ?? [];
    existing.push(itemId);
    map.set(contextId, existing);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgenticRetrievalTool(opts: {
  contexts: ExuluContext[];
  memoryContext?: ExuluContext;
  user?: User;
  role?: string;
  model?: LanguageModel;
  instructions?: string;
  preselected?: string[];
  memoryItems?: VectorSearchChunkResult[];
}): ExuluTool | undefined {
  const {
    contexts,
    memoryContext,
    user,
    role,
    model,
    instructions: adminInstructions,
    preselected,
    memoryItems,
  } = opts;

  const license = checkLicense();
  if (!license["agentic-retrieval"]) {
    console.warn("[EXULU] Not licensed for agentic retrieval");
    return undefined;
  }

  return ExuluTool.internal({
    id: "agentic_context_search",
    name: "Context Search",
    description: `Intelligent knowledge search across the available knowledge bases: ${contexts.map((c) => c.name || c.id).join(", ")}. Routes the question to the right sources, searches them with query expansion, and returns reranked passages.`,
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
        name: "require_preselected_contexts",
        description: "Require the user to preselect contexts before executing the tool, meaning the user will be asked to select the contexts they want to search in",
        type: "boolean",
        default: false,
      },
      {
        name: "logging",
        description: "Save a detailed markdown + JSON log of every retrieval execution to disk. Useful for debugging and evaluation.",
        type: "boolean",
        default: false,
      },
      {
        name: "utility_model",
        description: "Optional model id used for the pipeline's internal micro-calls (classification, memory checks, query expansion). Empty = the agent's own model.",
        type: "string",
        default: "",
      },
      {
        name: "knowledge_bases",
        description: "Per-knowledge-base profiles: enabled, kind (documents | conversations | records), instructions, and per-KB overrides (limit, expand, multiQuery, hyde). JSON object keyed by context id.",
        type: "json",
        default: "{}",
      },
      {
        name: "routing",
        description: "Routing rules: plain-language categories mapping to main and fallback knowledge bases. Empty = search all enabled knowledge bases.",
        type: "json",
        default: '{"rules":[]}',
      },
      {
        name: "vocabulary",
        description: "Domain vocabulary: glossary (term/meaning), identifier sets (product names, standards) used to pin matching files, query rewrite rules, and a styleHint describing the documents (feeds query expansion).",
        type: "json",
        default: '{"glossary":[],"identifiers":[],"rewrites":[],"styleHint":""}',
      },
      {
        name: "memory",
        description: "Memory features (requires the agent to have a memory context): relevance-checked recall, authoritative override, file prioritization, query augmentation.",
        type: "json",
        default: '{"enabled":true,"override":false,"filePrioritization":false,"queryAugmentation":true}',
      },
      {
        name: "tuning",
        description: "Retrieval tuning: topK, fallbackThreshold, pinBoost, identifierBoost, pageWindow, maxQueriesPerContext.",
        type: "json",
        default: '{"topK":5,"fallbackThreshold":0.95,"pinBoost":0.15,"identifierBoost":0.15,"pageWindow":1,"maxQueriesPerContext":5}',
      },
    ],
    inputSchema: z.object({
      userQuery: z.string().describe("The original unaltered question from the user"),
      relevantKeywords: z.array(z.string()).describe("Keywords extracted from the user's question relevant to the search"),
      importantKeyword: z.string().describe("The single most important keyword from the user's question"),
      confirmedContextIds: z
        .array(z.string())
        .optional()
        .describe(
          "Knowledge base IDs explicitly confirmed by the user to be used in the retrieval. " +
          "When present, only searches these contexts."
        ),
    }),
    execute: async function* ({
      userQuery,
      relevantKeywords,
      importantKeyword,
      confirmedContextIds,
      toolVariablesConfig,
    }: {
      userQuery: string;
      relevantKeywords: string[];
      importantKeyword: string;
      confirmedContextIds?: string[];
      toolVariablesConfig?: Record<string, unknown>;
    }) {
      // ── Gate: model required ──────────────────────────────────────────────
      if (!model) {
        yield { result: "Model is required for executing the agentic retrieval tool" };
        return;
      }

      const cfg = parsePipelineConfig(toolVariablesConfig);

      // ── Gate: managed context requires preselected items ──────────────────
      if (cfg.managedContext && !preselected?.length) {
        if (cfg.logging) console.log("[EXULU] Managed context was enabled for the agentic retrieval tool. This means that the user must preselect items that the agentic retrieval tool will search in, please notify the user to preselect items before executing the tool.");
        yield { result: "Managed context was enabled for the agentic retrieval tool. This means that the user must preselect items that the agentic retrieval tool will search in, please notify the user to preselect items before executing the tool." };
        return;
      }

      // ── Gate: require_preselected_contexts ───────────────────────────────
      if (cfg.requirePreselectedContexts && !confirmedContextIds?.length && !preselected?.length) {
        const activeContextsList = contexts.map((c) => c.id).join(", ");
        if (cfg.logging) console.log("[EXULU] The user must choose between the available contexts before executing the tool. The available contexts are: " + activeContextsList + ". If the question_ask tool is available use that to ask the user which contexts they want to search in, otherwise just ask them in plain text.");
        yield { result: "The user must choose between the available contexts before executing the tool, the available contexts are: " + activeContextsList + ". If the question_ask tool is available use that to ask the user which contexts they want to search in, otherwise just ask them in plain text." };
        return;
      }

      // ── Enabled contexts (knowledge_bases.enabled filter + restore-all) ───
      let enabledContexts = contexts.filter(
        (ctx) => cfg.knowledgeBases[ctx.id]?.enabled !== false,
      );
      if (enabledContexts.length === 0) enabledContexts = contexts;

      // ── Apply confirmedContextIds filter ──────────────────────────────────
      if (confirmedContextIds?.length) {
        const confirmed = new Set(confirmedContextIds);
        const filtered = enabledContexts.filter((c) => confirmed.has(c.id));
        if (filtered.length > 0) enabledContexts = filtered;
      }

      // ── Resolve reranker (best-effort) ────────────────────────────────────
      let reranker: Awaited<ReturnType<typeof resolveReranker>> | undefined;
      const rerankerId = cfg.reranker;
      if (rerankerId && rerankerId !== "none") {
        try {
          reranker = await resolveReranker({ model: rerankerId, user, roleId: role });
        } catch (err) {
          console.warn(
            `[EXULU pipeline] could not resolve reranker "${rerankerId}", continuing without reranking:`,
            err,
          );
        }
      }

      // ── Resolve utility model (best-effort) ───────────────────────────────
      let utilityModel: LanguageModel = model;
      if (cfg.utilityModel) {
        try {
          const resolved = await resolveModel({
            modelId: cfg.utilityModel,
            user,
            providers: exuluApp.get().providers,
            rbacBypass: true,
          });
          utilityModel = resolved.languageModel ?? model;
        } catch (err) {
          console.warn(
            `[EXULU pipeline] could not resolve utility model "${cfg.utilityModel}", falling back to agent model:`,
            err,
          );
        }
      }

      // ── Preselected items map ─────────────────────────────────────────────
      const preselectedItems = parsePreselectedItems(preselected ?? []);

      // ── Derived maps ──────────────────────────────────────────────────────
      const contextsById = new Map(enabledContexts.map((c) => [c.id, c]));
      const kbKindById = new Map(
        enabledContexts.map((c) => [
          c.id,
          effectiveKbSettings(cfg.knowledgeBases[c.id], c).kind,
        ]),
      );
      const documentContexts = enabledContexts.filter(
        (c) => (cfg.knowledgeBases[c.id]?.kind ?? "documents") === "documents",
      );

      // ── Initialise cumulative output ──────────────────────────────────────
      const result: AgenticRetrievalOutput = {
        steps: [],
        reasoning: [],
        chunks: [],
        usage: [],
        totalTokens: 0,
      };

      // ── Phase 1: memory + routing in parallel ─────────────────────────────
      const extraInstructions = [cfg.instructions, adminInstructions]
        .filter(Boolean)
        .join("\n");

      const [memResult, routResult] = await Promise.all([
        runMemoryPhase({
          memoryChunks: memoryItems ?? [],
          memoryContext,
          question: userQuery,
          keywords: relevantKeywords,
          importantKeyword,
          user,
          role,
          model: utilityModel,
          memoryConfig: cfg.memory,
          glossary: cfg.vocabulary.glossary,
          documentContexts,
        }),
        runRoutingPhase({
          question: userQuery,
          enabledContexts,
          documentContexts,
          routingRules: cfg.routing.rules,
          preselectedItems,
          extraInstructions: extraInstructions || undefined,
          model: utilityModel,
        }),
      ]);

      // Merge steps from both phases
      for (const step of [...memResult.steps, ...routResult.steps]) {
        result.steps.push({
          stepNumber: 1,
          text: step.text,
          toolCalls: step.toolCalls ?? [],
          chunks: (step.chunks as ChunkWithScore[]) ?? [],
          tokens: 0,
        });
        result.reasoning.push({ text: step.text, tools: [] });
      }
      yield { result: JSON.stringify(result) };

      // ── Preselection-subset guard (yield, not throw) ──────────────────────
      const { mainContexts, fallbackContexts, userPinnedItemIdsByContext, userRequestedPage, hasExplicitDocAndPage } = routResult;
      if (preselectedItems.size > 0 && !mainContexts.every((kb) => preselectedItems.has(kb))) {
        const missing = mainContexts.filter((kb) => !preselectedItems.has(kb));
        yield { result: "The user has requested to search in knowledge bases that are not part of the preselected knowledge bases: " + missing.join(", ") };
        return;
      }

      const {
        updatedQuestion,
        updatedKeywords,
        updatedImportantKeyword,
        memoryPinnedItemIds,
        memoryOverride,
      } = memResult;

      // ── Identifier pins (upfront, before Phase 2) ────────────────────────
      const { pinsByContext: identifierPinsByContext, exactPinsByContext, steps: pinSteps } =
        await resolveIdentifierPins({
          question: updatedQuestion,
          identifierSets: cfg.vocabulary.identifiers,
          contextsById,
          kbKindById,
          model: utilityModel,
        });

      for (const step of pinSteps) {
        result.steps.push({
          stepNumber: 1,
          text: step.text,
          toolCalls: step.toolCalls ?? [],
          chunks: (step.chunks as ChunkWithScore[]) ?? [],
          tokens: 0,
        });
        result.reasoning.push({ text: step.text, tools: [] });
      }

      // ── Phase 2: main + speculative fallback searchContexts in parallel ───
      const [mainSearch, speculativeFallbackSearch] = await Promise.all([
        searchContexts({
          contextIds: mainContexts,
          contextsById,
          kbProfiles: cfg.knowledgeBases,
          question: updatedQuestion,
          keywords: updatedKeywords,
          importantKeyword: updatedImportantKeyword,
          user,
          role,
          model: utilityModel,
          preselectedItems,
          identifierPinsByContext,
          memoryPinnedItemIds,
          userPinnedItemIdsByContext,
          rewrites: cfg.vocabulary.rewrites,
          styleHint: cfg.vocabulary.styleHint,
          maxQueries: cfg.tuning.maxQueriesPerContext,
          skipPrefilter: false,
        }),
        fallbackContexts.length > 0 && !hasExplicitDocAndPage
          ? searchContexts({
              contextIds: fallbackContexts,
              contextsById,
              kbProfiles: cfg.knowledgeBases,
              question: updatedQuestion,
              keywords: updatedKeywords,
              importantKeyword: updatedImportantKeyword,
              user,
              role,
              model: utilityModel,
              preselectedItems,
              identifierPinsByContext,
              memoryPinnedItemIds,
              userPinnedItemIdsByContext,
              rewrites: cfg.vocabulary.rewrites,
              styleHint: cfg.vocabulary.styleHint,
              maxQueries: cfg.tuning.maxQueriesPerContext,
              skipPrefilter: true,
            })
          : Promise.resolve({ chunks: [] }),
      ]);

      // ── Build rerank state ────────────────────────────────────────────────
      // pinnedItemIds = memory ∪ exact identifier pins ∪ user pins
      const pinnedItemIds = new Set<string>([
        ...memoryPinnedItemIds,
        ...(function* () {
          for (const s of exactPinsByContext.values()) yield* s;
        })(),
        ...(function* () {
          for (const s of userPinnedItemIdsByContext.values()) yield* s;
        })(),
      ]);
      // userPinnedItemIds = user pins only
      const userPinnedItemIds = new Set<string>(
        (function* () {
          for (const s of userPinnedItemIdsByContext.values()) yield* s;
        })(),
      );

      const rerankState: RerankState = {
        pinnedItemIds,
        userPinnedItemIds,
        userRequestedPage,
        keywords: updatedKeywords,
        importantKeyword: updatedImportantKeyword,
      };

      // ── Phase 3: rerank main results ──────────────────────────────────────
      result.steps.push({
        stepNumber: 1,
        text: `Reranking ${mainSearch.chunks.length} chunks`,
        toolCalls: [],
        chunks: [],
        tokens: 0,
      });
      result.reasoning.push({ text: `Reranking ${mainSearch.chunks.length} chunks`, tools: [] });
      yield { result: JSON.stringify(result) };

      const mainRerank = await rerankResults({
        chunks: mainSearch.chunks,
        query: updatedQuestion,
        state: rerankState,
        reranker,
        tuning: {
          topK: cfg.tuning.topK,
          pinBoost: cfg.tuning.pinBoost,
          identifierBoost: cfg.tuning.identifierBoost,
          pageWindow: cfg.tuning.pageWindow,
        },
      });

      result.steps.push({
        stepNumber: 1,
        text: "Results reranked",
        toolCalls: [{ name: "reranker", id: "reranker", input: { query: updatedQuestion } }],
        chunks: mainRerank.limited_results,
        tokens: 0,
      });
      result.reasoning.push({ text: "Results reranked", tools: [] });
      result.steps.push({
        stepNumber: 1,
        text: `Rerank_score min: ${mainRerank.sorted_reranked_results[mainRerank.sorted_reranked_results.length - 1]?.rerank_score || 0}, Rerank_score max: ${mainRerank.rerank_score_max_genuine}`,
        toolCalls: [],
        chunks: [],
        tokens: 0,
      });

      // Update chunks with main results
      result.chunks = mainRerank.limited_results;
      yield { result: JSON.stringify(result) };

      // ── Literal-lookup short-circuit ──────────────────────────────────────
      const literalLookupSatisfied =
        hasExplicitDocAndPage &&
        mainRerank.limited_results.length > 0 &&
        mainRerank.limited_results.some((r) => {
          const p = (r.chunk_metadata as { page?: unknown } | undefined)?.page;
          return (
            typeof p === "number" &&
            userRequestedPage !== null &&
            Math.abs(p - userRequestedPage) <= 1
          );
        });

      if (literalLookupSatisfied) {
        result.steps.push({
          stepNumber: 1,
          text: `Literal lookup satisfied (file pinned + page ${userRequestedPage} matched); skipping fallback search.`,
          toolCalls: [],
          chunks: [],
          tokens: 0,
        });
        result.reasoning.push({ text: "Literal lookup satisfied; skipping fallback.", tools: [] });
        yield { result: JSON.stringify(result) };
      }

      // ── Fallback gate ─────────────────────────────────────────────────────
      if (
        !literalLookupSatisfied &&
        fallbackContexts.length > 0 &&
        (reranker
          ? mainRerank.rerank_score_max_genuine < cfg.tuning.fallbackThreshold
          : mainRerank.limited_results.length < cfg.tuning.topK)
      ) {
        result.steps.push({
          stepNumber: 1,
          text: `Using fallback search in ${fallbackContexts.join(", ")}`,
          toolCalls: [],
          chunks: [],
          tokens: 0,
        });
        result.reasoning.push({ text: `Fallback search in ${fallbackContexts.join(", ")}`, tools: [] });
        yield { result: JSON.stringify(result) };

        const fallbackRerank = await rerankResults({
          chunks: speculativeFallbackSearch.chunks,
          query: updatedQuestion,
          state: { ...rerankState, pinnedItemIds: new Set() },
          reranker,
          tuning: {
            topK: cfg.tuning.topK,
            pinBoost: cfg.tuning.pinBoost,
            identifierBoost: cfg.tuning.identifierBoost,
            pageWindow: cfg.tuning.pageWindow,
          },
        });

        result.steps.push({
          stepNumber: 1,
          text: "Fallback results reranked",
          toolCalls: [],
          chunks: fallbackRerank.limited_results,
          tokens: 0,
        });
        result.reasoning.push({ text: "Fallback results reranked", tools: [] });
        result.chunks = fallbackRerank.limited_results;
        yield { result: JSON.stringify(result) };
      }

      // ── Phase 4: memory override directive ────────────────────────────────
      if (memoryOverride.active) {
        const authoritativeContent = memoryOverride.chunks
          .map((c) => `${c.item_name}: ${c.chunk_content}`)
          .join("\n\n");
        const directive =
          "⚠ VERIFIED ANSWER FROM COMPANY MEMORY — A curated, expert-verified memory entry has " +
          "been confirmed to directly and sufficiently answer the user's question. Treat it as " +
          "AUTHORITATIVE and build your answer on it: it takes precedence over the document " +
          "excerpts above, even where they state something different. If a document differs " +
          "materially, briefly note the manual's version (e.g. \"The manual states …\"), but " +
          "lead with and defer to this verified answer.\n\nVerified answer:\n" +
          authoritativeContent;
        result.steps.push({
          stepNumber: 1,
          text: directive,
          toolCalls: [],
          chunks: memoryOverride.chunks,
          tokens: 0,
        });
        result.reasoning.push({
          text: "A verified company-memory entry directly answers the question; instructing the answer to treat it as authoritative over the documents.",
          tools: [],
        });
        yield { result: JSON.stringify(result) };
      }

      if (cfg.logging) {
        console.log("[EXULU pipeline] final result:", JSON.stringify({ steps: result.steps.length, chunks: result.chunks.length }));
      }

      return { result: JSON.stringify(result) };
    },
  });
}
