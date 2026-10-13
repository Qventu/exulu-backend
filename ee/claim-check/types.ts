// ee/claim-check/types.ts
//
// The whole data contract of the claim-check engine. Every stage is a pure
// function over these types, so a stage can be tested without a provider and
// without the orchestrator.

/** Raised output cap: the staged prompts reason before answering, and the
 *  shared MICRO_CALL_MAX_OUTPUT_TOKENS (2000) truncates a batch of sentences. */
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
};

export type DisambiguationOutcome = {
  index: number;
  resolvable: boolean;
  /** Clarified sentence, or null when no change was needed. */
  clarified: string | null;
  reason: string;
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
