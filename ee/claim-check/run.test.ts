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
import { MAX_EVIDENCE_PER_CALL, runClaimCheck, selectGroupEvidence } from "./run";
import { indexSources, selectEvidence } from "./evidence";
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


  it("bisects a failed batch once and only marks the still-failing half not_checked", async () => {
    const seen: number[][] = [];
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => {
      const indexes = windows.map((w: any) => w.sentence.index);
      seen.push(indexes);
      if (indexes.length > 1) throw new Error("batch too big for the provider today");
      if (indexes[0] === 2) throw new Error("still failing");
      return allClear(indexes);
    });
    (runDecomposition as jest.Mock).mockResolvedValue({ outcomes: [], usage: USAGE });

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // One full batch, then its halves.
    expect(seen[0]).toEqual([0, 1, 2]);
    expect(seen.length).toBeGreaterThan(1);
    expect(result.status).toBe("partial");
    expect(result.sentences.find((s) => s.index === 2)!.state).toBe("not_checked");
    expect(result.notes.join(" ")).toContain("not_checked");
  });

  // Renamed from "aborts a stage above the failure ratio...": with only one
  // batch (3 sentences, well under BATCH.selectDisambiguate), the breaker's
  // failures>=2 floor can never trip — a lone failing batch always gets its
  // bisect-retry instead. This test now actually exercises "the bisected
  // halves fail too", not the circuit breaker. See the dedicated breaker test
  // below for that.
  it("fails every sentence not_checked when a lone batch's bisected halves fail too (not the breaker)", async () => {
    (runSelectAndDisambiguate as jest.Mock).mockRejectedValue(new Error("provider down"));

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    // 1 initial call (the whole batch) + 2 retries (its bisected halves) — no
    // abort, since one batch's failure can never meet the failures>=2 floor.
    expect((runSelectAndDisambiguate as jest.Mock).mock.calls.length).toBe(3);
    expect(result.status).toBe("partial");
    expect(result.claims).toEqual([]);
    expect(result.sentences.every((s) => s.state === "not_checked")).toBe(true);
    expect(result.notes.some((n) => n.includes("selection+disambiguation"))).toBe(true);
  });

  // Finding 2 (R18): a genuine multi-batch circuit-breaker fixture. 25
  // sentences batch into [10, 10, 5] for BATCH.selectDisambiguate = 10; the
  // mock fails only the two full-size (un-bisected) batches outright — any
  // bisected retry (always length < 10) would succeed — so disabling the
  // breaker changes the outcome: the aborted batches' sentences would recover
  // via their retries instead of staying not_checked, and the call count
  // would rise from 3 to 7. That is the sensitivity check this test relies on.
  it("trips the circuit breaker across multiple batches and never retries the aborted ones", async () => {
    const answer = Array.from({ length: 25 }, (_, i) => `Satz Nummer ${i + 1} ist eindeutig wahr.`).join(" ");
    (runSelectAndDisambiguate as jest.Mock).mockImplementation(async ({ windows }) => {
      const indexes = windows.map((w: any) => w.sentence.index);
      if (indexes.length === 10 && (indexes[0] === 0 || indexes[0] === 10)) {
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
    expect(result.sentences[15]!.state).toBe("not_checked");
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

    // Both claims are in ONE verification group (BATCH.verifySentences = 3).
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
    const passages = indexSources(sources);
    const claims = Array.from({ length: 20 }, (_, i) => `Begriff${i} ist dokumentiert.`);

    const union = selectGroupEvidence(claims, passages);
    expect(union).toHaveLength(MAX_EVIDENCE_PER_CALL);
    // Rank-first filling: every one of the first twelve claims contributed its
    // OWN best passage, instead of the first four claims taking three each.
    expect(new Set(union.map((e) => e.sourceId)).size).toBe(MAX_EVIDENCE_PER_CALL);
    for (let i = 0; i < MAX_EVIDENCE_PER_CALL; i += 1) {
      expect(union.map((e) => e.sourceId)).toContain(`s${i}`);
    }
  });

  it("returns nothing when there are no passages at all", () => {
    expect(selectGroupEvidence(["irgendein Claim"], [])).toEqual([]);
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
  });

  it("leaves limits.truncated false when every source fits", async () => {
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

    const result = await runClaimCheck({
      question: "q", answer: ANSWER, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.limits.truncated).toBe(false);
    expect(result.notes.some((n) => n.includes("truncated"))).toBe(false);
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
    const answer = "Satz eins ist wahr. Satz zwei ist auch wahr. Satz drei ist strittig. Satz vier ist sicher.";
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
    // BATCH.verifySentences = 3: sentences 0-2 land in one group (3 claims),
    // sentence 3 lands alone in a second group. Fail the first, pass the second.
    (runVerification as jest.Mock).mockImplementation(async ({ claims }) => {
      if (claims.length === 3) throw new Error("provider down for this group");
      return {
        outcomes: claims.map((c: any) => ({ claimId: c.id, verdict: "supported", evidence: [], rationale: "r" })),
        usage: USAGE,
      };
    });

    const result = await runClaimCheck({
      question: "q", answer, sources: SOURCES, model: {} as any, options: options(), locale: "de",
    });

    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]!.sentenceIndex).toBe(3);
    expect(result.score.claims).toBe(1);
    expect(result.sentences[0]!.state).toBe("not_checked");
    expect(result.sentences[0]!.reason).toBe("verification failed for this sentence");
    expect(result.sentences[1]!.state).toBe("not_checked");
    expect(result.sentences[2]!.state).toBe("not_checked");
    expect(result.sentences[3]!.state).toBe("checked");
    expect(result.status).toBe("partial");
    expect(result.notes.some((n) => n.includes("verification"))).toBe(true);
  });
});
