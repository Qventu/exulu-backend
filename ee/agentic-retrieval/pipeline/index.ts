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
import { resolveProjectScope, type ProjectScope } from "./project-scope";
import { runRoutingPhase } from "./routing";
import { runMemoryPhase } from "./memory";
import { resolveIdentifierPins } from "./prefilter";
import { searchContexts } from "./search";
import { rerankResults } from "./rerank";
import type { AgenticRetrievalOutput, RerankState, ChunkWithScore } from "./types";
import type { VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import { parsePreselectedItems } from "./global-ids";
export { parsePreselectedItems } from "./global-ids";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accumulate chunks into result.chunks, deduplicating by chunk_id (first-seen wins).
 */
function addChunks(result: AgenticRetrievalOutput, chunks: ChunkWithScore[]): void {
  const seen = new Set(result.chunks.map((c) => c.chunk_id));
  for (const chunk of chunks) {
    if (!seen.has(chunk.chunk_id)) {
      seen.add(chunk.chunk_id);
      result.chunks.push(chunk);
    }
  }
}

/**
 * Serialize the cumulative output for yielding. Full chunk content lives ONLY in the
 * top-level `chunks` (what the chat UI cites and the calling agent reads); the per-step
 * chunk copies keep ids/names/metadata for counts and traceability but drop
 * `chunk_content` — serializing the same content twice roughly doubled the tool payload
 * and, across a few calls, overflowed the calling agent's context window.
 */
function serializeOutput(result: AgenticRetrievalOutput): string {
  return JSON.stringify({
    ...result,
    steps: result.steps.map((step) =>
      step.chunks.length === 0
        ? step
        : {
            ...step,
            chunks: step.chunks.map((c) => ({ ...c, chunk_content: undefined })),
          },
    ),
  });
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
  projectScope?: ProjectScope;
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
    projectScope,
  } = opts;

  const license = checkLicense();
  if (!license["agentic-retrieval"]) {
    console.warn("[EXULU] Not licensed for agentic retrieval");
    return undefined;
  }

  return ExuluTool.internal({
    id: "agentic_context_search",
    name: "Context Search",
    description:
      `Intelligent knowledge search across the available knowledge bases: ${contexts.map((c) => c.name || c.id).join(", ")}. Routes the question to the right sources, searches them with query expansion, and returns reranked passages. Results are exhaustive for the given query: do NOT repeat the call with a rephrased version of the same question — re-call only with genuinely new information (a different product or model, an explicitly named source or document, or new details from the user).` +
      // Note: the description suffix intentionally remains even when the per-agent project_search
      // config is off — the config is only known at execute time, not at factory time.
      (projectScope ? ` Also searches the knowledge items attached to the project "${projectScope.name}".` : ""),
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
        description: "Verbose debug logging of each retrieval phase to the server console. Useful for debugging and evaluation.",
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
        name: "max_steps",
        description: "Maximum reasoning/tool steps the CALLING agent may take on a message while this tool is enabled (bounds retry loops and token cost). 0 = platform default (5, or 10 with skills).",
        type: "number",
        default: 0,
      },
      {
        name: "project_search",
        description:
          "Automatically include items attached to the chat's project as an additional knowledge source (boosts them in shared sources, adds scoped search for others).",
        type: "boolean",
        default: true,
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

      // ── Initialise cumulative output (before try so catch can reference it) ──
      const result: AgenticRetrievalOutput = {
        steps: [],
        reasoning: [],
        chunks: [],
        usage: [],
        totalTokens: 0,
      };

      try {
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

      // ── Project scope: additional source, never narrows configured sources ──
      const availableContextsById = new Map(contexts.map((c) => [c.id, c]));
      const resolvedProject = cfg.projectSearch
        ? resolveProjectScope({
            scope: projectScope,
            enabledContextIds: new Set(enabledContexts.map((c) => c.id)),
            availableContextIds: new Set(availableContextsById.keys()),
          })
        : undefined;
      if (resolvedProject) {
        // Synthesized profile defaults (e.g. transcriptions → conversations kind);
        // a stored knowledge_bases profile always wins.
        if (projectScope?.kbProfileDefaults) {
          for (const [ctxId, profile] of Object.entries(projectScope.kbProfileDefaults)) {
            if (!cfg.knowledgeBases[ctxId]) cfg.knowledgeBases[ctxId] = profile;
          }
        }
        // Copy-on-write: enabledContexts may alias the factory's contexts array
        // (the restore-all branch above), so never push into it.
        enabledContexts = [
          ...enabledContexts,
          ...resolvedProject.addedContextIds
            .map((id) => availableContextsById.get(id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c)),
        ];
      }

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

      // ── Phase 1: memory + routing in parallel ─────────────────────────────
      // Gate on resolvedProject: when project_search is off, resolvedProject is undefined
      // and project custom instructions must NOT leak into routing/HyDE.
      const extraInstructions = [
        cfg.instructions,
        adminInstructions,
        resolvedProject && projectScope?.customInstructions
          ? `Instructions for the attached project "${projectScope.name}":\n${projectScope.customInstructions}`
          : "",
      ]
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
          // Configured identifier examples (product names, standards) — the doc-reference
          // detector must never treat these as filename hints.
          knownIdentifiers: cfg.vocabulary.identifiers.flatMap((i) => i.examples),
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
      // Memory citable chunks go first (insertion-order dedup)
      addChunks(result, memResult.memoryChunksForAnswer);
      yield { result: serializeOutput(result) };

      // ── Preselection-subset guard (yield, not throw) ──────────────────────
      const { mainContexts, fallbackContexts, userPinnedItemIdsByContext, userRequestedPage, hasExplicitDocAndPage } = routResult;
      if (preselectedItems.size > 0 && !mainContexts.every((kb) => preselectedItems.has(kb))) {
        const missing = mainContexts.filter((kb) => !preselectedItems.has(kb));
        yield { result: "The user has requested to search in knowledge bases that are not part of the preselected knowledge bases: " + missing.join(", ") };
        return;
      }

      // ── Project sources are always-main (attaching a project is an explicit signal) ──
      let effectiveMainContexts = mainContexts;
      if (resolvedProject) {
        const mainSet = new Set(mainContexts);
        const appended = resolvedProject.allProjectContextIds.filter(
          (id) => !mainSet.has(id) && contextsById.has(id),
        );
        if (appended.length > 0) {
          effectiveMainContexts = [...mainContexts, ...appended];
          result.steps.push({
            stepNumber: 1,
            text: `Including sources from project "${projectScope!.name}": ${appended.join(", ")}`,
            toolCalls: [],
            chunks: [],
            tokens: 0,
          });
          result.reasoning.push({
            text: `Including project sources: ${appended.join(", ")}`,
            tools: [],
          });
        }
      }

      // A project context appended to effectiveMainContexts can also appear in fallbackContexts
      // (routing classified it as enabled before the project append). Deduplicate to avoid
      // double-searching the same context in the speculative fallback pass.
      const fallbackContextsToSearch = fallbackContexts.filter(
        (id) => !effectiveMainContexts.includes(id),
      );

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
          contextIds: effectiveMainContexts,
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
          scopedItemsByContext: resolvedProject?.scopedItemsByContext,
          rewrites: cfg.vocabulary.rewrites,
          styleHint: cfg.vocabulary.styleHint,
          maxQueries: cfg.tuning.maxQueriesPerContext,
          skipPrefilter: false,
        }),
        fallbackContextsToSearch.length > 0 && !hasExplicitDocAndPage
          ? searchContexts({
              contextIds: fallbackContextsToSearch,
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
              scopedItemsByContext: resolvedProject?.scopedItemsByContext,
              rewrites: cfg.vocabulary.rewrites,
              styleHint: cfg.vocabulary.styleHint,
              maxQueries: cfg.tuning.maxQueriesPerContext,
              skipPrefilter: true,
            })
          : Promise.resolve({ chunks: [] }),
      ]);

      // ── Build rerank state ────────────────────────────────────────────────
      // pinnedItemIds = memory ∪ exact identifier pins ∪ user pins ∪ project pins
      const pinnedItemIds = new Set<string>([
        ...memoryPinnedItemIds,
        ...(function* () {
          for (const s of exactPinsByContext.values()) yield* s;
        })(),
        ...(function* () {
          for (const s of userPinnedItemIdsByContext.values()) yield* s;
        })(),
        ...(function* () {
          if (resolvedProject) for (const s of resolvedProject.pinsByContext.values()) yield* s;
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
      yield { result: serializeOutput(result) };

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

      // Accumulate main results (dedup by chunk_id, memory chunks already first)
      addChunks(result, mainRerank.limited_results);
      yield { result: serializeOutput(result) };

      // ── Literal-lookup short-circuit ──────────────────────────────────────
      const literalLookupSatisfied =
        hasExplicitDocAndPage &&
        mainRerank.limited_results.length > 0 &&
        mainRerank.limited_results.some((r) => {
          const p = (r.chunk_metadata as { page?: unknown } | undefined)?.page;
          return (
            typeof p === "number" &&
            userRequestedPage !== null &&
            Math.abs(p - userRequestedPage) <= cfg.tuning.pageWindow
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
        yield { result: serializeOutput(result) };
      }

      // ── Fallback gate ─────────────────────────────────────────────────────
      if (
        !literalLookupSatisfied &&
        fallbackContextsToSearch.length > 0 &&
        (reranker
          ? mainRerank.rerank_score_max_genuine < cfg.tuning.fallbackThreshold
          : mainRerank.limited_results.length < cfg.tuning.topK)
      ) {
        result.steps.push({
          stepNumber: 1,
          text: `Using fallback search in ${fallbackContextsToSearch.join(", ")}`,
          toolCalls: [],
          chunks: [],
          tokens: 0,
        });
        result.reasoning.push({ text: `Fallback search in ${fallbackContextsToSearch.join(", ")}`, tools: [] });
        yield { result: serializeOutput(result) };

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
        addChunks(result, fallbackRerank.limited_results);
        yield { result: serializeOutput(result) };
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
        addChunks(result, memoryOverride.chunks);
        yield { result: serializeOutput(result) };
      }

      if (cfg.logging) {
        console.log("[EXULU pipeline] final result:", JSON.stringify({ steps: result.steps.length, chunks: result.chunks.length }));
      }

      return { result: serializeOutput(result) };
      } catch (err) {
        console.warn("[EXULU pipeline] retrieval pipeline failed:", err);
        result.steps.push({
          stepNumber: 1,
          text: "Retrieval degraded due to an internal error — returning partial results.",
          toolCalls: [],
          chunks: [],
          tokens: 0,
        });
        yield { result: serializeOutput(result) };
        return;
      }
    },
  });
}
