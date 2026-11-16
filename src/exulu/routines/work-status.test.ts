import { parseWorkStatusConfig, validateWorkStatusConfig, isDoneStatus, decideWorkStatusWrite } from "./work-status";

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

describe("decideWorkStatusWrite", () => {
  const C = parseWorkStatusConfig({
    statuses: [{ key: "neu", label: "Neu" }, { key: "angebot_im_erp", label: "Angebot im ERP" }, { key: "rueckfrage", label: "Rückfrage" }, { key: "erledigt", label: "Erledigt", done: true }],
    default: "neu",
  });
  const base = { config: C, routineName: "Ersatzteil Angebot", current: { status: "neu", updatedBy: { kind: "default" } as const } };
  it("writes a configured status", () =>
    expect(decideWorkStatusWrite({ ...base, next: "angebot_im_erp", origin: "worker" })).toEqual({ action: "write", status: "angebot_im_erp" }));
  it("skips when unchanged", () =>
    expect(decideWorkStatusWrite({ ...base, next: "neu", origin: "worker" })).toEqual({ action: "skip", reason: "unchanged" }));
  it("rejects an unknown key and lists the allowed ones", () => {
    const d = decideWorkStatusWrite({ ...base, next: "fertig", origin: "worker" });
    expect(d).toMatchObject({ action: "reject" });
    expect((d as any).message).toContain("neu, angebot_im_erp, rueckfrage, erledigt");
  });
  it("rejects when the routine has no statuses, naming the routine", () => {
    const d = decideWorkStatusWrite({ ...base, config: { statuses: [], default: null }, next: "neu", origin: "worker" });
    expect((d as any).message).toContain('"Ersatzteil Angebot" has no work statuses configured');
  });
  const human = { status: "erledigt", updatedBy: { kind: "user", id: 14 } as const };
  it("worker write does not override a human-set status", () =>
    expect(decideWorkStatusWrite({ ...base, current: human, next: "angebot_im_erp", origin: "worker" })).toEqual({ action: "skip", reason: "human_set" }));
  it("chat and manual writes do override it", () => {
    for (const origin of ["chat", "manual"] as const)
      expect(decideWorkStatusWrite({ ...base, current: human, next: "angebot_im_erp", origin })).toEqual({ action: "write", status: "angebot_im_erp" });
  });
  it("clearing (null) is manual-only", () => {
    expect(decideWorkStatusWrite({ ...base, next: null, origin: "manual" })).toEqual({ action: "write", status: null });
    expect(decideWorkStatusWrite({ ...base, next: null, origin: "chat" })).toMatchObject({ action: "reject" });
  });
  it("a stored key that is no longer configured can be replaced", () =>
    expect(decideWorkStatusWrite({ ...base, current: { status: "alt_geloescht", updatedBy: null }, next: "neu", origin: "worker" })).toEqual({ action: "write", status: "neu" }));
  it("manual clear works even when the routine has no statuses any more", () =>
    expect(decideWorkStatusWrite({ ...base, config: { statuses: [], default: null }, next: null, origin: "manual" })).toEqual({ action: "write", status: null }));
});
