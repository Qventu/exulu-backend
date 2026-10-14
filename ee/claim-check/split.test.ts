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

  // Regression: a bare single-letter abbreviation entry ("z.") must not glue
  // on ordinary nouns ending in the same letter plus a period (Platz, Satz,
  // Netz, ...) while still gluing real abbreviations.
  it("does not over-glue ordinary sentences ending in a noun that shares an abbreviation's last letter", () => {
    const answer = "Der Aufzug steht am Platz. Er wird repariert.";
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual([
      "Der Aufzug steht am Platz.",
      "Er wird repariert.",
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

  // Review Focus 1 / Finding 2: table rows and fenced code stay excluded —
  // code is not a claim, and a table row is a fragment whose claim semantics
  // need their own treatment.
  it("does not emit markdown table rows or fenced code as sentences", () => {
    const answer = [
      "Übersicht:",
      "",
      "| Teil | Nr. |",
      "| --- | --- |",
      "| Schalter | 7 |",
      "",
      "```",
      "rm -rf /tmp. Kein Satz.",
      "```",
    ].join("\n");
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual(["Übersicht:"]);
  });

  // Finding 2: bullets and numbered steps used to produce NO sentence at all —
  // no sentences[] entry, no limits count, no note — so the response reported
  // "ok" for content it had never examined. They are prose now; the marker is
  // stripped and the offsets point at the content after it.
  it("segments list bullets and numbered items as prose, with offsets after the marker", () => {
    const answer = [
      "- Punkt eins ist wahr.",
      "* Punkt zwei ist falsch.",
      "+ Punkt drei fehlt.",
      "1. Erster Schritt ist nötig.",
      "2) Zweiter Schritt folgt.",
    ].join("\n");
    const sentences = splitIntoSentences(answer, "de");
    expect(sentences.map((s) => s.text)).toEqual([
      "Punkt eins ist wahr.",
      "Punkt zwei ist falsch.",
      "Punkt drei fehlt.",
      "Erster Schritt ist nötig.",
      "Zweiter Schritt folgt.",
    ]);
    expect(offsetsAreExact(answer)).toBe(true);
    // The marker itself is never part of the sentence, and never part of its range.
    expect(answer[sentences[0]!.start - 1]).toBe(" ");
    expect(answer.slice(sentences[3]!.start, sentences[3]!.end)).toBe("Erster Schritt ist nötig.");
  });

  it("ignores a bare marker with no content and keeps horizontal rules out", () => {
    const answer = ["-", "- ", "---", "***", "- Echter Punkt."].join("\n");
    expect(splitIntoSentences(answer, "de").map((s) => s.text)).toEqual(["Echter Punkt."]);
  });

  // Finding 2: the German fixture this feature's first tenant actually posts —
  // a heading, prose, two bullets, two numbered steps and a table.
  it("checks the bullets and steps of a German maintenance answer but not its table rows", () => {
    const answer = [
      "## FST-2XT Steuerung",
      "",
      "Die Fernabschaltung hat mehrere Ursachen.",
      "",
      "- Der Kabinenlichtschalter steht auf AUS.",
      "- Die Sicherung F3 ist defekt.",
      "",
      "1. Schaltschrank öffnen und Sicherung F3 prüfen.",
      "2. Kabinenlichtschalter auf EIN stellen.",
      "",
      "| Teil | Nr. |",
      "| --- | --- |",
      "| Sicherung | F3 |",
    ].join("\n");
    const sentences = splitIntoSentences(answer, "de");
    const texts = sentences.map((s) => s.text);

    expect(texts).toEqual([
      "Die Fernabschaltung hat mehrere Ursachen.",
      "Der Kabinenlichtschalter steht auf AUS.",
      "Die Sicherung F3 ist defekt.",
      "Schaltschrank öffnen und Sicherung F3 prüfen.",
      "Kabinenlichtschalter auf EIN stellen.",
    ]);
    expect(texts.some((t) => t.includes("|"))).toBe(false);
    expect(offsetsAreExact(answer)).toBe(true);
    expect(sentences.every((s) => s.headingPath[0] === "FST-2XT Steuerung")).toBe(true);
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
