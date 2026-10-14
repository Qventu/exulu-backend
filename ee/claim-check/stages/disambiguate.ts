import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type DisambiguationOutcome, type SentenceWindow } from "../types";
import { DISAMBIGUATE_SYSTEM, disambiguateUserPrompt } from "../prompts/disambiguate";
import { excerptFor } from "./select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      resolvable: z.boolean(),
      clarified: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

export async function runDisambiguation(args: {
  windows: SentenceWindow[];
  question: string;
  /** Selection's rewrites by sentence index; falls back to the original text. */
  sentenceTexts: Map<number, string>;
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: DisambiguationOutcome[]; usage: StageUsage }> {
  const targets = args.windows.map((w) => ({
    index: w.sentence.index,
    text: args.sentenceTexts.get(w.sentence.index) ?? w.sentence.text,
  }));

  const { output, usage } = await microCall({
    model: args.model,
    system: DISAMBIGUATE_SYSTEM,
    prompt: disambiguateUserPrompt({
      question: args.question,
      excerpt: excerptFor(args.windows, args.sentenceTexts),
      targets,
    }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const returned = new Map((output?.sentences ?? []).map((s) => [s.index, s]));

  // An unanswered sentence is excluded, not assumed clear: this stage exists
  // to refuse rather than guess, and a missing answer is not a resolution.
  const outcomes = targets.map(({ index }) => {
    const hit = returned.get(index);
    if (!hit) {
      return {
        index,
        resolvable: false,
        clarified: null,
        reason: "no disambiguation returned for this sentence",
        answered: false,
      };
    }
    return {
      index,
      resolvable: hit.resolvable,
      clarified: hit.resolvable && hit.clarified && hit.clarified.trim() ? hit.clarified.trim() : null,
      reason: hit.reason,
      answered: true,
    };
  });

  return { outcomes, usage: { calls: 1, ...usage } };
}
