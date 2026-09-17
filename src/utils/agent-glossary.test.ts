import {
  extractGlossaryFromAgentTools,
  formatGlossaryBlock,
  withGlossary,
} from "./agent-glossary";

const toolsWithGlossary = (glossary: unknown, asObject = false) => [
  { id: "internet_search", config: [{ name: "enabled", type: "boolean", variable: true }] },
  {
    id: "agentic_context_search",
    config: [
      { name: "instructions", type: "string", variable: "" },
      {
        name: "vocabulary",
        type: "json",
        variable: asObject ? { glossary, identifiers: [], rewrites: [], styleHint: "" } : JSON.stringify({ glossary, identifiers: [], rewrites: [], styleHint: "" }),
      },
    ],
  },
];

describe("extractGlossaryFromAgentTools", () => {
  it("reads the glossary from the agentic_context_search tool's vocabulary config (JSON string)", () => {
    const glossary = [{ term: "AZK", meaning: "Kompakter Hebertyp" }];
    expect(extractGlossaryFromAgentTools(toolsWithGlossary(glossary))).toEqual(glossary);
  });

  it("reads the glossary when the variable is already a hydrated object, not a JSON string", () => {
    const glossary = [{ term: "AZK", meaning: "Kompakter Hebertyp" }];
    expect(extractGlossaryFromAgentTools(toolsWithGlossary(glossary, true))).toEqual(glossary);
  });

  it("returns [] when tools is not an array", () => {
    expect(extractGlossaryFromAgentTools(undefined)).toEqual([]);
    expect(extractGlossaryFromAgentTools(null)).toEqual([]);
    expect(extractGlossaryFromAgentTools("not an array")).toEqual([]);
  });

  it("returns [] when there is no agentic_context_search tool", () => {
    expect(extractGlossaryFromAgentTools([{ id: "internet_search", config: [] }])).toEqual([]);
  });

  it("returns [] when the vocabulary config entry is missing or empty", () => {
    expect(
      extractGlossaryFromAgentTools([{ id: "agentic_context_search", config: [{ name: "instructions", type: "string", variable: "" }] }]),
    ).toEqual([]);
    expect(
      extractGlossaryFromAgentTools([{ id: "agentic_context_search", config: [{ name: "vocabulary", type: "json", variable: "" }] }]),
    ).toEqual([]);
  });

  it("returns [] instead of throwing when the vocabulary variable holds invalid JSON", () => {
    expect(
      extractGlossaryFromAgentTools([
        { id: "agentic_context_search", config: [{ name: "vocabulary", type: "json", variable: "{not valid json" }] },
      ]),
    ).toEqual([]);
  });

  it("drops malformed glossary entries (missing term/meaning) but keeps valid ones", () => {
    const glossary = [
      { term: "AZK", meaning: "Kompakter Hebertyp" },
      { term: "", meaning: "should be dropped: empty term" },
      { term: "KV" }, // missing meaning
      "not an object",
    ];
    expect(extractGlossaryFromAgentTools(toolsWithGlossary(glossary))).toEqual([
      { term: "AZK", meaning: "Kompakter Hebertyp" },
    ]);
  });
});

describe("formatGlossaryBlock", () => {
  it("returns '' for an empty glossary", () => {
    expect(formatGlossaryBlock([])).toBe("");
  });

  it("renders one 'term : meaning' line per entry", () => {
    const block = formatGlossaryBlock([
      { term: "AZK", meaning: "Kompakter Hebertyp" },
      { term: "KV", meaning: "Kostenvoranschlag" },
    ]);
    expect(block).toContain("AZK : Kompakter Hebertyp");
    expect(block).toContain("KV : Kostenvoranschlag");
  });
});

describe("withGlossary", () => {
  it("prepends the glossary block before the agent's own instructions, at a fixed position", () => {
    const glossary = [{ term: "AZK", meaning: "Kompakter Hebertyp" }];
    const result = withGlossary("Be a helpful support agent.", toolsWithGlossary(glossary));
    expect(result.startsWith("The organization's documents and internal terminology")).toBe(true);
    expect(result.endsWith("Be a helpful support agent.")).toBe(true);
  });

  it("returns the base instructions unchanged when there is no glossary", () => {
    const base = "Be a helpful support agent.";
    expect(withGlossary(base, [])).toBe(base);
    expect(withGlossary(base, undefined)).toBe(base);
  });

  it("returns just the glossary block when base instructions are empty", () => {
    const glossary = [{ term: "AZK", meaning: "Kompakter Hebertyp" }];
    const result = withGlossary("", toolsWithGlossary(glossary));
    expect(result).toBe(formatGlossaryBlock(glossary));
  });
});
