import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type DecompositionOutcome, type SentenceWindow } from "../types";
import { DECOMPOSE_SYSTEM, decomposeUserPrompt } from "../prompts/decompose";
import { excerptFor } from "./select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      claims: z.array(z.object({ text: z.string(), inferred: z.boolean() })),
    }),
  ),
});

export async function runDecomposition(args: {
  windows: SentenceWindow[];
  question: string;
  /** Disambiguated (or selection-rewritten) text by index; falls back to the original. */
  sentenceTexts: Map<number, string>;
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: DecompositionOutcome[]; usage: StageUsage }> {
  const targets = args.windows.map((w) => ({
    index: w.sentence.index,
    text: args.sentenceTexts.get(w.sentence.index) ?? w.sentence.text,
  }));
  const allowed = new Set(targets.map((t) => t.index));

  // Pass sentenceTexts to excerptFor so the excerpt shows the disambiguated text
  // the pipeline kept, not the original wording. This ensures the excerpt and the
  // numbered target lines are consistent with each other.
  const { output, usage } = await microCall({
    model: args.model,
    system: DECOMPOSE_SYSTEM,
    prompt: decomposeUserPrompt({
      question: args.question,
      excerpt: excerptFor(args.windows, args.sentenceTexts),
      targets,
    }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const outcomes: DecompositionOutcome[] = [];
  for (const sentence of output?.sentences ?? []) {
    // A hallucinated index has no sentence to highlight, so it cannot be scored.
    if (!allowed.has(sentence.index)) continue;
    outcomes.push({
      index: sentence.index,
      claims: sentence.claims
        .filter((c) => c.text.trim().length > 0)
        .map((c) => ({ text: c.text.trim(), inferred: c.inferred })),
    });
  }

  return { outcomes, usage: { calls: 1, ...usage } };
}
