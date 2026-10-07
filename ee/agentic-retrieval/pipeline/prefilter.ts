import Fuse from "fuse.js";
import { z } from "zod";
import { microCall } from "./micro-call";
import { normalizeFileName, stripSeparators } from "./text-utils";
import { DEFAULT_PREFILTER_CUTOFF, type IdentifierSet, type KbKind } from "./config";
import type { PhaseStep } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrefilteredResult = {
  key: string;
  name: string;
  id: string;
};

type ItemsCache = {
  fuseIndex: any;
  items: { name?: string; id?: string; external_id?: string; normalized?: string; stripped?: string }[];
  tsp: Date;
  cacheKey: string;
};

/** Shortest separator-free token eligible for the supplementary pass. Below
 *  this, a token matches too much of the corpus to be a useful pin. */
const SUPPLEMENT_MIN_TOKEN_LENGTH = 4;
/** Most items the supplementary pass may add on top of the primary result. */
const SUPPLEMENT_BUDGET = 15;

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let itemCaches: Record<string, ItemsCache> = {};

export function clearPrefilterCaches(): void {
  itemCaches = {};
}

const ensureItemsCache = async ({
  cacheKey,
  context,
  fields,
  normalize,
}: {
  cacheKey: string;
  context: { id: string; getItems: (o: any) => Promise<any[]> };
  fields: string[];
  normalize: (item: any) => string | undefined;
}): Promise<ItemsCache> => {
  if (
    !itemCaches[cacheKey] ||
    Date.now() - itemCaches[cacheKey]!.tsp.getTime() > 5 * 60 * 1000 ||
    itemCaches[cacheKey]!.items.length === 0
  ) {
    const result = await context.getItems({ fields, filters: [] });

    const normalizedItems = result.map((item: any) => {
      const normalized = normalize(item);
      return {
        name: item.name,
        id: item.id,
        external_id: item.external_id,
        normalized,
        // Separator-free form used only by the supplementary pass in
        // fuzzyPrefilter. Deliberately NOT added to the Fuse index or keys:
        // changing what Fuse scores reshuffles which items win the result cap,
        // which cost 22 regressions against 6 improvements when measured over
        // positively-rated production cases.
        stripped: stripSeparators(normalized ?? item.name ?? ""),
      };
    });

    itemCaches[cacheKey] = {
      cacheKey,
      items: normalizedItems,
      tsp: new Date(),
      fuseIndex: Fuse.createIndex(["normalized"], normalizedItems),
    };
  }

  return itemCaches[cacheKey]!;
};

// ---------------------------------------------------------------------------
// Exact-token prefilter
// ---------------------------------------------------------------------------

/**
 * Precise filename prefiltering for distinctive identifiers such as norm/standard numbers
 * (e.g. "8100", "8100-1", "81-20"). Strips all separators from both tokens and normalized
 * file names and requires an exact substring match. Tokens shorter than `minTokenLength`
 * (after stripping) are ignored to avoid over-broad matches.
 */
export async function exactTokenPrefilter({
  cacheKey,
  tokens,
  context,
  fields,
  normalize,
  minTokenLength = 3,
  limit,
}: {
  cacheKey: string;
  tokens: string[];
  context: { id: string; getItems: (o: any) => Promise<any[]> };
  fields: string[];
  normalize: (item: any) => string | undefined;
  minTokenLength?: number;
  limit?: number;
}): Promise<PrefilteredResult[]> {
  const cache = await ensureItemsCache({ cacheKey, context, fields, normalize });

  const strip = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const normalizedTokens = [...new Set(tokens.map(strip))].filter((t) => t.length >= minTokenLength);

  if (!normalizedTokens.length) {
    return [];
  }

  const matches = cache.items.filter((item) => {
    const haystack = strip(item.normalized || "");
    return normalizedTokens.some((token) => haystack.includes(token));
  });

  console.log("[EXULU pipeline] exactTokenPrefilter matched:", matches.map((m) => m.external_id));

  return matches.slice(0, limit ?? 30).map((item) => ({
    key: item.external_id ?? "",
    name: item.name ?? "",
    id: item.id ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Fuzzy (keyword-based) prefilter
// ---------------------------------------------------------------------------

/**
 * Fuzzy keyword prefilter using Fuse.js. Searches the normalized item text and name
 * with OR logic across keywords, then re-scores by keyword-coverage ratio, title matches,
 * and an optional important-keyword boost. Returns only results scoring ≤ cutoff.
 */
export async function fuzzyPrefilter({
  cacheKey,
  relevantKeywords,
  importantKeyword,
  context,
  fields,
  normalize,
  cutoff = DEFAULT_PREFILTER_CUTOFF,
  limit,
  supplementSeparatorVariants = false,
}: {
  cacheKey: string;
  relevantKeywords: string[];
  importantKeyword?: string;
  context: { id: string; getItems: (o: any) => Promise<any[]> };
  fields: string[];
  normalize: (item: any) => string | undefined;
  cutoff?: number;
  limit?: number;
  /**
   * Opt in to the separator-insensitive supplement below. Only meaningful when
   * `normalize` yields FILENAME-ish text: it exists because a hyphenated
   * identifier scores badly against an unhyphenated filename. Callers that
   * normalize to prose — the conversations keyword prefilter joins a ticket's
   * name and description — get nothing useful from it, so it stays off by
   * default rather than silently widening every prefilter in the pipeline.
   */
  supplementSeparatorVariants?: boolean;
}): Promise<PrefilteredResult[]> {
  const cache = await ensureItemsCache({ cacheKey, context, fields, normalize });

  if (!relevantKeywords?.length) {
    return [];
  }

  // Split multi-word keywords, flatten, deduplicate
  const uniqueKeywords = [...new Set(relevantKeywords.flatMap((k) => k.split(" ")))];

  const index = Fuse.parseIndex(cache.fuseIndex);
  const fuse = new Fuse(
    cache.items,
    {
      includeScore: true,
      useExtendedSearch: true,
      keys: [
        { name: "normalized", weight: 2.0 },
        { name: "name", weight: 1.0 },
      ],
      threshold: 0.8,    // Lenient — custom scoring applied afterward (0.0 = perfect, 1.0 = anything)
      distance: 500,     // Allow matching across longer distances in text
      ignoreLocation: true,
      minMatchCharLength: 3,
    },
    index,
  );

  // OR search across all keywords, then re-rank
  const searchQuery = uniqueKeywords.join(" | ");
  const result = fuse.search(searchQuery);

  const rescored = result
    .map((r: any) => {
      const normalized = r.item.normalized?.toLowerCase() || "";
      const name = r.item.name?.toLowerCase() || "";
      // Flexible matching: replace separator chars with spaces
      const normalizedFlexible = normalized.replace(/[-_\.]/g, " ").replace(/\s+/g, " ");
      const nameFlexible = name.replace(/[-_\.]/g, " ").replace(/\s+/g, " ");

      // Count how many keywords appear in the item (exact or separator-flexible)
      const matchedKeywords = uniqueKeywords.filter((keyword: string) => {
        const keywordLower = keyword.toLowerCase();
        const keywordFlexible = keywordLower.replace(/[-_\.]/g, " ").replace(/\s+/g, " ");

        const exactMatchInNormalized =
          normalized.includes(keywordLower) || normalizedFlexible.includes(keywordFlexible);
        const exactMatchInName = name.includes(keywordLower) || nameFlexible.includes(keywordFlexible);

        return exactMatchInNormalized || exactMatchInName;
      });
      const matchRatio = matchedKeywords.length / uniqueKeywords.length;

      // Title match count for additional boost
      const titleMatches = uniqueKeywords.filter((keyword: string) => {
        const keywordLower = keyword.toLowerCase();
        const keywordFlexible = keywordLower.replace(/[-_\.]/g, " ").replace(/\s+/g, " ");

        return name.includes(keywordLower) || nameFlexible.includes(keywordFlexible);
      }).length;

      // Important-keyword presence check
      let hasImportantKeyword = false;
      let importantKeywordInTitle = false;
      if (importantKeyword) {
        const importantLower = importantKeyword.toLowerCase();
        const importantFlexible = importantLower.replace(/[-_\.]/g, " ").replace(/\s+/g, " ");

        hasImportantKeyword =
          normalized.includes(importantLower) || normalizedFlexible.includes(importantFlexible);
        importantKeywordInTitle = name.includes(importantLower) || nameFlexible.includes(importantFlexible);
      }

      // Re-score: penalize by match-ratio, then boost for title and important keyword
      let adjustedScore: number;
      if (matchRatio === 1.0) {
        adjustedScore = r.score;
      } else if (matchRatio >= 0.66) {
        adjustedScore = r.score * 1.5;
      } else if (matchRatio >= 0.33) {
        adjustedScore = r.score * 3;
      } else {
        adjustedScore = r.score * 10;
      }

      if (titleMatches > 0) {
        const titleBoost = Math.pow(0.6, titleMatches); // 0.6^n per title match
        adjustedScore = adjustedScore * titleBoost;
      }

      if (hasImportantKeyword) {
        adjustedScore = adjustedScore * 0.5; // 50% better score
        if (importantKeywordInTitle) {
          adjustedScore = adjustedScore * 0.4; // additional 60% boost if in title
        }
      }

      return {
        ...r,
        matchedKeywords: matchedKeywords.length,
        matchRatio,
        titleMatches,
        hasImportantKeyword,
        importantKeywordInTitle,
        originalScore: r.score,
        score: adjustedScore,
      };
    })
    .sort((a: any, b: any) => a.score - b.score);

  const filteredResults = rescored.filter((r: any) => r.score <= cutoff);

  const prefiltered = filteredResults.slice(0, limit ?? 30).map((result: any) => ({
    key: result.item.external_id,
    name: result.item.name,
    id: result.item.id,
  }));

  // ---------------------------------------------------------------------
  // Supplementary separator-insensitive pass
  // ---------------------------------------------------------------------
  // Fuse scores an identifier's punctuation, not just its letters: "FST-2XT"
  // scores ~0.0001 against `br_FST-2XT_2019-10_de.pdf` but ~0.02 against
  // `hb_FST2XT-XTs_2017-11_de.pdf`. NEWLIFT's brochures carry the hyphen and
  // its handbooks do not, so the brochures filled the cap above and the
  // handbooks — which hold the error-code tables — were dropped entirely.
  // Because identifier pins are a hard id-whitelist rather than a boost, that
  // made their content unreachable no matter how the model phrased the query.
  //
  // This pass is strictly ADDITIVE: it never reorders or displaces a primary
  // hit, so no pin that resolved before can be lost. Only tokens that actually
  // CONTAIN a separator can be mismatched this way, so only those are
  // supplemented — a plain token like "FST" is already scored correctly and
  // supplementing it would match most of the corpus.
  const supplementTokens = !supplementSeparatorVariants
    ? []
    : [
        ...new Set(
          uniqueKeywords
            .filter((k) => /[-_.]/.test(k))
            .map((k) => stripSeparators(k))
            .filter((t) => t.length >= SUPPLEMENT_MIN_TOKEN_LENGTH),
        ),
      ].sort((a, b) => b.length - a.length); // most specific first

  if (supplementTokens.length > 0) {
    const seen = new Set(prefiltered.map((p) => p.id));
    // `normalized` is the full storage path, and NEWLIFT files a product's
    // documents under a folder named after it (`/FST/FST-2XT/...`), so every
    // incidental file in that folder matches the identifier as well as the
    // handbook does. Rank a match in the FILENAME above a path-only match, then
    // prefer the shorter name (the more specific document), before falling back
    // to corpus order — otherwise the budget fills with whatever happens to be
    // stored alongside.
    const candidates = cache.items
      .filter(
        (item) =>
          item.id &&
          !seen.has(item.id) &&
          supplementTokens.some((t) => (item.stripped ?? "").includes(t)),
      )
      .map((item, idx) => {
        const nameStripped = stripSeparators(item.name ?? "");
        return {
          item,
          idx,
          nameMatch: supplementTokens.some((t) => nameStripped.includes(t)) ? 0 : 1,
          nameLength: (item.name ?? "").length,
        };
      })
      .sort(
        (a, b) =>
          a.nameMatch - b.nameMatch || a.nameLength - b.nameLength || a.idx - b.idx,
      );

    const supplement: PrefilteredResult[] = [];
    for (const { item } of candidates) {
      if (supplement.length >= SUPPLEMENT_BUDGET) break;
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      supplement.push({
        key: item.external_id ?? item.id,
        name: item.name ?? item.external_id ?? item.id,
        id: item.id,
      });
    }
    if (supplement.length > 0) {
      console.log(
        `[EXULU pipeline] fuzzyPrefilter: +${supplement.length} separator-insensitive supplement(s) for [${supplementTokens.join(", ")}]`,
      );
      prefiltered.push(...supplement);
    }
  }

  console.log(
    `[EXULU pipeline] fuzzyPrefilter: ${prefiltered.length} result(s) for [${uniqueKeywords.join(", ")}]`,
  );

  return prefiltered;
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const FUZZY_EXTRACTION_PROMPT = (set: IdentifierSet) => `
You are checking whether the user's question references any "${set.name}".
${set.description ? set.description + "\n" : ""}Examples of such identifiers: ${set.examples.join(", ")}.
If the question references one, return it BOTH as its stem and its full version.
For example, for "${set.examples[0] ?? "ABC-1"}-3" return "${set.examples[0] ?? "ABC-1"}" and "${set.examples[0] ?? "ABC-1"}-3".
If the question references none, return an empty array and hasMatches set to false.`;

const EXACT_EXTRACTION_PROMPT = (set: IdentifierSet) => `
You are checking whether the user's question references any "${set.name}".
${set.description ? set.description + "\n" : ""}Examples: ${set.examples.join(", ")}.
If it does, return hasMatches true and matches: a list of search tokens used to find the
matching document by its file name. Include BOTH the full identifier and useful partial
forms — the bare number on its own, and each individual part when a multi-part identifier
is referenced (e.g. "ISO 8100-1-2" must yield "8100-1" AND "8100-2").
Do NOT include generic single words on their own.
If the question references none, return hasMatches false and an empty array.`;

// ---------------------------------------------------------------------------
// Config-driven identifier-pin resolution
// ---------------------------------------------------------------------------

export async function resolveIdentifierPins({
  question,
  identifierSets,
  contextsById,
  kbKindById,
  model,
}: {
  question: string;
  identifierSets: IdentifierSet[];
  contextsById: Map<string, any>;
  kbKindById: Map<string, KbKind>;
  model: any;
}): Promise<{
  pinsByContext: Map<string, Set<string>>;
  exactPinsByContext: Map<string, Set<string>>;
  steps: PhaseStep[];
}> {
  const pinsByContext = new Map<string, Set<string>>();
  const exactPinsByContext = new Map<string, Set<string>>();
  const steps: PhaseStep[] = [];

  await Promise.all(
    identifierSets.map(async (set) => {
      if (!set.contexts.length) return;
      try {
        const { output } = await microCall({
          model,
          system:
            set.strategy === "exact" ? EXACT_EXTRACTION_PROMPT(set) : FUZZY_EXTRACTION_PROMPT(set),
          messages: [{ role: "user", content: question }],
          schema: z.object({
            hasMatches: z.boolean(),
            matches: z.array(z.string()).optional(),
          }),
        });
        if (!output?.hasMatches || !output.matches?.length) return;
        steps.push({ text: `Detected ${set.name} in the question: ${output.matches.join(", ")}` });

        await Promise.all(
          set.contexts.map(async (ctxId) => {
            const ctx = contextsById.get(ctxId);
            if (!ctx) return;
            const common = {
              cacheKey: `identifier:${ctxId}`,
              context: ctx,
              fields: ["name", "id", "external_id"],
              normalize: (item: any) =>
                item.external_id ? normalizeFileName(item.external_id) : item.name,
            };
            const matched =
              set.strategy === "exact"
                ? await exactTokenPrefilter({ ...common, tokens: output.matches! })
                : await fuzzyPrefilter({
                    ...common,
                    relevantKeywords: output.matches!,
                    cutoff: DEFAULT_PREFILTER_CUTOFF,
                    // Identifier pins are a hard id-whitelist over filenames,
                    // which is exactly the case the supplement exists for.
                    supplementSeparatorVariants: true,
                  });
            if (!matched.length) return;
            const target = pinsByContext.get(ctxId) ?? new Set<string>();
            for (const m of matched) target.add(m.id);
            pinsByContext.set(ctxId, target);
            if (set.strategy === "exact") {
              const boost = exactPinsByContext.get(ctxId) ?? new Set<string>();
              for (const m of matched) boost.add(m.id);
              exactPinsByContext.set(ctxId, boost);
            }
            steps.push({
              text: `Limiting "${ctxId}" to ${matched.length} matching file(s): ${matched.map((m) => m.name).join(", ")}`,
            });
          }),
        );
      } catch (err) {
        console.warn(
          `[EXULU pipeline] identifier extraction for "${set.name}" failed — skipping.`,
          err,
        );
      }
    }),
  );

  return { pinsByContext, exactPinsByContext, steps };
}
