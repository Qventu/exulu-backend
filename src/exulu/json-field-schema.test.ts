import { z } from "zod";
import { loosenForTransport, mergeJson, schemaPaths, unknownPaths } from "./json-field-schema";

// Shape mirrors the M&V pitch matrix the spec is built around: a json field
// that is a record of entries, each entry a small fixed object.
const feld = z.object({ wert: z.string(), konfidenz: z.enum(["low", "high"]) });
const schema = z.record(z.string(), feld);

describe("schemaPaths", () => {
  test("schemaPaths sees through .optional()", () => {
    expect(schemaPaths(z.object({ a: z.string() }).optional())).toEqual(["a"]);
  });

  test("schemaPaths goes one level into an object-valued key", () => {
    expect(schemaPaths(z.object({ a: feld }))).toEqual(["a.wert", "a.konfidenz"]);
  });

  test("schemaPaths prefixes a top-level record's paths with the <key> placeholder", () => {
    // F2: Task 5 prints "Valid paths: <feld_key>.wert, ..." straight from
    // this list — it cannot re-derive "this schema is record-shaped" on its
    // own, since unwrap()/AnyDef are private to this module.
    expect(schemaPaths(schema)).toEqual(["<key>.wert", "<key>.konfidenz"]);
  });

  test("schemaPaths falls back to the bare placeholder for a record of scalars", () => {
    expect(schemaPaths(z.record(z.string(), z.string()))).toEqual(["<key>"]);
  });

  test("schemaPaths collects paths across union branches, de-duplicated", () => {
    // F3: Review Focus 4 names unions alongside optional/nullable/default.
    // Collecting (not narrowing) is well-defined without a value to pick a
    // branch with — the set of valid paths is just every branch's paths.
    const union = z.union([
      z.object({ a: z.string(), shared: z.string() }),
      z.object({ b: z.string(), shared: z.number() }),
    ]);
    expect(schemaPaths(union)).toEqual(["a", "shared", "b"]);
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

  test("unknownPaths flags a record entry whose value disagrees in kind with the declared object", () => {
    // F1 (Critical), pinned to the spec's own motivating example: a record
    // key is always legal, but `{ konfidenz: "low" }` supplies a scalar
    // where `feld` (an object) belongs — the real shape is
    // `felder.<feld_key>.konfidenz`, so this is a mistake, not a query, and
    // before this fix it silently returned [].
    expect(unknownPaths(z.record(z.string(), feld), { konfidenz: "low" })).toEqual([
      "konfidenz",
    ]);
  });

  test("unknownPaths flags an object key whose value disagrees in kind with the declared sub-object", () => {
    // Same disagreement-in-kind reasoning, one level up: an object schema
    // was declared for "a", a scalar was supplied.
    expect(unknownPaths(z.object({ a: feld }), { a: "not an object" })).toEqual(["a"]);
  });
});

describe("loosenForTransport", () => {
  // Task 2 review, Critical: the schema handed to the AI SDK is parsed by
  // the `ai` package's own safeParseAsync before Exulu ever sees the tool
  // call, and z.object() strips undeclared keys by default. A fix that only
  // loosens the outer object does not fix this — the nested object inside
  // `felder`'s value type strips its own extra keys independently. Both
  // levels are asserted here for exactly that reason.
  test("a top-level unknown key survives", () => {
    const loose = loosenForTransport(z.object({ a: z.string() }));
    const parsed = loose.safeParse({ a: "x", unknown: "KEEP" });
    expect(parsed.success).toBe(true);
    expect(parsed).toMatchObject({ data: { a: "x", unknown: "KEEP" } });
  });

  test("an unknown key nested one level deeper also survives", () => {
    const loose = loosenForTransport(z.object({ a: feld }));
    const parsed = loose.safeParse({ a: { wert: "x", konfidenz: "low", unknown: "KEEP" } });
    expect(parsed.success).toBe(true);
    expect(parsed).toMatchObject({ data: { a: { wert: "x", konfidenz: "low", unknown: "KEEP" } } });
  });

  test("an unknown key survives inside a record's object-shaped value type", () => {
    // schema here is z.record(z.string(), feld) — the M&V shape the rest of
    // this file uses throughout.
    const loose = loosenForTransport(schema);
    const parsed = loose.safeParse({ e1: { wert: "x", konfidenz: "low", unknown: "KEEP" } });
    expect(parsed.success).toBe(true);
    expect(parsed).toMatchObject({ data: { e1: { wert: "x", konfidenz: "low", unknown: "KEEP" } } });
  });

  test("a declared key's wrong type is still rejected after loosening — top level and nested", () => {
    const topLevel = loosenForTransport(z.object({ a: z.string() }));
    expect(topLevel.safeParse({ a: 1 }).success).toBe(false);

    const nested = loosenForTransport(z.object({ a: feld }));
    expect(nested.safeParse({ a: { wert: "x", konfidenz: "not-a-valid-enum-value" } }).success).toBe(false);
    expect(nested.safeParse({ a: "not an object" }).success).toBe(false);
  });

  test("passes through a schema with nothing object-shaped to loosen", () => {
    const stringSchema = z.string();
    expect(loosenForTransport(stringSchema)).toBe(stringSchema);
  });

  test("preserves a .describe() across the rebuild", () => {
    const described = z.object({ a: z.string() }).describe("an entry");
    expect(loosenForTransport(described).description).toBe("an entry");
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
