import {
  normalizeFileName, deriveKeywordVariants, extractIdentifierTokens,
  itemMatchesIdentifierToken, applyRewrites, stripSeparators,
} from "./text-utils";

describe("text-utils", () => {
  it("normalizeFileName strips the bucket segment, separators, and extension", () => {
    expect(normalizeFileName("/bucket/folder/hb_PAM-E4_2023.de.pdf")).toBe("folder hbpame42023 de pdf");
  });

  it("normalizeFileName drops the first segment for paths without leading slash", () => {
    expect(normalizeFileName("bucket/folder/hb_PAM-E4_2023.de.pdf")).toBe("folder hbpame42023 de pdf");
  });

  it("normalizeFileName preserves bare filenames without dropping segments", () => {
    expect(normalizeFileName("hb_FST-2XT_manual.pdf")).toBe("hbfst2xtmanual pdf");
  });

  it("deriveKeywordVariants yields lowercased, separator- and digit-stripped forms ≥4 chars", () => {
    expect(deriveKeywordVariants("FST-2XT").sort()).toEqual(["fst-2xt", "fst2xt"].sort());
    expect(deriveKeywordVariants("MISCEL6")).toEqual(expect.arrayContaining(["miscel6", "miscel"]));
    expect(deriveKeywordVariants("ab")).toEqual([]); // too short
  });

  it("extractIdentifierTokens keeps ≥4-char tokens containing a digit and a letter", () => {
    expect(extractIdentifierTokens(["FST-2XT", "sperren", "S2", undefined])).toEqual(["fst2xt"]);
  });

  it("itemMatchesIdentifierToken matches separator-insensitively against the filename", () => {
    expect(itemMatchesIdentifierToken("hb_FST-2XT_manual.pdf", ["fst2xt"])).toBe(true);
    expect(itemMatchesIdentifierToken("hb_FST2_manual.pdf", ["fst2xt"])).toBe(false);
  });

  it("applyRewrites returns one variant per matching rule, none when nothing matches", () => {
    const rules = [{ find: "bypass", replace: "override" }, { find: "zzz", replace: "yyy" }];
    expect(applyRewrites("how to bypass the door", rules)).toEqual(["how to override the door"]);
    expect(applyRewrites("hello", rules)).toEqual([]);
  });

  it("stripSeparators lowers and removes separators", () => {
    expect(stripSeparators("FST-2 XT.a")).toBe("fst2xta");
  });
});
