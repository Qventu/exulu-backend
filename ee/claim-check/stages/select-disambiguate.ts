import { z } from "zod";
import type { LanguageModel } from "ai";
import { microCall } from "@EE/agentic-retrieval/pipeline/micro-call";
import {
  CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  type DisambiguationOutcome,
  type SelectionOutcome,
  type SentenceWindow,
} from "../types";
import {
  SELECT_DISAMBIGUATE_SYSTEM,
  selectDisambiguateUserPrompt,
} from "../prompts/select-disambiguate";
import { excerptFor } from "./select";
import type { StageUsage } from "./usage";

const schema = z.object({
  sentences: z.array(
    z.object({
      index: z.number().int(),
      verifiable: z.boolean(),
      rewritten: z.string().nullable(),
      resolvable: z.boolean(),
      clarified: z.string().nullable(),
      reason: z.string(),
    }),
  ),
});

export async function runSelectAndDisambiguate(args: {
  windows: SentenceWindow[];
  question: string;
  model: LanguageModel;
  temperature?: number;
}): Promise<{
  selection: SelectionOutcome[];
  disambiguation: DisambiguationOutcome[];
  usage: StageUsage;
}> {
  const targets = args.windows.map((w) => ({ index: w.sentence.index, text: w.sentence.text }));

  const { output, usage } = await microCall({
    model: args.model,
    system: SELECT_DISAMBIGUATE_SYSTEM,
    prompt: selectDisambiguateUserPrompt({
      question: args.question,
      excerpt: excerptFor(args.windows),
      targets,
    }),
    schema,
    temperature: args.temperature ?? 0,
    maxOutputTokens: CLAIM_CHECK_MAX_OUTPUT_TOKENS,
  });

  const returned = new Map((output?.sentences ?? []).map((s) => [s.index, s]));
  const selection: SelectionOutcome[] = [];
  const disambiguation: DisambiguationOutcome[] = [];

  for (const { index } of targets) {
    const hit = returned.get(index);
    if (!hit) {
      selection.push({ index, verifiable: false, rewritten: null, reason: "no outcome returned for this sentence" });
      disambiguation.push({ index, resolvable: false, clarified: null, reason: "no outcome returned for this sentence" });
      continue;
    }
    selection.push({
      index,
      verifiable: hit.verifiable,
      rewritten: hit.rewritten?.trim() || null,
      reason: hit.reason,
    });
    // A sentence that failed selection must never reach decomposition, whatever
    // the model said about its ambiguity.
    const resolvable = hit.verifiable && hit.resolvable;
    disambiguation.push({
      index,
      resolvable,
      clarified: (resolvable && hit.clarified?.trim()) || null,
      reason: hit.reason,
    });
  }

  return { selection, disambiguation, usage: { calls: 1, ...usage } };
}
