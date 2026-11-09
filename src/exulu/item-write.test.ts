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

  test("a merge-listed field whose incoming value is not an object falls back to replace", () => {
    // Degenerate input the spec never anticipates a caller sending — merging
    // a non-object patch has no defined meaning, so this does not merge into
    // whatever is stored; it replaces, the same as an un-merge-listed field.
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
    const input = { name: "Acme" };
    const result = prepareItemWrite({ fields, existing: { name: "Old Co" }, input, merge: ["name"] });

    expect(result).toEqual({ ok: true, values: { name: "Acme" } });
  });

  // --- Known limitation, verified directly rather than assumed -----------
  //
  // unknownPaths (Task 1) catches an unnamed key and an object/record "kind"
  // mismatch (object declared, scalar supplied). It does NOT validate a
  // scalar value against its declared leaf type — an enum member, a string
  // vs number, etc. — because that was never its contract (see its own doc
  // comment: "a bare scalar... there is nothing declared to compare
  // against"). That gap reaches this write path unchanged: a malformed enum
  // value on an otherwise well-shaped patch is NOT refused here.
  //
  // This is reported, not papered over, per the task brief. Fixing it
  // correctly needs per-leaf value validation (not full schema.safeParse()
  // on the whole patch, which would wrongly reject a valid MERGE patch that
  // omits other required top-level keys on a non-record object schema) and
  // is a bigger design call than this task's assigned interface
  // (mergeJson + unknownPaths + schemaPaths) covers. See task-3-report.md.
  test("KNOWN LIMITATION: a malformed enum value is not refused (unknownPaths does not check leaf types)", () => {
    const input = { felder: { budget_gesamt: { wert: "1000", konfidenz: "sehr hoch" } } };

    const result = prepareItemWrite({ fields, existing: null, input });

    // Documents the current, real behaviour — this is NOT the desired end
    // state (the spec's own Part A example expects exactly this value
    // rejected with "expected low|medium|high, got sehr hoch"). If this
    // assertion ever flips to `false`, the limitation has been closed
    // upstream and this test (and the note above) should be deleted, not
    // "fixed" to match new behaviour.
    expect(result.ok).toBe(true);
  });
});
