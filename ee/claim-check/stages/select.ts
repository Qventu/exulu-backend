import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import { CLAIM_CHECK_MAX_OUTPUT_TOKENS, type SelectionOutcome, type SentenceWindow } from "../types";
import { SELECT_SYSTEM, selectUserPrompt } from "../prompts/select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      verifiable: z.boolean(),
      rewritten: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

/** The excerpt shown to the model: the batch's sentences plus their windows, in answer order.
 *  When sentenceTexts is provided, uses those rewrites instead of original text. */
export function excerptFor(windows: SentenceWindow[], sentenceTexts?: Map<number, string>): string {
  const byIndex = new Map<number, string>();
  for (const w of windows) {
    for (const s of [...w.preceding, w.sentence, ...w.following]) {
      byIndex.set(s.index, sentenceTexts?.get(s.index) ?? s.text);
    }
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join(" ");
}

export async function runSelection(args: {
  windows: SentenceWindow[];
  question: string;
  model: LanguageModel;
  temperature?: number;
}): Promise<{ outcomes: SelectionOutcome[]; usage: StageUsage }> {
  const targets = args.windows.map((w) => ({ index: w.sentence.index, text: w.sentence.text }));

  const { output, usage } = await microCall({
    model: args.model,
    system: SELECT_SYSTEM,
    prompt: selectUserPrompt({ question: args.question, excerpt: excerptFor(args.windows), targets }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const returned = new Map((output?.sentences ?? []).map((s) => [s.index, s]));

  // A sentence the model skipped is NOT silently promoted to "checked": an
  // unanswered sentence contributes nothing to the score instead of a verdict
  // nobody produced.
  const outcomes = targets.map(({ index }) => {
    const hit = returned.get(index);
    if (!hit) {
      return {
        index,
        verifiable: false,
        rewritten: null,
        reason: "no selection returned for this sentence",
        answered: false,
      };
    }
    const rewritten = hit.rewritten?.trim() || null;
    return {
      index,
      verifiable: hit.verifiable,
      rewritten,
      reason: hit.reason,
      answered: true,
    };
  });

  return { outcomes, usage: { calls: 1, ...usage } };
}
