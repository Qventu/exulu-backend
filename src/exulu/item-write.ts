import type { ExuluContextFieldDefinition } from "./context";
import { leafViolations, mergeJson, schemaPaths, unknownPaths, type LeafViolation } from "./json-field-schema";

/**
 * The single chokepoint both write paths (the generated tool's
 * `context.updateItem` and the GraphQL resolver's direct knex `.update()`,
 * spec Part B) must call before anything reaches the database. Everything
 * here is a pure function of its arguments — no database, no Knex, no I/O —
 * so Task 4 can wire it into both paths and trust it behaves identically in
 * each.
 *
 * Two rules this module exists to enforce, both costly to get wrong:
 *
 * 1. **Validate, never strip.** A `json` field's declared schema is used
 *    only to CHECK the incoming value (`unknownPaths`, from Task 1). The
 *    value written to `values` is always the caller's own object — the same
 *    reference, not `schema.parse()`'s output. zod's `z.object()` strips
 *    undeclared keys by default; writing a parsed result here would be the
 *    exact anti-goal the design spec names (it has already cost a customer
 *    production data once, at the tool-config layer — see
 *    `json-field-schema.ts`'s `loosenForTransport` for the transport-side
 *    half of that same story). This module is the layer that is actually
 *    supposed to decide what is acceptable, so the one thing it must never
 *    do is quietly rewrite what it was handed.
 *
 * 2. **Validate only the incoming value, never the stored one.** A row
 *    written before a field declared a schema may already hold a shape the
 *    schema would reject. `unknownPaths`/`leafViolations` are only ever
 *    called on `input`'s values; `existing` is read (by `mergeJson`) but
 *    never checked. Checking `existing` would make a merge that only
 *    touches already-valid keys fail on a stored key nobody is even trying
 *    to change — turning on validation would then make old rows permanently
 *    unwritable, which is worse than not validating at all.
 *
 * Two checks run against the incoming value, in order, because they answer
 * different questions and one is cheap to get wrong in the other's
 * direction:
 * - `unknownPaths` — is this path even one the schema recognises (an
 *   unnamed key, or an object/record declared where a scalar was supplied)?
 * - `leafViolations` — for a path the schema DOES recognise, does the leaf
 *   value satisfy what was declared there (an enum member, a type)? This is
 *   the design spec's own Part A example (`felder.budget_gesamt.konfidenz:
 *   expected "low" | "medium" | "high", got "sehr hoch"`) — `unknownPaths`
 *   alone cannot see it (see its own doc comment), so without this second
 *   check that value would reach a write unflagged. It runs ONLY the
 *   present top-level key's own sub-schema, never the whole schema against
 *   the whole patch — a merge patch legitimately omits top-level keys it
 *   isn't touching, and the whole-schema version would wrongly reject that
 *   as a missing required field. See `leafViolations`' own doc comment in
 *   `json-field-schema.ts` for why that distinction matters and how both
 *   shapes (`z.object()`, `z.record()`) resolve it the same way.
 */

export type PrepareItemWriteArgs = {
  fields: ExuluContextFieldDefinition[];
  existing: Record<string, unknown> | null;
  input: Record<string, unknown>;
  /** Names of `json` fields in `input` whose value is a merge patch rather than a full replacement (spec Part B). */
  merge?: string[];
};

export type PrepareItemWriteResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the four-part refusal the design spec requires (Part C, applied
 * here to writes rather than filters): what was rejected, why, what was
 * expected, and what is available instead. The last part is the one that
 * actually lets a model self-correct, and it comes straight from
 * `schemaPaths` — the same list `unknownPaths` just checked `value` against
 * — rather than a generic "invalid" that teaches nothing.
 *
 * Deliberately field- and schema-shaped, never Postgres-shaped: nothing here
 * can mention SQL, a column type, or a database error, because this message
 * is read by a model that will retry on the strength of it alone.
 */
function refusalMessage(
  fieldName: string,
  badPaths: string[],
  schema: NonNullable<ExuluContextFieldDefinition["schema"]>,
): string {
  const plural = badPaths.length > 1;
  const badList = badPaths.map((path) => `"${path}"`).join(", ");
  const validPaths = schemaPaths(schema);
  const validList = validPaths.length > 0 ? validPaths.join(", ") : "(the schema declares no paths)";

  return (
    `Write to field "${fieldName}" rejected: ${plural ? "paths" : "path"} ${badList} ` +
    `${plural ? "do" : "does"} not match the shape declared for "${fieldName}". ` +
    `Valid paths for "${fieldName}": ${validList}.`
  );
}

/**
 * The four-part refusal for a `leafViolations` finding. Unlike
 * `refusalMessage` above, "what is available instead" here is the valid
 * VALUES at that leaf (an enum's members, a type name), not valid PATHS —
 * the path itself is fine; it's the value that is wrong — and zod's own
 * issue message already names that set, so it is used directly rather than
 * reaching for `schemaPaths`, which only ever describes paths. `received` is
 * appended explicitly because zod does not always carry it on the issue
 * itself (an enum mismatch has no `received` field in zod 4.3.6 — see
 * `leafViolations`' own comment) — without it, the model would be told what
 * was expected but not shown what it actually sent.
 */
function leafRefusalMessage(fieldName: string, violations: LeafViolation[]): string {
  const parts = violations.map((violation) => {
    const got = JSON.stringify(violation.received);
    return `"${fieldName}.${violation.path}": ${violation.expected} (got ${got})`;
  });
  return `Write to field "${fieldName}" rejected: ${parts.join("; ")}.`;
}

/**
 * Checks and shapes one write's values. For each key in `input`:
 *
 * - If its field is `type: "json"` and declares a `schema`, the incoming
 *   value is checked with `unknownPaths`, then (only if that passes)
 *   `leafViolations` (not `existing` either way — see module doc). Either
 *   check finding something refuses the *entire* write (fail fast; a write
 *   is one unit, not a bag of independently-committable fields).
 * - If the key is named in `merge`, the stored value and the incoming patch
 *   are combined with `mergeJson` — but only when the incoming value is
 *   itself a plain object. A merge-listed field handed something else (no
 *   caller in this codebase does this, but nothing stops a future one) has
 *   no sensible patch to apply, so it falls back to replace rather than
 *   feeding a non-object into a function that expects one.
 * - Otherwise the value replaces whatever was stored, exactly as today.
 *
 * A key with no matching entry in `fields` (or a field whose type isn't
 * `json`, or a `json` field with no declared `schema`) is passed through
 * unchanged — this helper's job is merge-and-validate for declared `json`
 * shapes, not column-existence checking, which the generated tool/GraphQL
 * input types already own.
 */
export function prepareItemWrite(args: PrepareItemWriteArgs): PrepareItemWriteResult {
  const { fields, existing, input, merge } = args;
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const field = fieldsByName.get(key);
    const schema = field?.type === "json" ? field.schema : undefined;

    if (schema) {
      const badPaths = unknownPaths(schema, value);
      if (badPaths.length > 0) {
        return { ok: false, message: refusalMessage(key, badPaths, schema) };
      }

      const violations = leafViolations(schema, value);
      if (violations.length > 0) {
        return { ok: false, message: leafRefusalMessage(key, violations) };
      }
    }

    if (merge?.includes(key) && isPlainObject(value)) {
      values[key] = mergeJson(existing?.[key], value);
    } else {
      values[key] = value;
    }
  }

  return { ok: true, values };
}
