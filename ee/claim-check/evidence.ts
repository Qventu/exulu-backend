//
// Why this exists: measured on NEWLIFT's live data, one turn's evidence
// averages ~89k chars (max ~600k). Sending all of it into every verification
// call would cost more than every extraction stage combined. So sources are
// sliced into overlapping passages and scored per claim with a lexical
// IDF-weighted overlap — deliberately no embedder, so a client that brings its
// own sources gets identical behaviour with no embedding spend.
import { preprocessQuery } from "@SRC/utils/query-preprocessing";
import type { ClaimCheckSource, EvidenceSnippet } from "./types";

export type IndexedPassage = {
  sourceId: string;
  sourceName?: string;
  text: string;
  tokens: string[];
};

/**
 * Per-source hard limit. A 600k-char evidence set is never indexed whole (spec
 * §4), so anything past this is NOT searched — which is only honest if the
 * result says so, hence the truncation report below. Without it, a claim
 * supported only in a dropped tail comes back "unsupported" and the feature
 * invents a hallucination on the largest real turns.
 */
export const MAX_CHARS_PER_SOURCE = 60_000;

const DEFAULTS = { passageChars: 1200, overlapChars: 200, maxCharsPerSource: MAX_CHARS_PER_SOURCE };

/** What indexing had to leave unsearched. */
export type SourceTruncation = {
  /** Number of sources whose content was cut. */
  sources: number;
  /** Characters of source content that were never indexed. */
  droppedChars: number;
};

/** Stemmed, deduplicated content tokens. Language is detected per text. */
function tokenize(text: string): string[] {
  if (!text.trim()) return [];
  const { processed } = preprocessQuery(text, { enableStemming: true, detectLanguage: true, silent: true });
  return processed
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
}

export type IndexOptions = { passageChars?: number; overlapChars?: number; maxCharsPerSource?: number };

/**
 * Index the sources AND report what had to be dropped, so the caller can set
 * `limits.truncated` and note it. The passages-only `indexSources` below is
 * the same function for callers that cannot truncate anything (second-chance
 * retrieval, which feeds it chunks, not whole documents).
 */
export function indexSourcesWithLimits(
  sources: ClaimCheckSource[],
  opts: IndexOptions = {},
): { passages: IndexedPassage[]; truncation: SourceTruncation } {
  const { passageChars, overlapChars, maxCharsPerSource } = { ...DEFAULTS, ...opts };
  const passages: IndexedPassage[] = [];
  const truncation: SourceTruncation = { sources: 0, droppedChars: 0 };

  for (const source of sources) {
    const full = source.content ?? "";
    const content = full.slice(0, maxCharsPerSource);
    if (full.length > content.length) {
      truncation.sources += 1;
      truncation.droppedChars += full.length - content.length;
    }
    if (!content.trim()) continue;

    const step = Math.max(1, passageChars - overlapChars);
    for (let start = 0; start < content.length; start += step) {
      const text = content.slice(start, start + passageChars).trim();
      if (!text) continue;
      passages.push({
        sourceId: source.id,
        sourceName: source.name,
        text,
        tokens: tokenize(text),
      });
      if (start + passageChars >= content.length) break;
    }
  }

  return { passages, truncation };
}

export function indexSources(sources: ClaimCheckSource[], opts: IndexOptions = {}): IndexedPassage[] {
  return indexSourcesWithLimits(sources, opts).passages;
}

export function selectEvidence(
  claimTexts: string[],
  passages: IndexedPassage[],
  topK = 4,
): EvidenceSnippet[] {
  if (passages.length === 0) return [];

  const queryTokens = new Set(claimTexts.flatMap((t) => tokenize(t)));

  // IDF over passages, so a term that appears everywhere ("aufzug" in a lift
  // manual) cannot outvote the one distinguishing term in the claim.
  const documentFrequency = new Map<string, number>();
  for (const passage of passages) {
    for (const token of new Set(passage.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const scored = passages.map((passage, position) => {
    const present = new Set(passage.tokens);
    let score = 0;
    for (const token of queryTokens) {
      if (!present.has(token)) continue;
      const df = documentFrequency.get(token) ?? passages.length;
      score += Math.max(0, Math.log(passages.length / df));
    }
    return { passage, score, position };
  });

  // Stable: score desc, then original order, so an all-zero set still returns
  // a deterministic fallback rather than nothing to check against.
  scored.sort((a, b) => (b.score - a.score) || (a.position - b.position));

  return scored.slice(0, topK).map(({ passage, score }) => ({
    sourceId: passage.sourceId,
    sourceName: passage.sourceName,
    text: passage.text,
    score: Number(score.toFixed(4)),
  }));
}
