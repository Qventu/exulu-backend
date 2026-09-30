import type { UIMessage } from "ai";
import { buildRecallQuery, previousUserTexts, MAX_QUERY_CHARS } from "./recall-query";

describe("buildRecallQuery", () => {
  const prev = ["Wie wird bei der FST-2 die Kalibrierfahrt gestartet?", "Und bei Anlage 000048F1, welche Steuerung ist verbaut?"];

  it("uses a long, self-contained question as is", () => {
    const q = "Anlage 98200010, AZFR 2.0: Display zeigt 0,2 m/s, die Kabine fährt aber normal. Was soll ich prüfen?";
    expect(buildRecallQuery(q, prev)).toBe(q);
  });

  it("prepends the previous two user turns to a short follow-up", () => {
    expect(buildRecallQuery("sorry, ich meinte 000048F2", prev)).toBe(`${prev[0]}\n${prev[1]}\nsorry, ich meinte 000048F2`);
  });

  it("prepends context when a long message still refers back", () => {
    const q = "Nein, ich meinte die andere Anlage mit dem gleichen Fehlerbild an der Steuerung und den Ventilen";
    expect(buildRecallQuery(q, prev)).toBe(`${prev[0]}\n${prev[1]}\n${q}`);
  });

  it("returns the current message alone when there is no earlier turn", () => {
    expect(buildRecallQuery("und bei 000048F2?", [])).toBe("und bei 000048F2?");
    expect(buildRecallQuery("und bei 000048F2?", ["", "  "])).toBe("und bei 000048F2?");
  });

  it("caps the combined text at MAX_QUERY_CHARS and always keeps the current message", () => {
    const long = ["x".repeat(500), "y".repeat(500)];
    const out = buildRecallQuery("kurz?", long);
    expect(out.length).toBe(MAX_QUERY_CHARS);
    expect(out.endsWith("\nkurz?")).toBe(true);
  });

  it("trims whitespace", () => {
    expect(buildRecallQuery("  hallo  ", [])).toBe("hallo");
  });
});

describe("previousUserTexts", () => {
  const m = (role: string, text: string): UIMessage => ({ id: text, role, parts: [{ type: "text", text }] } as unknown as UIMessage);
  it("returns user texts of all but the last message, oldest first", () => {
    expect(previousUserTexts([m("user", "a"), m("assistant", "x"), m("user", "b"), m("assistant", "y"), m("user", "c")])).toEqual(["a", "b"]);
  });
  it("ignores non-text parts and empty texts", () => {
    const withFile = { id: "f", role: "user", parts: [{ type: "file", url: "u" }] } as unknown as UIMessage;
    expect(previousUserTexts([withFile, m("user", ""), m("user", "z"), m("user", "current")])).toEqual(["z"]);
  });
  it("is empty for a single message", () => {
    expect(previousUserTexts([m("user", "only")])).toEqual([]);
  });
});
