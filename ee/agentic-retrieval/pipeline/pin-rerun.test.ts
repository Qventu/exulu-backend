import { needsPinRerun } from "./pin-rerun";

describe("needsPinRerun — whether memory's rewrite of the question can change the identifier pins", () => {
  it("is false when the question is unchanged", () => {
    expect(needsPinRerun("Fehler 0x02 am CBM-2", "Fehler 0x02 am CBM-2")).toBe(false);
  });
  it("is false when the rewrite only adds plain words or synonyms: pins depend on designations, not prose", () => {
    expect(needsPinRerun("Wie quittiere ich die ECO Steuerung?", "Wie quittiere ich die ECO Steuerung (Hydraulik, Quittierung, bestätigen)?")).toBe(false);
  });
  it("is true when the rewrite introduces a new designation such as a model or error code", () => {
    expect(needsPinRerun("Wie quittiere ich die ECO Steuerung?", "Wie quittiere ich die ECO Steuerung (FST-2XT)?")).toBe(true);
    expect(needsPinRerun("Fehler am Bremsmodul", "Fehler 0x02 am Bremsmodul")).toBe(true);
  });
  it("ignores case and punctuation around designations", () => {
    expect(needsPinRerun("cbm-2 Fehler", "CBM-2, Fehler, Bremsmodul")).toBe(false);
  });
});
