import type { ExuluContextFieldDefinition } from "./context";
import { mergeJson, schemaPaths, unknownPaths } from "./json-field-schema";

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
 *    schema would reject. `unknownPaths` is only ever called on `input`'s
 *    values; `existing` is read (by `mergeJson`) but never checked. Checking
 *    `existing` would make a merge that only touches already-valid keys fail
 *    on a stored key nobody is even trying to change — turning on validation
 *    would then make old rows permanently unwritable, which is worse than
 *    not validating at all.
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
 * Checks and shapes one write's values. For each key in `input`:
 *
 * - If its field is `type: "json"` and declares a `schema`, the incoming
 *   value is checked with `unknownPaths` (not `existing` — see module doc).
 *   Any unknown path refuses the *entire* write (fail fast; a write is one
 *   unit, not a bag of independently-committable fields).
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
    }

    if (merge?.includes(key) && isPlainObject(value)) {
      values[key] = mergeJson(existing?.[key], value);
    } else {
      values[key] = value;
    }
  }

  return { ok: true, values };
}
