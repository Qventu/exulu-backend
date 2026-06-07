import { computeTypesSignature, normalizeCanonicalKey } from "./normalize";

describe("normalizeCanonicalKey", () => {
  it("lowercases and trims", () => {
    expect(normalizeCanonicalKey("  Munich  ")).toBe("munich");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeCanonicalKey("Acme   Corp")).toBe("acme corp");
  });

  it("strips surrounding punctuation but keeps internal", () => {
    expect(normalizeCanonicalKey('"Acme, Inc."')).toBe("acme, inc");
    expect(normalizeCanonicalKey("(Globex)")).toBe("globex");
  });

  it("maps casing/spacing variants of the same name to one key", () => {
    const a = normalizeCanonicalKey("ACME");
    const b = normalizeCanonicalKey("  acme ");
    const c = normalizeCanonicalKey("Acme");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("treats different names as different keys", () => {
    expect(normalizeCanonicalKey("Munich")).not.toBe(normalizeCanonicalKey("Berlin"));
  });

  it("normalizes unicode width/compatibility forms", () => {
    // Full-width characters normalize to ASCII under NFKC.
    expect(normalizeCanonicalKey("ＡＣＭＥ")).toBe("acme");
  });
});

describe("computeTypesSignature", () => {
  it("is stable and order-independent", () => {
    const a = computeTypesSignature([
      { name: "Person", description: "x" },
      { name: "Company", description: "y" },
    ]);
    const b = computeTypesSignature([
      { name: "Company", description: "different desc" },
      { name: "Person", description: "z" },
    ]);
    expect(a).toBe(b);
  });

  it("ignores description and case in the signature", () => {
    const a = computeTypesSignature([{ name: "Person", description: "a" }]);
    const b = computeTypesSignature([{ name: "person", description: "b" }]);
    expect(a).toBe(b);
  });

  it("changes when a type is added", () => {
    const a = computeTypesSignature([{ name: "Person", description: "" }]);
    const b = computeTypesSignature([
      { name: "Person", description: "" },
      { name: "Company", description: "" },
    ]);
    expect(a).not.toBe(b);
  });

  it("deduplicates identical type names", () => {
    const a = computeTypesSignature([{ name: "Person", description: "" }]);
    const b = computeTypesSignature([
      { name: "Person", description: "" },
      { name: "Person", description: "" },
    ]);
    expect(a).toBe(b);
  });
});
