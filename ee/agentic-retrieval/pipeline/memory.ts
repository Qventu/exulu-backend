import { z } from "zod";
import { microCall } from "./micro-call";
import { singleSearch } from "./multi-query";
import { fuzzyPrefilter } from "./prefilter";
import { deriveKeywordVariants, normalizeFileName, stripSeparators } from "./text-utils";
import type { Chunk, ChunkWithScore, MemoryPhaseResult, PhaseStep } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_OVERRIDE_MIN_CONFIDENCE = "high";
const MEMORY_SYNTHETIC_RERANK_SCORE = 1;
const ITEM_CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// 5-min item cache (keyed by memoryContext.id)
// ---------------------------------------------------------------------------

type MemoryItem = { id: string; name: string; description?: string; information?: string };

let memoryItemCache = new Map<string, { items: MemoryItem[]; tsp: Date }>();

export function clearMemoryItemCache(): void {
  memoryItemCache = new Map();
}

async function loadMemoryItems(context: {
  id: string;
  getItems: (o: any) => Promise<MemoryItem[]>;
}): Promise<MemoryItem[]> {
  const cached = memoryItemCache.get(context.id);
  if (cached && Date.now() - cached.tsp.getTime() < ITEM_CACHE_TTL_MS) {
    return cached.items;
  }
  const items = await context.getItems({
    fields: ["id", "name", "description", "information"],
    filters: [],
  });
  memoryItemCache.set(context.id, { items, tsp: new Date() });
  return items;
}

// ---------------------------------------------------------------------------
// Keyword recall (ported from newton-memory.ts:91-169)
// ---------------------------------------------------------------------------

async function recallMemoryByKeywords({
  keywords,
  importantKeyword,
  user,
  role,
  memoryContext,
}: {
  keywords: string[];
  importantKeyword: string;
  user: any;
  role: any;
  memoryContext: { id: string; getItems: (o: any) => Promise<MemoryItem[]> };
}): Promise<Chunk[]> {
  const allKeywords = [
    ...new Set(
      [importantKeyword, ...keywords].filter(
        (k): k is string => !!k && k.trim().length > 0,
      ),
    ),
  ];
  if (!allKeywords.length) return [];

  const importantVariants = importantKeyword
    ? [...new Set(deriveKeywordVariants(importantKeyword).map(stripSeparators))].filter(
        (v) => v.length >= 4,
      )
    : [];
  const allVariants = [
    ...new Set(allKeywords.flatMap(deriveKeywordVariants).map(stripSeparators)),
  ].filter((v) => v.length >= 4);
  if (!allVariants.length) return [];

  const items = await loadMemoryItems(memoryContext);

  type Scored = { id: string; hits: number; importantHit: boolean; name: string };
  const scored: Scored[] = [];
  for (const item of items) {
    const haystack = stripSeparators(
      [item.name, item.description, item.information].filter(Boolean).join(" "),
    );
    if (!haystack) continue;
    const hits = allVariants.filter((v) => haystack.includes(v)).length;
    if (hits === 0) continue;
    const importantHit = importantVariants.some((v) => haystack.includes(v));
    scored.push({ id: item.id, hits, importantHit, name: item.name ?? "" });
  }

  scored.sort((a, b) => {
    if (a.importantHit !== b.importantHit) return a.importantHit ? -1 : 1;
    return b.hits - a.hits;
  });
  const topMatches = scored.slice(0, 25);
  if (!topMatches.length) return [];

  console.log(
    "[EXULU pipeline] keyword-triggered memory matches:",
    topMatches.map((s) => `${s.name} (hits=${s.hits}, important=${s.importantHit})`),
  );

  const chunks = await singleSearch({
    query: allKeywords.join(", "),
    config: { method: "hybridSearch", cutoffs: undefined, limit: 50 },
    user,
    role,
    pinnedItemIds: topMatches.map((s) => s.id),
    context: memoryContext,
  });

  return chunks;
}

// ---------------------------------------------------------------------------
// Neutral result helper
// ---------------------------------------------------------------------------

function neutralResult(
  question: string,
  keywords: string[],
  importantKeyword: string,
  steps: PhaseStep[] = [],
): MemoryPhaseResult {
  return {
    memoryChunksForAnswer: [],
    memoryOverride: { active: false, chunks: [], reason: "" },
    memoryPinnedItemIds: new Set(),
    updatedQuestion: question,
    updatedKeywords: keywords,
    updatedImportantKeyword: importantKeyword,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runMemoryPhase({
  memoryChunks,
  memoryContext,
  question,
  keywords,
  importantKeyword,
  user,
  role,
  model,
  memoryConfig,
  glossary,
  documentContexts,
}: {
  memoryChunks: Chunk[];
  memoryContext?: any;
  question: string;
  keywords: string[];
  importantKeyword: string;
  user: any;
  role: any;
  model: any;
  memoryConfig: {
    enabled: boolean;
    override: boolean;
    filePrioritization: boolean;
    queryAugmentation: boolean;
  };
  glossary: { term: string; meaning: string }[];
  documentContexts: any[];
}): Promise<MemoryPhaseResult> {
  try {
    // Short-circuit: disabled, or nothing to work with
    if (!memoryConfig.enabled || (memoryChunks.length === 0 && !memoryContext)) {
      return neutralResult(question, keywords, importantKeyword);
    }

    const steps: PhaseStep[] = [];
    let retrieved_memory = [...memoryChunks];

    // Keyword recall: extend memory with items that match the user's keywords
    if (memoryContext) {
      try {
        const keywordMatched = await recallMemoryByKeywords({
          keywords,
          importantKeyword,
          user,
          role,
          memoryContext,
        });
        if (keywordMatched.length > 0) {
          const seen = new Set(retrieved_memory.map((c) => c.chunk_id));
          const additions = keywordMatched.filter((c) => !seen.has(c.chunk_id));
          retrieved_memory = [...retrieved_memory, ...additions];
        }
      } catch (e) {
        console.error("[EXULU pipeline] keyword-triggered memory recall failed:", e);
      }
    }

    // Step 1: Relevance check
    const CHECK_MEMORIES_FOR_RELEVANT_INFORMATION = `
    You are checking whether any chunks from the shared company memory contain information
    relevant to the user's question. Return the chunk_ids of relevant chunks, or an empty array.

    Be generous: include chunks that are topically related, share key terminology, describe the
    same symptom from a different angle, or could plausibly help diagnose the issue — even if
    they don't answer the question directly. Memory entries are deliberately broad, hand-curated
    hints written by domain experts; the user's wording will rarely match the memory verbatim.
    When in doubt, include the chunk.

    <memory_chunks>
    ${retrieved_memory.map((chunk) => `- ${chunk.chunk_id}: ${chunk.item_name} - ${chunk.chunk_content}`).join("\n")}
    </memory_chunks>
    `;

    let relevantMemoryChunks: Chunk[] = [];
    try {
      const { output: output_relevant_memory } = await microCall({
        model,
        system: CHECK_MEMORIES_FOR_RELEVANT_INFORMATION,
        messages: [
          {
            role: "user",
            content: `
            <user_question>${question}</user_question>
            <relevant_keywords>${keywords.join(", ")}</relevant_keywords>
            <important_keyword>${importantKeyword}</important_keyword>
            `,
          },
        ],
        schema: z.object({
          relevantChunkIds: z
            .array(z.string())
            .describe(
              "The chunk_ids (UUIDs at the start of each bullet) of chunks containing information relevant to the user's question. Empty array if none are relevant.",
            ),
        }),
      });

      const ids = new Set(output_relevant_memory?.relevantChunkIds ?? []);
      relevantMemoryChunks =
        ids.size === 0 ? [] : retrieved_memory.filter((c) => ids.has(c.chunk_id));
    } catch (e) {
      // On failure, treat NONE as relevant (strict: a broken check must not flood answer with memory)
      steps.push({ text: "Memory relevance check failed — memory was skipped." });
      return neutralResult(question, keywords, importantKeyword, steps);
    }

    // Synthetic score/citable shaping
    const memoryChunksForAnswer: ChunkWithScore[] = relevantMemoryChunks.map((chunk) => ({
      ...chunk,
      rerank_score: MEMORY_SYNTHETIC_RERANK_SCORE,
      context: { name: "memory", id: "memory" },
    }));

    if (relevantMemoryChunks.length > 0) {
      steps.push({
        text:
          "Retrieved potentially relevant information from memory: " +
          relevantMemoryChunks
            .map((c) => `${c.item_name}: ${c.chunk_content}`)
            .join(", "),
        chunks: memoryChunksForAnswer,
      });
    }

    let memoryOverride: MemoryPhaseResult["memoryOverride"] = {
      active: false,
      chunks: [],
      reason: "",
    };
    let memoryPinnedItemIds = new Set<string>();
    let updatedQuestion = question;
    let updatedKeywords = keywords;
    let updatedImportantKeyword = importantKeyword;

    if (relevantMemoryChunks.length > 0) {
      const CHECK_MEMORY_OVERRIDE = `
      You are deciding whether a curated company-memory entry should become the AUTHORITATIVE
      basis of the answer to the user's question — taking precedence over the official
      documentation even if the documents state something different.

      This is a deliberately STRICT check. Set overrides=true ONLY if a single memory chunk,
      on its own, contains a DIRECT and SUFFICIENT answer to exactly what the user asked —
      enough that the final answer should be built on it and defer to it. Being topically
      related, sharing terminology, describing the same component, or only partially
      addressing the question is NOT sufficient: in those cases set overrides=false. When in
      doubt, set overrides=false.

      Memory entries are hand-curated by domain experts and may capture field experience that
      the manuals get wrong, so a confident, direct match is meant to win over the documents.

      <memory_chunks>
      ${relevantMemoryChunks.map((c) => `- ${c.chunk_id}: ${c.item_name} - ${c.chunk_content}`).join("\n")}
      </memory_chunks>
      `;

      const PROMPT_EXTRACT_PRIORITIZED_FILES = `
      You decide whether the shared company memory instructs prioritizing one or more SPECIFIC
      documents/files when answering the user's question.

      Only set shouldPrioritizeFiles to true if the memory explicitly says to look in, prioritize,
      prefer, or always search a particular document, file, or file family (for example a note like
      "When asked about X, always search in Y-Dateien first"). General background facts, glossaries,
      or synonyms are NOT a file prioritization instruction — in that case return false.

      When true, return fileNameHints: the document/file name(s) to prioritize, exactly as referenced
      in the memory (e.g. "PROJECT_NOTES"). Return the bare name without folder paths.

      <user_question>${question}</user_question>
      <relevant_keywords>${keywords.join(", ")}</relevant_keywords>
      <relevant_memory>
      ${relevantMemoryChunks.map((c) => `- ${c.item_name}: ${c.chunk_content}`).join("\n")}
      </relevant_memory>
      `;

      // Build glossary text for query augmentation
      const glossaryText =
        glossary.length > 0
          ? `The organization's documents use the following abbreviations/terms:\n\n${glossary.map((g) => `${g.term} : ${g.meaning}`).join("\n")}`
          : "";

      const hasAugmentationContent =
        glossary.length > 0 || relevantMemoryChunks.some((c) => c.chunk_content);

      const QUERY_AUGMENTATION_PROMPT = `
      Below is the original user question, relevant extracted keywords and important keyword.

      <user_question>${question}</user_question>
      <relevant_keywords>${keywords.join(", ")}</relevant_keywords>
      <important_keyword>${importantKeyword}</important_keyword>

      We also just retrieved the following relevant information from the shared company memory:

      <relevant_memory_information>
      ${relevantMemoryChunks.map((c) => c.chunk_content).join("\n")}

      ${glossaryText}
      </relevant_memory_information>

      If, and only if, relevant memory information contains information that should be used to update the user's query
      such as synonyms or similar terms, update the user's query and keywords to include the synonyms or similar terms,
      always make sure to keep the original as well as the synonyms or similar terms in the updated user question and keywords.

      Otherwise, return the original user question, relevant keywords and important keyword.
      `;

      const [overrideResult, fileResult, queryResult] = await Promise.all([
        // Override check: strict gate to decide if memory should be authoritative
        memoryConfig.override
          ? microCall({
              model,
              system: CHECK_MEMORY_OVERRIDE,
              messages: [
                {
                  role: "user",
                  content: `
                  <user_question>${question}</user_question>
                  <relevant_keywords>${keywords.join(", ")}</relevant_keywords>
                  <important_keyword>${importantKeyword}</important_keyword>
                  `,
                },
              ],
              schema: z.object({
                overrides: z
                  .boolean()
                  .describe(
                    "True ONLY if a memory chunk directly and sufficiently answers the user's question and should be authoritative over the documents. Be strict; when unsure, false.",
                  ),
                confidence: z
                  .enum(["high", "medium", "low"])
                  .describe(
                    "Confidence that the selected memory chunk(s) fully and directly answer the question.",
                  ),
                authoritativeChunkIds: z
                  .array(z.string())
                  .describe(
                    "The chunk_ids of the memory chunk(s) that directly answer the question. Empty if overrides is false.",
                  ),
                reason: z
                  .string()
                  .describe(
                    "One short sentence: why this memory does or does not directly answer the question.",
                  ),
              }),
            }).catch(() => ({
              output: {
                overrides: false,
                confidence: "low",
                authoritativeChunkIds: [],
                reason: "",
              },
            }))
          : Promise.resolve({
              output: {
                overrides: false,
                confidence: "low",
                authoritativeChunkIds: [],
                reason: "",
              },
            }),

        // File prioritization: detect explicit document-pinning instructions in memory
        memoryConfig.filePrioritization
          ? microCall({
              model,
              system:
                "You are a helpful assistant that will strictly follow the user's instructions.",
              messages: [{ role: "user", content: PROMPT_EXTRACT_PRIORITIZED_FILES }],
              schema: z.object({
                shouldPrioritizeFiles: z.boolean(),
                fileNameHints: z.array(z.string()).optional(),
              }),
            }).catch(() => ({
              output: { shouldPrioritizeFiles: false, fileNameHints: [] as string[] },
            }))
          : Promise.resolve({
              output: { shouldPrioritizeFiles: false, fileNameHints: [] as string[] },
            }),

        // Query augmentation: expand keywords with synonyms/abbreviations from memory
        memoryConfig.queryAugmentation && hasAugmentationContent
          ? microCall({
              model,
              system:
                "You are a helpful assistant that will strictly follow the user's instructions.",
              messages: [{ role: "user", content: QUERY_AUGMENTATION_PROMPT }],
              schema: z.object({
                updatedUserQuestion: z.string(),
                updatedRelevantKeywords: z.array(z.string()),
                updatedImportantKeyword: z.string(),
              }),
            }).catch(() => ({
              output: {
                updatedUserQuestion: question,
                updatedRelevantKeywords: [],
                updatedImportantKeyword: importantKeyword,
              },
            }))
          : Promise.resolve({
              output: {
                updatedUserQuestion: question,
                updatedRelevantKeywords: [],
                updatedImportantKeyword: importantKeyword,
              },
            }),
      ]);

      // Override gate (STRICT: only active when overrides===true && confidence==="high" && authoritativeChunks.length > 0)
      const overrideIds = new Set(overrideResult.output?.authoritativeChunkIds ?? []);
      const authoritativeChunks = memoryChunksForAnswer.filter(
        (c) => c.chunk_id && overrideIds.has(c.chunk_id),
      );
      if (
        overrideResult.output?.overrides === true &&
        overrideResult.output?.confidence === MEMORY_OVERRIDE_MIN_CONFIDENCE &&
        authoritativeChunks.length > 0
      ) {
        memoryOverride = {
          active: true,
          chunks: authoritativeChunks,
          reason: overrideResult.output.reason ?? "",
        };
      }

      // File prioritization: resolve hints via fuzzyPrefilter against EVERY documentContexts entry
      if (fileResult.output?.shouldPrioritizeFiles && fileResult.output?.fileNameHints?.length) {
        const hints = fileResult.output.fileNameHints;
        const pinResults = await Promise.all(
          documentContexts.map((ctx) =>
            fuzzyPrefilter({
              cacheKey: `memory-pin:${ctx.id}`,
              relevantKeywords: hints,
              context: ctx,
              fields: ["name", "id", "external_id"],
              normalize: (item: any) =>
                item.external_id ? normalizeFileName(item.external_id) : item.name,
            }).catch(() => []),
          ),
        );
        for (const results of pinResults) {
          for (const r of results) {
            memoryPinnedItemIds.add(r.id);
          }
        }
        if (memoryPinnedItemIds.size > 0) {
          const names = pinResults.flat().map((i) => i.name).join(", ");
          steps.push({
            text: `Memory prioritizes specific document(s); pinning ${memoryPinnedItemIds.size} file(s) into the search: ${names}`,
          });
        }
      }

      // Query augmentation merge: keywords union lowercased/trimmed; updatedImportantKeyword ALWAYS preserved as original
      const augmented = queryResult.output;
      if (
        augmented?.updatedUserQuestion !== question ||
        (augmented?.updatedRelevantKeywords?.length ?? 0) > 0 ||
        augmented?.updatedImportantKeyword?.trim().toLowerCase() !==
          importantKeyword?.trim().toLowerCase()
      ) {
        updatedQuestion = augmented?.updatedUserQuestion ?? question;
        updatedKeywords = [
          ...new Set(
            [...keywords, ...(augmented?.updatedRelevantKeywords ?? [])].map((k) =>
              k.trim().toLowerCase(),
            ),
          ),
        ];
        updatedImportantKeyword = importantKeyword; // preserve original
        steps.push({
          text: `The user's query and keywords have been updated: ${updatedQuestion}, ${updatedKeywords.join(", ")}, ${updatedImportantKeyword}`,
        });
      }
    }

    return {
      memoryChunksForAnswer,
      memoryOverride,
      memoryPinnedItemIds,
      updatedQuestion,
      updatedKeywords,
      updatedImportantKeyword,
      steps,
    };
  } catch (err) {
    console.warn("[EXULU pipeline] memory phase failed — continuing without memory.", err);
    return neutralResult(question, keywords, importantKeyword);
  }
}
