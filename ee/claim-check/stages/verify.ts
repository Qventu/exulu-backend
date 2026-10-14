import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type EvidenceSnippet, type VerifyOutcome } from "../types";
import { VERIFY_SYSTEM, verifyUserPrompt } from "../prompts/verify";
import { EMPTY_USAGE, type StageUsage } from "./usage";

const schema = z.object({
  claims: z.array(
    z.object({
      claimId: z.string(),
      verdict: z.enum(["supported", "contradicted", "unsupported"]),
      evidence: z.array(z.object({ sourceId: z.string(), quote: z.string() })),
      rationale: z.string(),
    }),
  ),
});

export async function runVerification(args: {
  claims: { id: string; text: string }[];
  evidence: EvidenceSnippet[];
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: VerifyOutcome[]; usage: StageUsage }> {
  if (args.claims.length === 0) return { outcomes: [], usage: { ...EMPTY_USAGE } };

  // No evidence means nothing to check against. Asking a model anyway would
  // invite it to answer from its own knowledge, which is exactly the failure
  // this feature exists to detect.
  if (args.evidence.length === 0) {
    return {
      outcomes: args.claims.map((c) => ({
        claimId: c.id,
        verdict: "unsupported" as const,
        evidence: [],
        rationale: "no evidence was available for this claim",
      })),
      usage: { ...EMPTY_USAGE },
    };
  }

  const { output, usage } = await microCall({
    model: args.model,
    system: VERIFY_SYSTEM,
    prompt: verifyUserPrompt({ claims: args.claims, evidence: args.evidence }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const knownSourceIds = new Set(args.evidence.map((e) => e.sourceId));
  const returned = new Map((output?.claims ?? []).map((c) => [c.claimId, c]));

  // Finding 4: a claim the model dropped from a long JSON array is the
  // likeliest failure of this stage, and reporting it as "unsupported" put the
  // model's silence into the score as a finding against the ANSWER. No outcome
  // is returned for it instead; run.ts drops the claim and marks its sentence
  // not_checked, exactly as it already does for a call that failed outright.
  const outcomes = args.claims.flatMap(({ id }) => {
    const hit = returned.get(id);
    if (!hit) return [];
    return [
      {
        claimId: id,
        verdict: hit.verdict,
        // A citation to a source that was never shown is not traceable, so it is
        // dropped; the verdict itself stands with its rationale.
        evidence: hit.evidence.filter((e) => knownSourceIds.has(e.sourceId)),
        rationale: hit.rationale,
      },
    ];
  });

  return { outcomes, usage: { calls: 1, ...usage } };
}
