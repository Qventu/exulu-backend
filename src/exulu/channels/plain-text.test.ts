import { stripCitations } from "./plain-text";

// The formats the citation prompt in generate-stream.ts asks for (one line, unquoted keys).
const ks = (name = "Handbuch FST.pdf", id = "abc123") =>
  `{item_name: ${name}, item_id: ${id}, context: tech_doc, chunk_id: chunk_456, chunk_index: 0}`;
const web = `{url: https://www.example.com/a?b=1, title: Example, snippet: The result, with a comma.}`;

describe("stripCitations", () => {
  it("removes a single citation and the space before the full stop", () => {
    expect(stripCitations(`Drücken Sie die Reset-Taste ${ks()}.`)).toBe("Drücken Sie die Reset-Taste.");
  });

  it("removes several citations in one sentence", () => {
    expect(stripCitations(`Der Wert ist 42 ${ks()} ${ks("b.pdf", "x2")}, laut Handbuch ${ks("c.pdf", "x3")}.`)).toBe(
      "Der Wert ist 42, laut Handbuch.",
    );
  });

  it("removes a citation between words and keeps one space", () => {
    expect(stripCitations(`Erst A ${ks()} dann B.`)).toBe("Erst A dann B.");
  });

  it("removes a citation at the end of a line and leaves no trailing space", () => {
    expect(stripCitations(`Zeile eins ${ks()}\nZeile zwei ${ks("b.pdf", "x2")}`)).toBe("Zeile eins\nZeile zwei");
  });

  it("removes web search citations", () => {
    expect(stripCitations(`Siehe Hersteller ${web}.`)).toBe("Siehe Hersteller.");
  });

  it("handles quoted values with braces and nested braces in a field", () => {
    expect(stripCitations(`Wert {item_name: "Tabelle {A}.pdf", item_id: "x}y", context: "agent_memory_context"} ok.`)).toBe(
      "Wert ok.",
    );
    expect(stripCitations(`Wert {item_name: Liste {Rev 2}.pdf, item_id: q1, chunk_id: c, chunk_index: 1}.`)).toBe("Wert.");
  });

  it("removes brackets that only held citations", () => {
    expect(stripCitations(`Siehe Abschnitt 4 (${ks()}).`)).toBe("Siehe Abschnitt 4.");
    expect(stripCitations(`Siehe Abschnitt 4 [${ks()} ${ks("b", "c")}].`)).toBe("Siehe Abschnitt 4.");
  });

  it("drops lines that only held citations and trailing blank lines", () => {
    expect(stripCitations(`Antwort.\n\n${ks()}\n\nMehr.\n\n${ks("b", "c")}\n`)).toBe("Antwort.\n\nMehr.");
  });

  it("does not touch text that merely contains braces", () => {
    const samples = [
      'Die Konfiguration lautet {"timeout": 30, "retry": true}.',
      "Setzen Sie den Parameter {0x1F} auf 1.",
      "Platzhalter {name} und {item_name} bleiben.",
      "Ein Objekt {a: 1, b: 2} ist kein Zitat.",
      "Code: `if (x) { return y; }`",
      "Offene Klammer { ohne Ende",
    ];
    for (const text of samples) expect(stripCitations(text)).toBe(text);
  });

  it("returns the text unchanged when there is no citation, whitespace included", () => {
    const text = "Zeile  mit  Leerzeichen .\n\n\n\nEnde\n";
    expect(stripCitations(text)).toBe(text);
  });

  it("an answer that is only citations becomes empty", () => {
    expect(stripCitations(`${ks()} ${web}\n${ks("b", "c")}`)).toBe("");
  });
});
