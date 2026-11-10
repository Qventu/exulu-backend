import type { ExuluContextFieldDefinition } from "./context";
import {
  leafViolations,
  mergeJson,
  requiresPlainObject,
  schemaPaths,
  unknownPaths,
  type LeafViolation,
} from "./json-field-schema";

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
 *    only to CHECK the incoming value. The value written to `values` is
 *    always the caller's own object — the same reference, not
 *    `schema.parse()`'s output. zod's `z.object()` strips undeclared keys by
 *    default; writing a parsed result here would be the exact anti-goal the
 *    design spec names (it has already cost a customer production data
 *    once, at the tool-config layer — see `json-field-schema.ts`'s
 *    `loosenForTransport` for the transport-side half of that same story).
 *    This module is the layer that is actually supposed to decide what is
 *    acceptable, so the one thing it must never do is quietly rewrite what
 *    it was handed. `mergeJson` itself enforces the JS-level version of this
 *    same rule (see its own doc comment on `Object.defineProperty`) — a
 *    patch key cannot destroy data via a prototype-chain trick either.
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
 * Three checks run against the incoming value, in order:
 * - **Shape** (`requiresPlainObject` + a `schema.safeParse` confirmation) —
 *   does this schema even commit to an object/record shape, and if so, is
 *   the incoming value a plain object at all? `unknownPaths`/`leafViolations`
 *   both correctly return "nothing wrong" for a non-plain-object value
 *   against ANY schema (there is nothing to check paths or leaves against)
 *   — but for a schema that DOES declare an object/record shape, "nothing
 *   to check" is not the same as "nothing is wrong": a bare
 *   string/array/number/`null` sent for a field declared as a keyed
 *   structure violates that declared shape, and for a merge-listed field it
 *   would otherwise fall through to a silent REPLACE that deletes the
 *   entire stored object (Task 3 review, Critical — this check exists
 *   specifically so that fallthrough never happens).
 *
 *   `requiresPlainObject` alone is not sufficient to decide "violates",
 *   though — it only reports the UNWRAPPED shape, and unwrapping is exactly
 *   wrong for deciding which VALUES a schema accepts: `z.record(...)
 *   .nullable()` unwraps to "record", but the schema as actually WRITTEN
 *   explicitly allows `null` (Task 3 re-review, New 2 — my own original
 *   ruling said "unwrapped top level" and that wording was the bug; a
 *   nullable/optional wrapper is precisely a declared exception to the
 *   shape it wraps). So a non-plain-object value only refuses the write
 *   when BOTH `requiresPlainObject(schema)` is true AND `schema` — as
 *   written, wrapper included — genuinely rejects the value
 *   (`schema.safeParse(value).success === false`). Only `.success` is ever
 *   read from that call, never `.data` — this is a check, same as
 *   `unknownPaths`/`leafViolations`, not a second parse whose result could
 *   get written. A schema that does NOT require a plain object at all
 *   (array- or union-rooted — this module validates neither at all today,
 *   see `requiresPlainObject`'s own doc comment) skips this whole check,
 *   same as before.
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
 *
 * Before the last two checks run on a MERGE-listed field, any of the
 * patch's own top-level entries whose value is `null` are exempted (Task 3
 * review, Important 2) — spec Part B defines an explicit `null` there as
 * "delete this key", not a value to validate, and `unknownPaths`/
 * `leafViolations` have no way to know that on their own (they only ever see
 * a bare value, never whether it arrived under `merge`). Refusing a
 * legitimate deletion is worse than merely wrong here: the refusal message
 * says the path doesn't match and lists valid paths, and a model's
 * plausible repair is to resend the field WITHOUT `merge` — which replaces
 * the whole value and destroys every other key the deletion wasn't touching.
 * A plain REPLACE has no such sentinel (the spec only defines it for merge),
 * so a `null` entry there is still checked normally.
 *
 * Above every other check sits one more rule, checked first, for a
 * different reason than any of them (Task 3 third re-review, Important 1):
 * a MERGE-listed field whose incoming TOP-LEVEL value is itself `null` is
 * refused UNCONDITIONALLY — even against a schema that declares `null`
 * legal via `.nullable()`. This is deliberately not a type/schema question
 * (the schema check further down would happily accept it on such a schema)
 * — it is an OPERATION question: merge means patch, and Part B's `null`
 * sentinel deletes one key one level IN, never the whole patch. Letting a
 * bare `null` double as "clear the whole field" under `merge` reopens
 * exactly the "merge silently becomes a whole-object replace" shape
 * Critical 1 exists to prevent, just through the one door — a
 * declared-nullable schema — that check doesn't close. A caller who means
 * to clear a field says so with a plain REPLACE (no `merge`), which is
 * untouched by this rule and behaves exactly as before.
 *
 * Sitting right beside that rule, checked immediately after it (Task 4 fix
 * round 2, Important 4): a MERGE-listed, SCHEMA-LESS field whose incoming
 * value is non-null but still not a plain object (an array, a string, a
 * number...) is ALSO refused unconditionally, for the identical reason —
 * merging into something that isn't a keyed structure has no defined
 * meaning, and without this it silently fell through to a plain REPLACE
 * that overwrote the whole value, reachable in production on
 * `users.favourite_items`/`favourite_artifacts`/`favourite_projects` (all
 * schema-less json ARRAY columns). A schema-carrying field whose schema
 * commits to an object/record shape already gets the equivalent refusal
 * from the shape check below; this is the schema-LESS half of the same
 * question, which had no check to fall back on at all.
 *
 * Task 4 (both production write paths went live) owned four more decisions
 * about the wire, not the chokepoint itself:
 *
 * 1. Confirmed through the GraphQL `UpdateOneById` path (what artifacts use,
 *    `src/graphql/mutations/index.ts`): a bare REPLACE with `{}` clears every
 *    stored key of an object/record-shaped field without tripping any check
 *    here (an empty object has no present keys for `unknownPaths`/
 *    `leafViolations` to visit) — that is the route to clearing a schema-
 *    carrying field now that the rule above refuses `null` under `merge`.
 * 2. A `.default()`/`.optional()`-wrapped schema can make this function write
 *    an own key whose VALUE is `undefined` (see the "New 2" tests). Checked
 *    against the installed knex rather than assumed: `.update({ x: undefined
 *    })` compiles to the IDENTICAL SQL as omitting `x` — already a safe
 *    no-op on that column, not a null-out. Neither wire caller can actually
 *    produce this in practice today (GraphQL's JSON has no `undefined`;
 *    `pickContent`'s own `params[key] !== undefined` guard filters it on the
 *    tool path), so this is a documented safety net, not a live path.
 * 3. zod's `.passthrough()` (`loosenForTransport`, the AI SDK's own parse of
 *    a tool call) can hand back a nested value whose `[[Prototype]]` was
 *    swapped to a model-controlled object — confirmed empirically — rather
 *    than keeping an own `"__proto__"` key. Harmless here specifically
 *    because every read in this module and `json-field-schema.ts` goes
 *    through `Object.entries`/`Object.keys`/`hasOwn`, which only ever see
 *    OWN properties; the swapped prototype is invisible to validation and
 *    to `JSON.stringify` alike, as if the key had simply been dropped
 *    upstream. A future change that reads a value's property via plain dot/
 *    bracket access instead would reopen this.
 * 4. A literal `"__proto__"` key is NOT refused as data (unchanged from Task
 *    3): it is legal under a record-shaped schema and under any schema-less
 *    field, same as any other key, and is stored/merged/deleted safely by
 *    this module's own `Object.defineProperty`/`Object.create(null)`
 *    machinery. The risk named for this decision — a downstream `Object.
 *    assign({}, rowReadBackFromJsonb)` would set the COPY's prototype,
 *    confirmed empirically — is a consumer-side hazard (object SPREAD is
 *    immune; `Object.assign` is not), not a producer-side one; there is no
 *    such `Object.assign` call on an item/row anywhere in this codebase
 *    today (checked). Refusing the key here would be the write path
 *    choosing to strip legitimate data for a risk that lives in how a
 *    future reader might copy the result, which is exactly backwards for a
 *    module whose central rule is "never strip".
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
 * `JSON.stringify` throws on a `BigInt` (and would on a circular
 * reference, though nothing upstream of this module can produce one before
 * this point). This function exists purely to build refusal MESSAGES — it
 * must never itself throw, or a write that should end in a clean refusal
 * would instead end in an unhandled exception. `String()` never throws, so
 * it is the fallback, not a second stringify attempt.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Removes a merge patch's own top-level deletion markers (`null`-valued
 * entries) before validation — see the module doc's note on Important 2.
 * Only ever called on a value already confirmed to be a plain object, and
 * only for the copy handed to `unknownPaths`/`leafViolations`; `mergeJson`
 * still runs on the caller's ORIGINAL, unfiltered patch afterwards, so the
 * `null` is not lost — it still deletes the key there, exactly as the spec
 * requires. This function only ever feeds a validation call; its output is
 * never written anywhere.
 *
 * Built on `Object.create(null)`, not `{}` (Task 3 re-review, New 1): a
 * plain `{}` has `Object.prototype` in its chain, so `filtered[key] =
 * inner` for `key === "__proto__"` runs through the inherited `__proto__`
 * *setter* — the exact footgun `mergeJson` was just fixed for — except here
 * it would reopen it as a VALIDATION BYPASS, not a write: the key vanishes
 * from `filtered` before either check ever sees it (confirmed empirically:
 * `Object.keys(filtered)` no longer contains `"__proto__"` once the setter
 * fires), so a payload like `{ felder: { "__proto__": { "NOT_A_FELD": true
 * } } }` sailed through `unknownPaths`/`leafViolations` as `ok: true` and
 * was then written verbatim by `mergeJson` (which, unlike this function, was
 * already fixed to use `Object.defineProperty`) — persisting an unvalidated
 * payload under a merge-listed field, where the identical input as a plain
 * REPLACE was correctly refused. An object with a `null` prototype has no
 * inherited `__proto__` accessor at all, so bracket assignment on it is
 * always a plain own-property write, for every key, with no special-casing.
 */
function omitNullEntries(value: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = Object.create(null);
  for (const [key, inner] of Object.entries(value)) {
    if (inner !== null) filtered[key] = inner;
  }
  return filtered;
}

/**
 * The refusal for a merge-listed field's TOP-LEVEL patch value being `null`
 * (Task 3 third re-review, Important 1 — a latent gap in the Important-2
 * clause, not a defect in how that clause was implemented). This is an
 * OPERATION mismatch, not a type/schema one — it fires regardless of what
 * the field's schema declares, including a schema that explicitly allows
 * `null` (`.nullable()`), which is exactly the case that slipped through:
 * a nullable schema makes `null` a legal VALUE, but spec Part B never made
 * a bare `null` a legal MERGE PATCH — merge means patch, and a patch's own
 * top-level deletion sentinel lives one level IN (see `omitNullEntries`),
 * never as the patch itself. Collapsing "clear the whole field" into the
 * same spelling as "delete one key" gives the two operations — wildly
 * different blast radius, one key vs. every key — one spelling, which is
 * exactly the ambiguity Critical 1 existed to close off in the first place,
 * now reachable through the one door (a declared-nullable schema) that
 * check doesn't cover.
 */
function mergeClearRefusalMessage(fieldName: string): string {
  return (
    `Write to field "${fieldName}" rejected: a merge patch's own value cannot be null. ` +
    `A bare null here would clear the entire field, and clearing a field is a replace, not a ` +
    `merge. To clear "${fieldName}" entirely, resend it WITHOUT "merge". To delete specific ` +
    `keys instead, keep merging and set only those keys' values to null.`
  );
}

/**
 * The symmetric case to `mergeClearRefusalMessage`, for a SCHEMA-LESS
 * merge-listed field (Task 4 fix round 2, Important 4): a merge patch that
 * is non-null but still not a plain object (an array, a string, a number,
 * ...). A schema-carrying field whose schema commits to an object/record
 * shape already gets an equivalent refusal from the shape check below
 * (`requiresPlainObject` + `shapeRefusalMessage`, Task 3's Critical 1); a
 * field with NO declared schema has no such check to fall back on, so
 * without this a merge-listed, schema-less field silently degraded to a
 * plain REPLACE for any non-object value — live and reachable today:
 * `users.favourite_items`/`favourite_artifacts`/`favourite_projects` are
 * schema-less json ARRAY columns, and `usersUpdateOne(input: {
 * favourite_items: [...] }, merge: ["favourite_items"])` would silently
 * replace the whole list instead of refusing, exactly contradicting the
 * SDL's own "only the keys given are changed, other stored keys are kept"
 * description. Deliberately scoped to the schema-LESS case only — an
 * array- or union-rooted *declared* schema is Task 3's own documented,
 * separately-tracked residual (this module validates neither shape at all
 * today), not reopened here.
 */
function mergeNonObjectRefusalMessage(fieldName: string, value: unknown): string {
  const kind = Array.isArray(value) ? "an array" : `a ${typeof value}`;
  return (
    `Write to field "${fieldName}" rejected: a merge patch must be a JSON object with named keys, ` +
    `but ${kind} was sent (${safeStringify(value)}). A merge patch cannot be ${kind} — only its ` +
    `object keys are merged. To replace "${fieldName}" entirely with ${kind}, resend it WITHOUT "merge".`
  );
}

/**
 * Task 4 fix round 3: the refusal for a json field's STRING value that is
 * not valid JSON at all — distinct from `shapeRefusalMessage`/
 * `mergeNonObjectRefusalMessage`, which both describe a value whose PARSED
 * kind is wrong (an array where an object belongs, say). A string that
 * cannot be parsed has no kind to report yet; saying "a string was sent" in
 * this case is the exact misleading framing the coordinator's ruling
 * rejected, because a JSON string IS a legitimate wire form for a json
 * field here (coerce.ts's import cells, and the generated tool's `z.string()`
 * transport for a schema-less field) — the actual defect is that THIS
 * string's content does not parse, not that a string arrived at all.
 * Schema paths are included (the same way `shapeRefusalMessage` includes
 * them) only when a schema was actually in play — a schema-less field
 * reaching this at all means it was merge-listed (see `prepareItemWrite`'s
 * call site), and there is no schema to cite paths from.
 */
function stringParseFailedMessage(
  fieldName: string,
  raw: string,
  schema?: NonNullable<ExuluContextFieldDefinition["schema"]>,
): string {
  const base =
    `Write to field "${fieldName}" rejected: the value is a string, but it does not parse as JSON ` +
    `(${safeStringify(raw)}). A json field may be sent as a serialized JSON string, but the string ` +
    `itself must be valid JSON.`;
  if (!schema) return base;
  const validPaths = schemaPaths(schema);
  const validList = validPaths.length > 0 ? validPaths.join(", ") : "(the schema declares no paths)";
  return `${base} Valid paths for "${fieldName}": ${validList}.`;
}

/**
 * The four-part refusal for the shape check above: a schema declares an
 * object/record at its top level, but the incoming value for that field is
 * not a plain object at all. "What is available instead" reuses
 * `schemaPaths`, the same as `refusalMessage` below — the model needs to see
 * what a well-formed value for this field actually looks like, which is
 * exactly what that list describes.
 */
function shapeRefusalMessage(
  fieldName: string,
  value: unknown,
  schema: NonNullable<ExuluContextFieldDefinition["schema"]>,
): string {
  const kind = value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
  const validPaths = schemaPaths(schema);
  const validList = validPaths.length > 0 ? validPaths.join(", ") : "(the schema declares no paths)";

  return (
    `Write to field "${fieldName}" rejected: the value must be a JSON object with named keys, ` +
    `but ${kind} was sent (${safeStringify(value)}). ` +
    `Valid paths for "${fieldName}": ${validList}.`
  );
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
 * VALUES at that leaf (an enum's members, a literal union's members), not
 * valid PATHS — the path itself is fine; it's the value that is wrong.
 * `violation.expected` already carries that set when one is derivable (see
 * `leafViolations`' own doc comment on `describeExpectedValues`) or zod's
 * own message otherwise; `received` is appended explicitly because zod does
 * not always carry it on the issue itself (an enum/union mismatch has no
 * `received` field in zod 4.3.6) — without it, the model would be told what
 * was expected but not shown what it actually sent.
 */
function leafRefusalMessage(fieldName: string, violations: LeafViolation[]): string {
  const parts = violations.map((violation) => {
    const got = safeStringify(violation.received);
    return `"${fieldName}.${violation.path}": ${violation.expected} (got ${got})`;
  });
  return `Write to field "${fieldName}" rejected: ${parts.join("; ")}.`;
}

/**
 * Checks and shapes one write's values. For each key in `input`:
 *
 * - If its field is `type: "json"` and the incoming value is a STRING, it is
 *   tentatively parsed first (Task 4 fix round 3) — see the module doc's
 *   note on string-valued json below for why. Every check and the merge
 *   input below operate on that parsed value (`checkValue`); only the
 *   WRITTEN value for a non-merge key is ever the caller's original `value`.
 * - If its field is `type: "json"` and declares a `schema`:
 *   - A value that violates the schema's shape (not a plain object where
 *     one is required) refuses the write outright — see the module doc's
 *     note on the shape check.
 *   - Otherwise the incoming value (with a merge-listed field's own
 *     null-valued deletion markers exempted first) is checked with
 *     `unknownPaths`, then `leafViolations`. Either finding something
 *     refuses the *entire* write (fail fast; a write is one unit, not a bag
 *     of independently-committable fields).
 * - If the field is `type: "json"` AND the key is named in `merge`, the
 *   stored value and the incoming patch are combined with `mergeJson` — but
 *   only when the (possibly just-parsed) incoming value is itself a plain
 *   object (the shape check above already refuses a schema-carrying field's
 *   non-object value before this point; a merge-listed field with NO schema
 *   and a non-object, non-parseable value has nothing stopping it from
 *   reaching here, so it still falls back to replace rather than feeding a
 *   non-object into `mergeJson`). Gating on `type === "json"` (not just
 *   membership in `merge`) matters: `merge` is a concept Part B defines for
 *   `json` fields only, so a non-`json` field named there by mistake must
 *   not have `mergeJson` run against it (Task 3 review, Important 4).
 * - Otherwise the value replaces whatever was stored, exactly as today.
 *
 * A key with no matching entry in `fields` (or a field whose type isn't
 * `json`, or a `json` field with no declared `schema`) is passed through
 * unchanged — this helper's job is merge-and-validate for declared `json`
 * shapes, not column-existence checking, which the generated tool/GraphQL
 * input types already own.
 *
 * **String-valued json (Task 4 fix round 3).** A JSON field's incoming
 * value is not always already-parsed: `src/exulu/import/coerce.ts` returns
 * a SERIALIZED STRING for a json cell on purpose (confirmed by the
 * coordinator directly against its code — both write paths stringify only
 * `typeof value === "object"`/arrays before a jsonb write, so a string
 * passes straight through and Postgres casts it; that convention is also
 * why a schema-LESS field's generated-tool transport type is bare
 * `z.string()`). A json field's incoming value being a string is therefore
 * NOT itself a violation anywhere in this codebase — but before this round,
 * this module treated a valid-JSON string exactly like a non-object
 * violation, refusing a perfectly well-formed import cell with "the value
 * must be a JSON object... but a string was sent" — true of the WIRE FORM,
 * false and misleading about the CONTENT, which the model/importer has no
 * way to act on (it already sent a JSON object; the message tells it to
 * send one).
 *
 * So: a `json`-typed field's string value is parsed FIRST, and every check
 * below — the shape gate, `unknownPaths`, `leafViolations`, and what counts
 * as a plain-object merge patch — runs against the PARSED value, never the
 * raw string. A string that fails to parse is its own refusal
 * (`stringParseFailedMessage`), distinct from "wrong kind", because there
 * is no kind to report yet — saying "a string was sent" would be exactly as
 * misleading for garbage as for valid JSON, since a string is legitimate
 * wire form either way. What gets WRITTEN never changes because of this:
 * a REPLACE still writes the caller's original string untouched
 * (never-strip — parsing exists only to inform the checks, not to
 * substitute what is stored), and a MERGE still writes `mergeJson`'s own
 * object output, exactly as before; only a merge's PATCH input is ever the
 * parsed form. This incidentally closes a second, independently-noticed gap
 * for free: the generated update tool offers `merge` on every json field
 * including schema-less ones, whose transport is `z.string()` — before this
 * fix, Important 4's own check refused every such merge "by construction"
 * (a string is never `isPlainObject`), so the tool offered an option it
 * could never satisfy. A schema-less field's string-that-parses-to-an-object
 * merge patch now actually merges.
 */
export function prepareItemWrite(args: PrepareItemWriteArgs): PrepareItemWriteResult {
  const { fields, existing, input, merge } = args;
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    const field = fieldsByName.get(key);
    const schema = field?.type === "json" ? field.schema : undefined;
    const isMergeField = field?.type === "json" && (merge?.includes(key) ?? false);

    // Tentative parse (Task 4 fix round 3) — see the module doc's note on
    // string-valued json. `checkValue` is used for every decision below;
    // `value` (the caller's original) is still what gets WRITTEN for a
    // non-merge key, further down.
    let checkValue: unknown = value;
    let stringParseFailed = false;
    if (field?.type === "json" && typeof value === "string") {
      try {
        checkValue = JSON.parse(value);
      } catch {
        stringParseFailed = true;
      }
    }

    // Checked first, above the schema check and independent of it (Task 3
    // third re-review, Important 1): an operation question, not a type
    // question — see the module doc's note above this function. Reads on
    // `checkValue`, not `value`: a merge patch that is the literal STRING
    // `"null"` means the same thing operationally as a bare `null` patch —
    // clear the whole field, which merge never allows — and deserves the
    // identical, more actionable refusal rather than falling through to a
    // generic "wrong kind" message.
    if (isMergeField && checkValue === null) {
      return { ok: false, message: mergeClearRefusalMessage(key) };
    }

    // A string that will not parse at all matters only where something
    // actually needs to inspect its content: a merge needs an object patch
    // no matter what the field's schema says, and a schema that commits to
    // an object/record shape needs to check that shape. A schema-less,
    // non-merge field's garbage string is untouched — same as always, that
    // combination validates nothing at all.
    if (stringParseFailed && (isMergeField || (schema && requiresPlainObject(schema)))) {
      return { ok: false, message: stringParseFailedMessage(key, value as string, schema) };
    }

    // Task 4 fix round 2, Important 4: the symmetric check for a
    // SCHEMA-LESS merge-listed field given a non-null, non-object value
    // (an array, string, number, ...) — see mergeNonObjectRefusalMessage's
    // own doc comment for why this is scoped to `!schema` specifically. A
    // schema-carrying field reaches the equivalent, better-informed check
    // just below instead (it can cite valid paths; this can't). Reads
    // `checkValue` so a string that parsed to, say, an array is described
    // by its actual parsed kind ("an array"), not reported as "a string".
    if (isMergeField && !schema && !isPlainObject(checkValue)) {
      return { ok: false, message: mergeNonObjectRefusalMessage(key, checkValue) };
    }

    if (schema) {
      if (requiresPlainObject(schema) && !isPlainObject(checkValue) && !schema.safeParse(checkValue).success) {
        return { ok: false, message: shapeRefusalMessage(key, checkValue, schema) };
      }

      const toValidate = isMergeField && isPlainObject(checkValue) ? omitNullEntries(checkValue) : checkValue;

      const badPaths = unknownPaths(schema, toValidate);
      if (badPaths.length > 0) {
        return { ok: false, message: refusalMessage(key, badPaths, schema) };
      }

      const violations = leafViolations(schema, toValidate);
      if (violations.length > 0) {
        return { ok: false, message: leafRefusalMessage(key, violations) };
      }
    }

    // Object.defineProperty, not `values[key] = ...` (Task 3 third
    // re-review, Important 2): `values` is this function's own RETURN
    // value, and `key` comes straight from `Object.entries(input)` —
    // exactly as untrusted as every other key this task has had to guard
    // against. An own top-level `"__proto__"` key in `input` would
    // otherwise run through the inherited setter here too, corrupting the
    // chokepoint's own output (`Object.keys` looking clean while
    // `Object.getPrototypeOf` says otherwise) rather than merely failing to
    // validate one. `values` itself stays a plain `{}` (unlike
    // `omitNullEntries`'s internal-only copy) because it crosses this
    // module's boundary into the write paths that consume it — the same
    // reason `mergeJson` keeps its own return value a normal object too.
    //
    // The merge branch feeds `mergeJson` the PARSED patch (`checkValue`) —
    // a string can't be iterated as a patch's keys at all — but the replace
    // branch still writes `value`, the caller's untouched original: parsing
    // only ever informs a decision here, it never becomes what is stored
    // (never-strip holds for a string-valued json field exactly as it does
    // for an already-parsed one).
    if (isMergeField && isPlainObject(checkValue)) {
      Object.defineProperty(values, key, { value: mergeJson(existing?.[key], checkValue), writable: true, enumerable: true, configurable: true });
    } else {
      Object.defineProperty(values, key, { value, writable: true, enumerable: true, configurable: true });
    }
  }

  return { ok: true, values };
}
