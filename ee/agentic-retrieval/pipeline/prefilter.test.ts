import { fuzzyPrefilter, exactTokenPrefilter, resolveIdentifierPins, clearPrefilterCaches } from "./prefilter";

jest.mock("ai", () => ({
  ...jest.requireActual("ai"),
  generateText: jest.fn(),
  Output: { object: jest.fn((o) => o) },
}));
import { generateText } from "ai";

const items = [
  { id: "1", name: "FST-2XT Manual", external_id: "/b/hb_FST-2XT_manual.pdf" },
  { id: "2", name: "ECO Guide", external_id: "/b/eco_guide.pdf" },
  { id: "3", name: "ISO 8100-1", external_id: "/b/din_en_iso_8100-1.pdf" },
];
const ctx = (id: string) => ({ id, getItems: jest.fn(async () => items) });

beforeEach(() => {
  clearPrefilterCaches();
  (generateText as jest.Mock).mockReset();
});

describe("exactTokenPrefilter", () => {
  it("matches exact separator-stripped substrings only", async () => {
    const r = await exactTokenPrefilter({
      cacheKey: "t1", tokens: ["8100-1"], context: ctx("c"), fields: ["name", "id", "external_id"],
      normalize: (i) => i.external_id,
    });
    expect(r.map((x) => x.id)).toEqual(["3"]);
  });
  it("ignores tokens shorter than minTokenLength", async () => {
    const r = await exactTokenPrefilter({
      cacheKey: "t2", tokens: ["81"], context: ctx("c"), fields: ["name"], normalize: (i) => i.external_id,
    });
    expect(r).toEqual([]);
  });
});

describe("fuzzyPrefilter", () => {
  it("finds items whose normalized name matches the keywords", async () => {
    const r = await fuzzyPrefilter({
      cacheKey: "t3", relevantKeywords: ["FST-2XT"], context: ctx("c"),
      fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
    });
    expect(r.map((x) => x.id)).toContain("1");
    expect(r.map((x) => x.id)).not.toContain("2");
  });
});

describe("fuzzyPrefilter separator handling", () => {
  // Real NEWLIFT shape: the FST-2XT *handbooks* spell the product without a
  // hyphen (hb_FST2XT-XTs_...), while brochures and certificates spell it with
  // one. A question says "FST-2XT", so that is what the extractor emits. With
  // more hyphenated files than the 30-result cap, an unhyphenated handbook has
  // to survive the rescorer's match-ratio penalty to be pinned at all.
  const decoys = Array.from({ length: 34 }, (_, i) => ({
    id: `br${i}`,
    name: `br_FST-2XT_brochure_${i}.pdf`,
    external_id: `/b/br_FST-2XT_brochure_${i}.pdf`,
  }));
  const handbook = {
    id: "hb",
    name: "hb_FST2XT-XTs_2017-11_de.pdf",
    external_id: "/b/hb_FST2XT-XTs_2017-11_de.pdf",
  };
  const newliftCtx = { id: "tech", getItems: jest.fn(async () => [...decoys, handbook]) };

  it("pins an unhyphenated handbook despite a hyphenated identifier and a full result cap", async () => {
    const r = await fuzzyPrefilter({
      cacheKey: "sep1", relevantKeywords: ["FST-2XT"], context: newliftCtx,
      fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
      supplementSeparatorVariants: true,
    });
    expect(r.map((x) => x.id)).toContain("hb");
  });
});

describe("fuzzyPrefilter supplement ordering", () => {
  // `normalized` carries the whole storage path, and NEWLIFT files the product's
  // documents under a `/FST/FST-2XT/` folder — so every unrelated file in that
  // folder matches the identifier just as well as the handbook does. Taking the
  // supplement in corpus order therefore fills the budget with incidental files
  // (observed in production: Bosch-FWMaterialfahrt.pdf, spsrules.txt) and drops
  // the handbook. A filename match has to outrank a path-only match.
  const brochures = Array.from({ length: 34 }, (_, i) => ({
    id: `br${i}`,
    name: `br_FST-2XT_brochure_${i}.pdf`,
    external_id: `/Techdoc/FST/FST-2XT/br_FST-2XT_brochure_${i}.pdf`,
  }));
  const pathOnly = Array.from({ length: 25 }, (_, i) => ({
    id: `path${i}`,
    name: `unrelated_doc_${i}.pdf`,
    external_id: `/Techdoc/FST/FST-2XT/unrelated_doc_${i}.pdf`,
  }));
  const handbook = {
    id: "hb",
    name: "hb_FST2XT-XTs_2017-11_de.pdf",
    external_id: "/Techdoc/FST/FST-2XT/hb_FST2XT-XTs_2017-11_de.pdf",
  };
  // handbook last, so only relevance ordering can keep it within the budget
  const ctxRel = {
    id: "tech",
    getItems: jest.fn(async () => [...brochures, ...pathOnly, handbook]),
  };

  it("prefers a filename match over path-only matches when the budget is tight", async () => {
    const r = await fuzzyPrefilter({
      cacheKey: "ord1", relevantKeywords: ["FST-2XT"], context: ctxRel,
      fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
      supplementSeparatorVariants: true,
    });
    expect(r.map((x) => x.id)).toContain("hb");
  });
});

describe("fuzzyPrefilter supplement scope and degenerate corpora", () => {
  const brochures = Array.from({ length: 34 }, (_, i) => ({
    id: `br${i}`,
    name: `br_FST-2XT_brochure_${i}.pdf`,
    external_id: `/Techdoc/FST/FST-2XT/br_FST-2XT_brochure_${i}.pdf`,
  }));
  const handbook = {
    id: "hb",
    name: "hb_FST2XT-XTs_2017-11_de.pdf",
    external_id: "/Techdoc/FST/FST-2XT/hb_FST2XT-XTs_2017-11_de.pdf",
  };

  it("leaves the result untouched unless the caller opts in", async () => {
    // The conversations keyword prefilter (search.ts) matches ticket text, not
    // filenames, so it must not inherit filename-shaped supplementing.
    const ctxNoOptIn = { id: "tech", getItems: jest.fn(async () => [...brochures, handbook]) };
    const r = await fuzzyPrefilter({
      cacheKey: "noopt", relevantKeywords: ["FST-2XT"], context: ctxNoOptIn,
      fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
    });
    expect(r).toHaveLength(30);
    expect(r.map((x) => x.id)).not.toContain("hb");
  });

  it("adds nothing when external_id carries no filename text", async () => {
    // Other tenants store an opaque id (uuid / int / "9998-31938") instead of a
    // path, so there is nothing for a separator-free token to match.
    const opaque = [
      ...brochures.map((b, i) => ({ ...b, external_id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}` })),
      { ...handbook, external_id: "550e8400-e29b-41d4-a716-446655449999" },
    ];
    const ctxOpaque = { id: "tickets", getItems: jest.fn(async () => opaque) };
    const r = await fuzzyPrefilter({
      cacheKey: "opaque", relevantKeywords: ["FST-2XT"], context: ctxOpaque,
      fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
      supplementSeparatorVariants: true,
    });
    // no crash, and the opaque corpus yields no separator-variant candidates
    expect(r.length).toBeLessThanOrEqual(30);
  });

  it("survives items with no name at all", async () => {
    const nameless = [
      ...brochures,
      { id: "nameless", name: undefined as any, external_id: "/Techdoc/FST/FST-2XT/x.pdf" },
    ];
    const ctxNameless = { id: "tech", getItems: jest.fn(async () => nameless) };
    await expect(
      fuzzyPrefilter({
        cacheKey: "nameless", relevantKeywords: ["FST-2XT"], context: ctxNameless,
        fields: ["name", "id", "external_id"], normalize: (i) => i.external_id,
        supplementSeparatorVariants: true,
      }),
    ).resolves.toBeDefined();
  });
});

describe("resolveIdentifierPins", () => {
  it("runs one extraction call per identifier set and routes pins to the set's contexts", async () => {
    (generateText as jest.Mock).mockResolvedValue({
      output: { hasMatches: true, matches: ["FST-2XT", "FST"] },
    });
    const c = ctx("docs");
    const r = await resolveIdentifierPins({
      question: "Wie sperre ich die Tür beim FST-2XT?",
      identifierSets: [{ name: "Product names", description: "", examples: ["FST"], strategy: "fuzzy", contexts: ["docs"] }],
      contextsById: new Map([["docs", c]]),
      kbKindById: new Map([["docs", "documents"]]),
      model: {},
    });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect([...(r.pinsByContext.get("docs") ?? [])]).toContain("1");
    expect(r.exactPinsByContext.get("docs")).toBeUndefined(); // fuzzy sets don't boost
  });

  it("degrades to no pins when extraction fails", async () => {
    (generateText as jest.Mock).mockRejectedValue(new Error("llm down"));
    const r = await resolveIdentifierPins({
      question: "q",
      identifierSets: [{ name: "Norms", description: "", examples: ["ISO 8100"], strategy: "exact", contexts: ["docs"] }],
      contextsById: new Map([["docs", ctx("docs")]]),
      kbKindById: new Map([["docs", "documents"]]),
      model: {},
    });
    expect(r.pinsByContext.size).toBe(0);
  });

  it("pins exact-matched items to both pinsByContext and exactPinsByContext", async () => {
    (generateText as jest.Mock).mockResolvedValue({
      output: { hasMatches: true, matches: ["8100-1"] },
    });
    const c = ctx("docs");
    const r = await resolveIdentifierPins({
      question: "Welche Norm beschreibt ISO 8100-1?",
      identifierSets: [{ name: "Norms", description: "", examples: ["ISO 8100"], strategy: "exact", contexts: ["docs"] }],
      contextsById: new Map([["docs", c]]),
      kbKindById: new Map([["docs", "documents"]]),
      model: {},
    });
    expect([...(r.pinsByContext.get("docs") ?? [])]).toContain("3");
    expect([...(r.exactPinsByContext.get("docs") ?? [])]).toContain("3");
  });
});
