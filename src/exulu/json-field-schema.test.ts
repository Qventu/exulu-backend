import { z } from "zod";
import {
  leafViolations,
  loosenForTransport,
  mergeJson,
  missingRequiredKeys,
  requiresPlainObject,
  schemaPaths,
  unknownPaths,
} from "./json-field-schema";

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

  // Task 3 re-review, New 3: `shape[key]` and `subKey in childShape` both
  // walk the PROTOTYPE chain. A key named after an Object.prototype member
  // used to crash this module outright for an OBJECT-rooted schema (a
  // record never looks a key up against a fixed `shape`, so it was immune —
  // confirmed by every existing test above using `z.record(...)` without
  // ever tripping this).
  test("a prototype-named key on an OBJECT schema is flagged as unknown, not crashed on", () => {
    expect(unknownPaths(z.object({ a: z.string() }), { toString: 1 })).toEqual(["toString"]);
    expect(unknownPaths(z.object({ a: z.string() }), { constructor: 1 })).toEqual(["constructor"]);
  });

  test("a prototype-named key nested one level in is ALSO flagged — parity with an ordinary typo", () => {
    // Before the fix, `"toString" in childShape` was `true` (inherited),
    // so this key was invisible to the check while an ordinary unknown key
    // at the same position was correctly flagged — an asymmetry a model
    // could not have discovered by reading any error message.
    expect(unknownPaths(z.object({ a: feld }), { a: { wert: "x", konfidenz: "low", toString: 1 } })).toEqual([
      "a.toString",
    ]);
    expect(unknownPaths(z.object({ a: feld }), { a: { wert: "x", konfidenz: "low", typo: 1 } })).toEqual([
      "a.typo",
    ]);
  });
});

describe("leafViolations", () => {
  // Coordinator ruling (Task 3): validate each PRESENT top-level key's value
  // against its own declared sub-schema, in full. An absent key is never an
  // error — that is what keeps this safe for a shallow top-level merge
  // patch, which legitimately omits keys it is not touching.

  test("object shape: a present key's leaf value that fails its own sub-schema is reported", () => {
    const schemaObj = z.object({ a: feld, b: z.string() });
    const violations = leafViolations(schemaObj, { a: { wert: "x", konfidenz: "not-valid" } });
    expect(violations).toEqual([
      { path: "a.konfidenz", expected: expect.stringContaining("low"), received: "not-valid" },
    ]);
  });

  test("record shape: a present key's leaf value that fails Feld is reported", () => {
    // The spec's own motivating example, pinned exactly: felder.budget_gesamt.konfidenz
    // with an enum value that isn't one of the declared options.
    const violations = leafViolations(schema, { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } });
    expect(violations).toEqual([
      {
        path: "budget_gesamt.konfidenz",
        expected: expect.stringContaining("low"),
        received: "sehr hoch",
      },
    ]);
  });

  test("a valid partial patch passes even though the object schema declares other keys", () => {
    // Guards against an over-strict implementation that runs the WHOLE
    // schema's safeParse() against the patch (which would wrongly demand
    // "b" too) instead of checking only the key that is actually present.
    const schemaObj = z.object({ a: feld, b: z.string() });
    expect(leafViolations(schemaObj, { a: { wert: "x", konfidenz: "low" } })).toEqual([]);
  });

  test("an absent key is never an error, even for an empty patch", () => {
    const schemaObj = z.object({ a: feld, b: z.string() });
    expect(leafViolations(schemaObj, {})).toEqual([]);
  });

  test("sees past unknownPaths's own one-level depth cap, because the sub-schema check recurses", () => {
    // feld here nests a further object (`meta`) — unknownChildPaths never
    // looks inside it (Task 1's documented cap), but subSchema.safeParse()
    // validates its whole subtree in one call.
    const feldWithMeta = z.object({ wert: z.string(), meta: z.object({ source: z.enum(["sap", "manual"]) }) });
    const schemaWithMeta = z.record(z.string(), feldWithMeta);
    const violations = leafViolations(schemaWithMeta, {
      budget_gesamt: { wert: "1000", meta: { source: "excel" } },
    });
    expect(violations).toEqual([
      {
        path: "budget_gesamt.meta.source",
        expected: expect.stringContaining("sap"),
        received: "excel",
      },
    ]);
  });

  test("an unnamed key on an object schema is not this function's job (unknownPaths's, instead)", () => {
    const schemaObj = z.object({ a: z.string() });
    expect(leafViolations(schemaObj, { typo: "x" })).toEqual([]);
  });

  test("a prototype-named key on an object schema does not crash this function either", () => {
    // Task 3 re-review, New 3: the identical shape[key] pattern as
    // unknownPaths's, in this function's own object branch — not one of
    // the coordinator's two named repros (both against unknownPaths), but
    // the same bug class in code this task added, fixed alongside them.
    const schemaObj = z.object({ a: z.string() });
    expect(leafViolations(schemaObj, { toString: "x" })).toEqual([]);
    expect(leafViolations(schemaObj, { constructor: "x" })).toEqual([]);
  });

  test("returns [] for a non-object value and for a schema with no checkable top level", () => {
    expect(leafViolations(z.object({ a: z.string() }), "not an object")).toEqual([]);
    expect(leafViolations(z.string(), { a: "x" })).toEqual([]);
  });

  test("a union-of-literals leaf violation names the valid set, not zod's bare 'Invalid input'", () => {
    // Task 3 re-review, Important 3: z.enum's own message happens to carry
    // the set; a union of literals — a common way to spell the same "one of
    // these values" constraint — does not (zod 4.3.6's top-level
    // invalid_union message is literally "Invalid input", confirmed
    // empirically). Without deriving the set from issue.errors, this leaf
    // violation would give a model nothing to retry against.
    const schemaObj = z.object({ status: z.union([z.literal("open"), z.literal("closed")]) });
    const violations = leafViolations(schemaObj, { status: "pending" });
    expect(violations).toEqual([
      { path: "status", expected: expect.stringContaining("open"), received: "pending" },
    ]);
    expect(violations[0]?.expected).toContain("closed");
    expect(violations[0]?.expected.toLowerCase()).not.toBe("invalid input");
  });

  test("falls back to zod's own message when a union branch isn't a simple literal/enum", () => {
    // Deliberately conservative half of the same fix: a union with a
    // non-literal branch (here, a whole object) has no complete "set" to
    // report, so this must not invent a partial, misleading one.
    const schemaObj = z.object({ value: z.union([z.literal("open"), z.object({ note: z.string() })]) });
    const violations = leafViolations(schemaObj, { value: "pending" });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.expected).not.toContain(" | ");
  });
});

describe("requiresPlainObject", () => {
  // Task 3 review, Critical: unknownPaths/leafViolations both correctly
  // return [] for a non-plain-object value against ANY schema — there is
  // nothing to check paths or leaves against. This function is how a caller
  // (prepareItemWrite) tells "this schema has nothing to say about
  // non-objects by design" apart from "this schema declares an object/
  // record shape and a non-object value violates it".
  test("true for an object schema, seeing through .optional()", () => {
    expect(requiresPlainObject(z.object({ a: z.string() }).optional())).toBe(true);
  });

  test("true for a record schema", () => {
    expect(requiresPlainObject(schema)).toBe(true);
  });

  test("false for a bare scalar, an array, and a union — this module validates none of them", () => {
    expect(requiresPlainObject(z.string())).toBe(false);
    expect(requiresPlainObject(z.array(z.string()))).toBe(false);
    expect(requiresPlainObject(z.union([z.literal("a"), z.literal("b")]))).toBe(false);
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

  test("a __proto__ patch key is stored as literal data, not used to pollute the result's prototype", () => {
    // Task 3 review, Minor (overridden to required): patch keys come from
    // model-supplied JSON. JSON.parse('{"__proto__":{"polluted":true}}')
    // produces a normal OWN enumerable "__proto__" property (JSON.parse
    // does not trigger the accessor) — but the OLD `merged[key] = value`
    // line ran through Object.prototype's inherited __proto__ *setter*,
    // which reassigns the object's actual [[Prototype]] instead of storing
    // an own property. That is simultaneously a "never strip" violation
    // (the key vanishes) and live prototype pollution (confirmed
    // empirically against the pre-fix implementation before writing this
    // fix).
    const patch = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const result = mergeJson({}, patch);

    // Not polluted: the result's actual prototype is untouched.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as any).polluted).toBeUndefined();
    // Not stripped: the literal key survives as ordinary data.
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(JSON.stringify(result)).toBe('{"__proto__":{"polluted":true}}');
  });

  test("a __proto__ key can still be deleted via an explicit null, like any other key", () => {
    const patch = JSON.parse('{"__proto__":null}') as Record<string, unknown>;
    const stored = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const result = mergeJson(stored, patch);

    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

describe("missingRequiredKeys", () => {
  // Final review, Important 6. The half of the shape contract
  // `leafViolations` deliberately does not cover: it visits only PRESENT
  // keys, so an absent required key was invisible to every check.
  test("names the required top-level keys an object-rooted schema declares and the value omits", () => {
    const o = z.object({ a: z.string(), b: z.string() });
    expect(missingRequiredKeys(o, { a: "x" })).toEqual(["b"]);
    expect(missingRequiredKeys(o, { a: "x", b: "y" })).toEqual([]);
    expect(missingRequiredKeys(o, {})).toEqual(["a", "b"]);
  });

  test("optionality is asked of the sub-schema, not of its .def.type", () => {
    // Every one of these spellings accepts `undefined`, so none of them is
    // required -- and a `.def.type === "optional"` test gets at least the
    // last two wrong.
    const o = z.object({
      plain: z.string(),
      optional: z.string().optional(),
      withDefault: z.string().default("d"),
      any: z.any(),
      nullableOptional: z.string().optional().nullable(),
      optionalNullable: z.string().nullable().optional(),
    });
    expect(missingRequiredKeys(o, {})).toEqual(["plain"]);
  });

  test(".nullable() alone does not make a key optional -- it may be null, not absent", () => {
    const o = z.object({ a: z.string().nullable() });
    expect(missingRequiredKeys(o, {})).toEqual(["a"]);
    expect(missingRequiredKeys(o, { a: null })).toEqual([]);
  });

  test("sees through the field-level optional/nullable/default wrappers, same as every other function here", () => {
    const o = z.object({ a: z.string(), b: z.string() });
    expect(missingRequiredKeys(o.optional(), { a: "x" })).toEqual(["b"]);
    expect(missingRequiredKeys(o.nullable(), { a: "x" })).toEqual(["b"]);
  });

  test("a record has no required keys -- every key is a caller-chosen id (the M&V case)", () => {
    expect(missingRequiredKeys(schema, {})).toEqual([]);
    expect(missingRequiredKeys(schema, { anything: { wert: "x", konfidenz: "low" } })).toEqual([]);
  });

  test("an array- or union-rooted schema, or a non-object value, reports nothing", () => {
    expect(missingRequiredKeys(z.array(z.object({ a: z.string() })), { a: "x" })).toEqual([]);
    expect(missingRequiredKeys(z.union([z.object({ a: z.string() }), z.string()]), {})).toEqual([]);
    expect(missingRequiredKeys(z.object({ a: z.string() }), "not an object")).toEqual([]);
    expect(missingRequiredKeys(z.object({ a: z.string() }), null)).toEqual([]);
  });

  test("a declared key named after an Object.prototype member is read with hasOwn, not `in`", () => {
    // `"toString" in value` is true for ANY object, so a `key in value`
    // presence test would report a key the caller never sent as present --
    // the same prototype-chain read this module fixes everywhere else.
    const o = z.object({ toString: z.string() });
    expect(missingRequiredKeys(o, {})).toEqual(["toString"]);
    expect(missingRequiredKeys(o, JSON.parse('{"toString":"x"}'))).toEqual([]);
  });

  test("does not read .data from the probe parse -- the value it is handed is never rewritten", () => {
    // The module's central rule, asserted on the one function that parses
    // something other than the caller's value: `undefined` is parsed only
    // to ask whether a key is optional.
    const o = z.object({ a: z.string().default("injected"), b: z.string() });
    const value = { a: "mine" } as Record<string, unknown>;
    expect(missingRequiredKeys(o, value)).toEqual(["b"]);
    expect(value).toEqual({ a: "mine" });
  });
});
