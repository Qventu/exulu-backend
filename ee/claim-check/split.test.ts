// ee/claim-check/split.test.ts
import { splitIntoSentences, buildWindows, localeFromText } from "./split";

const offsetsAreExact = (answer: string) =>
  splitIntoSentences(answer).every((s) => answer.slice(s.start, s.end) === s.text);

describe("splitIntoSentences", () => {
  it("splits plain German prose and keeps offsets exact", () => {
    const answer = "Die FST-2XT ist eine Steuerung. Sie wird im Schaltschrank montiert.";
    const sentences = splitIntoSentences(answer, "de");
    expect(sentences.map((s) => s.text)).toEqual([
      "Die FST-2XT ist eine Steuerung.",
      "Sie wird im Schaltschrank montiert.",
    ]);
    expect(offsetsAreExact(answer)).toBe(true);
    expect(sentences[0]!.index).toBe(0);
    expect(sentences[1]!.index).toBe(1);
  });

  it("does not split on German abbreviations", () => {
    const answer = "Die Ursache ist z. B. ein defekter Schalter. Nr. 7 ist betroffen, ca. 3 Stück.";
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual([
      "Die Ursache ist z. B. ein defekter Schalter.",
      "Nr. 7 ist betroffen, ca. 3 Stück.",
    ]);
  });

  // Review Focus 1
  it("skips heading lines and fenced code blocks, recording the heading path", () => {
    const answer = [
      "# Fehlerbehebung",
      "",
      "## FERNABSCHALTUNG",
      "Der Kabinenlichtschalter ist eine Ursache.",
      "",
      "```bash",
      "systemctl restart lift. Nicht als Satz zählen.",
      "```",
      "",
      "Weitere Ursachen sind dokumentiert.",
    ].join("\n");
    const sentences = splitIntoSentences(answer, "de");
    expect(sentences.map((s) => s.text)).toEqual([
      "Der Kabinenlichtschalter ist eine Ursache.",
      "Weitere Ursachen sind dokumentiert.",
    ]);
    expect(sentences[0]!.headingPath).toEqual(["Fehlerbehebung", "FERNABSCHALTUNG"]);
    expect(offsetsAreExact(answer)).toBe(true);
  });

  // Review Focus 1
  it("does not emit markdown table rows or list bullets as sentences", () => {
    const answer = [
      "Übersicht:",
      "",
      "| Teil | Nr. |",
      "| --- | --- |",
      "| Schalter | 7 |",
      "",
      "- Punkt eins",
      "- Punkt zwei",
    ].join("\n");
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual(["Übersicht:"]);
  });

  // Review Focus 2
  it("keeps offsets exact across umlauts, emoji and combining characters", () => {
    const answer = "Grüße aus Köln 🎉. Der Aufzug läuft wieder. Schön! 👍🏽";
    expect(offsetsAreExact(answer)).toBe(true);
    expect(splitIntoSentences(answer, "de").length).toBeGreaterThanOrEqual(2);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(splitIntoSentences("")).toEqual([]);
    expect(splitIntoSentences("   \n\n  ")).toEqual([]);
  });
});

describe("buildWindows", () => {
  it("clamps the window at both ends of the answer", () => {
    const answer = "Eins. Zwei. Drei. Vier.";
    const sentences = splitIntoSentences(answer, "de");
    const windows = buildWindows(sentences, 5, 5);
    expect(windows[0]!.preceding).toEqual([]);
    expect(windows[0]!.following.map((s) => s.text)).toEqual(["Zwei.", "Drei.", "Vier."]);
    expect(windows[3]!.following).toEqual([]);
    expect(windows[3]!.preceding.map((s) => s.text)).toEqual(["Eins.", "Zwei.", "Drei."]);
  });

  it("honours a following window of 0 (the later stages' setting)", () => {
    const sentences = splitIntoSentences("Eins. Zwei. Drei.", "de");
    expect(buildWindows(sentences, 5, 0).every((w) => w.following.length === 0)).toBe(true);
  });
});

describe("localeFromText", () => {
  it("maps detected German to de and unknown input to en", () => {
    expect(localeFromText("Der Aufzug steht still und zeigt eine Fernabschaltung an.")).toBe("de");
    expect(localeFromText("")).toBe("en");
  });
});
