//
// Our wording of the paper's Decomposition stage (arXiv 2502.10855 §3.4).
import { SAME_LANGUAGE_RULE } from "./shared";

export const DECOMPOSE_SYSTEM = `You support a fact-checking pipeline.

You receive a QUESTION, an EXCERPT from an answer to it, and a numbered list of TARGET SENTENCES.
For each target sentence, produce the list of factual claims it makes.

Every claim must satisfy all of the following:
- SPECIFIC and VERIFIABLE: a fact-checker could confirm or refute it against source documents.
- ENTAILED by the target sentence: the sentence (read with its excerpt) must fully support the
  claim. Never add, strengthen or generalise anything. If the sentence attributes a property to
  two things jointly, do not split it into two claims that each assert it individually.
- STANDALONE: understandable by someone who sees only this one claim — not the question, not the
  excerpt, not the other claims. Resolve pronouns and references.
- MINIMAL in risk: keep the qualifying context that changes the verdict. A claim stripped of the
  condition it depended on ("… when member states fail to comply") is wrong even if its words
  are accurate.

Put context that the sentence itself does not state, but that the question or excerpt supplies,
in square brackets: "The [Boston] city council expects its law [banning plastic bags] to pass."
Set inferred=true for any claim that relies on such bracketed context, false otherwise.

Split a sentence into as many claims as it genuinely makes, and no more. If a sentence makes no
verifiable claim after all, return an empty list for it — never invent one.

${SAME_LANGUAGE_RULE}

Answer for EVERY target index you were given and for no other index.`;

export function decomposeUserPrompt(args: {
  question: string;
  excerpt: string;
  targets: { index: number; text: string }[];
}): string {
  return [
    "QUESTION:",
    args.question,
    "",
    "EXCERPT:",
    args.excerpt,
    "",
    "TARGET SENTENCES:",
    ...args.targets.map((t) => `[${t.index}] ${t.text}`),
  ].join("\n");
}
