// ee/claim-check/verbatim.ts
//
// The verbatim short-circuit: the one case where a verdict needs no model call.
//
// RAG answers quote their sources heavily. When a sentence of the answer
// appears LITERALLY in one of the supplied sources, every claim the extraction
// stages decomposed from that sentence is already entailed by that source —
// the stages' own contract is that a claim is entailed by its target sentence
// — so asking a model to confirm it buys nothing but latency and spend.
// Verification is the biggest consumer of calls in a check (10 of ~19 on a
// 30-sentence answer), so this is where the saving is.
//
// Every rule below is chosen so that a false positive is impossible for the
// reasons a cheaper rule would make it possible:
//
//  - CONTIGUOUS SUBSTRING, never token-set overlap. "der Schalter löst die
//    Abschaltung aus" and "die Abschaltung löst den Schalter aus" have the
//    same tokens and opposite meanings, and a maintenance knowledge base is
//    full of exactly that shape. Contiguity preserves word order, which is
//    what preserves meaning. It also makes negations and numbers PROTECTIVE
//    rather than dangerous: a sentence carrying "nicht" or "240" that the
//    source does not carry simply fails the test and goes to the model.
//  - A WHOLE SENTENCE of the source, not merely a substring of it (R47).
//    Contiguity alone was defended by the claim that `splitIntoSentences`
//    keeps terminal punctuation, so a sentence could only match where the
//    source also ended a sentence. It does not: split.ts emits every markdown
//    list item as its own sentence with the marker stripped, and notes in its
//    own comment that list items "rarely end in a period". A German
//    maintenance answer is bullet-heavy, so the usual needle has NO
//    terminator — and matched the opening clause of a longer source sentence
//    that went on to condition or withdraw it:
//
//      bullet: "Der Aufzug darf nach der Wartung wieder in Betrieb genommen
//               werden"
//      source: "Der Aufzug darf nach der Wartung wieder in Betrieb genommen
//               werden, wenn der TÜV zugestimmt hat."
//
//    A safety condition silently dropped and reported `supported` with no
//    model call. The same shape covers a source that quotes a sentence in
//    order to refute it ("Viele Monteure glauben, X. Das trifft nicht zu."),
//    one that presents it as superseded ("Früher galt: X. … nicht mehr der
//    Fall."), and a colon-terminated lead-in ("Falsch: X."). Requiring the
//    match to BE a sentence of the source is exactly what the entailment
//    argument licenses and nothing more, and it costs nothing in the common
//    case, because a genuinely quoted sentence is a whole source sentence.
//  - The SENTENCE, not the claim. Claims are decontextualised rewrites with
//    bracketed inserts, so they almost never match verbatim; whole sentences
//    are quoted constantly. Specifically the sentence text DECOMPOSITION was
//    given — the clarified or selection-rewritten text when there was one —
//    because that, and not the original wording, is the text the stage's
//    entailment contract is about. See canShortCircuitClaim.
//  - The source's own CONTENT, not the sliced passages. `indexSources` cuts
//    1,200-char passages with 200-char overlap, so a sentence straddling a
//    slice boundary would miss even though it is plainly in the document.
//  - CONSERVATIVE normalisation: whitespace runs collapse, case folds.
//    Punctuation is NOT stripped — a punctuation difference is a legitimate
//    reason to fall through to the model.
//  - A LENGTH FLOOR. A short sentence ("Ja.", "Siehe oben.") can appear inside
//    any document by chance, so short sentences always go to the model.
//
// COST: the scan is synchronous and scales as sentences x source content — up
// to 120 sentences against 200 sources of 60,000 characters at the payload cap.
// Measured at that cap: 79 ms to build the index, then 260 ms to scan it for
// 120 sentences that are not in it (the worst realistic case, since a miss
// reads every source end to end). That blocks the event loop the process also
// owes to chat streaming for every other user, it is not free, and the docs
// invite operators to raise `caps.maxSentences` past 120 — which scales it
// linearly. The pathological case is bounded separately; see
// MAX_SENTENCE_CANDIDATES.
import { MAX_CHARS_PER_SOURCE } from "./evidence";
import type { ClaimCheckSource } from "./types";

/**
 * Minimum length of the NORMALISED sentence for the short-circuit to apply.
 * Below this, containment is as likely to be a coincidence as a quotation.
 */
export const VERBATIM_MIN_CHARS = 40;

/**
 * The rationale a short-circuited claim carries. It must never read like a
 * model's judgement: the response reports a string match as a string match,
 * and `Claim.matchedVerbatim` carries the same fact as a machine-readable flag.
 */
export const VERBATIM_RATIONALE =
  "The sentence this claim was extracted from appears verbatim as a sentence of this source, which " +
  "therefore entails the claim; matched by exact text comparison, not judged by a model.";

/**
 * Collapse whitespace runs to a single space and case-fold. JavaScript's `\s`
 * covers the Unicode separators a PDF extractor emits (NBSP, U+2028/U+2029,
 * the U+2000 block), which is exactly what must not defeat a match.
 */
export function normaliseForContainment(text: string): string {
  return text.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** One normalised haystack per source, built once per check. */
export type VerbatimIndex = { sourceId: string; normalised: string }[];

/**
 * Normalise each source's content for containment testing.
 *
 * The content is truncated at the same per-source limit the passage index
 * uses, so the two never disagree about what was read: a sentence found only
 * past the limit is not reported as supported by evidence the check never
 * searched. A sentence straddling the cut simply misses and goes to the model.
 */
export function buildVerbatimIndex(
  sources: ClaimCheckSource[],
  maxCharsPerSource = MAX_CHARS_PER_SOURCE,
): VerbatimIndex {
  const index: VerbatimIndex = [];
  for (const source of sources) {
    const normalised = normaliseForContainment((source.content ?? "").slice(0, maxCharsPerSource));
    if (!normalised) continue;
    index.push({ sourceId: source.id, normalised });
  }
  return index;
}

/**
 * What ends a sentence in a source document. Deliberately only these three.
 *
 * `…` is excluded on purpose: an ellipsis announces that the sentence
 * continues, which is the one direction this test must never be generous in.
 * `;` and `:` are excluded because they join clauses rather than ending a
 * claim — and `:` in particular is how a source introduces a sentence it is
 * about to deny ("Früher galt: …", "Falsch: …").
 */
const SENTENCE_TERMINATORS = ".!?";

const isTerminator = (ch: string | undefined): boolean => ch !== undefined && SENTENCE_TERMINATORS.includes(ch);

/**
 * How many occurrences of one sentence to examine inside one source before
 * giving up on it.
 *
 * Plain `includes` stopped at the FIRST occurrence; the boundary test has to
 * keep looking, because a source can quote a sentence mid-clause and then
 * assert it properly. Measured at the payload cap, a source whose text repeats
 * the sentence 612 times and never at a sentence boundary turned a 0.26 s scan
 * into 1.6 s of synchronous event-loop blocking — the same league as the
 * per-claim evidence-selection bug that PassageIndex exists to fix, in a
 * process that also owes chat streaming to every other user. A real document
 * states a given sentence once or twice; 32 is far past anything legitimate.
 *
 * Giving up errs toward a model call — the safe direction — so the cap can
 * never turn a non-match into a match.
 */
const MAX_SENTENCE_CANDIDATES = 32;

/**
 * Does `haystack` contain `needle` as a WHOLE SENTENCE of its own (R47)?
 *
 * Both strings are already normalised, so every whitespace run is a single
 * space. Every occurrence is tested, not just the first — a source may quote a
 * sentence mid-clause once and assert it properly later — up to
 * MAX_SENTENCE_CANDIDATES of them.
 */
function containsWholeSentence(haystack: string, needle: string): boolean {
  const needleIsTerminated = isTerminator(needle[needle.length - 1]);

  for (let from = 0, examined = 0; examined < MAX_SENTENCE_CANDIDATES; examined += 1) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) return false;
    from = start + 1;

    // Left: the start of the source, or straight after a terminator and the
    // single space normalisation left behind. Anything else — a comma, a
    // colon, a list marker, the tail of a heading — means the source was
    // saying something before this, and what it was saying is not in evidence.
    if (start !== 0 && !(haystack[start - 1] === " " && isTerminator(haystack[start - 2]))) continue;

    // Right: the end of the source; or the source's own terminator sits right
    // here (the bullet case — the answer dropped the period the source has);
    // or the needle brought its terminator and the source's sentence ends with
    // it. A needle ending in "." followed immediately by a non-space is NOT a
    // sentence end — that "." was a decimal point or an abbreviation.
    const end = start + needle.length;
    if (
      end === haystack.length ||
      isTerminator(haystack[end]) ||
      (needleIsTerminated && haystack[end] === " ")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The id of the first source (in the order the caller supplied them) that
 * carries this sentence as a whole sentence of its own, or undefined when none
 * does — which is also the answer for every sentence under the length floor.
 */
export function findVerbatimSource(sentenceText: string, index: VerbatimIndex): string | undefined {
  const needle = normaliseForContainment(sentenceText);
  if (needle.length < VERBATIM_MIN_CHARS) return undefined;
  for (const { sourceId, normalised } of index) {
    // Cheap guard before the search: a haystack shorter than the needle can
    // never contain it, and a 200-source payload is scanned once per sentence.
    if (normalised.length < needle.length) continue;
    if (containsWholeSentence(normalised, needle)) return sourceId;
  }
  return undefined;
}

/**
 * Whether a claim may be short-circuited AT ALL, given that the text it was
 * decomposed from was found verbatim in a source.
 *
 * Containment proves "this source contains the text these claims came from".
 * That is not the same as "this source entails this claim", for a claim that
 * deliberately asserts more than that text does:
 *
 *  - Decomposition is instructed to put context the sentence itself does not
 *    state, but the question or the surrounding answer supplies, in square
 *    brackets, and to report `inferred: true` for any claim that leans on it.
 *    "Die [FST-3XT] arbeitet mit 230 Volt." decomposed from "Sie arbeitet mit
 *    230 Volt." is entailed by that sentence PLUS a subject taken from
 *    elsewhere in the answer — and the subject is precisely the part a
 *    hallucinating answer gets wrong, and the part the matched source never
 *    saw. An inferred claim therefore always goes to the model.
 *  - `inferred` is model-reported, so the bracket convention is checked
 *    directly as well: a claim carrying a bracketed insert is treated as
 *    inferred whatever flag arrived with it. A false positive here costs one
 *    model call; a false negative costs a claim reported `supported` by a
 *    source that does not support it.
 */
export function canShortCircuitClaim(claim: { inferred: boolean; text: string }): boolean {
  return !claim.inferred && !claim.text.includes("[");
}
