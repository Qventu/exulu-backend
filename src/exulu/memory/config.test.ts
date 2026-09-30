import { DEFAULT_MEMORY_CONFIG, resolveMemoryConfig } from "./config";

describe("resolveMemoryConfig", () => {
  it("returns defaults for null, undefined and garbage", () => {
    expect(resolveMemoryConfig(null)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(undefined)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig("not json")).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(42)).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  it("accepts an object and a JSON string, filling gaps with defaults", () => {
    expect(resolveMemoryConfig({ retrieval: { limit: 5 } })).toEqual({
      retrieval: { enabled: true, limit: 5 }, visibility: "ask", guests: { showRecalled: false },
    });
    expect(resolveMemoryConfig('{"visibility":"preselect_private","guests":{"showRecalled":true}}')).toEqual({
      retrieval: { enabled: true, limit: 10 }, visibility: "preselect_private", guests: { showRecalled: true },
    });
  });

  it("clamps the limit to 1..50 and rejects unknown visibility values", () => {
    expect(resolveMemoryConfig({ retrieval: { limit: 0 } }).retrieval.limit).toBe(1);
    expect(resolveMemoryConfig({ retrieval: { limit: 500 } }).retrieval.limit).toBe(50);
    expect(resolveMemoryConfig({ retrieval: { limit: "12" } }).retrieval.limit).toBe(12);
    expect(resolveMemoryConfig({ visibility: "everyone" }).visibility).toBe("ask");
  });
});
