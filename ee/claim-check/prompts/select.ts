// Our wording of the paper's Selection stage (arXiv 2502.10855 §3.2). The
// paper's appendix prompt is a behaviour reference, not a source text.
import { fenced, SAME_LANGUAGE_RULE, UNTRUSTED_TEXT_RULE } from "./shared";

export const SELECT_SYSTEM = `You support a fact-checking pipeline.

You receive a QUESTION, an EXCERPT from an answer to that question, and a numbered list of
TARGET SENTENCES taken from that excerpt. For each target sentence, decide whether it contains
at least one specific, verifiable proposition — a statement that a fact-checker could confirm or
refute against source documents.

Rules:
- Whether the proposition is true or false does not matter.
- Whether it is relevant to the question does not matter.
- Unresolved pronouns or vague references do not matter: assume the fact-checker can resolve
  them. Judge only whether something specific is being asserted.
- A statement that information is missing or unavailable is NOT verifiable.
- A sentence that only introduces what the following sentences say, or only restates preceding
  sentences as a conclusion, is NOT verifiable.
- Opinions, recommendations, value judgements, generic statements and speculation are NOT
  verifiable.
- Citations, formatting and markup are irrelevant to the decision.
- Use the surrounding sentences to decide: a short sentence can be verifiable because the
  preceding sentence supplies its subject.

If a sentence mixes verifiable and unverifiable content, return a rewritten version that keeps
only the verifiable content, staying as close to the original wording as possible. If the whole
sentence is already verifiable, return null for the rewrite.

${SAME_LANGUAGE_RULE}

${UNTRUSTED_TEXT_RULE}

Answer for EVERY target sentence index you were given, and for no other index. Keep each reason
under 15 words.`;

export function selectUserPrompt(args: {
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
