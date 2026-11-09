import { z } from "zod";
import { mergeJson, schemaPaths, unknownPaths } from "./json-field-schema";

// Shape mirrors the M&V pitch matrix the spec is built around: a json field
// that is a record of entries, each entry a small fixed object. Declared
// here but exercised only by schemaPaths/unknownPaths tests below that need
// a nested object, not by the record itself — Task 1 does not have a test
// that calls these functions with a top-level record schema (see report).
const feld = z.object({ wert: z.string(), konfidenz: z.enum(["low", "high"]) });
const schema = z.record(z.string(), feld);

describe("schemaPaths", () => {
  test("schemaPaths sees through .optional()", () => {
    expect(schemaPaths(z.object({ a: z.string() }).optional())).toEqual(["a"]);
  });

  test("schemaPaths goes one level into an object-valued key", () => {
    expect(schemaPaths(z.object({ a: feld }))).toEqual(["a.wert", "a.konfidenz"]);
  });

  test("schemaPaths delegates a top-level record to its value type", () => {
    expect(schemaPaths(schema)).toEqual(["wert", "konfidenz"]);
  });
});

describe("unknownPaths", () => {
  test("unknownPaths names a path the schema does not define", () => {
    expect(unknownPaths(z.object({ a: feld }), { b: { wert: "x" } })).toEqual(["b"]);
  });

  test("unknownPaths is empty when every path is known", () => {
    expect(unknownPaths(z.object({ a: feld }), { a: { wert: "x" } })).toEqual([]);
  });

  test("unknownPaths names a path one level inside a known key", () => {
    expect(unknownPaths(z.object({ a: feld }), { a: { wert: "x", extra: 1 } })).toEqual([
      "a.extra",
    ]);
  });

  test("unknownPaths permits any top-level key of a record but checks underneath it", () => {
    expect(unknownPaths(schema, { e1: { wert: "x", bogus: 1 } })).toEqual(["e1.bogus"]);
  });

  test("unknownPaths returns empty for a non-object value", () => {
    expect(unknownPaths(z.object({ a: z.string() }), "not an object")).toEqual([]);
  });
});

describe("mergeJson", () => {
  test("mergeJson keeps keys the patch does not mention", () => {
    expect(mergeJson({ a: 1, b: 2 }, { a: 9 })).toEqual({ a: 9, b: 2 });
  });

  test("mergeJson deletes a key given explicit null", () => {
    expect(mergeJson({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  test("mergeJson treats a null stored value as empty", () => {
    expect(mergeJson(null, { a: 1 })).toEqual({ a: 1 });
  });

  test("mergeJson treats an undefined stored value as empty", () => {
    expect(mergeJson(undefined, { a: 1 })).toEqual({ a: 1 });
  });

  test("mergeJson treats a non-object stored value as empty", () => {
    expect(mergeJson("not an object", { a: 1 })).toEqual({ a: 1 });
  });
});
