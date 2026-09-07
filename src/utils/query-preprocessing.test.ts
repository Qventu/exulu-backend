import { preprocessQuery, buildFullTextOrQuery, resolveSearchQueryTexts } from "./query-preprocessing";

describe("preprocessQuery — tokens carrying digits or punctuation are identifiers, not words", () => {
  it("keeps a fraction like 3/4 intact instead of collapsing it to 34", () => {
    const { processed } = preprocessQuery("Pulsationsdämpfer 3/4 Zoll");
    expect(processed.split(" ")).toContain("3/4");
    expect(processed.split(" ")).not.toContain("34");
  });

  it("keeps product identifiers with slashes, dots and underscores intact", () => {
    const { processed } = preprocessQuery("Pumpe AZH 50/95 Zeichnung Zg.60858_0500");
    const tokens = processed.split(" ");
    expect(tokens).toContain("50/95");
    expect(tokens).toContain("zg.60858_0500");
    expect(tokens).not.toContain("5095");
  });

  it("drops surrounding punctuation from an identifier but keeps its inner structure", () => {
    const { processed } = preprocessQuery('Anschluss 3/4", bitte');
    expect(processed.split(" ")).toContain("3/4");
  });

  it("still stems plain words", () => {
    const { processed } = preprocessQuery("running quickly through the tests");
    expect(processed).toBe("run quickli through the test");
  });
});

describe("buildFullTextOrQuery — lenient websearch_to_tsquery input for the hybrid full-text branch", () => {
  it("ORs the original and the stemmed tokens so one unmatched keyword cannot zero the branch", () => {
    const q = buildFullTextOrQuery("Pulsationsdämpfer 3/4 Zoll AZH 50/95", "pulsationsdämpf 3/4 zoll azh 50/95");
    expect(q).toBe("pulsationsdämpfer or 3/4 or zoll or azh or 50/95 or pulsationsdämpf");
  });

  it("strips quote characters and a leading dash, which websearch_to_tsquery would read as phrase/NOT operators", () => {
    const q = buildFullTextOrQuery('Kugelhahn 3/4" -neu', 'kugelhahn 3/4" -neu');
    expect(q).toBe("kugelhahn or 3/4 or neu");
  });

  it("drops tokens that are empty, pure punctuation, or the literal operator word 'or'", () => {
    const q = buildFullTextOrQuery("Heber - or ?", "heber - or ?");
    expect(q).toBe("heber");
  });

  it("returns an empty string when nothing usable is left", () => {
    expect(buildFullTextOrQuery("", "")).toBe("");
  });
});

describe("resolveSearchQueryTexts — what the vector search embeds vs. what it feeds to full-text", () => {
  it("embeds the untouched query: chunks are embedded raw, so a stemmed/mangled query would not be comparable", () => {
    const q = "Suche nach einem Pulsationsdämpfer mit 3/4 Zoll Anschluss passend zur Pumpe AZH 50/95";
    expect(resolveSearchQueryTexts(q).embedText).toBe(q);
  });

  it("uses the stemmed form for the tsvector method and an OR-union for the hybrid branch", () => {
    const { ftsText, hybridOrQuery } = resolveSearchQueryTexts("Pulsationsdämpfer 3/4 Zoll");
    expect(ftsText).toBe("pulsationsdämpf 3/4 zoll");
    expect(hybridOrQuery).toBe("pulsationsdämpfer or 3/4 or zoll or pulsationsdämpf");
  });
});
