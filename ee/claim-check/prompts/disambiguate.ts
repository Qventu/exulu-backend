// Our wording of the paper's Disambiguation stage (arXiv 2502.10855 §3.3).
// This stage is the paper's distinctive contribution: it refuses to guess.
import { fenced, SAME_LANGUAGE_RULE, UNTRUSTED_TEXT_RULE } from "./shared";

/** The stage's rules, without the lead-in line, so the merged fast-path prompt
 *  (task 7) can compose them instead of string-replacing the lead-in out. */
export const DISAMBIGUATE_RULES = `You receive a QUESTION, an EXCERPT from an answer to it, and a numbered list of TARGET SENTENCES
from that excerpt. For each target sentence, find the linguistic ambiguity in it and decide
whether the question and the excerpt resolve that ambiguity.

Two kinds of ambiguity count:
1. REFERENTIAL — it is unclear what a word or phrase refers to ("they", "the policy", "there",
   "next year", "these differences"). Temporal references count. Vague or general wording
   ("some experts", "several") is NOT referential ambiguity.
2. STRUCTURAL — the grammar allows more than one reading. State the readings explicitly as
   "The sentence could be interpreted as: (1) ... (2) ...". A special case: whether a trailing
   clause is something an actor did, or an interpretation the author added.

Partial names, acronyms and abbreviations are NOT linguistic ambiguity. If the question or the
excerpt gives the full form, use it in the clarified sentence; if not, leave it exactly as it is
and do not count it as ambiguity.

The standard for resolution is consensus: would a group of readers shown the question and the
excerpt agree on one interpretation? If yes for every ambiguity in the sentence, return a
clarified sentence that resolves all of them (or null if nothing needed changing). If any single
ambiguity would leave readers split, the sentence cannot be used: return resolvable=false, even
when other parts of it are perfectly clear.

Never add information that the question and excerpt do not support. ${SAME_LANGUAGE_RULE}

Answer for EVERY target index you were given and for no other index. Keep each reason under 20
words.`;

export const DISAMBIGUATE_SYSTEM = `You support a fact-checking pipeline.

${DISAMBIGUATE_RULES}

${UNTRUSTED_TEXT_RULE}`;

export function disambiguateUserPrompt(args: {
  question: string;
  excerpt: string;
  targets: { index: number; text: string }[];
}): string {
  return [
    "QUESTION:",
    args.question,
    "",
    "EXCERPT:",
    fenced("EXCERPT", args.excerpt),
    "",
    "TARGET SENTENCES:",
    fenced("TARGET SENTENCES", args.targets.map((t) => `[${t.index}] ${t.text}`).join("\n")),
  ].join("\n");
}
