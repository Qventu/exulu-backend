import { resolveSetting } from "./platform-setting";

describe("resolveSetting", () => {
  it("prefers the stored value", () => {
    expect(resolveSetting("db", "env", "code")).toEqual({ value: "db", source: "database" });
  });

  it("falls back to env when nothing is stored", () => {
    expect(resolveSetting(null, "env", "code")).toEqual({ value: "env", source: "env" });
  });

  it("falls back to the code default when neither is set", () => {
    expect(resolveSetting(null, null, "code")).toEqual({ value: "code", source: "code" });
  });

  it("treats undefined the same as null at both layers", () => {
    expect(resolveSetting(undefined, undefined, "code")).toEqual({ value: "code", source: "code" });
    expect(resolveSetting(undefined, "env", "code")).toEqual({ value: "env", source: "env" });
  });

  it("a stored FALSE beats a truthy env value", () => {
    // The bug this helper exists to get right once: a `||`-based resolver
    // silently discards every falsy admin choice. An admin turning local
    // video storage OFF must win over RECALL_STORE_VIDEO_LOCALLY=true.
    expect(resolveSetting(false, true, true)).toEqual({ value: false, source: "database" });
  });

  it("a stored ZERO beats a non-zero env value", () => {
    expect(resolveSetting(0, 90, 2160)).toEqual({ value: 0, source: "database" });
  });

  it("a stored EMPTY STRING beats an env value", () => {
    expect(resolveSetting("", "env", "code")).toEqual({ value: "", source: "database" });
  });

  it("an env FALSE beats the code default", () => {
    expect(resolveSetting(null, false, true)).toEqual({ value: false, source: "env" });
  });

  it("carries a string sentinel through unchanged", () => {
    // "forever" / "none" are real admin choices, not absences.
    expect(resolveSetting<number | "forever">("forever", 720, 2160)).toEqual({
      value: "forever",
      source: "database",
    });
  });

  it("carries an array value through", () => {
    const presets = [{ prompt_id: "p", agent_id: "a" }];
    expect(resolveSetting(presets, null, [])).toEqual({ value: presets, source: "database" });
  });

  it("an empty stored array is a deliberate choice, not an absence", () => {
    // An admin removing every preset must not fall back to the code default.
    expect(resolveSetting<unknown[]>([], null, [{ prompt_id: "p", agent_id: "a" }])).toEqual({
      value: [],
      source: "database",
    });
  });
});
