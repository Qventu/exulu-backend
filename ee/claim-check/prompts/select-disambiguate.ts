// The fast path merges the paper's Selection (§3.2) and Disambiguation (§3.3)
// stages into one call, the way the retrieval pipeline's engine v2 merges its
// memory and routing hops. Same rules, one hop.
import { SELECT_SYSTEM } from "./select";
import { DISAMBIGUATE_RULES } from "./disambiguate";

export const SELECT_DISAMBIGUATE_SYSTEM = `${SELECT_SYSTEM}

AFTER deciding verifiability, perform a second judgement on the same sentence.

${DISAMBIGUATE_RULES}

Return both judgements per sentence in one object: verifiable, rewritten, resolvable, clarified,
reason. If a sentence is not verifiable, the ambiguity judgement is irrelevant — return
resolvable=false and clarified=null for it.`;

export { selectUserPrompt as selectDisambiguateUserPrompt } from "./select";
