import { indexSources, selectEvidence } from "./evidence";

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

  it("pools the terms of several claims when they share a sentence neighbourhood", () => {
    const passages = indexSources(SOURCES);
    const picked = selectEvidence(["Die Tür wurde getauscht", "Die Spannung beträgt 230 Volt"], passages, 2);
    expect(new Set(picked.map((p) => p.sourceId))).toEqual(new Set(["s1", "s2"]));
  });
});
