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
 * Deliberately NOT unwrapping unions here, even though Review Focus 4 also
 * names them: there is no single branch to reduce a union *to* — unwrapping
 * is for collapsing a wrapper that has exactly one inner schema. `schemaPaths`
 * handles unions itself, by collecting every branch's paths instead of
 * picking one (see there for why that is sufficient for listing paths but
 * not for validating a value against one).
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
 * top-level record reports its value type's paths prefixed with the literal
 * placeholder `<key>` (the spec's own `<feld_key>` was illustrative of M&V's
 * domain; this module has no field name to use, so it names the slot
 * generically) — `Record<string, feld>` therefore yields `<key>.wert`,
 * `<key>.konfidenz`. If the value type has nothing to go a level into (a
 * record of scalars), the bare placeholder `<key>` is returned instead of
 * nothing, matching the "value is not an object -> bare key" rule above.
 *
 * A top-level union collects the paths of every branch, de-duplicated —
 * Review Focus 4 names unions alongside the optional/nullable/default
 * wrappers. Unlike those, a union cannot be *unwrapped* to one inner schema
 * (there is no value here to pick a branch with), but listing valid paths
 * does not need to pick one: the set of paths a union defines is just the
 * union of what each branch defines.
 */
export function schemaPaths(schema: z.ZodTypeAny): string[] {
  const base = unwrap(schema);
  const def = base.def as AnyDef;

  if (def.type === "union") {
    const seen = new Set<string>();
    for (const option of def.options as z.ZodTypeAny[]) {
      for (const path of schemaPaths(option)) seen.add(path);
    }
    return [...seen];
  }

  if (def.type === "record") {
    const subPaths = schemaPaths(def.valueType as z.ZodTypeAny);
    return subPaths.length > 0 ? subPaths.map((path) => `<key>.${path}`) : ["<key>"];
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
 * Checks one key's value against the schema declared for that key (either a
 * named object key, or a record's dynamic key against its value type).
 * Returns the unknown paths found under `key`, prefixed with it.
 *
 * Two different disagreements both get reported here, and only the first is
 * about a *name*:
 * - the key names a sub-field the declared object does not have, or
 * - the declared shape and the supplied value disagree in *kind* — an
 *   object (or record) was declared and something else was supplied. This
 *   is the spec's own motivating case: `felder`'s value type is an object,
 *   and a filter value like `{ konfidenz: "low" }` supplies a scalar one
 *   level too shallow — "low" where a `feld` object belonged. That is not
 *   an unknown *key* (any record key is legal by definition); it is a
 *   value the declared shape does not accept, which is exactly what this
 *   function's contract is since F1 widened it.
 *
 * Does not recurse past this single level, matching the cap `schemaPaths`
 * uses: a nested record whose entries are themselves checked would need its
 * own value type, which schemaPaths likewise does not expand past `<key>`.
 */
function unknownChildPaths(child: z.ZodTypeAny, value: unknown, key: string): string[] {
  const childDef = unwrap(child).def as AnyDef;

  if (childDef.type === "object") {
    if (!isPlainObject(value)) {
      return [key];
    }
    const childShape = childDef.shape as Record<string, z.ZodTypeAny>;
    const unknown: string[] = [];
    for (const subKey of Object.keys(value)) {
      if (!(subKey in childShape)) unknown.push(`${key}.${subKey}`);
    }
    return unknown;
  }

  if (childDef.type === "record" && !isPlainObject(value)) {
    return [key];
  }

  // Anything else this module does not unwrap (scalar, enum, a nested
  // record whose entry IS a plain object, union, ...) is fully known at
  // this depth — schemaPaths does not define anything deeper for it
  // either, so there is nothing further to compare.
  return [];
}

/**
 * Paths present in `value` that `schema` does not accept — the check behind
 * Part C's filter refusal and Part A's write validation. "Does not accept"
 * covers both an unnamed key and a named key whose value is the wrong kind
 * for the shape declared there (see `unknownChildPaths`); it is not a
 * strict "appears in `schemaPaths(schema)`" lookup, and the two functions'
 * outputs are not directly comparable string-for-string — in particular,
 * `schemaPaths` on a record prefixes with the literal placeholder `<key>`,
 * while `unknownPaths` reports the caller's actual key.
 *
 * Returns `[]` for a schema this module cannot see a shape in at the top
 * level (a union, a bare scalar, anything not unwrapped to object/record) —
 * there is nothing declared to compare against, so nothing can be flagged.
 * A top-level union is deliberately not handled the way `schemaPaths`
 * handles it: listing a union's paths needs no decision, but checking a
 * value against one would mean picking the branch to validate against,
 * which this module does not attempt.
 */
export function unknownPaths(schema: z.ZodTypeAny, value: unknown): string[] {
  if (!isPlainObject(value)) return [];

  const base = unwrap(schema);
  const def = base.def as AnyDef;

  if (def.type === "record") {
    // Every top-level key is a caller-chosen id and always permitted; what
    // is checkable is whether each entry's value matches the record's
    // value type.
    const valueType = def.valueType as z.ZodTypeAny;
    const unknown: string[] = [];
    for (const [key, inner] of Object.entries(value)) {
      unknown.push(...unknownChildPaths(valueType, inner, key));
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
    unknown.push(...unknownChildPaths(child, inner, key));
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
