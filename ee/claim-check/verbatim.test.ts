// ee/claim-check/verbatim.test.ts
//
// The safety cases matter more than the happy path here: this module is the
// one place in the engine that reports a claim "supported" without a model
// having read anything, so every test below is written to FAIL if containment
// is ever loosened — to token-set overlap, to a partial-overlap score, to a
// lower length floor, or to punctuation stripping.
import {
  buildVerbatimIndex,
  canShortCircuitClaim,
  findVerbatimSource,
  normaliseForContainment,
  VERBATIM_MIN_CHARS,
} from "./verbatim";
import { MAX_CHARS_PER_SOURCE } from "./evidence";

/** A 54-character German sentence, comfortably over the 40-char floor. */
const SENTENCE = "Der Hauptschalter unterbricht die Spannungsversorgung.";
const HANDBOOK =
  "Kapitel 3: Sicherheit. Der Hauptschalter unterbricht die Spannungsversorgung. " +
  "Danach ist die Anlage spannungsfrei.";
const index = () => buildVerbatimIndex([{ id: "handbuch", content: HANDBOOK }]);

describe("normaliseForContainment", () => {
  it("collapses every kind of whitespace run and case-folds", () => {
    expect(normaliseForContainment("  Der  Haupt\nschalter ist\tAUS.  ")).toBe(
      "der haupt schalter ist aus.",
    );
  });

  it("leaves punctuation in place", () => {
    expect(normaliseForContainment("230 Volt, laut Handbuch.")).toBe("230 volt, laut handbuch.");
  });
});

describe("buildVerbatimIndex", () => {
  it("skips sources with nothing but whitespace, matching what the passage index skips", () => {
    expect(buildVerbatimIndex([{ id: "blank", content: "  \n\t " }])).toEqual([]);
    expect(buildVerbatimIndex([{ id: "a", content: "Text." }])).toEqual([{ sourceId: "a", normalised: "text." }]);
  });

  it("reads only the first MAX_CHARS_PER_SOURCE characters, as the passage index does", () => {
    const sources = [{ id: "lang", content: `${"x".repeat(MAX_CHARS_PER_SOURCE)}. ${SENTENCE}` }];
    // The sentence lives past the per-source limit, so it was never searched
    // and must not be reported as supported by evidence nobody read.
    expect(findVerbatimSource(SENTENCE, buildVerbatimIndex(sources))).toBeUndefined();
    expect(findVerbatimSource(SENTENCE, buildVerbatimIndex(sources, MAX_CHARS_PER_SOURCE + 200))).toBe("lang");
  });
});

describe("findVerbatimSource", () => {
  it("finds a sentence quoted literally in a source", () => {
    expect(findVerbatimSource(SENTENCE, index())).toBe("handbuch");
  });

  it("still matches across whitespace-run and case differences", () => {
    expect(findVerbatimSource("DER   HAUPTSCHALTER\n\nunterbricht die\tSpannungsversorgung.", index())).toBe(
      "handbuch",
    );
  });

  it("returns undefined when no source carries the sentence", () => {
    expect(findVerbatimSource("Der Hauptschalter sitzt hinter der Revisionsklappe.", index())).toBeUndefined();
  });

  // THE justification for requiring a contiguous substring. These two
  // sentences have the identical token set and opposite meanings, and a
  // maintenance knowledge base is full of exactly that shape. A token-set or
  // bag-of-words rule reports this one supported.
  it("does NOT match a reversed word order with the identical token set", () => {
    const reversed = "Die Spannungsversorgung unterbricht der Hauptschalter.";
    expect(new Set(reversed.toLowerCase().match(/\p{L}+/gu))).toEqual(
      new Set(SENTENCE.toLowerCase().match(/\p{L}+/gu)),
    );
    expect(findVerbatimSource(reversed, index())).toBeUndefined();
  });

  // Contiguity makes a negation protective rather than dangerous: the source
  // does not carry "nicht", so the sentence is simply not in it.
  it("does NOT match a negated variant of a sentence the source does carry", () => {
    const source = buildVerbatimIndex([
      { id: "s1", content: "Die Steuerung FST-2XT arbeitet mit 230 Volt im Schaltschrank." },
    ]);
    expect(findVerbatimSource("Die Steuerung FST-2XT arbeitet mit 230 Volt.", source)).toBeUndefined();
    expect(findVerbatimSource("Die Steuerung FST-2XT arbeitet nicht mit 230 Volt.", source)).toBeUndefined();
  });

  // Same for a changed number: one digit is enough to break containment.
  it("does NOT match a numeric variant", () => {
    const source = buildVerbatimIndex([
      { id: "s1", content: "Die Steuerung FST-2XT arbeitet mit 230 Volt im Schaltschrank." },
    ]);
    expect(findVerbatimSource("Die Steuerung FST-2XT arbeitet mit 240 Volt im Schaltschrank.", source)).toBeUndefined();
    expect(findVerbatimSource("Die Steuerung FST-2XT arbeitet mit 230 Volt im Schaltschrank.", source)).toBe("s1");
  });

  // A short sentence can appear inside any document by coincidence, so the
  // floor sends it to the model even when containment holds.
  it("does NOT short-circuit a sentence under the length floor that IS in a source", () => {
    const short = "Siehe Kapitel 3 der Anleitung.";
    expect(normaliseForContainment(short).length).toBeLessThan(VERBATIM_MIN_CHARS);
    const source = buildVerbatimIndex([{ id: "s1", content: `Hinweis: ${short} Danach weiter bei Schritt 4.` }]);
    // Containment itself holds — only the floor stops it.
    expect(source[0]!.normalised).toContain(normaliseForContainment(short));
    expect(findVerbatimSource(short, source)).toBeUndefined();
  });

  it("matches a sentence exactly at the length floor", () => {
    const atFloor = `${"a".repeat(VERBATIM_MIN_CHARS - 1)}.`;
    expect(normaliseForContainment(atFloor).length).toBe(VERBATIM_MIN_CHARS);
    expect(findVerbatimSource(atFloor, buildVerbatimIndex([{ id: "s1", content: `x. ${atFloor} y` }]))).toBe("s1");
  });
});

// R47. Containment alone is NOT entailment. The original rule was "a
// contiguous substring of the document", defended by the observation that
// `splitIntoSentences` keeps terminal punctuation, so a sentence could only
// match where the source also ended a sentence. That defence does not hold:
// split.ts emits every markdown list item as its own sentence with the marker
// stripped, and its own comment notes list items "rarely end in a period". A
// German maintenance answer is bullet-heavy, so the common case is a needle
// with NO terminator — which happily matches the opening clause of a longer
// source sentence that goes on to qualify, condition or withdraw it.
//
// So the rule is now "a WHOLE SENTENCE of the document": the match must begin
// at the start of the source or just after a sentence terminator and a space,
// and must end at the end of the source or at a terminator. That is exactly
// what the entailment argument licenses and nothing more, and it is still pure
// string comparison with no judgement in it.
describe("findVerbatimSource — whole-sentence boundaries (R47)", () => {
  const BULLET = "Der Aufzug darf nach der Wartung wieder in Betrieb genommen werden";
  const src = (content: string) => buildVerbatimIndex([{ id: "s1", content }]);

  it("is a fixture whose needle carries no terminator at all", () => {
    expect(BULLET).not.toMatch(/[.!?]$/);
    expect(normaliseForContainment(BULLET).length).toBeGreaterThanOrEqual(VERBATIM_MIN_CHARS);
  });

  it.each([
    [
      "an unterminated bullet that is only the opening clause of a source sentence",
      `${BULLET}, wenn der TÜV zugestimmt hat. Ohne diese Zustimmung bleibt der Aufzug stillgelegt.`,
    ],
    [
      "a prefix whose continuation withdraws it",
      `${BULLET}, sofern der TÜV zugestimmt hat; andernfalls bleibt er stillgelegt.`,
    ],
    [
      "a sentence the source quotes in order to refute it (hedged frame)",
      `Viele Monteure glauben, ${BULLET}. Das trifft nicht zu.`,
    ],
    [
      "a sentence the source presents as superseded (colon frame)",
      `Früher galt: ${BULLET}. Das ist seit 2019 nicht mehr der Fall.`,
    ],
    ["a colon-terminated lead-in", `Falsch: ${BULLET}. Richtig ist das Gegenteil.`],
  ])("does NOT match %s", (_label, content) => {
    // Plain containment holds in every one of these — only the sentence
    // boundaries refuse them.
    expect(src(content)[0]!.normalised).toContain(normaliseForContainment(BULLET));
    expect(findVerbatimSource(BULLET, src(content))).toBeUndefined();
  });

  it("does NOT match a parenthesised sentence that the source sentence continues past", () => {
    const needle = "Die Steuerung arbeitet mit 230 Volt (laut Handbuch)";
    const content = `${needle} und wurde 2019 durch ein Nachfolgemodell ersetzt.`;
    expect(src(content)[0]!.normalised).toContain(normaliseForContainment(needle));
    expect(findVerbatimSource(needle, src(content))).toBeUndefined();
  });

  // The shapes that MUST still match, or the rule has eaten the feature. The
  // dominant real shape is exactly the first one: the answer bullets a
  // sentence the source writes as terminated prose.
  it.each([
    ["the source sentence is the bullet plus its own terminator", `Hinweis zur Abnahme. ${BULLET}. Danach folgt Kapitel 4.`],
    ["the bullet is the source's first sentence", `${BULLET}. Danach folgt Kapitel 4.`],
    ["the bullet is the source's last sentence", `Hinweis zur Abnahme. ${BULLET}.`],
    ["the bullet is the entire source", BULLET],
    ["the source ends the sentence with an exclamation mark", `Achtung. ${BULLET}! Danach folgt Kapitel 4.`],
  ])("DOES still match when %s", (_label, content) => {
    expect(findVerbatimSource(BULLET, src(content))).toBe("s1");
  });

  it("checks every occurrence, not only the first", () => {
    // First occurrence is mid-sentence, second is a sentence of its own.
    const content = `Viele glauben, ${BULLET}, was falsch ist. ${BULLET}.`;
    expect(findVerbatimSource(BULLET, src(content))).toBe("s1");
  });

  // Plain `includes` stopped at the first occurrence; the boundary test has to
  // keep looking, which a source repeating the sentence can turn into a long
  // synchronous scan (measured: 0.26 s -> 1.6 s at the payload cap). The
  // candidate cap bounds it, and gives up toward a MODEL CALL, never toward a
  // match — so the limitation this test pins is the safe kind.
  it("gives up on a source that buries a real match behind a wall of non-boundary repeats", () => {
    const decoy = `${BULLET}, wenn der TÜV zugestimmt hat. `;
    expect(findVerbatimSource(BULLET, src(`${decoy.repeat(8)}${BULLET}.`))).toBe("s1");
    expect(findVerbatimSource(BULLET, src(`${decoy.repeat(200)}${BULLET}.`))).toBeUndefined();
  });

  // A terminated needle keeps working the way it always did, and still cannot
  // match as the opening half of a longer source sentence.
  it("keeps a terminated needle's boundaries too", () => {
    const terminated = `${BULLET}.`;
    expect(findVerbatimSource(terminated, src(`Hinweis zur Abnahme. ${terminated} Danach folgt mehr.`))).toBe("s1");
    expect(findVerbatimSource(terminated, src(`Viele glauben, ${terminated} Das ist falsch.`))).toBeUndefined();
  });
});

describe("canShortCircuitClaim", () => {
  it("accepts a claim decomposition reported as not inferred", () => {
    expect(canShortCircuitClaim({ inferred: false, text: "Der Hauptschalter unterbricht die Spannung." })).toBe(true);
  });

  // An inferred claim asserts MORE than the text it was decomposed from: the
  // bracketed context comes from the question or from elsewhere in the answer,
  // which is exactly the part a hallucinating answer gets wrong and the part
  // the matched source never saw.
  it("refuses an inferred claim", () => {
    expect(canShortCircuitClaim({ inferred: true, text: "Die [FST-3XT] arbeitet mit 230 Volt." })).toBe(false);
  });

  // `inferred` is model-reported, so the bracket convention is checked too.
  it("refuses a claim carrying a bracketed insert even when inferred came back false", () => {
    expect(canShortCircuitClaim({ inferred: false, text: "Die [FST-3XT] arbeitet mit 230 Volt." })).toBe(false);
  });
});
