import { effectiveKbSettings, type KbProfile } from "./config";
import { multiQuerySearch, singleSearch, type SearchCallConfig } from "./multi-query";
import { generateHydePassage } from "./hyde";
import { fuzzyPrefilter } from "./prefilter";
import { applyRewrites } from "./text-utils";
import type { Chunk } from "./types";

export async function searchContexts(opts: {
  contextIds: string[];
  contextsById: Map<string, any>;
  kbProfiles: Record<string, KbProfile>;
  question: string;
  keywords: string[];
  importantKeyword: string;
  user: any;
  role: any;
  model: any;
  preselectedItems: Map<string, string[] | null>;
  identifierPinsByContext: Map<string, Set<string>>;   // from resolveIdentifierPins
  memoryPinnedItemIds: Set<string>;                     // from memory phase (documents kind only)
  userPinnedItemIdsByContext: Map<string, Set<string>>; // from routing phase
  rewrites: { find: string; replace: string }[];
  styleHint: string;
  maxQueries: number;
  skipPrefilter: boolean;                               // true for the speculative fallback pass
}): Promise<{ chunks: Chunk[] }> {
  const {
    contextIds,
    contextsById,
    kbProfiles,
    question,
    keywords,
    importantKeyword,
    user,
    role,
    model,
    preselectedItems,
    identifierPinsByContext,
    memoryPinnedItemIds,
    userPinnedItemIdsByContext,
    rewrites,
    styleHint,
    maxQueries,
    skipPrefilter,
  } = opts;

  const chunkArrays = await Promise.all(
    contextIds.map(async (ctxId): Promise<Chunk[]> => {
      try {
        // Rule 4: Missing context contributes []
        const ctx = contextsById.get(ctxId);
        if (!ctx) return [];

        const profile = kbProfiles[ctxId];
        const settings = effectiveKbSettings(profile, ctx);
        const { kind, limit, expand, cutoffs, multiQuery, hyde, keywordPrefilter } = settings;

        const searchConfig: SearchCallConfig = {
          method: "hybridSearch",
          limit,
          expand,
          cutoffs,
        };

        // ---------------------------------------------------------------
        // Pin semantics (rules 1–2)
        // ---------------------------------------------------------------

        // Rule 1: Effective pins START from preselectedItems
        const hasPreselection = preselectedItems.has(ctxId);
        let pinnedItemIds: string[];

        if (hasPreselection) {
          // null value = whole context = no filter = []
          pinnedItemIds = preselectedItems.get(ctxId) ?? [];
        } else if (!skipPrefilter) {
          // Rule 2: No preselection and !skipPrefilter

          // 2a: start from identifier pins for this context
          const identifierPins = identifierPinsByContext.get(ctxId) ?? new Set<string>();
          let pins = new Set<string>(identifierPins);

          // 2b: documents kind only — UNION with memoryPinnedItemIds
          if (kind === "documents") {
            for (const id of memoryPinnedItemIds) pins.add(id);
          }

          // 2c: user pins REPLACE everything (authoritative)
          const userPins = userPinnedItemIdsByContext.get(ctxId);
          if (userPins && userPins.size > 0) {
            pins = new Set<string>(userPins);
          }

          pinnedItemIds = Array.from(pins);
        } else {
          // skipPrefilter = true: suppress identifier/memory pins
          pinnedItemIds = [];
        }

        // ---------------------------------------------------------------
        // Rule 3: Query construction by kind
        // ---------------------------------------------------------------

        if (kind === "documents") {
          if (multiQuery) {
            // Generate HyDE passage when settings.hyde is true
            let hydePassage: string | null = null;
            if (hyde) {
              hydePassage = await generateHydePassage({
                originalQuestion: question,
                relevantKeywords: keywords,
                importantKeyword,
                styleHint,
                model,
              });
            }

            // HyDE placed right after the question so the cap never drops it
            const candidates: string[] = [
              question,
              ...(hydePassage ? [hydePassage] : []),
              ...applyRewrites(question, rewrites),
            ];
            const queries = [...new Set(candidates)].slice(0, maxQueries);

            return await multiQuerySearch({ queries, config: searchConfig, user, role, pinnedItemIds, context: ctx });
          } else {
            return await singleSearch({ query: question, config: searchConfig, user, role, pinnedItemIds, context: ctx });
          }
        }

        if (kind === "conversations") {
          // Deliberately NOT gated on skipPrefilter: the keyword prefilter is intrinsic to how
          // conversations-kind search works (reference parity — newlkiag ran it in the fallback
          // pass too), unlike the cross-context identifier/memory/user pins suppressed above.
          // keywordPrefilter and no pins yet → fuzzyPrefilter; results become the pins
          if (keywordPrefilter && pinnedItemIds.length === 0) {
            const prefiltered = await fuzzyPrefilter({
              cacheKey: `conversations:${ctxId}`,
              relevantKeywords: keywords,
              importantKeyword,
              context: ctx,
              fields: ["name", "id", "external_id", "description"],
              normalize: (i: any) => [i.name, i.description].filter(Boolean).join(": "),
            });
            pinnedItemIds = prefiltered.map((r) => r.id);
          }

          const keywordQuery = keywords.length
            ? keywords.join(" ") + " " + importantKeyword
            : question;

          return await singleSearch({ query: keywordQuery, config: searchConfig, user, role, pinnedItemIds, context: ctx });
        }

        if (kind === "records") {
          const keywordQuery = keywords.length
            ? keywords.join(" ") + " " + importantKeyword
            : question;

          return await singleSearch({ query: keywordQuery, config: searchConfig, user, role, pinnedItemIds, context: ctx });
        }

        return [];
      } catch (err) {
        console.warn(`[EXULU pipeline] searchContexts failed for context "${ctxId}":`, err);
        return [];
      }
    }),
  );

  return { chunks: chunkArrays.flat() };
}
