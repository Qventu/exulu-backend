import { preprocessQuery } from "@SRC/utils/query-preprocessing";
import { indexSources, indexSourcesWithLimits, MAX_CHARS_PER_SOURCE, selectEvidence } from "./evidence";

const SOURCES = [
  {
    id: "s1",
    name: "handbuch.pdf",
    content:
      "Der Kabinenlichtschalter im Schaltschrank kann eine Fernabschaltung auslösen. " +
      "Die Spannung beträgt 230 Volt.",
  },
  {
    id: "s2",
    name: "ticket-1735.txt",
    content: "Der Kunde meldet eine defekte Tür. Die Tür wurde am 3. März getauscht.",
  },
];

describe("indexSources", () => {
  it("produces passages tagged with their source id and name", () => {
    const passages = indexSources(SOURCES);
    expect(passages.length).toBeGreaterThanOrEqual(2);
    expect(new Set(passages.map((p) => p.sourceId))).toEqual(new Set(["s1", "s2"]));
    expect(passages[0]!.tokens.length).toBeGreaterThan(0);
  });

  it("slices long content into overlapping passages and truncates per source", () => {
    const long = { id: "big", content: "Satz eins. ".repeat(500) };
    const passages = indexSources([long], { passageChars: 400, overlapChars: 50, maxCharsPerSource: 2000 });
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(2000 + 400);
  });

  // Finding 5: 28.4% of a 601,392-char evidence set used to be dropped
  // silently — limits.truncated stayed false and no note was emitted, so
  // claims supported only in a dropped tail came back "unsupported".
  it("reports how many sources were truncated and how many characters were dropped", () => {
    const { passages, truncation } = indexSourcesWithLimits(
      [
        { id: "big", content: "a".repeat(2500) },
        { id: "bigger", content: "b".repeat(3000) },
        { id: "small", content: "Kurzer Satz." },
      ],
      { passageChars: 400, overlapChars: 50, maxCharsPerSource: 1000 },
    );
    expect(truncation).toEqual({ sources: 2, droppedChars: 1500 + 2000 });
    expect(passages.every((p) => p.text.length <= 400)).toBe(true);
  });

  it("reports no truncation when every source fits", () => {
    expect(indexSourcesWithLimits(SOURCES).truncation).toEqual({ sources: 0, droppedChars: 0 });
  });

  it("defaults the per-source limit to the documented 60,000 characters", () => {
    expect(MAX_CHARS_PER_SOURCE).toBe(60_000);
    const { truncation } = indexSourcesWithLimits([{ id: "huge", content: "x".repeat(60_010) }]);
    expect(truncation).toEqual({ sources: 1, droppedChars: 10 });
  });

  // Review Focus 3
  it("ignores empty and whitespace-only sources without crashing", () => {
    expect(indexSources([{ id: "e1", content: "" }, { id: "e2", content: "   \n " }])).toEqual([]);
  });

  // Review Focus 3
  it("keeps duplicate source ids distinguishable by passage, never merging them", () => {
    const passages = indexSources([
      { id: "dup", name: "a.pdf", content: "Inhalt A über Schalter." },
      { id: "dup", name: "b.pdf", content: "Inhalt B über Türen." },
    ]);
    expect(passages.map((p) => p.sourceName).sort()).toEqual(["a.pdf", "b.pdf"]);
    expect(passages.every((p) => p.sourceId === "dup")).toBe(true);
  });
});

describe("selectEvidence", () => {
  it("ranks the passage that shares the claim's terms first", () => {
    const passages = indexSources(SOURCES);
    const [top] = selectEvidence(["Der Kabinenlichtschalter löst eine Fernabschaltung aus"], passages, 2);
    expect(top!.sourceId).toBe("s1");
    expect(top!.text).toContain("Fernabschaltung");
    expect(top!.score).toBeGreaterThan(0);
  });

  it("returns at most topK snippets and none for an empty passage set", () => {
    const passages = indexSources(SOURCES);
    expect(selectEvidence(["Spannung"], passages, 1)).toHaveLength(1);
    expect(selectEvidence(["Spannung"], [], 3)).toEqual([]);
  });

  it("scores a claim with no lexical overlap at zero but still returns a fallback snippet", () => {
    const passages = indexSources(SOURCES);
    const picked = selectEvidence(["Völlig unverwandtes Thema Zebrastreifen"], passages, 2);
    expect(picked).toHaveLength(2);
    expect(picked.every((p) => p.score === 0)).toBe(true);
  });

  it("pools the terms of several claims, surfacing a passage one claim alone would not rank", () => {
    const sources = [
      { id: "p1", content: "Steuerung meldet Fernabschaltung im Schaltschrank." },
      { id: "p2", content: "Kabinentuer wurde getauscht und Dienstag geprueft." },
      { id: "p3", content: "Steuerung ist montiert." },
    ];
    const passages = indexSources(sources);
    const claimA = "Steuerung meldet Fernabschaltung";
    const claimB = "Kabinentuer wurde getauscht Dienstag";

    // Claim A alone: p3 shares "Steuerung" and so outranks p2, which shares nothing.
    const aOnly = selectEvidence([claimA], passages, 2).map((p) => p.sourceId);
    expect(aOnly).toContain("p1");
    expect(aOnly).toContain("p3");
    expect(aOnly).not.toContain("p2");

    // Both claims pooled: p2 now carries three of claim B's rare terms and must
    // displace p3, which carries only one of claim A's. This assertion is the
    // discriminator — it fails if the second claim's tokens are not pooled in.
    const pooled = selectEvidence([claimA, claimB], passages, 2).map((p) => p.sourceId);
    expect(pooled).toContain("p1");
    expect(pooled).toContain("p2");
    expect(pooled).not.toContain("p3");
  });

  it("zeroes ubiquitous terms and avoids their ranking inversion", () => {
    const sources = [
      { id: "s1", name: "a.txt", content: "Die Anlage wurde installiert und getestet." },
      { id: "s2", name: "b.txt", content: "Die Prüfung wurde durchgeführt und bestanden." },
      { id: "s3", name: "c.txt", content: "Die Wartung wurde geplant und dokumentiert." },
      { id: "s4", name: "d.txt", content: "Die Spule wurde ersetzt und kalibriert." },
    ];
    const passages = indexSources(sources);
    // "Die" and "wurde" appear in all four passages (filler); "Spule" only in s4
    const claimMixed = ["Die Spule wurde ersetzt"];
    const picked = selectEvidence(claimMixed, passages, 4);
    // The passage with "Spule" must rank first despite "Die" and "wurde" being ubiquitous
    expect(picked[0]!.sourceId).toBe("s4");
    // A claim built only from ubiquitous terms scores every passage 0
    const claimFiller = ["Die wurde"];
    const fillerPicked = selectEvidence(claimFiller, passages, 4);
    expect(fillerPicked.every((p) => p.score === 0)).toBe(true);
  });

  it("silences preprocessing logs when requested", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation();
    try {
      // Calling indexSources should not emit preprocessing logs
      indexSources([{ id: "s1", content: "Test content für eine Überprüfung." }]);
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("[EXULU] Query preprocessing"));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still logs when silent is not requested", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      preprocessQuery("Die Steuerung meldet eine Fernabschaltung.", { enableStemming: false });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
