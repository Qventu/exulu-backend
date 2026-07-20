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
