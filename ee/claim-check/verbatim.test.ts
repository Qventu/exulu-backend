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
    const sources = [{ id: "lang", content: `${"x".repeat(MAX_CHARS_PER_SOURCE)} ${SENTENCE}` }];
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
    expect(findVerbatimSource(atFloor, buildVerbatimIndex([{ id: "s1", content: `x ${atFloor} y` }]))).toBe("s1");
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
