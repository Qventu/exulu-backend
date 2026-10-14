// ee/claim-check/types.ts
//
// The whole data contract of the claim-check engine. Every stage is a pure
// function over these types, so a stage can be tested without a provider and
// without the orchestrator.

/**
 * Raised output cap: the staged prompts reason before answering, and the
 * shared MICRO_CALL_MAX_OUTPUT_TOKENS (2000) truncates a batch of sentences.
 *
 * Still 8000 at the raised BATCH sizes, measured (o200k_base) against German
 * maintenance prose rather than estimated. Worst case per stage, with every
 * optional field returned at full length:
 *
 *   selection+disambiguation, 25 sentences, both `rewritten` and `clarified`
 *     returned in full and a 15-word reason: 2,131 tok at the measured average
 *     sentence (77 chars), 3,481 at 205 chars, 4,981 at 356 chars.
 *   decomposition, 15 sentences: 966 tok at 2 claims x 77 chars, 2,601 at
 *     3 x 205, 4,251 at 5 x 205, and 6,501 in the pathological 5 x 356 shape
 *     (five claims per sentence, each restating a 356-character sentence in
 *     full — a 5x expansion of the input).
 *   verification, 8 sentences: 1,877 tok at 3 claims x 77-char quotes, 2,525
 *     at 3 x 205, 5,405 at 5 x 356.
 *
 * So the binding case is a pathological decomposition batch at 6,501 of 8,000,
 * leaving 1,499 for a reasoning model's thinking (which counts against this
 * cap — see MICRO_CALL_MAX_OUTPUT_TOKENS). It is deliberately NOT raised:
 * 8,000 sits just under the 8,192-token output ceiling of a whole generation of
 * models that a self-hosted CLAIM_CHECK_DEFAULT_MODEL may well be, where a
 * higher value fails every call outright, and a truncated batch already
 * degrades safely — the parse fails, the batch fails, and run.ts's recursive
 * bisect retries it at 8 and 7 sentences, which fit with room to spare.
 */
export const CLAIM_CHECK_MAX_OUTPUT_TOKENS = 8000;

export type ClaimCheckSource = { id: string; name?: string; content: string };

export type Sentence = {
  index: number;
  /** Char offsets into the ORIGINAL answer string; answer.slice(start, end) === text. */
  start: number;
  end: number;
  text: string;
  /** Markdown heading hierarchy above this sentence, outermost first. */
  headingPath: string[];
};

export type SentenceWindow = {
  sentence: Sentence;
  preceding: Sentence[];
  following: Sentence[];
};

export type SelectionOutcome = {
  index: number;
  verifiable: boolean;
  /** Rewritten verifiable-only sentence, or null when unchanged. */
  rewritten: string | null;
  reason: string;
  /**
   * False when the model returned no outcome for this sentence at all. The
   * stage still reports verifiable=false (it must never promote a sentence
   * nobody judged), but "the model skipped this" is NOT the finding
   * "this sentence asserts nothing checkable", so the orchestrator needs to
   * tell the two apart without matching on reason strings.
   */
  answered: boolean;
};

export type DisambiguationOutcome = {
  index: number;
  resolvable: boolean;
  /** Clarified sentence, or null when no change was needed. */
  clarified: string | null;
  reason: string;
  /** False when the model returned no outcome for this sentence. See SelectionOutcome.answered. */
  answered: boolean;
};

export type DecompositionOutcome = {
  index: number;
  claims: { text: string; inferred: boolean }[];
};

export type EvidenceSnippet = {
  sourceId: string;
  sourceName?: string;
  text: string;
  score: number;
};

export type Verdict = "supported" | "contradicted" | "unsupported";

export type VerifyOutcome = {
  claimId: string;
  verdict: Verdict;
  evidence: { sourceId: string; quote: string }[];
  rationale: string;
};

export type Claim = {
  /** Stable within one result: "c1", "c2", … in extraction order. */
  id: string;
  sentenceIndex: number;
  text: string;
  inferred: boolean;
  verdict: Verdict;
  evidence: { sourceId: string; quote: string }[];
  rationale: string;
  /** True when a second-chance retrieval supplied the evidence. */
  rechecked: boolean;
  /**
   * True when this verdict came from an exact text match rather than a model
   * judgement: the text this claim was decomposed from appears verbatim in the
   * cited source, which therefore entails it (see ./verbatim). Such a claim is
   * always `supported`, is counted in the score like any other verified claim,
   * and cost no provider call. False for every model-judged claim.
   */
  matchedVerbatim: boolean;
};

export type SentenceState =
  | "checked"
  | "no_verifiable_content"
  | "cannot_disambiguate"
  | "not_checked";

export type SentenceResult = {
  index: number;
  start: number;
  end: number;
  state: SentenceState;
  reason?: string;
  claimIds: string[];
};

export type ScoreLabel = "ok" | "warn" | "alert" | "n/a";

export type ClaimCheckScore = {
  /** Checked claims only — the denominator. */
  claims: number;
  supported: number;
  contradicted: number;
  unsupported: number;
  /** (contradicted + unsupported) / claims; 0 when claims === 0. */
  unsupportedShare: number;
  label: ScoreLabel;
};

export type ClaimCheckResult = {
  status: "ok" | "partial";
  score: ClaimCheckScore;
  sentences: SentenceResult[];
  claims: Claim[];
  usage: { calls: number; inputTokens: number; outputTokens: number };
  timings: Record<string, number>;
  limits: { truncated: boolean; sentencesSkipped: number };
  notes: string[];
};

export type ClaimCheckOptions = {
  fidelity: "fast" | "paper";
  completions: number;
  reRetrieve: boolean;
  thresholds: { warn: number; alert: number };
  caps: { maxSentences: number; maxClaims: number; maxReRetrievals: number };
};

export const CLAIM_CHECK_DEFAULTS: ClaimCheckOptions = {
  fidelity: "fast",
  completions: 1,
  reRetrieve: true,
  thresholds: { warn: 0.1, alert: 0.3 },
  caps: { maxSentences: 120, maxClaims: 200, maxReRetrievals: 10 },
};
