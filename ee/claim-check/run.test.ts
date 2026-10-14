jest.mock("./stages/select-disambiguate", () => ({ runSelectAndDisambiguate: jest.fn() }));
jest.mock("./stages/select", () => ({ runSelection: jest.fn(), excerptFor: jest.fn(() => "excerpt") }));
jest.mock("./stages/disambiguate", () => ({ runDisambiguation: jest.fn() }));
jest.mock("./stages/decompose", () => ({ runDecomposition: jest.fn() }));
jest.mock("./stages/verify", () => ({ runVerification: jest.fn() }));

import { runSelectAndDisambiguate } from "./stages/select-disambiguate";
import { runSelection } from "./stages/select";
import { runDisambiguation } from "./stages/disambiguate";
import { runDecomposition } from "./stages/decompose";
import { runVerification } from "./stages/verify";
import { BISECT_FLOOR, MAX_EVIDENCE_PER_CALL, runClaimCheck, selectGroupEvidence } from "./run";
import { indexSources, selectEvidence } from "./evidence";
import { VERBATIM_RATIONALE } from "./verbatim";
import { CLAIM_CHECK_DEFAULTS, type ClaimCheckOptions } from "./types";

const USAGE = { calls: 1, inputTokens: 100, outputTokens: 10 };
const options = (over: Partial<ClaimCheckOptions> = {}): ClaimCheckOptions => ({
  ...CLAIM_CHECK_DEFAULTS,
  ...over,
  thresholds: { ...CLAIM_CHECK_DEFAULTS.thresholds, ...(over.thresholds ?? {}) },
  caps: { ...CLAIM_CHECK_DEFAULTS.caps, ...(over.caps ?? {}) },
});

const SOURCES = [{ id: "s1", content: "Die FST-2XT arbeitet mit 230 Volt im Schaltschrank." }];
const ANSWER = "Die FST-2XT arbeitet mit 230 Volt. Das ist beeindruckend. Sie sitzt im Schaltschrank.";

/** All three sentences verifiable and resolvable. */
const allClear = (indexes: number[]) => ({
  selection: indexes.map((index) => ({ index, verifiable: true, rewritten: null, reason: "fact", answered: true })),
  disambiguation: indexes.map((index) => ({ index, resolvable: true, clarified: null, reason: "clear", answered: true })),
  usage: USAGE,
});

beforeEach(() => {
  [runSelectAndDisambiguate, runSelection, runDisambiguation, runDecomposition, runVerification].forEach((m) =>
    (m as jest.Mock).mockReset(),
  );
});

describe("runClaimCheck — fast path", () => {
  it("uses the merged call, then decomposition, then verification, and assembles a scored result", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim for ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any, i: number) => ({
        claimId: c.id,
        verdict: i === 0 ? "supported" : "unsupported",
        evidence: [],
        rationale: "r",
      })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "Womit arbeitet die FST-2XT?",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options(),
      locale: "de",
    });

    expect(runSelection).not.toHaveBeenCalled();
    expect(runDisambiguation).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.claims).toHaveLength(3);
    expect(result.claims.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(result.score.claims).toBe(3);
    expect(result.sentences.every((s) => s.state === "checked")).toBe(true);
    expect(result.usage.calls).toBeGreaterThanOrEqual(3);
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("records dropped sentences with their reason and keeps them out of the score", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({
        index: w.sentence.index,
        verifiable: w.sentence.index !== 1,
        rewritten: null,
        reason: w.sentence.index === 1 ? "opinion" : "fact",
      })),
      disambiguation: windows.map((w: any) => ({
        index: w.sentence.index,
        resolvable: w.sentence.index === 0,
        clarified: null,
        reason: w.sentence.index === 2 ? "'Sie' unresolvable" : "clear",
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.sentences.map((s) => s.state)).toEqual(["checked", "no_verifiable_content", "cannot_disambiguate"]);
    expect(result.sentences[1]!.reason).toBe("opinion");
    expect(result.score.claims).toBe(1);
    // Decomposition only ever saw the surviving sentence.
    expect((runDecomposition as jest.Mock).mock.calls[0][0].windows).toHaveLength(1);
  });

  // Review Focus 4
  it("returns label n/a with no claims when every sentence is dropped, and never calls verification", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({ index: w.sentence.index, verifiable: false, rewritten: null, reason: "pleasantry" })),
      disambiguation: windows.map((w: any) => ({ index: w.sentence.index, resolvable: false, clarified: null, reason: "pleasantry" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: "Gern! Immer wieder.", sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(runDecomposition).not.toHaveBeenCalled();
    expect(runVerification).not.toHaveBeenCalled();
    expect(result.claims).toEqual([]);
    expect(result.score.label).toBe("n/a");
    expect(result.status).toBe("ok");
  });
});

// Finding 3 (spec §2.4 rule 3): sources: [] (or whitespace-only content) used
// to produce label "alert", unsupportedShare 1.0, status "ok" and no notes —
// a 100% hallucination verdict produced without reading a byte.
describe("runClaimCheck — no usable evidence", () => {
  const allClaims = () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    // What the real verify stage does with an empty evidence array.
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({
        claimId: c.id,
        verdict: "unsupported",
        evidence: [],
        rationale: "no evidence was available for this claim",
      })),
      usage: USAGE,
    }));
  };

  it("reports n/a and partial instead of a 100% unsupported share when no source has any content", async () => {
    allClaims();
    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: [], model: {} as any, options: options(), locale: "de",
    });

    expect(result.score.label).toBe("n/a");
    expect(result.score.claims).toBe(0);
    expect(result.score.unsupportedShare).toBe(0);
    expect(result.status).toBe("partial");
    // The claims themselves are kept, with their verdicts and rationales.
    expect(result.claims).toHaveLength(3);
    expect(result.claims.every((c) => c.verdict === "unsupported")).toBe(true);
    expect(result.claims[0]!.rationale).toBe("no evidence was available for this claim");
    expect(result.notes.some((n) => n.includes("no usable evidence was supplied"))).toBe(true);
  });

  it("treats whitespace-only source content as no evidence at all", async () => {
    allClaims();
    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: [{ id: "blank", content: "   \n\t " }],
      model: {} as any,
      options: options(),
      locale: "de",
    });

    expect(result.score.label).toBe("n/a");
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("no usable evidence was supplied"))).toBe(true);
  });

  it("still scores the claims a second-chance retrieval did supply evidence for", async () => {
    allClaims();
    let verifyCall = 0;
    (runVerification as jest.Mock).mockImplementation(async ({ claims, evidence }) => {
      verifyCall += 1;
      return {
        outcomes: claims.map((c: any) => ({
          claimId: c.id,
          verdict: evidence.length > 0 ? "supported" : "unsupported",
          evidence: [],
          rationale: verifyCall === 1 ? "no evidence was available for this claim" : "found later",
        })),
        usage: USAGE,
      };
    });
    const secondChance = jest
      .fn()
      .mockResolvedValue([{ sourceId: "deep", text: "Die FST-2XT arbeitet mit 230 Volt.", score: 2 }]);

    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: [],
      model: {} as any,
      options: options({ caps: { maxReRetrievals: 3 } }),
      locale: "de",
      secondChance,
    });

    // All three claims were re-retrieved and judged against real passages, so
    // the score is honest again and nothing is excluded.
    expect(result.claims.every((c) => c.rechecked)).toBe(true);
    expect(result.score.claims).toBe(3);
    expect(result.score.label).toBe("ok");
    expect(result.notes.some((n) => n.includes("no usable evidence was supplied"))).toBe(false);
  });
});

describe("runClaimCheck — resilience", () => {
  // Finding 3 (R19): "partial beats failing" is unconditional — an error
  // thrown anywhere in the pipeline (not just a provider call) must degrade
  // to a partial result rather than reject the caller's promise. An invalid
  // Intl.Segmenter locale throws synchronously inside the split stage, before
  // any stage mock is ever reached.
  //
  // Finding 14: the HTTP route now rejects an unusable locale with a 400
  // (routes.test.ts), so this is no longer reachable through the API. It stays
  // as the engine's own guarantee — runClaimCheck is called directly here, and
  // every internal caller (the benchmark runner, a future chat path) depends
  // on it degrading rather than throwing.
  it("degrades to a partial result instead of throwing when the pipeline itself throws", async () => {
    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options(),
      locale: "💥not-a-locale💥",
    });

    expect(result.status).toBe("partial");
    expect(result.claims).toEqual([]);
    expect(result.sentences).toEqual([]);
    expect(result.score.label).toBe("n/a");
    expect(result.notes.some((n) => n.includes("claim check failed internally"))).toBe(true);
    expect(runSelectAndDisambiguate).not.toHaveBeenCalled();
  });


  // Change B: BATCH.selectDisambiguate rose to 25, so a failed batch now
  // bisects RECURSIVELY down to BISECT_FLOOR rather than once —
  // 25 -> 13 + 12 -> 7 + 6 + 6 + 6 — and the sentences lost to a failure are
  // the smallest still-failing piece, not half the batch. The fixture is 25
  // sentences (one full batch) because the previous 3-sentence fixture is now
  // below the floor and is never split at all.
  it("bisects a failed batch recursively down to the floor and only loses the still-failing piece", async () => {
    const answer = Array.from({ length: 25 }, (_, i) => `Satz Nummer ${i + 1} ist eindeutig wahr.`).join(" ");
    const seen: number[][] = [];
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => {
      const indexes = windows.map((w: any) => w.sentence.index);
      seen.push(indexes);
      // Fails for its SIZE above the floor — the deterministic output-overflow
      // shape the recursion exists for — and at or below the floor only for
      // the one piece holding sentence 24.
      if (indexes.length > BISECT_FLOOR) throw new Error("batch too big for the provider today");
      if (indexes.includes(24)) throw new Error("still failing");
      return allClear(indexes);
    });
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // The whole batch, its halves, then THEIR halves — which are at or below
    // the floor and are never split again.
    expect(seen.map((b) => b.length)).toEqual([25, 13, 12, 7, 6, 6, 6]);
    // Everything outside the single piece that kept failing survived the
    // batch's collapse. A one-shot bisect loses all 25; no floor at all would
    // keep splitting and lose only [22, 23, 24].
    expect(result.sentences.filter((s) => s.state === "not_checked").map((s) => s.index)).toEqual([
      19, 20, 21, 22, 23, 24,
    ]);
    expect(result.sentences.filter((s) => s.state === "checked")).toHaveLength(19);
    expect(result.sentences[19]!.reason).toBe("selection+disambiguation failed after bisect");
    expect(result.status).toBe("partial");
    expect(result.notes.join(" ")).toContain("not_checked");
  });

  // With only one batch the breaker's failures>=2 floor can never trip, so a
  // lone failing batch always gets its bisect — and now gets it twice over,
  // because the breaker deliberately does not re-run on the retry rounds (an
  // output overflow is deterministic in batch size, so every sibling failing
  // is the signal to split further, not to give up). The call count is the
  // whole point of this test: it pins the recursion, the floor AND that
  // non-re-running breaker at once.
  it("recurses a lone failing batch to the floor without the breaker, for 1 + 2 + 4 calls", async () => {
    const answer = Array.from({ length: 25 }, (_, i) => `Satz Nummer ${i + 1} ist eindeutig wahr.`).join(" ");
    (runSelectAndDisambiguate as jest.Mock).mockRejectedValue(new Error("provider down"));

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // 7: a one-shot bisect would be 3, a breaker re-run at round 1 would be 3,
    // and splitting past the floor would be 15.
    expect((runSelectAndDisambiguate as jest.Mock).mock.calls.length).toBe(7);
    expect(result.status).toBe("partial");
    expect(result.claims).toEqual([]);
    expect(result.sentences.every((s) => s.state === "not_checked")).toBe(true);
    expect(result.sentences).toHaveLength(25);
    expect(result.notes.some((n) => n.includes("selection+disambiguation"))).toBe(true);
    expect(result.notes.some((n) => n.includes("aborted"))).toBe(false);
  });

  // Finding 2 (R18): a genuine multi-batch circuit-breaker fixture. 60
  // sentences batch into [25, 25, 10] for BATCH.selectDisambiguate = 25; the
  // mock fails only the two full-size (un-bisected) batches outright — any
  // bisected retry (always length < 25) would succeed — so disabling the
  // breaker changes the outcome: the aborted batches' sentences would recover
  // via their retries instead of staying not_checked, and the call count
  // would rise from 3 to 7. That is the sensitivity check this test relies on.
  it("trips the circuit breaker across multiple batches and never retries the aborted ones", async () => {
    const answer = Array.from({ length: 60 }, (_, i) => `Satz Nummer ${i + 1} ist eindeutig wahr.`).join(" ");
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => {
      const indexes = windows.map((w: any) => w.sentence.index);
      if (indexes.length === 25 && (indexes[0] === 0 || indexes[0] === 25)) {
        throw new Error("provider down for this batch");
      }
      return allClear(indexes);
    });
    (runDecomposition as jest.Mock).mockResolvedValue({ outcomes: [], usage: USAGE });

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // Only the 3 initial batch calls — the breaker fired before any bisect
    // retry was attempted for the two failing batches.
    expect((runSelectAndDisambiguate as jest.Mock).mock.calls.length).toBe(3);
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("selection+disambiguation") && n.includes("aborted"))).toBe(true);
    expect(result.sentences[0]!.state).toBe("not_checked");
    expect(result.sentences[30]!.state).toBe("not_checked");
  });

  // Review Focus 5
  it("caps sentences and claims, flags the result partial, and keeps claim ids contiguous", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [
          { text: `a${w.sentence.index}`, inferred: false },
          { text: `b${w.sentence.index}`, inferred: false },
        ],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options({ caps: { maxSentences: 2, maxClaims: 3, maxReRetrievals: 0 } }),
      locale: "de",
    });

    expect(result.status).toBe("partial");
    expect(result.limits.sentencesSkipped).toBe(1);
    expect(result.sentences.find((s) => s.index === 2)!.reason).toBe("cap_exceeded");
    expect(result.claims.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(result.notes.some((n) => n.includes("maxClaims"))).toBe(true);
  });

  // Review Focus 5
  it("drops a decomposition outcome whose sentence index was never in the batch", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [
        { index: 0, claims: [{ text: "echt", inferred: false }] },
        { index: 42, claims: [{ text: "erfunden", inferred: false }] },
      ],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.text).toBe("echt");
    expect(result.claims[0]!.sentenceIndex).toBe(0);
  });

  // Finding 4 (R20): a surviving sentence whose decomposed claims were ALL cut
  // by maxClaims must read as cap_exceeded, not no_verifiable_content — the
  // cap is a resource limit, not a judgement that the sentence had nothing
  // checkable in it.
  it("marks a sentence cap_exceeded, not no_verifiable_content, when the cap cuts all of its claims", async () => {
    const answer = "Erster Satz ist eindeutig. Zweiter Satz ist auch eindeutig.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [
          { text: `a${w.sentence.index}`, inferred: false },
          { text: `b${w.sentence.index}`, inferred: false },
        ],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer,
      sources: SOURCES,
      model: {} as any,
      // maxClaims = 2 exhausts entirely on sentence 0's two claims, so
      // sentence 1's two claims are cut before either one is pushed.
      options: options({ caps: { maxClaims: 2 } }),
      locale: "de",
    });

    expect(result.claims).toHaveLength(2);
    expect(result.sentences[0]!.state).toBe("checked");
    expect(result.sentences[1]!.state).toBe("not_checked");
    expect(result.sentences[1]!.reason).toBe("cap_exceeded");
    expect(result.status).toBe("partial");
  });

  // Correction 2: runDecomposition OMITS an entry entirely for a sentence the
  // model never answered, which must read as "the pipeline failed to process
  // this sentence" (not_checked), not as "no factual claim here"
  // (no_verifiable_content, which is reserved for a reported-but-empty claim list).
  it("tells apart an empty claim list from a decomposition outcome that was never reported", async () => {
    const answer = "Die Anlage läuft stabil. Das Blech ist blau.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    // Reports an (empty) outcome for sentence 0, says nothing at all about sentence 1.
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [] }],
      usage: USAGE,
    });

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.sentences[0]!.state).toBe("no_verifiable_content");
    expect(result.sentences[0]!.reason).toBe("decomposition extracted no claim");
    expect(result.sentences[1]!.state).toBe("not_checked");
    expect(result.sentences[1]!.reason).toBe("decomposition did not report an outcome");
    expect(result.status).toBe("partial");
    expect(runVerification).not.toHaveBeenCalled();
  });
});

// Finding 4: the model's silence is not a finding against the answer. Both
// places that used to turn an omitted outcome into a verdict about the text.
// Finding 5: per-source truncation has to be visible — the engine drops
// everything past 60,000 characters per source and never searches it.
// Finding 6: evidence selection is a per-claim job (spec §2.2). Pooling a
// group's claim texts into one query starved the weaker-scoring claims, and
// the failure mode is a false "unsupported".
describe("evidence selection per claim", () => {
  // Four passages carry two rare terms of claim A each (score 3.58); the one
  // passage that supports claim B carries three less-rare terms (3.30). The
  // pooled top-4 is therefore exactly the four A passages, and claim B goes
  // into verification with nothing that mentions it.
  const SELECTION_SOURCES = [
    { id: "a1", content: "Steuerung meldet." },
    { id: "a2", content: "Fernabschaltung Sicherung." },
    { id: "a3", content: "Defekt Schaltschrank." },
    { id: "a4", content: "Verschlossen Kabinenlicht." },
    { id: "b1", content: "Kabinentuer Dienstag getauscht." },
    { id: "d1", content: "Kabinentuer Dienstag getauscht Protokoll." },
  ];
  const CLAIM_A =
    "Die Steuerung meldet eine Fernabschaltung, die Sicherung ist defekt, der Schaltschrank ist verschlossen und das Kabinenlicht flackert.";
  const CLAIM_B = "Die Kabinentuer wurde am Dienstag getauscht.";

  it("is a fixture where pooling really does starve the second claim", () => {
    const pooled = selectEvidence([CLAIM_A, CLAIM_B], indexSources(SELECTION_SOURCES), 4);
    expect(pooled.map((p) => p.sourceId)).not.toContain("b1");
  });

  it("gives two claims with disjoint vocabularies each their own supporting passage", async () => {
    const answer = "Die Steuerung meldet eine Fernabschaltung. Die Kabinentuer wurde getauscht.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: w.sentence.index === 0 ? CLAIM_A : CLAIM_B, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    await runClaimCheck({
      question: "q",
      answer,
      sources: SELECTION_SOURCES,
      model: {} as any,
      options: options(),
      locale: "de",
    });

    // Both claims are in ONE verification group (BATCH.verifySentences = 8).
    expect((runVerification as jest.Mock).mock.calls).toHaveLength(1);
    const evidence = (runVerification as jest.Mock).mock.calls[0][0].evidence as { sourceId: string }[];
    const ids = evidence.map((e) => e.sourceId);
    expect(ids).toContain("b1");
    expect(ids.some((id) => id.startsWith("a"))).toBe(true);
  });

  it("deduplicates the union by passage identity and caps it per call", () => {
    const sources = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      content: `Begriff${i} Begriff${i} dokumentiert.`,
    }));
    const index = indexSources(sources);
    const claims = Array.from({ length: 20 }, (_, i) => `Begriff${i} ist dokumentiert.`);

    const union = selectGroupEvidence(claims, index);
    expect(union).toHaveLength(MAX_EVIDENCE_PER_CALL);
    // Rank-first filling: every one of the first twelve claims contributed its
    // OWN best passage, instead of the first four claims taking three each.
    expect(new Set(union.map((e) => e.sourceId)).size).toBe(MAX_EVIDENCE_PER_CALL);
    for (let i = 0; i < MAX_EVIDENCE_PER_CALL; i += 1) {
      expect(union.map((e) => e.sourceId)).toContain(`s${i}`);
    }
  });

  it("returns nothing when there are no passages at all", () => {
    expect(selectGroupEvidence(["irgendein Claim"], indexSources([]))).toEqual([]);
  });
});

// Finding 7: the HTTP handler's 60 s deadline has to reach the provider calls.
describe("runClaimCheck — abort signal", () => {
  it("forwards the caller's signal to every stage", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));
    const controller = new AbortController();

    await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options(),
      locale: "de",
      signal: controller.signal,
    });

    expect((runSelectAndDisambiguate as jest.Mock).mock.calls[0][0].signal).toBe(controller.signal);
    expect((runDecomposition as jest.Mock).mock.calls[0][0].signal).toBe(controller.signal);
    expect((runVerification as jest.Mock).mock.calls[0][0].signal).toBe(controller.signal);
  });
});

describe("runClaimCheck — source truncation", () => {
  it("flags limits.truncated and notes the dropped characters when a source is cut", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    // Every sentence gets an outcome, so truncation is the ONLY thing that can
    // make these two results `partial`: a decomposition reporting on one of
    // three sentences degrades the result by itself, and would have let the
    // status assertions below pass under the very bug they pin.
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `c${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: [{ id: "handbuch", content: `Die FST-2XT arbeitet mit 230 Volt. ${"x".repeat(60_000)}` }],
      model: {} as any,
      options: options(),
      locale: "de",
    });

    expect(result.limits.truncated).toBe(true);
    expect(result.limits.sentencesSkipped).toBe(0);
    expect(result.notes.some((n) => n.includes("truncated at 60000 characters"))).toBe(true);
    expect(result.notes.some((n) => n.includes("35 character(s) of evidence were not searched"))).toBe(true);
    // R35: part of the evidence went unread, so the share of unsupported
    // claims is not a number this check measured. Every other
    // partly-measured outcome reports `partial`, including the zero-evidence
    // case below, which is the same question of degree.
    expect(result.status).toBe("partial");
  });

  it("leaves limits.truncated false when every source fits", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    // Every sentence gets an outcome, so truncation is the ONLY thing that can
    // make these two results `partial`: a decomposition reporting on one of
    // three sentences degrades the result by itself, and would have let the
    // status assertions below pass under the very bug they pin.
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `c${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.limits.truncated).toBe(false);
    expect(result.notes.some((n) => n.includes("truncated"))).toBe(false);
    // The discriminator for the assertion above: truncation is what turns a
    // check partial here, not the fixture.
    expect(result.status).toBe("ok");
  });
});

describe("runClaimCheck — omitted outcomes", () => {
  it("drops a claim verification returned no verdict for, instead of scoring it unsupported", async () => {
    const answer = "Satz eins ist wahr. Satz zwei ist auch wahr.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    // The call SUCCEEDS but answers for the first claim only — the likeliest
    // failure of a long JSON array.
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims
        .slice(0, 1)
        .map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // c2 is gone entirely rather than standing as an unsupported claim.
    expect(result.claims.map((c) => c.id)).toEqual(["c1"]);
    expect(result.score.claims).toBe(1);
    expect(result.score.unsupported).toBe(0);
    expect(result.score.label).toBe("ok");
    expect(result.sentences[0]!.state).toBe("checked");
    expect(result.sentences[1]!.state).toBe("not_checked");
    expect(result.sentences[1]!.reason).toBe("verification returned no verdict for this sentence");
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("verification returned no verdict"))).toBe(true);
  });

  it("marks a sentence selection never answered for not_checked, not no_verifiable_content", async () => {
    const answer = "Satz eins ist wahr. Satz zwei ist auch wahr.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({
        index: w.sentence.index,
        verifiable: w.sentence.index === 0,
        rewritten: null,
        reason: w.sentence.index === 0 ? "fact" : "no outcome returned for this sentence",
        answered: w.sentence.index === 0,
      })),
      disambiguation: windows.map((w: any) => ({
        index: w.sentence.index,
        resolvable: w.sentence.index === 0,
        clarified: null,
        reason: w.sentence.index === 0 ? "clear" : "no outcome returned for this sentence",
        answered: w.sentence.index === 0,
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.sentences[1]!.state).toBe("not_checked");
    expect(result.sentences[1]!.reason).toBe("no outcome returned for this sentence");
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("returned no outcome for 1 sentence(s)"))).toBe(true);
  });

  it("marks a sentence disambiguation never answered for not_checked, not cannot_disambiguate", async () => {
    const answer = "Satz eins ist wahr. Satz zwei ist auch wahr.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({
        index: w.sentence.index,
        verifiable: true,
        rewritten: null,
        reason: "fact",
        answered: true,
      })),
      disambiguation: windows.map((w: any) => ({
        index: w.sentence.index,
        resolvable: w.sentence.index === 0,
        clarified: null,
        reason: w.sentence.index === 0 ? "clear" : "no disambiguation returned for this sentence",
        answered: w.sentence.index === 0,
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.sentences[1]!.state).toBe("not_checked");
    expect(result.sentences[1]!.reason).toBe("no disambiguation returned for this sentence");
    expect(result.status).toBe("partial");
  });
});

describe("runClaimCheck — paper fidelity and second chance", () => {
  it("runs selection and disambiguation as separate stages with majority voting", async () => {
    (runSelection as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({ index: w.sentence.index, verifiable: true, rewritten: null, reason: "fact" })),
      usage: USAGE,
    }));
    // Two of three completions say resolvable, so min_successes=2 passes.
    const resolvableSequence = [true, true, false];
    let call = 0;
    (runDisambiguation as jest.Mock).mockImplementation(async ({ windows }) => {
      const resolvable = resolvableSequence[call % resolvableSequence.length]!;
      call += 1;
      return {
        outcomes: windows.map((w: any) => ({ index: w.sentence.index, resolvable, clarified: null, reason: "r" })),
        usage: USAGE,
      };
    });
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer: "Die FST-2XT arbeitet mit 230 Volt.",
      sources: SOURCES,
      model: {} as any,
      options: options({ fidelity: "paper", completions: 3 }),
      locale: "de",
    });

    expect(runSelectAndDisambiguate).not.toHaveBeenCalled();
    expect((runSelection as jest.Mock).mock.calls.length).toBe(3);
    expect((runSelection as jest.Mock).mock.calls[0][0].temperature).toBe(0.2);
    expect(result.sentences[0]!.state).toBe("checked");
  });

  // Finding 9: paper fidelity only unmerged the stages and added voting; both
  // fidelities batched 10 sentences per selection call and 5 per decomposition
  // call, so §8's fast-vs-paper comparison could not set the batch sizes.
  it("issues one call per sentence per completion in paper fidelity", async () => {
    const answer = "Satz eins ist wahr. Satz zwei ist wahr. Satz drei ist wahr.";
    (runSelection as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index, verifiable: true, rewritten: null, reason: "fact", answered: true,
      })),
      usage: USAGE,
    }));
    (runDisambiguation as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index, resolvable: true, clarified: null, reason: "clear", answered: true,
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer,
      sources: SOURCES,
      model: {} as any,
      options: options({ fidelity: "paper", completions: 2 }),
      locale: "de",
    });

    const selectionCalls = (runSelection as jest.Mock).mock.calls;
    const disambiguationCalls = (runDisambiguation as jest.Mock).mock.calls;
    const decompositionCalls = (runDecomposition as jest.Mock).mock.calls;
    // 3 sentences x 2 completions, one sentence per call.
    expect(selectionCalls).toHaveLength(6);
    expect(disambiguationCalls).toHaveLength(6);
    expect(selectionCalls.every((c) => c[0].windows.length === 1)).toBe(true);
    expect(disambiguationCalls.every((c) => c[0].windows.length === 1)).toBe(true);
    // Decomposition is not voted, but it is one sentence per call too.
    expect(decompositionCalls).toHaveLength(3);
    expect(decompositionCalls.every((c) => c[0].windows.length === 1)).toBe(true);
    expect(result.claims).toHaveLength(3);
  });

  // Finding 14: completions above 1 in fast fidelity only raised the
  // temperature to 0.2 — nothing votes in fast mode, so it bought strictly
  // less determinism for the same single call.
  it("ignores completions outside paper fidelity, keeping temperature at 0", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({ outcomes: [], usage: USAGE });

    await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options({ fidelity: "fast", completions: 3 }),
      locale: "de",
    });

    const calls = (runSelectAndDisambiguate as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].temperature).toBe(0);
  });

  it("keeps the fast path batched: one merged call and one decomposition call for three sentences", async () => {
    const answer = "Satz eins ist wahr. Satz zwei ist wahr. Satz drei ist wahr.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));

    await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect((runSelectAndDisambiguate as jest.Mock).mock.calls).toHaveLength(1);
    expect((runSelectAndDisambiguate as jest.Mock).mock.calls[0][0].windows).toHaveLength(3);
    expect((runDecomposition as jest.Mock).mock.calls).toHaveLength(1);
    expect((runDecomposition as jest.Mock).mock.calls[0][0].windows).toHaveLength(3);
  });

  it("re-retrieves only unsupported claims, up to the cap, and marks the flipped ones rechecked", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({ index: w.sentence.index, claims: [{ text: `claim ${w.sentence.index}`, inferred: false }] })),
      usage: USAGE,
    }));
    let verifyCall = 0;
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => {
      verifyCall += 1;
      // First pass: everything unsupported. Second pass (second chance): supported.
      return {
        outcomes: claims.map((c: any) => ({
          claimId: c.id,
          verdict: verifyCall === 1 ? "unsupported" : "supported",
          evidence: [],
          rationale: "r",
        })),
        usage: USAGE,
      };
    });

    const secondChance = jest
      .fn()
      .mockResolvedValue([{ sourceId: "deep", text: "Die FST-2XT arbeitet mit 230 Volt.", score: 2 }]);

    const result = await runClaimCheck({
      question: "q",
      answer: ANSWER,
      sources: SOURCES,
      model: {} as any,
      options: options({ caps: { maxSentences: 120, maxClaims: 200, maxReRetrievals: 2 } }),
      locale: "de",
      secondChance,
    });

    expect(secondChance).toHaveBeenCalledTimes(2);
    expect(result.claims.filter((c) => c.rechecked)).toHaveLength(2);
    expect(result.claims.filter((c) => c.verdict === "supported")).toHaveLength(2);
    expect(result.notes.some((n) => n.includes("maxReRetrievals"))).toBe(true);
  });

  it("skips the second chance entirely when reRetrieve is off", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "c", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));
    const secondChance = jest.fn();

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any,
      options: options({ reRetrieve: false }), locale: "de", secondChance,
    });

    expect(secondChance).not.toHaveBeenCalled();
    expect(result.claims[0]!.rechecked).toBe(false);
  });

  // Correction 3: a claim whose verification CALL FAILED (the group's promise
  // rejected) must not be reported as "unsupported" — that would misrepresent
  // a provider outage as "the sources don't support this." It must be dropped
  // from the result entirely, and its sentence marked not_checked.
  it("drops claims from a verification group that rejects, instead of reporting them unsupported", async () => {
    const answer = Array.from({ length: 9 }, (_, i) => `Satz Nummer ${i + 1} ist eindeutig wahr.`).join(" ");
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    // BATCH.verifySentences = 8: sentences 0-7 land in one group (8 claims),
    // sentence 8 lands alone in a second group. Fail the first, pass the second.
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => {
      if (claims.length === 8) throw new Error("provider down for this group");
      return {
        outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
        usage: USAGE,
      };
    });

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.sentenceIndex).toBe(8);
    expect(result.score.claims).toBe(1);
    expect(result.sentences.slice(0, 8).every((s) => s.state === "not_checked")).toBe(true);
    expect(result.sentences[0]!.reason).toBe("verification failed for this sentence");
    expect(result.sentences[8]!.state).toBe("checked");
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("verification"))).toBe(true);
  });
});

// Change A: a sentence that appears LITERALLY in one of the supplied sources
// needs no verification call — the extraction stages' contract is that a claim
// is entailed by the text it was decomposed from, so a source carrying that
// text entails the claim. The safety cases below matter more than the happy
// path: each one is a single edit away from matching, and each fails if
// containment is ever loosened to token-set overlap, to a partial-overlap
// score, or below the length floor. See verbatim.test.ts for the rules
// themselves; these tests pin the WIRING, above all that a short-circuited
// claim never reaches runVerification.
describe("runClaimCheck — verbatim short-circuit", () => {
  const SAFETY_SOURCE = [{ id: "s1", content: "Die Steuerung FST-2XT arbeitet mit 230 Volt im Schaltschrank links." }];
  /** Exactly the sentence the source carries, and over the 40-char floor. */
  const EXACT = "Die Steuerung FST-2XT arbeitet mit 230 Volt im Schaltschrank links.";
  const UNQUOTED = "Die Wartung erfolgt jährlich durch den Hersteller.";

  /**
   * One claim per sentence, verification answering "unsupported" for whatever
   * reaches it — so a `supported` verdict in the result can only have come
   * from the short-circuit, and the claim ids handed to runVerification say
   * exactly what the check paid for.
   */
  const probe = async (answer: string, sources: typeof SAFETY_SOURCE = SAFETY_SOURCE) => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "judged" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "Womit arbeitet die FST-2XT?",
      answer,
      sources,
      model: {} as any,
      options: options({ reRetrieve: false }),
      locale: "de",
    });
    const sentToModel = (runVerification as jest.Mock).mock.calls.flatMap(([a]: any[]) =>
      a.claims.map((c: any) => c.id),
    );
    return { result, sentToModel };
  };

  it("verifies a quoted sentence without a model and excludes its claims from the groups", async () => {
    const answer = `${EXACT} ${UNQUOTED}`;
    const { result, sentToModel } = await probe(answer);

    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]).toMatchObject({
      sentenceIndex: 0,
      verdict: "supported",
      matchedVerbatim: true,
      rechecked: false,
      rationale: VERBATIM_RATIONALE,
    });
    expect(result.claims[0]!.evidence).toEqual([{ sourceId: "s1", quote: EXACT }]);
    // The quote is the answer's own text at the sentence's own offsets — the
    // same invariant the UI highlights by.
    const s0 = result.sentences[0]!;
    expect(result.claims[0]!.evidence[0]!.quote).toBe(answer.slice(s0.start, s0.end));
    expect(result.claims[1]).toMatchObject({ sentenceIndex: 1, verdict: "unsupported", matchedVerbatim: false });

    // THE saving: only the unquoted sentence's claim cost a call.
    expect(sentToModel).toEqual(["c2"]);
    expect((runVerification as jest.Mock).mock.calls).toHaveLength(1);
    // A short-circuited claim IS verified, so it stays in the denominator.
    expect(result.score.claims).toBe(2);
    expect(result.score.supported).toBe(1);
    expect(result.sentences[0]!.state).toBe("checked");
    expect(result.sentences[0]!.claimIds).toEqual(["c1"]);
    expect(result.status).toBe("ok");
  });

  it.each([
    // The whole justification for requiring a CONTIGUOUS substring: identical
    // token set, inverted meaning.
    ["a reversed word order with the identical token set", "Im Schaltschrank links arbeitet die Steuerung FST-2XT mit 230 Volt."],
    ["a negated variant", "Die Steuerung FST-2XT arbeitet nicht mit 230 Volt im Schaltschrank links."],
    ["a numeric variant", "Die Steuerung FST-2XT arbeitet mit 240 Volt im Schaltschrank links."],
    // Contained in the source, but short enough to be there by coincidence.
    ["a sentence under the length floor the source does carry", "Im Schaltschrank links."],
  ])("does NOT short-circuit %s", async (_label, answer) => {
    const { result, sentToModel } = await probe(answer as string);

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.matchedVerbatim).toBe(false);
    expect(result.claims[0]!.verdict).toBe("unsupported");
    expect(result.claims[0]!.rationale).toBe("judged");
    expect(sentToModel).toEqual(["c1"]);
  });

  it("still short-circuits across whitespace-run and case differences", async () => {
    const { result, sentToModel } = await probe("DIE STEUERUNG FST-2XT  arbeitet   mit 230 VOLT im Schaltschrank LINKS.");

    expect(result.claims[0]).toMatchObject({ verdict: "supported", matchedVerbatim: true });
    expect(sentToModel).toEqual([]);
    expect(runVerification).not.toHaveBeenCalled();
  });

  // The match is against the text DECOMPOSITION was handed, not the original
  // wording: when disambiguation rewrote the sentence, the claims are entailed
  // by the rewrite, and the rewrite's new content (here a subject lifted from
  // elsewhere in the answer) is not what the source carries.
  it("does NOT short-circuit a verbatim sentence whose claims came from a clarified rewrite", async () => {
    const quoted = "Sie arbeitet mit 230 Volt im Schaltschrank links.";
    const source = [{ id: "s1", content: `Zur FST-2XT: ${quoted} Danach folgt Kapitel 4.` }];
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({
        index: w.sentence.index, verifiable: true, rewritten: null, reason: "fact", answered: true,
      })),
      disambiguation: windows.map((w: any) => ({
        index: w.sentence.index,
        resolvable: true,
        clarified: "Die FST-3XT arbeitet mit 230 Volt im Schaltschrank links.",
        reason: "'Sie' resolved",
        answered: true,
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "Die FST-3XT arbeitet mit 230 Volt.", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "judged" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: quoted, sources: source, model: {} as any,
      options: options({ reRetrieve: false }), locale: "de",
    });

    // Matching the ORIGINAL sentence here would report the FST-3XT's voltage
    // supported by a document about the FST-2XT.
    expect(result.claims[0]!.matchedVerbatim).toBe(false);
    expect(result.claims[0]!.verdict).toBe("unsupported");
    expect((runVerification as jest.Mock).mock.calls[0][0].claims.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it("DOES short-circuit when the clarified rewrite is itself verbatim in a source", async () => {
    const clarified = "Die FST-2XT arbeitet mit 230 Volt im Schaltschrank links.";
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => ({
      selection: windows.map((w: any) => ({
        index: w.sentence.index, verifiable: true, rewritten: null, reason: "fact", answered: true,
      })),
      disambiguation: windows.map((w: any) => ({
        index: w.sentence.index, resolvable: true, clarified, reason: "'Sie' resolved", answered: true,
      })),
      usage: USAGE,
    }));
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "Die FST-2XT arbeitet mit 230 Volt.", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "judged" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q",
      answer: "Sie arbeitet mit 230 Volt im Schaltschrank links.",
      sources: [{ id: "s1", content: `Zur Steuerung: ${clarified} Danach folgt Kapitel 4.` }],
      model: {} as any,
      options: options({ reRetrieve: false }),
      locale: "de",
    });

    expect(result.claims[0]).toMatchObject({ matchedVerbatim: true, verdict: "supported" });
    expect(result.claims[0]!.evidence).toEqual([{ sourceId: "s1", quote: clarified }]);
    expect(runVerification).not.toHaveBeenCalled();
  });

  // An inferred claim asserts MORE than the text it came from — the bracketed
  // context is taken from the question or from elsewhere in the answer, which
  // is exactly the part a hallucinating answer gets wrong and the part the
  // matched source never saw. It goes to the model however literal the match.
  it("sends an inferred claim of a quoted sentence to the model anyway", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [
        {
          index: 0,
          claims: [
            { text: "Die Steuerung FST-2XT arbeitet mit 230 Volt.", inferred: false },
            { text: "Die [FST-3XT] arbeitet mit 230 Volt.", inferred: true },
          ],
        },
      ],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "judged" })),
      usage: USAGE,
    }));

    const result = await runClaimCheck({
      question: "q", answer: EXACT, sources: SAFETY_SOURCE, model: {} as any,
      options: options({ reRetrieve: false }), locale: "de",
    });

    expect(result.claims[0]).toMatchObject({ id: "c1", matchedVerbatim: true, verdict: "supported" });
    expect(result.claims[1]).toMatchObject({ id: "c2", matchedVerbatim: false, verdict: "unsupported" });
    expect((runVerification as jest.Mock).mock.calls[0][0].claims.map((c: any) => c.id)).toEqual(["c2"]);
  });

  // A short-circuited claim is already `supported`, so the second-chance pass
  // — which only ever looks at `unsupported` claims — must never see it.
  it("never re-retrieves a short-circuited claim", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [{ index: 0, claims: [{ text: "claim 0", inferred: false }] }],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "unsupported", evidence: [], rationale: "judged" })),
      usage: USAGE,
    }));
    const secondChance = jest.fn().mockResolvedValue([]);

    const result = await runClaimCheck({
      question: "q", answer: EXACT, sources: SAFETY_SOURCE, model: {} as any,
      options: options({ caps: { ...CLAIM_CHECK_DEFAULTS.caps, maxReRetrievals: 5 } }), locale: "de", secondChance,
    });

    expect(result.claims[0]!.matchedVerbatim).toBe(true);
    // Without the short-circuit this claim comes back "unsupported" from the
    // mock above and the second chance fires — which is this test's teeth.
    expect(secondChance).not.toHaveBeenCalled();
    expect(runVerification).not.toHaveBeenCalled();
  });

  // The short-circuit is the only thing that can split one sentence across
  // both paths (canShortCircuitClaim holds its inferred claims back), so a
  // failed verification call must not report the sentence not_checked while
  // one of its claims stands verified in `claims[]`.
  it("keeps a sentence checked when its verbatim claim stands and the call for its inferred claim fails", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockResolvedValue({
      outcomes: [
        {
          index: 0,
          claims: [
            { text: "Die Steuerung FST-2XT arbeitet mit 230 Volt.", inferred: false },
            { text: "Die [FST-3XT] arbeitet mit 230 Volt.", inferred: true },
          ],
        },
      ],
      usage: USAGE,
    });
    (runVerification as jest.Mock).mockRejectedValue(new Error("provider down for this group"));

    const result = await runClaimCheck({
      question: "q", answer: EXACT, sources: SAFETY_SOURCE, model: {} as any,
      options: options({ reRetrieve: false }), locale: "de",
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ id: "c1", matchedVerbatim: true, verdict: "supported" });
    expect(result.sentences[0]!.state).toBe("checked");
    expect(result.sentences[0]!.claimIds).toEqual(["c1"]);
    expect(result.score.claims).toBe(1);
    // The dropped inferred claim is still a degradation and still says so.
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("verification failed for 1 claim(s)"))).toBe(true);
  });
});

// The product-owner objection this work answers: "running hundreds of checks
// is going to be incredibly expensive and take a long time". These two tests
// are the measurement — stage invocations counted, not estimated.
describe("runClaimCheck — call budget", () => {
  /** 30 sentences, each over the verbatim length floor. */
  const SENTENCES = Array.from(
    { length: 30 },
    (_, i) => `Satz Nummer ${i + 1} beschreibt eine eindeutig überprüfbare Tatsache.`,
  );
  const ANSWER_30 = SENTENCES.join(" ");

  const runWith = async (sources: { id: string; content: string }[]) => {
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) =>
      allClear(windows.map((w: any) => w.sentence.index)),
    );
    (runDecomposition as jest.Mock).mockImplementation(async ({ windows }) => ({
      outcomes: windows.map((w: any) => ({
        index: w.sentence.index,
        claims: [{ text: `claim ${w.sentence.index}`, inferred: false }],
      })),
      usage: USAGE,
    }));
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => ({
      outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
      usage: USAGE,
    }));
    return runClaimCheck({
      question: "q", answer: ANSWER_30, sources, model: {} as any,
      options: options({ reRetrieve: false }), locale: "de",
    });
  };

  it("costs 8 stage calls for a 30-sentence answer, down from 19", async () => {
    const result = await runWith(SOURCES);
    const counts = {
      selectDisambiguate: (runSelectAndDisambiguate as jest.Mock).mock.calls.length,
      decompose: (runDecomposition as jest.Mock).mock.calls.length,
      verify: (runVerification as jest.Mock).mock.calls.length,
    };

    // ceil(30/25) + ceil(30/15) + ceil(30/8). At {10, 5, 3} this was 3 + 6 + 10.
    expect(counts).toEqual({ selectDisambiguate: 2, decompose: 2, verify: 4 });
    expect(counts.selectDisambiguate + counts.decompose + counts.verify).toBe(8);
    // What the response reports back agrees with what was spent.
    expect(result.usage.calls).toBe(8);
    expect(result.score.claims).toBe(30);
    expect(result.status).toBe("ok");
  });

  it("costs 4 when every sentence of that answer is quoted verbatim in a source", async () => {
    const result = await runWith([{ id: "quelle", content: ANSWER_30 }]);

    expect((runVerification as jest.Mock).mock.calls).toHaveLength(0);
    expect(result.usage.calls).toBe(4);
    // Every claim is still verified, still scored, and says how.
    expect(result.claims).toHaveLength(30);
    expect(result.claims.every((c) => c.matchedVerbatim && c.verdict === "supported")).toBe(true);
    expect(result.score).toMatchObject({ claims: 30, supported: 30, unsupportedShare: 0, label: "ok" });
    expect(result.sentences.every((s) => s.state === "checked")).toBe(true);
    expect(result.status).toBe("ok");
  });
});
