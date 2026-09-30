import { checkMemoryBase, memoryTypeValues, memoryBaseHasSourceSession } from "./memory-base";

const ctx = (fields: { name: string; type: string; enumValues?: string[] }[]) => ({ fields } as any);

describe("checkMemoryBase", () => {
  it("accepts a Newton-style context (information text + type enum)", () => {
    const r = checkMemoryBase(ctx([
      { name: "information", type: "text" },
      { name: "type", type: "enum", enumValues: ["FACT", "PREFERENCE"] },
    ]));
    expect(r).toEqual({ ok: true, missing: [] });
  });

  it("accepts longText for information", () => {
    expect(checkMemoryBase(ctx([
      { name: "information", type: "longText" },
      { name: "type", type: "enum", enumValues: ["FACT"] },
    ])).ok).toBe(true);
  });

  it("reports both fields missing on an unrelated context", () => {
    expect(checkMemoryBase(ctx([{ name: "body", type: "text" }]))).toEqual({
      ok: false, missing: ["information", "type"],
    });
  });

  it("rejects a type field that is not an enum or has no values", () => {
    expect(checkMemoryBase(ctx([
      { name: "information", type: "text" },
      { name: "type", type: "text" },
    ])).missing).toEqual(["type"]);
    expect(checkMemoryBase(ctx([
      { name: "information", type: "text" },
      { name: "type", type: "enum", enumValues: [] },
    ])).missing).toEqual(["type"]);
  });

  it("treats a missing context as failing both", () => {
    expect(checkMemoryBase(undefined).missing).toEqual(["information", "type"]);
  });
});

describe("memoryTypeValues", () => {
  it("returns the enum values, or [] when the contract is not met", () => {
    expect(memoryTypeValues(ctx([{ name: "type", type: "enum", enumValues: ["A", "B"] }]))).toEqual(["A", "B"]);
    expect(memoryTypeValues(ctx([]))).toEqual([]);
  });
});

describe("memoryBaseHasSourceSession", () => {
  it("is true only for a text field named source_session", () => {
    expect(memoryBaseHasSourceSession({ fields: [{ name: "source_session", type: "text" }] } as any)).toBe(true);
    expect(memoryBaseHasSourceSession({ fields: [{ name: "source_session", type: "longText" }] } as any)).toBe(true);
    expect(memoryBaseHasSourceSession({ fields: [{ name: "source_session", type: "uuid" }] } as any)).toBe(false);
    expect(memoryBaseHasSourceSession({ fields: [{ name: "information", type: "text" }] } as any)).toBe(false);
    expect(memoryBaseHasSourceSession(undefined)).toBe(false);
  });
});
