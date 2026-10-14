// ee/claim-check/score.ts
//
// The honesty rules of the whole feature live here (spec §2.4):
//  1. only CHECKED claims are in the denominator — dropped sentences never
//     drag the number down;
//  2. "contradicted" and "unsupported" stay separate, because "the sources say
//     otherwise" and "the sources are silent" are different problems;
//  3. no checkable claims => "n/a", never 0, which would read as a failure.
import type {
  Claim,
  ClaimCheckScore,
  ScoreLabel,
  Sentence,
  SentenceResult,
  SentenceState,
} from "./types";

function labelFor(share: number, thresholds: { warn: number; alert: number }): ScoreLabel {
  if (share >= thresholds.alert) return "alert";
  if (share >= thresholds.warn) return "warn";
  return "ok";
}

export function scoreClaims(
  claims: Claim[],
  thresholds: { warn: number; alert: number },
): ClaimCheckScore {
  const supported = claims.filter((c) => c.verdict === "supported").length;
  const contradicted = claims.filter((c) => c.verdict === "contradicted").length;
  const unsupported = claims.filter((c) => c.verdict === "unsupported").length;
  const total = claims.length;

  if (total === 0) {
    return { claims: 0, supported: 0, contradicted: 0, unsupported: 0, unsupportedShare: 0, label: "n/a" };
  }

  const share = Number(((contradicted + unsupported) / total).toFixed(4));
  return {
    claims: total,
    supported,
    contradicted,
    unsupported,
    unsupportedShare: share,
    label: labelFor(share, thresholds),
  };
}

export function buildSentenceResults(
  sentences: Sentence[],
  states: Map<number, { state: SentenceState; reason?: string }>,
  claims: Claim[],
): SentenceResult[] {
  const claimIdsBySentence = new Map<number, string[]>();
  for (const claim of claims) {
    const list = claimIdsBySentence.get(claim.sentenceIndex) ?? [];
    list.push(claim.id);
    claimIdsBySentence.set(claim.sentenceIndex, list);
  }

  return sentences.map((sentence) => {
    const recorded = states.get(sentence.index) ?? {
      state: "not_checked" as SentenceState,
      reason: "stage did not report an outcome for this sentence",
    };
    const result: SentenceResult = {
      index: sentence.index,
      start: sentence.start,
      end: sentence.end,
      state: recorded.state,
      claimIds: claimIdsBySentence.get(sentence.index) ?? [],
    };
    if (recorded.reason) result.reason = recorded.reason;
    return result;
  });
}
