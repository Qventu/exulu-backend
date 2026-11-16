import { parseWorkStatusConfig, validateWorkStatusConfig, isDoneStatus } from "./work-status";

describe("parseWorkStatusConfig", () => {
  it("returns the empty config for null, {}, a string that is not JSON, and statuses missing", () => {
    for (const raw of [null, undefined, {}, "nope", { default: "x" }, { statuses: "x" }])
      expect(parseWorkStatusConfig(raw)).toEqual({ statuses: [], default: null });
  });
  it("parses a JSON string and drops entries without a valid key", () => {
    const raw = JSON.stringify({ statuses: [{ key: "neu", label: "Neu" }, { key: "Bad Key", label: "x" }, { label: "y" }], default: "neu" });
    expect(parseWorkStatusConfig(raw)).toEqual({ statuses: [{ key: "neu", label: "Neu" }], default: "neu" });
  });
  it("nulls a default that is not among the statuses", () => {
    expect(parseWorkStatusConfig({ statuses: [{ key: "neu", label: "Neu" }], default: "weg" }).default).toBeNull();
  });
  it("keeps colour and done only when they are a string / boolean", () => {
    expect(parseWorkStatusConfig({ statuses: [{ key: "a1", label: "A", color: "green", done: true }, { key: "b1", label: "B", color: 3, done: "yes" }], default: null }).statuses)
      .toEqual([{ key: "a1", label: "A", color: "green", done: true }, { key: "b1", label: "B" }]);
  });
});

describe("validateWorkStatusConfig", () => {
  const ok = { statuses: [{ key: "neu", label: "Neu" }, { key: "erledigt", label: "Erledigt", done: true }], default: "neu" };
  it("accepts null, an empty list and a complete config", () => {
    expect(validateWorkStatusConfig(null)).toEqual([]);
    expect(validateWorkStatusConfig({ statuses: [], default: null })).toEqual([]);
    expect(validateWorkStatusConfig(ok)).toEqual([]);
    expect(validateWorkStatusConfig(JSON.stringify(ok))).toEqual([]);
  });
  it("rejects bad key format, duplicate keys, empty label, unknown default, done default", () => {
    expect(validateWorkStatusConfig({ ...ok, statuses: [{ key: "Neu!", label: "Neu" }] }).join()).toMatch(/key/);
    expect(validateWorkStatusConfig({ ...ok, statuses: [...ok.statuses, { key: "neu", label: "x" }] }).join()).toMatch(/duplicate/i);
    expect(validateWorkStatusConfig({ ...ok, statuses: [{ key: "neu", label: " " }] }).join()).toMatch(/label/);
    expect(validateWorkStatusConfig({ ...ok, default: "weg" }).join()).toMatch(/default/);
    expect(validateWorkStatusConfig({ ...ok, default: "erledigt" }).join()).toMatch(/done/);
  });
  it("rejects something that is not a config object at all", () => {
    expect(validateWorkStatusConfig("nope").join()).toMatch(/object/);
    expect(validateWorkStatusConfig({ statuses: "x" }).join()).toMatch(/statuses/);
  });
  it("allows removing a status and editing label/colour/done", () => {
    expect(validateWorkStatusConfig({ statuses: [{ key: "neu", label: "Offen", color: "blue" }], default: "neu" }, ok)).toEqual([]);
  });
});

describe("isDoneStatus", () => {
  const c = parseWorkStatusConfig({ statuses: [{ key: "neu", label: "Neu" }, { key: "erledigt", label: "E", done: true }], default: "neu" });
  it("is true only for a configured done key", () => {
    expect(isDoneStatus(c, "erledigt")).toBe(true);
    expect(isDoneStatus(c, "neu")).toBe(false);
    expect(isDoneStatus(c, "weg")).toBe(false);
    expect(isDoneStatus(c, null)).toBe(false);
  });
});
