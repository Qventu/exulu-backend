import { scoreClaims, buildSentenceResults } from "./score";
import type { Claim, Sentence, SentenceState } from "./types";

const THRESHOLDS = { warn: 0.1, alert: 0.3 };

const claim = (id: string, verdict: Claim["verdict"], sentenceIndex = 0): Claim => ({
  id,
  sentenceIndex,
  text: `claim ${id}`,
  inferred: false,
  verdict,
  evidence: [],
  rationale: "",
  rechecked: false,
});

describe("scoreClaims", () => {
  it("counts the three verdicts separately and derives the combined share", () => {
    const score = scoreClaims(
      [
        claim("c1", "supported"),
        claim("c2", "supported"),
        claim("c3", "contradicted"),
        claim("c4", "unsupported"),
      ],
      THRESHOLDS,
    );
    expect(score).toEqual({
      claims: 4,
      supported: 2,
      contradicted: 1,
      unsupported: 1,
      unsupportedShare: 0.5,
      label: "alert",
    });
  });

  it("labels on inclusive lower bounds: below warn is ok, warn is warn, alert is alert", () => {
    const supported = (n: number) => Array.from({ length: n }, (_, i) => claim(`s${i}`, "supported"));
    // 0/10 => 0 => ok
    expect(scoreClaims(supported(10), THRESHOLDS).label).toBe("ok");
    // 1/10 => 0.1 => exactly warn
    expect(scoreClaims([...supported(9), claim("x", "unsupported")], THRESHOLDS).label).toBe("warn");
    // 2/10 => 0.2 => still warn
    expect(
      scoreClaims([...supported(8), claim("x", "unsupported"), claim("y", "unsupported")], THRESHOLDS).label,
    ).toBe("warn");
    // 3/10 => 0.3 => exactly alert
    expect(
      scoreClaims(
        [...supported(7), claim("x", "unsupported"), claim("y", "unsupported"), claim("z", "contradicted")],
        THRESHOLDS,
      ).label,
    ).toBe("alert");
  });

  // Review Focus 4
  it("returns label n/a and share 0 when there are no checkable claims — never 0 as a verdict", () => {
    const score = scoreClaims([], THRESHOLDS);
    expect(score).toEqual({
      claims: 0,
      supported: 0,
      contradicted: 0,
      unsupported: 0,
      unsupportedShare: 0,
      label: "n/a",
    });
    expect(Number.isNaN(score.unsupportedShare)).toBe(false);
  });

  it("rounds the share to four decimals rather than emitting a repeating float", () => {
    const score = scoreClaims([claim("a", "supported"), claim("b", "supported"), claim("c", "unsupported")], THRESHOLDS);
    expect(score.unsupportedShare).toBe(0.3333);
  });

  it("respects custom thresholds", () => {
    const strict = scoreClaims([claim("a", "supported"), claim("b", "unsupported")], { warn: 0.6, alert: 0.9 });
    expect(strict.unsupportedShare).toBe(0.5);
    expect(strict.label).toBe("ok");
  });
});

describe("buildSentenceResults", () => {
  const sentences: Sentence[] = [
    { index: 0, start: 0, end: 10, text: "Satz eins.", headingPath: [] },
    { index: 1, start: 11, end: 21, text: "Satz zwei.", headingPath: [] },
    { index: 2, start: 22, end: 32, text: "Satz drei.", headingPath: [] },
  ];

  it("carries offsets, state, reason and the claim ids of each sentence", () => {
    const states = new Map<number, { state: SentenceState; reason?: string }>([
      [0, { state: "checked" }],
      [1, { state: "no_verifiable_content", reason: "opinion" }],
      [2, { state: "cannot_disambiguate", reason: "'dort' unresolvable" }],
    ]);
    const results = buildSentenceResults(sentences, states, [claim("c1", "supported", 0), claim("c2", "unsupported", 0)]);

    expect(results[0]).toEqual({ index: 0, start: 0, end: 10, state: "checked", claimIds: ["c1", "c2"] });
    expect(results[1]).toEqual({ index: 1, start: 11, end: 21, state: "no_verifiable_content", reason: "opinion", claimIds: [] });
    expect(results[2]!.state).toBe("cannot_disambiguate");
  });

  it("defaults a sentence with no recorded state to not_checked", () => {
    const results = buildSentenceResults(sentences, new Map(), []);
    expect(results.every((r) => r.state === "not_checked")).toBe(true);
    expect(results[0]!.reason).toBe("stage did not report an outcome for this sentence");
  });
});
