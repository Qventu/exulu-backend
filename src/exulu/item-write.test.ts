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

  // --- Formerly a known limitation, now closed (Task 4 fix round 2,
  // Important 4) ---------------------------------------------------------
  //
  // This used to silently fall back to a plain REPLACE: merging a
  // non-object patch has no defined meaning, so there was nothing to merge
  // INTO whatever was stored — it just replaced, the same as an
  // un-merge-listed field. That was reachable in production (confirmed
  // live): `users.favourite_items`/`favourite_artifacts`/`favourite_projects`
  // are schema-less json ARRAY columns, and merge-listing one of them with
  // an array value silently replaced the whole list instead of refusing —
  // directly contradicting the generated tools' and the GraphQL SDL's own
  // "only the keys given are changed, other stored keys are kept"
  // description of what `merge` does. A schema-carrying field's non-object
  // value is refused outright already (see the "Critical 1" tests below);
  // this closes the identical gap for the schema-LESS case, inverting the
  // original gap-report test rather than deleting it.
  test("a merge-listed, SCHEMA-LESS field whose incoming value is not an object is now refused, not silently replaced", () => {
    // A NUMBER, not a string (Task 4 fix round 3 moved the "a plain string"
    // version of this input onto a different, now-dedicated code path --
    // see "a merge-listed, SCHEMA-LESS field whose string value is not
    // valid JSON at all" below). This keeps testing Important 4's original
    // claim in isolation: a non-object, non-string merge value is refused.
    const existing = { notes: { a: 1 } };
    const input = { notes: 42 };

    const result = prepareItemWrite({ fields, existing, input, merge: ["notes"] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("notes");
    expect(result.message.toLowerCase()).toContain("merge");
  });

  // --- Task 4 fix round 3: a json field's value may legitimately be a
  // SERIALIZED STRING (coerce.ts's import cells; the generated tool's
  // z.string() transport for a schema-less field) -------------------------
  test("a merge-listed, SCHEMA-LESS field whose string value is not valid JSON at all is refused, naming the parse failure (not 'a string was sent')", () => {
    const existing = { notes: { a: 1 } };
    const input = { notes: "a plain string, not a patch" };

    const result = prepareItemWrite({ fields, existing, input, merge: ["notes"] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain("notes");
    expect(result.message.toLowerCase()).toContain("json");
    expect(result.message.toLowerCase()).toContain("parse");
    // The misleading framing this round replaced:
    expect(result.message).not.toContain("a string was sent");
  });

  test("a merge-listed, SCHEMA-LESS field whose value is a STRING that DOES parse to an object now actually merges (closes the 'merge refused by construction' gap)", () => {
    // Before this fix: isPlainObject(value) was false for ANY string, so
    // this fell into Important 4's non-object refusal even though the
    // string's CONTENT was a perfectly valid patch -- the generated tool
    // advertises `merge` on every json field, including schema-less ones
    // whose transport is bare z.string(), so merge on those was refused
    // by construction until now.
    const existing = { notes: { a: 1, b: 2 } };
    const input = { notes: JSON.stringify({ a: 9 }) };

    const result = prepareItemWrite({ fields, existing, input, merge: ["notes"] });

    expect(result).toEqual({ ok: true, values: { notes: { a: 9, b: 2 } } });
  });

  test("the exact live repro: a schema-less json ARRAY column merge-listed with a replacement array is refused, not silently replaced", () => {
    // users.favourite_items/favourite_artifacts/favourite_projects shape:
    // a schema-less json field whose stored value is always an array.
    const arrayFields: ExuluContextFieldDefinition[] = [{ name: "favourite_items", type: "json" }];
    const existing = { favourite_items: ["old-1", "old-2"] };
    const input = { favourite_items: ["new-1"] };

    const result = prepareItemWrite({ fields: arrayFields, existing, input, merge: ["favourite_items"] });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error(
        `expected a refusal, got the list silently replaced: ${JSON.stringify(result.values.favourite_items)}`,
      );
    }
    expect(result.message).toContain("favourite_items");
    expect(result.message.toLowerCase()).toContain("array");
    expect(result.message.toLowerCase()).toContain("merge");
  });

  test("the SAME array value is accepted on a plain REPLACE (no merge) — this rule is merge-only", () => {
    const arrayFields: ExuluContextFieldDefinition[] = [{ name: "favourite_items", type: "json" }];
    const result = prepareItemWrite({
      fields: arrayFields,
      existing: { favourite_items: ["old-1"] },
      input: { favourite_items: ["new-1"] },
    });

    expect(result).toEqual({ ok: true, values: { favourite_items: ["new-1"] } });
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

  // --- Task 4 fix round 3: coerce.ts's wire form (a serialized JSON STRING)
  // --------------------------------------------------------------------
  //
  // src/exulu/import/coerce.ts validates a json cell with JSON.parse and
  // then deliberately returns the STRING, not the parsed value -- both
  // write paths only stringify an object/array before a jsonb write, so a
  // string passes straight through and Postgres casts it. Before this
  // fix, every bulk-import row touching a schema-carrying json column was
  // refused with "the value must be a JSON object... but a string was
  // sent" -- true of the wire form, false and misleading about the
  // content, which was already a valid JSON object.
  // Framing note (Task 4 fix round 4, re-review's deferred list): calling
  // the whole block below "coerce.ts's own wire form" overstates it.
  // coerce.ts's own cells (`importCellValue` above and the valid-content
  // tests using it) genuinely are what it produces -- but the "does not
  // parse at all" test further down is NOT: coerce.ts validates with
  // `JSON.parse` and returns an ERROR cell (never handing the chokepoint a
  // garbage string) when that fails, so that specific test is a defensive
  // check for ANY caller that might send an unparseable string (a model
  // via the schema-less z.string() transport, a direct API call), not a
  // simulation of coerce.ts's behaviour.
  describe("a json field's value may legitimately arrive as a serialized JSON string (coerce.ts's own wire form, for the parseable cases)", () => {
    const importCellValue = JSON.stringify({ budget_gesamt: { wert: "1000", konfidenz: "low" } });

    test("a STRING that parses to a valid value is accepted, not refused for 'being a string'", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { felder: importCellValue } });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success, got: " + result.message);
    });

    test("the WRITTEN value is still the caller's original STRING, unchanged — never-strip holds for a string input too", () => {
      const input = { felder: importCellValue };
      const result = prepareItemWrite({ fields, existing: null, input });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success, got: " + result.message);
      // Same reference, not the parsed object -- parsing only ever informs
      // the checks; it never becomes what gets stored.
      expect(result.values.felder).toBe(input.felder);
      expect(typeof result.values.felder).toBe("string");
    });

    test("THE EXACT REPORTED REPRO: a STRING whose parsed content violates the schema is refused with the real leaf violation, not 'a string was sent'", () => {
      // mv_pitches_itemsUpdateOneById(id, input: { felder: { budget_gesamt:
      // { wert: "1000", konfidenz: "sehr hoch" } } }) serialized exactly as
      // coerce.ts would hand it to context.ts.
      const badImportCellValue = JSON.stringify({ budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } });
      const result = prepareItemWrite({ fields, existing: null, input: { felder: badImportCellValue } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message).toContain("budget_gesamt.konfidenz");
      expect(result.message).toContain("sehr hoch");
      // The misleading framing this round replaced:
      expect(result.message).not.toContain("a string was sent");
    });

    test("a STRING that does not parse as JSON at all is refused naming the parse failure, not 'a string was sent'", () => {
      // NOT a coerce.ts shape (framing note above): coerce.ts rejects an
      // unparseable cell itself, with an error, before the chokepoint ever
      // sees it. This defends any OTHER caller that could still send
      // garbage -- a model via the schema-less z.string() transport, or a
      // direct API/GraphQL call.
      const result = prepareItemWrite({ fields, existing: null, input: { felder: "not json at all" } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message.toLowerCase()).toContain("parse");
      expect(result.message).not.toContain("a string was sent");
    });

    test("a MERGE-listed field's STRING patch is parsed and merged, keeping stored keys the string patch omits", () => {
      const existing = {
        felder: {
          budget_gesamt: { wert: "OLD", konfidenz: "low" },
          zielgruppe: { wert: "UNTOUCHED", konfidenz: "medium" },
        },
      };
      const input = { felder: JSON.stringify({ budget_gesamt: { wert: "NEW", konfidenz: "high" } }) };

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

    test("a MERGE-listed field's STRING value of literal 'null' is refused the same way a bare null patch is", () => {
      const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      const result = prepareItemWrite({ fields, existing, input: { felder: "null" }, merge: ["felder"] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message.toLowerCase()).toContain("merge");
      expect(result.message.toLowerCase()).toContain("replace");
    });
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

  test("a non-json field named in merge is refused, not silently replaced", () => {
    // Task 3 review, Important 4 required an OBJECT fixture here, or this
    // test could never reach the merge branch at all regardless of the type
    // gate — a string can never satisfy `isPlainObject`, so the original
    // string fixture passed even with the gate missing entirely. Kept as an
    // object for that reason.
    //
    // The ASSERTION is inverted by the final review's Important 1. The old
    // expectation was `ok: true` with `name` replaced wholesale, losing
    // `existing.name.b` — i.e. the caller asked to merge and silently got a
    // destructive replace. That is the same failure as the `"Felder"`
    // capitalisation repro, reached by naming a non-json field instead of
    // misspelling a json one, so it gets the same answer: refused. The type
    // gate the original test was written for is still there and still stops
    // `mergeJson` from running on a non-json field; the write just no longer
    // proceeds as a replace behind the caller's back.
    const input = { name: { a: 1 } };
    const result = prepareItemWrite({ fields, existing: { name: { a: 1, b: 2 } }, input, merge: ["name"] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.message).toContain('"merge" names "name"');
    expect(result.message).toContain("not a json field");
    // "What is available instead": the json fields this write could merge.
    expect(result.message).toContain("json fields this write can merge into");
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
      // "oops" is not valid JSON at all, so (Task 4 fix round 3) this is
      // refused via the string-parse-failure path rather than the shape
      // check directly -- both still refuse unconditionally, merge or not.
      const result = prepareItemWrite({ fields, existing: null, input: { felder: "oops" } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message.toLowerCase()).toContain("parse");
    });

    test("also refused on a plain REPLACE for a string that IS valid JSON but the wrong shape — the shape check itself, not just the parse-failure path", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { felder: JSON.stringify([1, 2, 3]) } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message).toContain("object");
      expect(result.message).toContain("array");
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
    //
    // Tightened (Task 3 third re-review): calls prepareItemWrite exactly
    // ONCE, inside the `.not.toThrow()` check itself, via the `result`
    // closure variable. The earlier two-call version let the SECOND,
    // unwrapped call throw too when the fix was reverted — so the test
    // failed at that line (an uncaught exception) before `toContain("10")`
    // ever ran, meaning that assertion's own discriminating power was
    // entirely carried by its `.not.toThrow()` sibling rather than
    // standing on its own. With one call, a future change that stops
    // throwing but changes the fallback's format (e.g. a different
    // stand-in for the BigInt) would be caught by `toContain("10")` on its
    // own merit.
    let result!: ReturnType<typeof prepareItemWrite>;
    const input = { felder: { budget_gesamt: { wert: 10n as unknown, konfidenz: "low" } } };
    expect(() => {
      result = prepareItemWrite({ fields, existing: null, input });
    }).not.toThrow();

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
    test("merge path refuses it FOR THE SAME REASON as the replace path, not merely ok:false", () => {
      // Tightened (Task 3 third re-review): the original version of this
      // test only checked `.ok === false` on both paths, which does not
      // by itself prove the merge path is refusing because of the
      // __proto__ entry's content rather than some unrelated reason.
      // Pinning the actual message — and that it is IDENTICAL on both
      // paths — proves the refusal is for the right reason: unknownPaths
      // sees "__proto__.NOT_A_FELD" as an unnamed key under "__proto__" on
      // BOTH paths once the filtered copy correctly retains the key.
      const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      // Built via JSON.parse, like the coordinator's repro and the
      // mergeJson tests — a normal own enumerable "__proto__" property,
      // not an exotic construction.
      const input = { felder: JSON.parse('{"__proto__":{"NOT_A_FELD":true}}') };

      const mergeResult = prepareItemWrite({ fields, existing, input, merge: ["felder"] });
      const replaceResult = prepareItemWrite({ fields, existing, input });

      expect(mergeResult.ok).toBe(false);
      expect(replaceResult.ok).toBe(false);
      if (mergeResult.ok || replaceResult.ok) throw new Error("expected both to refuse");
      expect(mergeResult.message).toContain("felder");
      expect(mergeResult.message).toContain("__proto__.NOT_A_FELD");
      expect(mergeResult.message).toBe(replaceResult.message);
    });

    // NOTE: this is NOT the test that discriminates the Object.create(null)
    // fix above, despite an earlier version of this file's comment claiming
    // it was (Task 3 third re-review, Important 3). `{"__proto__": null}`'s
    // value is `null`, so `omitNullEntries`'s own `if (inner !== null)`
    // guard skips the assignment line ENTIRELY for this key — the line
    // `Object.create(null)` vs `{}` fixed is never reached, with either
    // implementation, for a null-valued entry. Verified directly: running
    // both the old (`{}`) and the new (`Object.create(null)`)
    // implementations side by side on this exact input yields
    // `Object.keys(...) === []` for BOTH. The test above (a NON-null
    // `__proto__` value) is the one that actually exercises the fix. This
    // test instead pins a separate, genuinely true, legitimate behaviour:
    // a stored row that happens to hold an own "__proto__" key (itself
    // safe to read back — `{...existing}` is immune, same as mergeJson's
    // own spread) can still have it deleted via an explicit null, same as
    // any other key, and the result stays unpolluted (round 2's mergeJson
    // fix, exercised end-to-end here).
    test("a literal __proto__ key can still be deleted via null (a different, legitimate behaviour — not a fix-discriminating test)", () => {
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

    // --- Superseded by Task 4 fix round 4's Critical ruling ---------------
    //
    // Formerly: "a PLAIN (non-nullable) record schema still refuses null —
    // the re-ruling narrows, it does not loosen" (Task 3, New 2) — the
    // point then was that `requiresPlainObject` reports the UNWRAPPED
    // shape, so the shape gate must defer to `schema.safeParse(value)`
    // rather than let every schema through. Fix round 4's Critical ruling
    // supersedes this specifically for a top-level REPLACE: a blank CSV
    // cell (the most common sparse-column shape there is) coerces to a
    // literal `null`, and a schema describes the shape of a value that
    // EXISTS, not whether a column may be null — that is `required`'s job.
    // So a top-level null on a plain REPLACE is now exempt from schema
    // validation UNCONDITIONALLY, before the `schema.safeParse` path this
    // test used to exercise is ever reached — whether the schema is
    // wrapped in `.nullable()` or not makes no difference any more for
    // this specific case. Merge still refuses a top-level null
    // unconditionally either way (Task 3's original rule, untouched by
    // this round — see the "Important 1 (latent)" block above).
    test("a PLAIN (non-nullable) record schema now ALSO accepts a top-level null on a plain REPLACE (fix round 4 ruling)", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { felder: null } });
      expect(result).toEqual({ ok: true, values: { felder: null } });
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

  // --- Fourth re-review round: Important 1 (latent) --------------------
  //
  // My own re-ruling in round 3 said the shape gate must defer to
  // `schema.safeParse(value).success` — satisfied as written for a
  // `.nullable()` schema, since the schema DOES declare null legal. But
  // merge means patch (spec Part B): a top-level `null` IS the patch here,
  // not an entry inside one, and collapsing "clear the whole field" into
  // the same spelling as "delete one key" reopens exactly the shape
  // Critical 1 exists to prevent — just through the door a
  // declared-nullable schema opens, which the type-level safeParse check
  // has no way to see as an operation mismatch rather than a value one.
  describe("Important 1 (latent): a top-level null on a merge-listed field is refused regardless of what the schema declares", () => {
    const nullableFelderSchema = felderSchema.nullable();
    const nullableFields: ExuluContextFieldDefinition[] = [{ name: "felder", type: "json", schema: nullableFelderSchema }];

    test("a .nullable() schema's own null-legality does not make null a legal MERGE PATCH", () => {
      const existing = {
        felder: {
          budget_gesamt: { wert: "OLD", konfidenz: "low" },
          zielgruppe: { wert: "KEEP", konfidenz: "medium" },
        },
      };

      const result = prepareItemWrite({ fields: nullableFields, existing, input: { felder: null }, merge: ["felder"] });

      // Must be refused — NOT `ok: true, values: { felder: null }`, which
      // silently wipes both stored keys. This is the exact repro reported.
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a refusal, got values.felder = ${JSON.stringify(result.values.felder)}`);
      expect(result.message).toContain("felder");
      expect(result.message.toLowerCase()).toContain("merge");
      expect(result.message.toLowerCase()).toContain("replace");
      const lower = result.message.toLowerCase();
      for (const forbidden of ["jsonb", "sql", "syntax error", "postgres", "select ", "::"]) {
        expect(lower).not.toContain(forbidden);
      }
    });

    test("the SAME null is still accepted on a plain REPLACE — this rule is merge-only", () => {
      const result = prepareItemWrite({ fields: nullableFields, existing: null, input: { felder: null } });
      expect(result).toEqual({ ok: true, values: { felder: null } });
    });

    test("a non-nullable, SCHEMA-LESS merge-listed field is refused the same way — the rule is not about schemas at all", () => {
      // The rule fires on `isMergeField && value === null` BEFORE the
      // schema check even runs, so a merge-listed json field with no
      // schema at all must be refused too — otherwise this would just
      // move the hole from "nullable schemas" to "no schema".
      const schemaLessFields: ExuluContextFieldDefinition[] = [{ name: "notes", type: "json" }];
      const result = prepareItemWrite({
        fields: schemaLessFields,
        existing: { notes: { a: 1, b: 2 } },
        input: { notes: null },
        merge: ["notes"],
      });

      expect(result.ok).toBe(false);
    });

    test("a deletion of one key inside the patch is unaffected — only the PATCH ITSELF being null is refused", () => {
      // Important 2 (round 2) still works: null one level IN, not AT the
      // top, is a delete sentinel, not a clear-the-field operation.
      const existing = {
        felder: {
          budget_gesamt: { wert: "OLD", konfidenz: "low" },
          zielgruppe: { wert: "KEEP", konfidenz: "medium" },
        },
      };
      const result = prepareItemWrite({
        fields: nullableFields,
        existing,
        input: { felder: { budget_gesamt: null } },
        merge: ["felder"],
      });

      expect(result).toEqual({
        ok: true,
        values: { felder: { zielgruppe: { wert: "KEEP", konfidenz: "medium" } } },
      });
    });
  });

  // --- Fourth re-review round: Important 2 ------------------------------
  //
  // `mergeJson` got `Object.defineProperty`, `omitNullEntries` got
  // `Object.create(null)` — the chokepoint's own accumulator (`values`)
  // got neither. `key` in the main loop comes straight from
  // `Object.entries(input)`, exactly as untrusted as every other key this
  // task has guarded against; an own top-level `"__proto__"` key in
  // `input` ran through the inherited setter on `values[key] = value`,
  // corrupting the FUNCTION'S OWN RETURN VALUE rather than merely failing
  // to validate one field.
  describe("Important 2: the values accumulator itself cannot be prototype-polluted by a top-level input key", () => {
    test("an own top-level __proto__ key in input does not corrupt the returned values object's prototype", () => {
      const input = JSON.parse('{"__proto__":{"NOT_A_COLUMN":true}}') as Record<string, unknown>;
      const result = prepareItemWrite({ fields, existing: null, input });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success, got: " + result.message);
      expect(Object.getPrototypeOf(result.values)).toBe(Object.prototype);
      expect((result.values as any).NOT_A_COLUMN).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(result.values, "__proto__")).toBe(true);
      // NOT `toEqual({ __proto__: {...} })` — a non-computed `__proto__:`
      // key in an object LITERAL is special-cased by the language to set
      // the literal's actual prototype, not create an own property (the
      // opposite of what's being asserted here, confirmed empirically
      // while writing this test: `Object.keys({ __proto__: {a:1} })` is
      // `[]`). JSON.stringify, which only ever walks OWN enumerable
      // properties, is the comparison that actually exercises what this
      // test is about.
      expect(JSON.stringify(result.values)).toBe('{"__proto__":{"NOT_A_COLUMN":true}}');
    });

    test("the same protection applies when the key is written via the MERGE branch, not just the replace branch", () => {
      // The merge branch's own assignment (`values[key] = mergeJson(...)`)
      // is a second, independent site of the identical pattern — this
      // schema-less json field exercises that branch specifically.
      const schemaLessFields: ExuluContextFieldDefinition[] = [{ name: "__proto__", type: "json" }];
      const existing = JSON.parse('{"__proto__":{"a":1}}') as Record<string, unknown>;
      const input = JSON.parse('{"__proto__":{"b":2}}') as Record<string, unknown>;

      const result = prepareItemWrite({ fields: schemaLessFields, existing, input, merge: ["__proto__"] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success, got: " + result.message);
      expect(Object.getPrototypeOf(result.values)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(result.values, "__proto__")).toBe(true);
      // Same reasoning as the test above: JSON.stringify, not a literal
      // `toEqual({ __proto__: ... })`.
      expect(JSON.stringify(result.values)).toBe('{"__proto__":{"a":1,"b":2}}');
    });
  });

  // --- Task 4 fix round 4, Critical: a blank CSV cell fails every import --
  // --- row on a schema-carrying json column --------------------------------
  //
  // coerce.ts maps a blank cell to `value: null` (never "", never an
  // error) -- the most common sparse-column CSV shape there is. Before
  // this fix, a schema-carrying field's plain REPLACE with `null` was
  // refused by the shape check exactly like any other wrong-kind value,
  // so declaring a schema broke every sparse column's import. Ruling: a
  // schema describes the shape of a value that EXISTS; whether a column
  // may be null is `required`'s question, not the schema's -- so a
  // top-level null on a plain REPLACE is now exempt from schema
  // validation entirely, for every schema (nullable or not).
  describe("a plain REPLACE's top-level null is exempt from schema validation (fix round 4, Critical)", () => {
    test("a blank CSV cell (null) on a non-nullable, object-schema field is accepted, not refused for 'the wrong shape'", () => {
      const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      const result = prepareItemWrite({ fields, existing, input: { felder: null } });

      expect(result).toEqual({ ok: true, values: { felder: null } });
    });

    // --- Superseded by Task 4 fix round 5, Important 1 ---------------------
    //
    // Formerly: "required is a SEPARATE concern this module does not
    // enforce at all -- a null replace is accepted whether or not the
    // field is 'required'". The coordinator's own round-4 ruling leaned on
    // `required` already being enforced elsewhere as the backstop for this
    // exemption; checked rather than assumed, and found true for only two
    // of four write doors (bulk import's row builder, and the generated
    // tool's own input shape) -- NOT for GraphQL or any other programmatic
    // write, where nothing stopped a `required: true` json field being set
    // to `null`, after which every READ of it errors against the
    // non-nullable `JSON!` output type. Round 5 closes that gap in the
    // chokepoint itself, scoped to json fields only.
    test("a required json field's null replace IS now refused -- required is enforced here because it was not reliably enforced anywhere else", () => {
      const requiredFields: ExuluContextFieldDefinition[] = [
        { name: "felder", type: "json", schema: felderSchema, required: true },
      ];
      const result = prepareItemWrite({ fields: requiredFields, existing: null, input: { felder: null } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("felder");
      expect(result.message.toLowerCase()).toContain("required");
    });

    test("a NON-required (or required unset) field's null replace is unaffected -- the new rule only fires for required: true", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { felder: null } });
      expect(result).toEqual({ ok: true, values: { felder: null } });
    });

    // --- Inverted by the final review, Important 2 ------------------------
    //
    // Formerly asserted the opposite: "a required json field's null is
    // still refused even with NO declared schema -- the rule is about
    // required, not about the schema". That was the round-5 ruling applied
    // one scope too wide, and it broke the one guarantee this plan calls
    // absolute: a json field with no declared schema behaves exactly as it
    // did before the feature. Twelve live `required` json columns across
    // eleven tables sit in that gap (workflow_templates.steps_json,
    // platform_configurations.config_value, context_projections.mean/basis/
    // map/intercept, test_cases.inputs, eval_sets.*, workflow_triggers.
    // config, memory_conflicts.members, image_generations.image_keys,
    // context_presets.preset_items, memory_conflict_scans.context_ids), and
    // any existing client that clears one works today and would have
    // started throwing. The gap the rule was added for still closes for
    // every field this feature introduces, because a field only reaches any
    // rule in this module by declaring a schema.
    test("a required json field with NO declared schema accepts null -- the no-schema path is untouched by this feature, absolutely", () => {
      const requiredNoSchemaFields: ExuluContextFieldDefinition[] = [{ name: "notes", type: "json", required: true }];
      const result = prepareItemWrite({ fields: requiredNoSchemaFields, existing: null, input: { notes: null } });

      expect(result).toEqual({ ok: true, values: { notes: null } });
    });

    test("the required rule still fires for a required json field that DOES declare a schema", () => {
      // The other half of the same scoping: narrowing the rule to
      // schema-carrying fields must not narrow it to nothing.
      const requiredFields: ExuluContextFieldDefinition[] = [
        { name: "felder", type: "json", schema: felderSchema, required: true },
      ];
      const result = prepareItemWrite({ fields: requiredFields, existing: null, input: { felder: null } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message.toLowerCase()).toContain("required");
    });

    test("required is scoped to json fields only -- this module does not enforce it for any other field type", () => {
      const requiredTextFields: ExuluContextFieldDefinition[] = [{ name: "name", type: "text", required: true }];
      const result = prepareItemWrite({ fields: requiredTextFields, existing: null, input: { name: null } });

      expect(result).toEqual({ ok: true, values: { name: null } });
    });

    test("a required field's null under MERGE is refused by the existing merge-null rule, not the new required rule (both agree, for different reasons)", () => {
      const requiredFields: ExuluContextFieldDefinition[] = [
        { name: "felder", type: "json", schema: felderSchema, required: true },
      ];
      const result = prepareItemWrite({
        fields: requiredFields,
        existing: { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } },
        input: { felder: null },
        merge: ["felder"],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message.toLowerCase()).toContain("merge");
    });

    test("the exemption is REPLACE-only: the identical top-level null under merge is still refused exactly as before (Task 3's rule, untouched)", () => {
      const existing = { felder: { budget_gesamt: { wert: "OLD", konfidenz: "low" } } };
      const result = prepareItemWrite({ fields, existing, input: { felder: null }, merge: ["felder"] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a refusal, got values.felder = ${JSON.stringify(result.values.felder)}`);
      expect(result.message.toLowerCase()).toContain("merge");
    });

    test("a nested null (one level in, not the field's own top-level value) is UNCHANGED -- still checked normally against its own sub-schema", () => {
      // Guards against over-reach: the exemption is about the FIELD's own
      // value being null, not about null appearing anywhere inside it.
      const result = prepareItemWrite({ fields, existing: null, input: { felder: { budget_gesamt: null } } });
      expect(result.ok).toBe(false);
    });

    test("a schema-less field's blank-cell null replace is unaffected either way (nothing validated it before, nothing does now)", () => {
      const result = prepareItemWrite({ fields, existing: { notes: { a: 1 } }, input: { notes: null } });
      expect(result).toEqual({ ok: true, values: { notes: null } });
    });
  });

  // --- Task 4 fix round 4, Important: merging onto a non-object STORED ----
  // --- value is refused, not silently discarded ----------------------------
  //
  // mergeJson (json-field-schema.ts) treats ANY non-plain-object stored
  // value as "nothing there yet" and starts the merge from `{}` -- correct
  // for `null`/`undefined` (Review Focus 3: a field never written), but
  // DATA LOSS for a stored array or scalar: the whole stored value
  // vanishes, replaced by an object built from only the patch's own keys.
  // Live and reachable: users.favourite_items is a stored json ARRAY with
  // no schema, merge is advertised on it, and (fix round 3) a string patch
  // that parses to a plain object can now reach mergeJson at all.
  describe("merging onto a non-object STORED value is refused, naming the stored value (fix round 4, Important)", () => {
    test("THE EXACT REPORTED REPRO: a string patch that parses to an object, merged onto a stored ARRAY, is refused instead of silently replacing the list", () => {
      const favouriteFields: ExuluContextFieldDefinition[] = [{ name: "favourite_items", type: "json" }];
      const existing = { favourite_items: ["a", "b", "c"] };
      const input = { favourite_items: JSON.stringify({ "0": "x" }) };

      const result = prepareItemWrite({ fields: favouriteFields, existing, input, merge: ["favourite_items"] });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(
          `expected a refusal, got the array silently replaced: ${JSON.stringify(result.values.favourite_items)}`,
        );
      }
      expect(result.message).toContain("favourite_items");
      expect(result.message.toLowerCase()).toContain("array");
      expect(result.message.toLowerCase()).toContain("merge");
      // Names the STORED value, not the patch -- a caller who sees "your
      // patch isn't an object" would go fix the wrong end.
      expect(result.message.toLowerCase()).toContain("stored");
    });

    test("merging a plain object patch onto a stored SCALAR is also refused, not silently discarded", () => {
      const notesExisting = { notes: "a legacy scalar value, not an object" };
      const input = { notes: { a: 1 } };

      const result = prepareItemWrite({ fields, existing: notesExisting, input, merge: ["notes"] });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`expected a refusal, got: ${JSON.stringify(result.values.notes)}`);
      }
      expect(result.message).toContain("notes");
      expect(result.message.toLowerCase()).toContain("stored");
    });

    test("a schema-carrying field merged onto a non-object stored value is ALSO refused (not scoped to schema-less fields)", () => {
      const existing = { felder: "a legacy string value, not a record at all" };
      const input = { felder: { zielgruppe: { wert: "x", konfidenz: "low" } } };

      const result = prepareItemWrite({ fields, existing, input, merge: ["felder"] });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`expected a refusal, got: ${JSON.stringify(result.values.felder)}`);
      }
      expect(result.message).toContain("felder");
      expect(result.message.toLowerCase()).toContain("stored");
    });

    test("Review Focus 3 still holds: existing === null/undefined (nothing stored yet) is NOT refused -- the merge just produces the patch", () => {
      const resultNull = prepareItemWrite({
        fields: [{ name: "favourite_items", type: "json" }],
        existing: { favourite_items: null },
        input: { favourite_items: { a: 1 } },
        merge: ["favourite_items"],
      });
      expect(resultNull).toEqual({ ok: true, values: { favourite_items: { a: 1 } } });

      const resultAbsent = prepareItemWrite({
        fields: [{ name: "favourite_items", type: "json" }],
        existing: {},
        input: { favourite_items: { a: 1 } },
        merge: ["favourite_items"],
      });
      expect(resultAbsent).toEqual({ ok: true, values: { favourite_items: { a: 1 } } });
    });

    test("the message distinguishes a bad STORED value from a bad PATCH -- different wording from mergeNonObjectRefusalMessage", () => {
      const existing = { notes: ["already", "an", "array"] };
      const badPatchResult = prepareItemWrite({ fields, existing: { notes: {} }, input: { notes: ["bad patch"] }, merge: ["notes"] });
      const badStoredResult = prepareItemWrite({ fields, existing, input: { notes: { a: 1 } }, merge: ["notes"] });

      expect(badPatchResult.ok).toBe(false);
      expect(badStoredResult.ok).toBe(false);
      if (badPatchResult.ok || badStoredResult.ok) throw new Error("expected both to refuse");
      expect(badPatchResult.message).not.toBe(badStoredResult.message);
      expect(badPatchResult.message.toLowerCase()).not.toContain("stored");
      expect(badStoredResult.message.toLowerCase()).toContain("stored");
    });
  });
  // --- Final review, Important 1: an unmatched `merge` entry ---------------
  //
  // `merge` entries were never validated: `merge?.includes(key)` simply
  // failed to match and the field fell through to the REPLACE branch. The
  // exact reported repro, verbatim, is the first test below -- a single
  // capital letter, `ok: true`, and the stored key `b` gone.
  describe("Important 1: a merge entry that names nothing this write can merge is refused", () => {
    test("THE EXACT REPORTED REPRO: a capitalisation typo in merge no longer destroys the column", () => {
      const existing = {
        felder: {
          a: { wert: "A", konfidenz: "low" },
          b: { wert: "B", konfidenz: "high" },
        },
      };
      const result = prepareItemWrite({
        fields,
        existing,
        input: { felder: { a: { wert: "9", konfidenz: "low" } } },
        merge: ["Felder"], // capital F
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(
          `expected a refusal; got values.felder = ${JSON.stringify(result.values.felder)}`,
        );
      }
      expect(result.message).toContain('"merge" names "Felder"');
      // The actionable half: the correct spelling is in the message.
      expect(result.message).toContain('"felder"');
    });

    test("a json field named in merge that this write sends no value for is refused, with its own wording", () => {
      const result = prepareItemWrite({
        fields,
        existing: { felder: { a: { wert: "A", konfidenz: "low" } } },
        input: { name: "only the name" },
        merge: ["felder"],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("sends no value for it");
      expect(result.message).toContain("(none");
    });

    test("the two reasons get different messages -- they are fixed at different ends", () => {
      const notJson = prepareItemWrite({ fields, existing: null, input: { name: { a: 1 } }, merge: ["name"] });
      const absent = prepareItemWrite({ fields, existing: null, input: { name: "x" }, merge: ["felder"] });

      expect(notJson.ok).toBe(false);
      expect(absent.ok).toBe(false);
      if (notJson.ok || absent.ok) throw new Error("expected both to refuse");
      expect(notJson.message).not.toBe(absent.message);
    });

    test("a correct merge entry is unaffected, and so is a write with no merge at all", () => {
      const existing = { felder: { a: { wert: "A", konfidenz: "low" } } };

      const merged = prepareItemWrite({
        fields,
        existing,
        input: { felder: { b: { wert: "B", konfidenz: "high" } } },
        merge: ["felder"],
      });
      expect(merged).toEqual({
        ok: true,
        values: { felder: { a: { wert: "A", konfidenz: "low" }, b: { wert: "B", konfidenz: "high" } } },
      });

      // An empty list, and an absent one, both mean "no merge" -- neither
      // may be turned into a refusal by the new check.
      expect(prepareItemWrite({ fields, existing, input: { name: "x" }, merge: [] })).toEqual({
        ok: true,
        values: { name: "x" },
      });
      expect(prepareItemWrite({ fields, existing, input: { name: "x" } })).toEqual({
        ok: true,
        values: { name: "x" },
      });
    });

    test("a declared json field literally named after an Object.prototype member still works -- the presence check is hasOwn, not `in`", () => {
      // `"toString" in input` is true for ANY object, so a `key in input`
      // presence check would wave through a merge of a field this write
      // never sent -- the same prototype-chain read this module fixes
      // everywhere else. The field IS declared and IS sent here, so the
      // write must succeed; the inverse (declared, not sent) must refuse.
      const protoNamedFields: ExuluContextFieldDefinition[] = [{ name: "toString", type: "json" }];
      const sent = prepareItemWrite({
        fields: protoNamedFields,
        existing: JSON.parse('{"toString":{"a":1}}'),
        input: JSON.parse('{"toString":{"b":2}}'),
        merge: ["toString"],
      });
      expect(sent.ok).toBe(true);

      const notSent = prepareItemWrite({
        fields: protoNamedFields,
        existing: JSON.parse('{"toString":{"a":1}}'),
        input: { other: 1 },
        merge: ["toString"],
      });
      expect(notSent.ok).toBe(false);
    });
  });

  // --- Final review, Important 3: an array-/union-rooted declared schema --
  //
  // The non-object merge guard was scoped `!schema`, and a schema that is
  // not object/record-rooted satisfies neither it nor the shape check
  // (`requiresPlainObject` is false for it) -- so it reached the replace
  // branch. Same shape as the `users.favourite_items` bug an earlier round
  // fixed, left one condition away.
  describe("Important 3: a non-object-rooted declared schema cannot turn merge into a silent replace", () => {
    const listFields: ExuluContextFieldDefinition[] = [
      { name: "list", type: "json", schema: z.array(z.object({ a: z.string() })) },
    ];

    test("THE EXACT REPORTED REPRO: an array-rooted schema's merge-listed array value is refused, not written over the stored list", () => {
      const existing = { list: [{ a: "keep" }] };
      const result = prepareItemWrite({
        fields: listFields,
        existing,
        input: { list: [{ a: "new" }] },
        merge: ["list"],
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`expected a refusal; got values.list = ${JSON.stringify(result.values.list)}`);
      }
      expect(result.message).toContain("list");
      expect(result.message.toLowerCase()).toContain("merge patch");
    });

    test("a union-rooted schema's merge-listed non-object value is refused for the same reason", () => {
      const unionFields: ExuluContextFieldDefinition[] = [
        { name: "either", type: "json", schema: z.union([z.object({ a: z.string() }), z.array(z.string())]) },
      ];
      const result = prepareItemWrite({
        fields: unionFields,
        existing: { either: { a: "keep" } },
        input: { either: ["replaced"] },
        merge: ["either"],
      });

      expect(result.ok).toBe(false);
    });

    test("a plain REPLACE on the same array-rooted field is untouched -- this guard is merge-only", () => {
      const existing = { list: [{ a: "keep" }] };
      const result = prepareItemWrite({ fields: listFields, existing, input: { list: [{ a: "new" }] } });

      expect(result).toEqual({ ok: true, values: { list: [{ a: "new" }] } });
    });

    test("an object-rooted schema still gets the better-informed shape refusal, not this one", () => {
      // The two messages must stay distinguishable: only the shape check
      // can cite the schema's valid paths.
      const existing = { felder: { a: { wert: "A", konfidenz: "low" } } };
      const shapeRefusal = prepareItemWrite({ fields, existing, input: { felder: [1, 2] }, merge: ["felder"] });

      expect(shapeRefusal.ok).toBe(false);
      if (shapeRefusal.ok) throw new Error("expected a refusal");
      expect(shapeRefusal.message).toContain("Valid paths");
    });
  });

  // --- Final review, Important 6: required top-level keys on a REPLACE ----
  //
  // `leafViolations` checks only PRESENT keys -- correct for a merge patch,
  // wrong for a create or a non-merge update, which are full values.
  describe("Important 6: an object-rooted schema's required top-level keys are enforced on a replace", () => {
    const objectFields: ExuluContextFieldDefinition[] = [
      { name: "o", type: "json", schema: z.object({ a: z.string(), b: z.string() }) },
    ];

    test("THE EXACT REPORTED REPRO: a create missing a required top-level key is refused, not stored", () => {
      const result = prepareItemWrite({ fields: objectFields, existing: null, input: { o: { a: "x" } } });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected a refusal; got ${JSON.stringify(result.values.o)}`);
      expect(result.message).toContain('"b"');
      // Both escapes are named, so a model does not "fix" this by resending
      // the whole object and losing the stored keys it never meant to touch.
      expect(result.message).toContain('"merge"');
      expect(result.message).toContain("{}");
    });

    test("a non-merge UPDATE is held to the same completeness -- it replaces the whole field", () => {
      const result = prepareItemWrite({
        fields: objectFields,
        existing: { o: { a: "old", b: "old" } },
        input: { o: { a: "x" } },
      });

      expect(result.ok).toBe(false);
    });

    test("{} is explicitly exempt -- clearing a schema-carrying field is an operation, not a value", () => {
      const result = prepareItemWrite({
        fields: objectFields,
        existing: { o: { a: "old", b: "old" } },
        input: { o: {} },
      });

      expect(result).toEqual({ ok: true, values: { o: {} } });
    });

    test("a MERGE patch is exempt -- omitting a key is what a patch is for", () => {
      const result = prepareItemWrite({
        fields: objectFields,
        existing: { o: { a: "old", b: "keep" } },
        input: { o: { a: "x" } },
        merge: ["o"],
      });

      expect(result).toEqual({ ok: true, values: { o: { a: "x", b: "keep" } } });
    });

    test("a complete value passes, and optional/default/nullable keys are not required", () => {
      const mixedFields: ExuluContextFieldDefinition[] = [
        {
          name: "o",
          type: "json",
          schema: z.object({
            a: z.string(),
            opt: z.string().optional(),
            def: z.string().default("d"),
            nullableButPresent: z.string().nullable(),
          }),
        },
      ];

      const complete = prepareItemWrite({
        fields: mixedFields,
        existing: null,
        input: { o: { a: "x", nullableButPresent: null } },
      });
      expect(complete.ok).toBe(true);

      // `.nullable()` alone does NOT make a key optional -- it may be null,
      // it may not be absent.
      const missingNullable = prepareItemWrite({ fields: mixedFields, existing: null, input: { o: { a: "x" } } });
      expect(missingNullable.ok).toBe(false);
      if (missingNullable.ok) throw new Error("expected a refusal");
      expect(missingNullable.message).toContain('"nullableButPresent"');
      expect(missingNullable.message).not.toContain('"opt"');
      expect(missingNullable.message).not.toContain('"def"');
    });

    test("a RECORD-rooted schema is unaffected -- a record has no required keys (the M&V case)", () => {
      const result = prepareItemWrite({
        fields,
        existing: null,
        input: { felder: { just_one: { wert: "x", konfidenz: "low" } } },
      });

      expect(result.ok).toBe(true);
    });

    test("a schema-less json field is unaffected -- nothing validated it before, nothing does now", () => {
      const result = prepareItemWrite({ fields, existing: null, input: { notes: { anything: 1 } } });
      expect(result).toEqual({ ok: true, values: { notes: { anything: 1 } } });
    });

    test("an unknown key is reported as the typo it is, not as the correctly-spelled key being absent", () => {
      // Ordering matters for what a model is told: `unknownPaths` runs
      // first and its message lists every valid path.
      const result = prepareItemWrite({
        fields: objectFields,
        existing: null,
        input: { o: { a: "x", bee: "y" } },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain('"bee"');
      expect(result.message).toContain("Valid paths");
      expect(result.message).not.toContain("missing");
    });
  });

  // --- Final review, "also fold in": the null-vs-"null" seam --------------
  //
  // A literal `null` was exempt from schema validation on a REPLACE and the
  // string `"null"` was refused by the shape check, although both store
  // jsonb null after each write path's stringify loop. Two inputs, one
  // stored result, opposite answers.
  describe("the two spellings of a null replace get the same answer", () => {
    test('the string "null" is accepted on a replace, exactly as a literal null is', () => {
      const existing = { felder: { a: { wert: "A", konfidenz: "low" } } };

      const literal = prepareItemWrite({ fields, existing, input: { felder: null } });
      const stringForm = prepareItemWrite({ fields, existing, input: { felder: "null" } });

      expect(literal).toEqual({ ok: true, values: { felder: null } });
      // never-strip: the caller's own original value is what gets written,
      // so the string stays a string here. Both store jsonb null.
      expect(stringForm).toEqual({ ok: true, values: { felder: "null" } });
    });

    test('a required, schema-carrying field refuses BOTH spellings, with the identical message', () => {
      const requiredFields: ExuluContextFieldDefinition[] = [
        { name: "felder", type: "json", schema: felderSchema, required: true },
      ];
      const literal = prepareItemWrite({ fields: requiredFields, existing: null, input: { felder: null } });
      const stringForm = prepareItemWrite({ fields: requiredFields, existing: null, input: { felder: "null" } });

      expect(literal.ok).toBe(false);
      expect(stringForm.ok).toBe(false);
      if (literal.ok || stringForm.ok) throw new Error("expected both to refuse");
      expect(literal.message).toBe(stringForm.message);
    });

    test('under merge, BOTH spellings are still refused as "a merge patch cannot be null" (unchanged)', () => {
      const existing = { felder: { a: { wert: "A", konfidenz: "low" } } };
      const literal = prepareItemWrite({ fields, existing, input: { felder: null }, merge: ["felder"] });
      const stringForm = prepareItemWrite({ fields, existing, input: { felder: "null" }, merge: ["felder"] });

      expect(literal.ok).toBe(false);
      expect(stringForm.ok).toBe(false);
      if (literal.ok || stringForm.ok) throw new Error("expected both to refuse");
      expect(literal.message).toBe(stringForm.message);
    });
  });

  // --- Final review, "also fold in": refusal-message grammar -------------
  describe("refusal messages name a value's kind with the right article", () => {
    test('"undefined" is named bare, not as "a undefined"', () => {
      const existing = { felder: { a: { wert: "A", konfidenz: "low" } } };
      const result = prepareItemWrite({ fields, existing, input: { felder: undefined }, merge: ["felder"] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).not.toContain("a undefined");
      expect(result.message).toContain("undefined was sent");
    });

    test("the same helper names the kind in the patch-side refusal too", () => {
      // `describeKind` is shared by all three refusal messages, so this
      // pins the shared call rather than a per-message copy of the phrase.
      // (The `an <vowel>` branch of the helper is defensive only: the one
      // typeof that would reach it is "object", and every call site is
      // guarded by `!isPlainObject`, so no input can produce it. It is a
      // regex, not a branch worth a test that cannot fail.)
      const protoFields: ExuluContextFieldDefinition[] = [{ name: "notes", type: "json" }];
      const result = prepareItemWrite({
        fields: protoFields,
        existing: { notes: { a: 1 } },
        input: { notes: 42 },
        merge: ["notes"],
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.message).toContain("a number was sent");
      expect(result.message).not.toContain("a undefined");
    });
  });
});
