//
// This stage is NOT from the paper: Claimify stops at extraction. The verdict
// vocabulary is ours (spec §2.4) and the distinction between "the sources say
// otherwise" and "the sources are silent" is the whole point of it.

import { fenced, inlineQuoted, UNTRUSTED_TEXT_RULE } from "./shared";

export const VERIFY_SYSTEM = `You are a strict fact-checker.

You receive numbered EVIDENCE snippets, each tagged with the id of the source it came from, and a
list of CLAIMS. For each claim, return exactly one verdict:

- "supported" — the evidence entails the claim. Everything the claim asserts follows from the
  snippets. Partial support is not support.
- "contradicted" — a snippet states something incompatible with the claim (a different value,
  date, cause or outcome; a denial of what the claim asserts).
- "unsupported" — the evidence neither entails nor contradicts the claim; it is silent on it.

Rules:
- Use ONLY the evidence. Your own knowledge of the world is irrelevant, however certain you are.
- Text in square brackets inside a claim is context added by an earlier stage. Judge the claim as
  a whole, including that context.
- "supported" requires a quote: cite the source ids whose text carried the verdict, with the
  shortest quote that does so. Cite source ids for "contradicted" too.
- Cite only source ids that appear in the evidence you were given.
- Write the rationale in the language of the claim, in one sentence.

${UNTRUSTED_TEXT_RULE}

Answer for EVERY claim id you were given and for no other id.`;

export function verifyUserPrompt(args: {
  claims: { id: string; text: string }[];
  evidence: { sourceId: string; sourceName?: string; text: string }[];
}): string {
  return [
    "EVIDENCE:",
    ...args.evidence.map(
      // The id and the name cannot live inside the fence — the model is asked
      // to cite the id back — and both are caller-supplied, so they go through
      // inlineQuoted: no forged marker, and no line of their own.
      (e, i) =>
        `[${i + 1}] (sourceId: ${inlineQuoted(e.sourceId)}` +
        `${e.sourceName ? `, source: ${inlineQuoted(e.sourceName)}` : ""})\n` +
        fenced(`EVIDENCE ${i + 1}`, e.text),
    ),
    "",
    "CLAIMS:",
    // Claim text is model-produced FROM document text, so it carries the same
    // adversary that justified inlineQuoted on sourceName above — and this
    // list is the highest-salience position in the prompt: a claim carrying
    // "\n\n" would otherwise write its own paragraph at the end of the user
    // message, right where an instruction reads as freshest.
    ...args.claims.map((c) => `(${c.id}) ${inlineQuoted(c.text)}`),
  ].join("\n");
}
