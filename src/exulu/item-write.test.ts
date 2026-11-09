import { z } from "zod";
import { prepareItemWrite } from "./item-write";
import type { ExuluContextFieldDefinition } from "./context";

// Same M&V fixture as json-field-schema.test.ts: a json field that is a
// record of entries, each entry a small fixed object. Kept identical on
// purpose so a reader who has seen one file recognises the shape in the other.
const feld = z.object({ wert: z.string(), konfidenz: z.enum(["low", "medium", "high"]) });
const felderSchema = z.record(z.string(), feld);

const fields: ExuluContextFieldDefinition[] = [
  { name: "name", type: "text" },
  { name: "felder", type: "json", schema: felderSchema },
  { name: "notes", type: "json" }, // no schema declared — opaque, as today
];

describe("prepareItemWrite", () => {
  test("a field not named in merge is replaced, as today", () => {
    const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
    const input = { felder: { zielgruppe: { wert: "NEW", konfidenz: "high" } } };

    const result = prepareItemWrite({ fields, existing, input });

    expect(result).toEqual({ ok: true, values: { felder: input.felder } });
  });

  test("a field named in merge keeps stored keys the patch omits", () => {
    const existing = {
      felder: {
        budget_gesamt: { wert: "OLD", konfidenz: "low" },
        zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
      },
    };
    const input = { felder: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } };

    const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

    expect(result).toEqual({
      ok: true,
      values: {
        felder: {
          budget_gesamt: { wert: "NEW", konfidenz: "high" },
          zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
        },
      },
    });
  });

  test("merge is independent of validation: a json field with no schema still merges", () => {
    // Part B (merge) and Part A (schema) are separate concerns in the spec —
    // merge must not silently require a schema to work.
    const existing = { notes: { a: 1, b: 2 } };
    const input = { notes: { a: 9 } };

    const result = prepareItemWrite({ fields, existing, input, merge: ["notes"] });

    expect(result).toEqual({ ok: true, values: { notes: { a: 9, b: 2 } } });
  });

  test("a merge-listed, SCHEMA-LESS field whose incoming value is not an object falls back to replace", () => {
    // Degenerate input the spec never anticipates a caller sending — merging
    // a non-object patch has no defined meaning, so this does not merge into
    // whatever is stored; it replaces, the same as an un-merge-listed field.
    // This is specifically the schema-LESS case ("notes" has no declared
    // schema): a schema-carrying field's non-object value is refused
    // outright instead (see the "Critical 1" tests below) — this module has
    // no basis to refuse anything about a field's shape without a schema.
    const existing = { notes: { a: 1 } };
    const input = { notes: "a plain string, not a patch" };

    const result = prepareItemWrite({ fields, existing, input, merge: ["notes"] });

    expect(result).toEqual({ ok: true, values: { notes: "a plain string, not a patch" } });
  });

  test("a schema violation is refused, and the message names the field and what was expected", () => {
    // The spec's own motivating example: a record key is always legal, but
    // the value supplied is a scalar where the declared object ("feld")
    // belongs.
    const input = { felder: { budget_gesamt: "not an object" } };

    const result = prepareItemWrite({ fields, existing: null, input });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("felder");
    expect(result.message).toContain("budget_gesamt");
    // What is available instead — straight from schemaPaths, so the model
    // can retry with a path that actually exists.
    expect(result.message).toContain("<key>.wert");
    expect(result.message).toContain("<key>.konfidenz");
  });

  test("a refusal message never contains SQL or a Postgres type name", () => {
    const input = { felder: { budget_gesamt: "not an object" } };
    const result = prepareItemWrite({ fields, existing: null, input });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    const lower = result.message.toLowerCase();
    for (const forbidden of ["jsonb", "sql", "syntax error", "postgres", "select ", "::"]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  test("the written value is the caller's object, not a parse result (same reference)", () => {
    const input = { felder: { budget_gesamt: { wert: "1000", konfidenz: "high" } } };
    const result = prepareItemWrite({ fields, existing: null, input });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    // Reference equality, not just deep equality — proves nothing ran this
    // through schema.parse() and substituted a rebuilt object.
    expect(result.values.felder).toBe(input.felder);
  });

  test("the written value is the caller's object, not a parse result (undeclared nested key survives)", () => {
    // Global Constraints: validation never strips. A key nested past the
    // depth unknownPaths models (Task 1: one level into a named/record key)
    // is invisible to the check — and because this helper writes the
    // caller's object rather than schema.parse()'s output, it survives.
    // zod's own z.object() would have silently deleted it at parse time;
    // that silent deletion is the exact anti-goal this task exists to avoid.
    const feldWithMeta = z.object({
      wert: z.string(),
      meta: z.object({ source: z.string() }),
    });
    const schemaWithMeta = z.record(z.string(), feldWithMeta);
    const fieldsWithMeta: ExuluContextFieldDefinition[] = [
      { name: "felder", type: "json", schema: schemaWithMeta },
    ];
    const input = {
      felder: {
        budget_gesamt: { wert: "1000", meta: { source: "sap", extraInsideMeta: "KEEP" } },
      },
    };

    const result = prepareItemWrite({ fields: fieldsWithMeta, existing: null, input });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success, got refusal: " + result.message);
    expect(result.values.felder).toEqual(input.felder);
    expect((result.values.felder as any).budget_gesamt.meta.extraInsideMeta).toBe("KEEP");
  });

  test("a stored value that violates the schema still accepts a valid merge", () => {
    // Review Focus 1: a row written before the schema existed may hold a
    // shape the schema rejects. Validation only ever looks at the incoming
    // patch, never at what is already stored, or old rows become
    // permanently unwritable.
    const existing = {
      felder: {
        budget_gesamt: "a legacy string value, not a feld object at all",
      },
    };
    const input = { felder: { zielgruppe: { wert: "x", konfidenz: "low" } } };

    const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

    expect(result).toEqual({
      ok: true,
      values: {
        felder: {
          budget_gesamt: "a legacy string value, not a feld object at all",
          zielgruppe: { wert: "x", konfidenz: "low" },
        },
      },
    });
  });

  test("a merge-listed field is still validated, not just the replace path", () => {
    const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
    const input = { felder: { zielgruppe: "not an object" } };

    const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

    expect(result.ok).toBe(false);
  });

  test("a field with no matching definition passes through untouched", () => {
    const input = { untracked_legacy_column: "whatever was here stays" };

    const result = prepareItemWrite({ fields, existing: null, input });

    expect(result).toEqual({ ok: true, values: { untracked_legacy_column: "whatever was here stays" } });
  });

  test("a non-json field is never touched by merge or schema logic", () => {
    // Task 3 review, Important 4: must use an OBJECT fixture, or this test
    // can never reach the merge branch at all regardless of the type gate —
    // a string can never satisfy `isPlainObject`, so the old string fixture
    // passed even with the gate missing entirely. With an object value,
    // "name" being listed in `merge` must NOT cause a merge with `existing`
    // (merge is a `json`-field-only concept, spec Part B) — the field is
    // replaced wholesale, losing `existing.name.b`, exactly like a normal
    // non-merge-listed write would.
    const input = { name: { a: 1 } };
    const result = prepareItemWrite({ fields, existing: { name: { a: 1, b: 2 } }, input, merge: ["name"] });

    expect(result).toEqual({ ok: true, values: { name: { a: 1 } } });
  });

  // --- Formerly a known limitation, now closed (coordinator ruling) ------
  //
  // unknownPaths (Task 1) catches an unnamed key and an object/record "kind"
  // mismatch (object declared, scalar supplied). It does NOT validate a
  // scalar value against its declared leaf type — an enum member, a string
  // vs number, etc. — because that was never its contract (see its own doc
  // comment: "a bare scalar... there is nothing declared to compare
  // against"). That gap used to reach this write path unchanged.
  //
  // Closed via `leafViolations` (json-field-schema.ts): checks each PRESENT
  // top-level key's value against its own declared sub-schema, in full —
  // never the whole schema against the whole patch, which would wrongly
  // reject a valid merge patch that omits other required top-level keys.
  // This is the inverted form of the original gap-report test: same input,
  // now refused instead of silently written.
  test("a malformed enum value is refused, naming the field, path, valid values, and what was sent", () => {
    const input = { felder: { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } } };

    const result = prepareItemWrite({ fields, existing: null, input });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("felder");
    expect(result.message).toContain("budget_gesamt.konfidenz");
    expect(result.message).toContain("low");
    expect(result.message).toContain("medium");
    expect(result.message).toContain("high");
    expect(result.message).toContain("sehr hoch");
    const lower = result.message.toLowerCase();
    for (const forbidden of ["jsonb", "sql", "syntax error", "postgres", "select ", "::"]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  test("a valid partial merge patch passes even though the object-shaped json field declares other required keys", () => {
    // Guards against an over-strict leaf check: an OBJECT-shaped (not
    // record) json field with two required top-level keys, patched on only
    // one of them, must not be refused for the other's absence.
    const pitchSchema = z.object({
      budget_gesamt: z.object({ wert: z.string(), konfidenz: z.enum(["low", "medium", "high"]) }),
      zielgruppe: z.object({ wert: z.string(), konfidenz: z.enum(["low", "medium", "high"]) }),
    });
    const pitchFields: ExuluContextFieldDefinition[] = [
      { name: "pitch", type: "json", schema: pitchSchema },
    ];
    const existing = {
      pitch: {
        budget_gesamt: { wert: "OLD", konfidenz: "low" },
        zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
      },
    };
    const input = { pitch: { budget_gesamt: { wert: "NEW", konfidenz: "high" } } };

    const result = prepareItemWrite({ fields: pitchFields, existing, input, merge: ["pitch"] });

    expect(result).toEqual({
      ok: true,
      values: {
        pitch: {
          budget_gesamt: { wert: "NEW", konfidenz: "high" },
          zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
        },
      },
    });
  });

  test("an absent key is never an error — an empty merge patch is accepted untouched", () => {
    const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
    const input = { felder: {} };

    const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

    expect(result).toEqual({
      ok: true,
      values: { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } },
    });
  });

  // --- Second re-review round: Critical 1 -----------------------------
  //
  // unknownPaths/leafViolations both correctly return "nothing wrong" for a
  // non-plain-object value against ANY schema (there's nothing to check
  // paths/leaves against) — but for a schema that DOES declare an object or
  // record shape, that "nothing to check" must not read as "write it
  // through". Before this fix, a merge-listed field given a bare string/
  // array/null/number fell through to a silent REPLACE, deleting the entire
  // stored object with an `ok: true` verdict.
  describe("Critical 1: a non-plain-object value on an object/record-schema field is refused, not waved through", () => {
    test.each([
      ["a string", "oops"],
      ["an array", [1, 2, 3]],
      ["null", null],
      ["a number", 42],
    ])("merge-listed, value is %s", (_label, value) => {
      const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      const input = { felder: value };

      const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

      // Must be refused — NOT `ok: true` with the stored object silently
      // replaced/destroyed, which was the exact defect reported.
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a refusal, got values.felder = ${JSON.stringify(result.values.felder)}`);
      expect(result.message).toContain("felder");
    });

    test("also refused on a plain REPLACE (not merge-listed) — the shape check is unconditional", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { felder: "oops" } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message).toContain("object");
    });

    test("the refusal names the field, what was sent, and the valid paths (four-part contract)", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { felder: [1, 2, 3] } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message).toContain("array"); // what was rejected / why
      expect(result.message).toContain("<key>.wert"); // what's available instead
      expect(result.message).toContain("<key>.konfidenz");
      const lower = result.message.toLowerCase();
      for (const forbidden of ["jsonb", "sql", "syntax error", "postgres", "select ", "::"]) {
        expect(lower).not.toContain(forbidden);
      }
    });

    test("a non-object-or-record schema (array-rooted) is untouched by the shape check — documented inertness, not this round's fix", () => {
      // requiresPlainObject is deliberately narrow: an array- or union-
      // rooted json field schema is validated by NOTHING in this module
      // today (ledgered for the final review, not fixed this round). A
      // bare array value against such a schema must not be refused by a
      // check that doesn't apply to it.
      const arraySchema = z.array(z.string());
      const arrayFields: ExuluContextFieldDefinition[] = [{ name: "tags", type: "json", schema: arraySchema }];

      const result = prepareItemWrite({ fields: arrayFields, existing: null, input: { tags: ["a", "b"] } });

      expect(result).toEqual({ ok: true, values: { tags: ["a", "b"] } });
    });
  });

  // --- Second re-review round: Important 2 ----------------------------
  //
  // Coordinator's added clause: for a merge-listed field, a patch's own
  // top-level null-valued entry is a deletion (spec Part B / mergeJson),
  // not a value — exempt from both checks, or every deletion is refused,
  // and the refusal's own "here are the valid paths" message induces a
  // destructive repair (resend without `merge`, which replaces the WHOLE
  // field and destroys every key the deletion wasn't touching).
  describe("Important 2: null-as-delete is usable on a schema-carrying, merge-listed field", () => {
    test("a merge patch that deletes one record entry via null is accepted, not refused", () => {
      const existing = {
        felder: {
          budget_gesamt: { wert: "OLD", konfidenz: "low" },
          zielgruppe: { wert: "KEEP", konfidenz: "medium" },
        },
      };
      const input = { felder: { budget_gesamt: null } };

      const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

      expect(result).toEqual({
        ok: true,
        values: { felder: { zielgruppe: { wert: "KEEP", konfidenz: "medium" } } },
      });
    });

    test("a deletion can be combined with a valid same-call update to another key", () => {
      const existing = {
        felder: {
          budget_gesamt: { wert: "OLD", konfidenz: "low" },
          zielgruppe: { wert: "OLD", konfidenz: "medium" },
        },
      };
      const input = { felder: { budget_gesamt: null, zielgruppe: { wert: "NEW", konfidenz: "high" } } };

      const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

      expect(result).toEqual({
        ok: true,
        values: { felder: { zielgruppe: { wert: "NEW", konfidenz: "high" } } },
      });
    });

    test("the SAME null entry is still flagged normally on a plain REPLACE (no delete sentinel outside merge)", () => {
      // Spec Part B only defines null-as-delete for merge. Without `merge`,
      // this is just a value, and `null` where an object ("feld") belongs
      // is exactly the kind-mismatch unknownPaths already catches.
      const input = { felder: { budget_gesamt: null } };

      const result = prepareItemWrite({ fields, existing: null, input });

      expect(result.ok).toBe(false);
    });
  });

  // --- Second re-review round: Minor (overridden to required) ---------
  test("a refusal message never throws building itself on a BigInt at the SHAPE gate", () => {
    // Minor: JSON.stringify throws on a BigInt. A top-level BigInt trips
    // Critical 1's shape check (typeof 10n !== "object") before reaching
    // safeStringify's only pre-fix call site at all — see the NEXT test for
    // the one that actually exercises leafRefusalMessage's stringify.
    expect(() => prepareItemWrite({ fields, existing: null, input: { felder: 10n as unknown } })).not.toThrow();

    const result = prepareItemWrite({ fields, existing: null, input: { felder: 10n as unknown } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("felder");
  });

  test("a refusal message never throws building itself on a BigInt LEAF value (closes a disclosed coverage gap)", () => {
    // Coordinator follow-up: the test above short-circuits at the shape
    // gate and never reaches leafRefusalMessage — the only JSON.stringify
    // that existed before this task's fixes. A BigInt nested inside an
    // otherwise-valid top-level object reaches leafViolations/
    // leafRefusalMessage instead.
    const input = { felder: { budget_gesamt: { wert: 10n as unknown, konfidenz: "low" } } };

    expect(() => prepareItemWrite({ fields, existing: null, input })).not.toThrow();

    const result = prepareItemWrite({ fields, existing: null, input });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("felder");
    expect(result.message).toContain("budget_gesamt.wert");
    // String(10n) is "10" (the "n" suffix is literal syntax, not part of
    // the runtime string conversion) — asserting the actual observed
    // fallback output, not an assumption about what it would look like.
    expect(result.message).toContain("10");
  });

  // --- Third re-review round: New 1 ------------------------------------
  //
  // The I2 fix (omitNullEntries) built its validation-only copy with plain
  // bracket assignment, reopening the EXACT __proto__ footgun mergeJson was
  // just fixed for — except here it is a VALIDATION BYPASS: a `__proto__`
  // patch key vanishes from the filtered copy before either check ever
  // sees it (Object.keys on the result no longer contains it), so the
  // payload sails through as `ok: true` and mergeJson (already safe) then
  // writes it verbatim. The identical payload on a plain REPLACE was
  // already correctly refused the whole time — that asymmetry is exactly
  // how this hid.
  describe("New 1: a __proto__ merge-patch key cannot bypass validation", () => {
    test("merge path refuses it, matching the replace path's existing behaviour", () => {
      const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      // Built via JSON.parse, like the coordinator's repro and the
      // mergeJson tests — a normal own enumerable "__proto__" property,
      // not an exotic construction.
      const input = { felder: JSON.parse('{"__proto__":{"NOT_A_FELD":true}}') };

      const mergeResult = prepareItemWrite({ fields, existing, input, merge: ["felder"] });
      const replaceResult = prepareItemWrite({ fields, existing, input });

      expect(mergeResult.ok).toBe(false);
      expect(replaceResult.ok).toBe(false);
    });

    test("a literal __proto__ key can still be deleted via null, and the result stays unpolluted", () => {
      // The legitimate case `omitNullEntries` exists to support at all: a
      // stored row that happens to hold an own "__proto__" key (itself
      // safe to read back — `{...existing}` is immune, same as mergeJson's
      // own spread) gets it deleted via an explicit null, same as any
      // other key. This end-to-end path exercises BOTH this round's fix
      // (the filtered copy no longer silently drops the entry before
      // validation) and round 2's mergeJson fix (the actual write doesn't
      // corrupt the result's prototype) together.
      const existing = {
        felder: JSON.parse(
          '{"__proto__":{"wert":"OLD","konfidenz":"low"},"zielgruppe":{"wert":"KEEP","konfidenz":"medium"}}',
        ),
      };
      const input = { felder: JSON.parse('{"__proto__":null}') };

      const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success, got: " + result.message);
      const felderResult = result.values.felder as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(felderResult, "__proto__")).toBe(false);
      expect(Object.getPrototypeOf(felderResult)).toBe(Object.prototype);
      expect(felderResult).toEqual({ zielgruppe: { wert: "KEEP", konfidenz: "medium" } });
    });
  });

  // --- Third re-review round: New 2 ------------------------------------
  //
  // Re-ruling: requiresPlainObject reports the UNWRAPPED shape, which is
  // the wrong tool for deciding which VALUES a schema accepts — a
  // `.nullable()`/`.optional()` wrapper is a declared exception to exactly
  // the shape it wraps. The shape gate must defer to `schema.safeParse
  // (value).success` (read-only, never `.data`) before refusing.
  describe("New 2: the shape gate respects .nullable()/.optional(), not just the unwrapped shape", () => {
    const nullableFelderSchema = felderSchema.nullable();
    const nullableFields: ExuluContextFieldDefinition[] = [{ name: "felder", type: "json", schema: nullableFelderSchema }];

    test("a .nullable() record schema accepts a literal null — not refused by the shape gate", () => {
      const result = prepareItemWrite({ fields: nullableFields, existing: null, input: { felder: null } });
      expect(result).toEqual({ ok: true, values: { felder: null } });
    });

    test("the SAME .nullable() schema still refuses a value that is neither null nor a valid record", () => {
      const result = prepareItemWrite({ fields: nullableFields, existing: null, input: { felder: "oops" } });
      expect(result.ok).toBe(false);
    });

    const optionalPitchSchema = z.object({ a: z.object({ wert: z.string() }) }).optional();
    const optionalFields: ExuluContextFieldDefinition[] = [{ name: "pitch", type: "json", schema: optionalPitchSchema }];

    test("an .optional() object schema accepts undefined", () => {
      const result = prepareItemWrite({ fields: optionalFields, existing: null, input: { pitch: undefined } });
      expect(result).toEqual({ ok: true, values: { pitch: undefined } });
    });

    test("a PLAIN (non-nullable) record schema still refuses null — the re-ruling narrows, it does not loosen", () => {
      // Regression guard: felderSchema (used throughout this file) is NOT
      // wrapped, so this must behave exactly as Critical 1 originally
      // required.
      const result = prepareItemWrite({ fields, existing: null, input: { felder: null } });
      expect(result.ok).toBe(false);
    });
  });

  // --- Third re-review round: New 3 ------------------------------------
  //
  // Overridden into scope: an unnamed-key lookup on an OBJECT-rooted schema
  // used `shape[key]`/`key in childShape`, both prototype-chain lookups on
  // an untrusted key. A record-rooted schema (every fixture elsewhere in
  // this file) never does this lookup at all, which is why it never showed
  // up here despite being exercised constantly above.
  describe("New 3: a prototype-colliding key on an object-rooted schema is refused, not an unhandled throw", () => {
    const cfgSchema = z.object({ a: z.string() });
    const cfgFields: ExuluContextFieldDefinition[] = [{ name: "cfg", type: "json", schema: cfgSchema }];

    test.each(["constructor", "toString", "hasOwnProperty"])("key %s is refused cleanly, not thrown", (key) => {
      const input = { cfg: { [key]: { x: 1 } } };

      expect(() => prepareItemWrite({ fields: cfgFields, existing: null, input })).not.toThrow();

      const result = prepareItemWrite({ fields: cfgFields, existing: null, input });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("cfg");
    });
  });
});
