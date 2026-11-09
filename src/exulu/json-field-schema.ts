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
 * Walks a zod issue's `path` into the value it was raised against, to
 * recover the actual leaf value a `leafViolations` caller rejected — zod's
 * own issue objects carry this for an `invalid_type` issue (baked into the
 * message text) but not for `invalid_value` (an enum mismatch has no
 * `received` field at all in zod 4.3.6, confirmed empirically), so
 * `leafViolations` cannot rely on the issue alone for "what was rejected"
 * and has to re-derive it from the original value instead.
 */
function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/**
 * One present top-level key's value, found to fail its OWN declared
 * sub-schema. `path` is that key plus zod's own issue path underneath it
 * (so a violation inside `meta.source` under key `budget_gesamt` reports
 * `"budget_gesamt.meta.source"`); `expected` is zod's own issue message —
 * type/enum vocabulary only, never a database's; `received` is the actual
 * leaf value, recovered via `valueAtPath` since zod does not always carry it
 * (see above).
 */
export type LeafViolation = {
  path: string;
  expected: string;
  received: unknown;
};

/**
 * Closes the gap `unknownPaths` was never built to cover: a present key
 * whose value is structurally the right KIND (an object where an object was
 * declared, say) but wrong at the leaf — an enum member that isn't one of
 * the declared options, a string where a number belongs. `unknownPaths`'s
 * own doc comment says plainly it cannot see this ("a bare scalar... there
 * is nothing declared to compare against"); this is the design spec's own
 * named example (Part A: `felder.budget_gesamt.konfidenz: expected "low" |
 * "medium" | "high", got "sehr hoch"`), and without this function that
 * value would reach a write unflagged.
 *
 * Deliberately scoped to "each PRESENT top-level key, checked in full
 * against its own declared sub-schema" — never "the whole value against the
 * whole top-level schema". The write helper's merge (spec Part B) is
 * shallow at the top level: a patch legitimately omits top-level keys it
 * isn't touching, and running the WHOLE schema's `.safeParse()` against a
 * partial patch would reject that as a missing required field even though
 * the patch is correct. Checking only the keys that are actually present
 * sidesteps that for both shapes this module supports:
 * - `z.object({ a: A, b: B })`: a present `a` is checked in full against
 *   `A`; an absent `b` is never visited, so its absence is never an error.
 * - `z.record(string, Feld)`: every key is legal by definition (no
 *   "unknown key" question to ask), so every present key is checked in
 *   full against `Feld`.
 *
 * Checking "in full" is what lets this see past the one-level depth cap
 * `unknownPaths`/`unknownChildPaths` document for themselves — a violation
 * three levels deep inside one key's declared shape is still caught here,
 * because `subSchema.safeParse()` recurses through its own whole subtree in
 * one call. Only `.success`/`.error.issues` are ever read from that call;
 * `.data` (the thing that would silently have the undeclared keys stripped
 * out of it, since zod's `z.object()` strips rather than errors on those by
 * default) is never touched — this function answers "is it valid", nothing
 * it returns is ever written anywhere.
 */
export function leafViolations(schema: z.ZodTypeAny, value: unknown): LeafViolation[] {
  if (!isPlainObject(value)) return [];

  const base = unwrap(schema);
  const def = base.def as AnyDef;

  let subSchemaFor: (key: string) => z.ZodTypeAny | undefined;
  if (def.type === "record") {
    const valueType = def.valueType as z.ZodTypeAny;
    subSchemaFor = () => valueType;
  } else if (def.type === "object") {
    const shape = def.shape as Record<string, z.ZodTypeAny>;
    subSchemaFor = (key) => shape[key];
  } else {
    // Nothing declared to check a leaf against — same fallback unknownPaths
    // uses for a schema this module cannot see a shape in at the top level.
    return [];
  }

  const violations: LeafViolation[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const subSchema = subSchemaFor(key);
    // An object schema's unnamed key has no declared sub-schema to check
    // against — that is unknownPaths's job, not this function's.
    if (!subSchema) continue;

    const result = subSchema.safeParse(inner);
    if (result.success) continue;

    for (const issue of result.error.issues) {
      const issuePath = issue.path.map(String);
      const expectedSet = describeExpectedValues(issue);
      violations.push({
        path: [key, ...issuePath].join("."),
        expected: expectedSet ? `expected one of ${expectedSet}` : issue.message,
        received: issue.path.length > 0 ? valueAtPath(inner, issue.path) : inner,
      });
    }
  }
  return violations;
}

type AnyIssue = { code: string } & Record<string, unknown>;

/**
 * Derives a "valid values" set directly from an issue's own data, for the
 * cases where zod's `message` text does not carry one at all. An `enum`
 * mismatch's message already names its members (`Invalid option: expected
 * one of "low"|"medium"|"high"` — confirmed empirically), so `leafViolations`
 * is fine falling back to it there; a **union of literals** — a common way
 * to spell the same "one of these values" constraint — does not: zod 4.3.6's
 * top-level `invalid_union` issue message is the bare string `"Invalid
 * input"`, with no set at all (confirmed empirically). The per-branch detail
 * IS there, just one level down, in `issue.errors` (one array of issues per
 * union branch) — this walks that structure rather than re-deriving the set
 * from the schema tree a second time, since zod already computed exactly
 * this when it evaluated each branch.
 *
 * Deliberately conservative: if the issue is not itself (or every branch of
 * a union is not) a simple `invalid_value`-with-`values` issue, this returns
 * `undefined` and the caller falls back to zod's own `message` — reporting
 * nothing invented is better than reporting a partial, possibly misleading
 * set for a union with a non-literal branch (an object, a number range).
 */
function describeExpectedValues(issue: unknown): string | undefined {
  const anyIssue = issue as AnyIssue;

  if (anyIssue.code === "invalid_value" && Array.isArray(anyIssue.values) && anyIssue.values.length > 0) {
    return (anyIssue.values as unknown[]).map((value) => JSON.stringify(value)).join(" | ");
  }

  if (anyIssue.code === "invalid_union" && Array.isArray(anyIssue.errors)) {
    const parts: string[] = [];
    for (const branchIssues of anyIssue.errors as unknown[]) {
      const branchArray = branchIssues as AnyIssue[];
      const first = branchArray[0];
      if (!first || !Array.isArray(first.values) || first.values.length === 0) return undefined;
      parts.push(...(first.values as unknown[]).map((value) => JSON.stringify(value)));
    }
    return parts.length > 0 ? parts.join(" | ") : undefined;
  }

  return undefined;
}

/**
 * Whether `schema`'s unwrapped top level commits to a plain-object shape —
 * `z.object()` or `z.record()`, the only two kinds `unknownPaths` and
 * `leafViolations` each special-case. Exists for `prepareItemWrite`
 * (Task 3 review, Critical): both of those functions *correctly* return `[]`
 * for a non-plain-object value (there is nothing to check paths or leaves
 * against), but "nothing to check" must not be read by a caller as "nothing
 * is wrong" — a `json` field declaring an object/record shape that receives
 * a bare string/array/number/`null` IS a violation of that declared shape,
 * and without this function a caller has no way to tell "this schema has
 * nothing to say about non-objects by design" apart from "this schema
 * requires an object and got something else".
 *
 * Deliberately narrow: a `json` field whose declared schema is rooted in
 * `z.array()` or `z.union()` gets `false` here, same as a bare scalar — this
 * module validates neither shape at all today (see `unknownPaths`'s and
 * `leafViolations`'s own doc comments), so there is no declared "must be an
 * object" expectation to enforce for them either. That is a real, currently
 * undocumented-elsewhere gap, recorded here rather than silently assumed
 * safe: an array- or union-rooted `json` field schema is accepted at
 * declaration time and then enforced by nothing in this module, for any
 * value at all.
 */
export function requiresPlainObject(schema: z.ZodTypeAny): boolean {
  const def = unwrap(schema).def as AnyDef;
  return def.type === "object" || def.type === "record";
}

/**
 * Preserves a `.describe()` text across a rebuild. zod's clone (what every
 * wrapper/combinator constructor below produces) is a fresh instance, and
 * `.describe()`'s text lives in a registry keyed by instance identity, not
 * by `.def` — so a plain rebuild silently drops any description the schema
 * author wrote on a nested node. Only called where `loosenForTransport`
 * actually rebuilds a node; a node returned untouched keeps its own
 * identity and therefore its description for free.
 */
function preserveDescription(original: z.ZodTypeAny, rebuilt: z.ZodTypeAny): z.ZodTypeAny {
  return original.description ? rebuilt.describe(original.description) : rebuilt;
}

/**
 * Rebuilds `schema` so every object it contains, at every depth, accepts
 * unknown keys instead of silently dropping them — recursively, not just at
 * the top level (Task 2 review, Critical).
 *
 * The reason this exists at all: `field.schema` is handed to the AI SDK as
 * an `ExuluTool`'s `inputSchema`, and the `ai` package runs `safeParseAsync`
 * on the model's raw tool-call JSON *before* any Exulu code sees it. zod's
 * `z.object()` strips undeclared keys by default — that is correct for a
 * schema whose job is to validate, but this schema's only job here is to
 * guide the model toward the right shape. Used unmodified, it becomes a
 * second, silent validation layer: a key the model supplies but the schema
 * didn't declare vanishes before Task 3's chokepoint — the place that is
 * actually supposed to decide what's acceptable — ever sees it. That is the
 * design spec's named anti-goal ("never strips"); it resurfaced here because
 * the spec didn't know the AI SDK itself parses with zod.
 *
 * Looseness has to be recursive because the stripping is: a passthrough
 * applied only at the schema's own top level does nothing for a key nested
 * inside an object one level down (confirmed empirically against installed
 * zod@4.3.6 — loosening only the outer object left a nested extra key
 * stripped; `.passthrough()` on the nested object fixed it). So every
 * object node in the tree gets rebuilt with its own extra-key allowance,
 * via `.passthrough()`, not just the root.
 *
 * What this function deliberately does NOT change: a key's declared type is
 * still enforced (a wrong type is still rejected after loosening — that is
 * what makes the result safe rather than merely permissive), and it builds a
 * *new* schema rather than mutating `schema`, so the strict version Task 3
 * validates against is untouched. This is a transport concern only; it has
 * no opinion on whether an unknown key is OK — that answer still comes from
 * `unknownPaths` against the original, un-loosened schema.
 */
export function loosenForTransport(schema: z.ZodTypeAny): z.ZodTypeAny {
  const def = schema.def as AnyDef;

  switch (def.type) {
    case "optional":
      return preserveDescription(schema, z.optional(loosenForTransport(def.innerType as z.ZodTypeAny)));
    case "nullable":
      return preserveDescription(schema, z.nullable(loosenForTransport(def.innerType as z.ZodTypeAny)));
    case "default":
      return preserveDescription(
        schema,
        (loosenForTransport(def.innerType as z.ZodTypeAny) as z.ZodTypeAny & { default: (v: unknown) => z.ZodTypeAny }).default(
          def.defaultValue,
        ),
      );
    case "array":
      return preserveDescription(schema, z.array(loosenForTransport(def.element as z.ZodTypeAny)));
    case "record": {
      // A record never strips keys itself — every key is dynamically valid
      // against `valueType`, which is the thing that can itself be (or
      // contain) an object. So the key type is left exactly as declared
      // (rebuilding it through the public `z.record()` factory would also
      // need it narrowed to zod's `$ZodRecordKey` constraint, which
      // `z.ZodTypeAny` doesn't satisfy); `.clone()` swaps only `valueType`.
      const loosenedValue = loosenForTransport(def.valueType as z.ZodTypeAny);
      return preserveDescription(
        schema,
        (schema as z.ZodTypeAny & { clone: (def: AnyDef) => z.ZodTypeAny }).clone({ ...def, valueType: loosenedValue }),
      );
    }
    case "union":
      return preserveDescription(
        schema,
        z.union((def.options as z.ZodTypeAny[]).map((option) => loosenForTransport(option)) as [
          z.ZodTypeAny,
          z.ZodTypeAny,
          ...z.ZodTypeAny[],
        ]),
      );
    case "object": {
      const shape = def.shape as Record<string, z.ZodTypeAny>;
      const loosenedShape: Record<string, z.ZodTypeAny> = {};
      for (const key of Object.keys(shape)) {
        const child = shape[key];
        if (!child) continue;
        loosenedShape[key] = loosenForTransport(child);
      }
      return preserveDescription(
        schema,
        (z.object(loosenedShape) as z.ZodObject<Record<string, z.ZodTypeAny>> & { passthrough: () => z.ZodTypeAny })
          .passthrough(),
      );
    }
    default:
      // A scalar, enum, or anything else this module does not recognise has
      // no object inside it to loosen — returned as-is, which also keeps
      // its own identity (and therefore its `.describe()`, if any).
      return schema;
  }
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
 *
 * Writes each key via `Object.defineProperty`, never `merged[key] = value`
 * (Task 3 review, Minor — overridden to a required fix: this is reachable
 * prototype pollution, not a backlog item). `patch` comes from model-
 * supplied JSON; `JSON.parse('{"__proto__":{"polluted":true}}')` produces an
 * object with a perfectly normal OWN enumerable property literally named
 * `"__proto__"` (`JSON.parse` does not trigger the accessor). But plain
 * bracket assignment (`merged["__proto__"] = value`) runs through
 * `Object.prototype`'s inherited `__proto__` *setter*, which reassigns
 * `merged`'s actual `[[Prototype]]` instead of storing an own property — so
 * the key is simultaneously lost (never strip! this is exactly the anti-goal
 * the rest of this plan exists to avoid, just reached through a JS
 * footgun instead of a schema one) and the merged object's prototype chain
 * is corrupted. `Object.defineProperty` always creates/overwrites an OWN
 * property directly, bypassing any inherited accessor — confirmed
 * empirically that this keeps `Object.getPrototypeOf(merged)` untouched
 * while still storing the literal `"__proto__"` key's data, for every key,
 * not just that one (no special-casing needed, and no key gets silently
 * dropped to achieve it).
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
      Object.defineProperty(merged, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }
  return merged;
}
