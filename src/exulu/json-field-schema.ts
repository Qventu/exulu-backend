import { z } from "zod";

/**
 * Pure path-extraction and merge logic for a `json` context field that
 * declares a Zod shape (spec: 2026-11-09-typed-json-fields-design.md, Part A
 * and Part B). No database, no Knex — everything here is a function of its
 * arguments so it can be unit-tested and reused by both write paths and the
 * filter converter without pulling either in.
 *
 * Traversal walks `schema.def.type` rather than `instanceof` chains. Zod's
 * public classes have moved between major versions (ZodFirstPartyTypeKind in
 * v3, discriminated `.def.type` strings in v4 — confirmed against the
 * installed zod@4.3.6); `.def.type` is the one thing stable enough to branch
 * on, and a type this module does not recognise is treated as opaque rather
 * than crashing.
 */

type AnyDef = z.core.$ZodTypeDef & Record<string, unknown>;

/**
 * Strips `.optional()`, `.nullable()` and `.default()` wrappers so the
 * functions below can inspect the shape underneath. Plan Review Focus 4:
 * without this, a field declared as `z.object({...}).optional()` (the normal
 * way to make a whole `json` field optional) would report every one of its
 * own paths as unknown.
 *
 * Deliberately NOT unwrapping `ZodUnion`/`ZodPipe`/etc: there is no single
 * "the" shape underneath a union to unwrap to, and nothing in this plan's
 * tests or consumers needs it. A schema this does not see through still
 * behaves safely — see the opaque-type fallback in schemaPaths/unknownPaths.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    const def = current.def as AnyDef;
    if (def.type === "optional" || def.type === "nullable" || def.type === "default") {
      current = def.innerType as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dotted paths a schema defines, one level into each top-level key. A key
 * whose value is itself an object contributes its sub-keys (`"a.b"`); any
 * other key — string, enum, array, a nested record, anything this module
 * does not unwrap — contributes just the bare key, because that is as deep
 * as the schema actually commits to a shape.
 *
 * A schema that is itself a record (the real shape of a field like `felder:
 * Record<feld_key, feld>`) has no fixed top-level keys to enumerate — every
 * key is a caller-chosen id. What IS fixed is the shape of each entry, so a
 * top-level record delegates straight to its value type and returns that
 * type's paths unprefixed. `unknownPaths` mirrors this by checking a
 * record's entries against the same value type, which is what keeps the two
 * functions agreeing on what "known" means.
 */
export function schemaPaths(schema: z.ZodTypeAny): string[] {
  const base = unwrap(schema);
  const def = base.def as AnyDef;

  if (def.type === "record") {
    return schemaPaths(def.valueType as z.ZodTypeAny);
  }
  if (def.type !== "object") {
    return [];
  }

  const shape = def.shape as Record<string, z.ZodTypeAny>;
  const paths: string[] = [];
  for (const key of Object.keys(shape)) {
    const child = shape[key];
    if (!child) continue;
    const childDef = unwrap(child).def as AnyDef;
    if (childDef.type === "object") {
      for (const subKey of Object.keys(childDef.shape as Record<string, z.ZodTypeAny>)) {
        paths.push(`${key}.${subKey}`);
      }
    } else {
      paths.push(key);
    }
  }
  return paths;
}

/**
 * Paths present in `value` that `schema` does not define — the check behind
 * Part C's filter refusal and Part A's write validation. Walks the same
 * depth `schemaPaths` enumerates (object: one level; record: the value
 * type's own keys under any caller-chosen id) so a path this reports as
 * unknown is always one `schemaPaths` would not have listed, and vice versa.
 *
 * Returns `[]` for a schema this module cannot see a shape in (unions, bare
 * scalars, anything not unwrapped to object/record) — there is nothing
 * declared to compare against, so nothing can be flagged as undeclared.
 */
export function unknownPaths(schema: z.ZodTypeAny, value: unknown): string[] {
  if (!isPlainObject(value)) return [];

  const base = unwrap(schema);
  const def = base.def as AnyDef;

  if (def.type === "record") {
    // Every top-level key is a caller-chosen id and always permitted; only
    // what is underneath it is checkable, against the record's value type.
    const valueType = def.valueType as z.ZodTypeAny;
    const unknown: string[] = [];
    for (const [key, inner] of Object.entries(value)) {
      for (const path of unknownPaths(valueType, inner)) {
        unknown.push(`${key}.${path}`);
      }
    }
    return unknown;
  }

  if (def.type !== "object") {
    return [];
  }

  const shape = def.shape as Record<string, z.ZodTypeAny>;
  const unknown: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const child = shape[key];
    if (!child) {
      unknown.push(key);
      continue;
    }
    const childDef = unwrap(child).def as AnyDef;
    if (childDef.type === "object" && isPlainObject(inner)) {
      const childShape = childDef.shape as Record<string, z.ZodTypeAny>;
      for (const subKey of Object.keys(inner)) {
        if (!(subKey in childShape)) {
          unknown.push(`${key}.${subKey}`);
        }
      }
    }
    // A non-object child (including a nested record) is fully known at this
    // depth: schemaPaths does not define anything deeper for it either, so
    // there is nothing further to compare.
  }
  return unknown;
}

/**
 * Shallow top-level merge for a `json` field (spec Part B): keys the patch
 * omits keep their stored value, and an explicit `null` deletes a key —
 * distinct from an absent key, which is a no-op. `undefined` is not special;
 * a patch key cannot be `undefined` after passing through JSON/GraphQL, and
 * treating it as deletion would make it indistinguishable from "not sent".
 *
 * `stored` is whatever is already in the column, which may predate this
 * feature entirely (Review Focus 3): `null` (never written), `undefined`
 * (column absent from the row the caller fetched), or not an object at all
 * (a `json` field can legally hold a scalar). All three are treated as `{}`
 * rather than thrown on, so merging into a field nobody has written yet
 * just produces the patch.
 */
export function mergeJson(
  stored: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
