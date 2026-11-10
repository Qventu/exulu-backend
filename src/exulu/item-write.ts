import type { ExuluContextFieldDefinition } from "./context";
import {
  leafViolations,
  mergeJson,
  missingRequiredKeys,
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
 * 2. **Validate the incoming value's CONTENT, never the stored value's
 *    content.** (Revised, Task 4 fix round 5, Important 2 — this used to
 *    say "never the stored one" without qualification, which stopped being
 *    true the moment round 4 added a narrower check; see below.) A row
 *    written before a field declared a schema may already hold a shape the
 *    schema would reject. `unknownPaths`/`leafViolations` are only ever
 *    called on `input`'s values, never on `existing`'s — turning that on
 *    would make a merge that only touches already-valid keys fail on a
 *    stored key nobody is even trying to change, making old rows
 *    permanently unwritable, which is worse than not validating at all.
 *    `existing` IS read for one single, much narrower, SHAPE-only question
 *    since Task 4 fix round 4 (Important, below): is it even a plain
 *    object/record a merge patch could be combined into, as opposed to an
 *    array or a scalar? That is a deliberately stricter rule than "never
 *    checked" — a legacy row already holding a json array or scalar can no
 *    longer be MERGED, only REPLACED, which is exactly the "old rows become
 *    unwritable" tradeoff this rule warns against, accepted on purpose for
 *    that one narrow shape question because the alternative (`mergeJson`
 *    silently discarding the stored value) is worse. The schema is still
 *    never consulted about what `existing` CONTAINS — only this module's
 *    own `isPlainObject` is.
 *
 * Four checks run against the incoming value, in order:
 * - **Shape** (`requiresPlainObject` + a `schema.safeParse` confirmation) —
 *   does this schema even commit to an object/record shape, and if so, is
 *   the incoming value a plain object at all? `unknownPaths`/`leafViolations`
 *   both correctly return "nothing wrong" for a non-plain-object value
 *   against ANY schema (there is nothing to check paths or leaves against)
 *   — but for a schema that DOES declare an object/record shape, "nothing
 *   to check" is not the same as "nothing is wrong": a bare
 *   string/array/number sent for a field declared as a keyed structure
 *   violates that declared shape, and for a merge-listed field it would
 *   otherwise fall through to a silent REPLACE that deletes the entire
 *   stored object (Task 3 review, Critical — this check exists specifically
 *   so that fallthrough never happens). `null` is deliberately NOT on that
 *   list any more — a top-level REPLACE's `null` is handled by its own,
 *   later rule instead (Task 4 fix round 4, Critical, below), which exempts
 *   it from this shape check entirely rather than refusing it as a
 *   wrong-kind value. `null` under `merge` is a third, separate rule again
 *   (Task 3 third re-review, Important 1, below) — three different
 *   treatments for the identical bare value, each for a different reason;
 *   see each rule's own paragraph for why they are not the same question.
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
 *   same as before; a merge-listed field is nonetheless protected from the
 *   silent replace that used to follow from that, by the widened
 *   non-object merge guard below (final review, Important 3).
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
 * - `missingRequiredKeys` — the other half of that same distinction, and
 *   the reason it is a separate check rather than a `leafViolations`
 *   option (final review, Important 6). `leafViolations` only ever visits
 *   the keys that are PRESENT, which is right for a merge patch and wrong
 *   for a REPLACE: a create or a non-merge update is a whole value, so an
 *   object-rooted schema's required top-level keys have to be there. A
 *   create of `{ a: "x" }` against `z.object({ a: z.string(), b:
 *   z.string() })` used to return `ok: true` and store a row violating the
 *   very schema the model was shown. So this check runs for a REPLACE only,
 *   with `{}` EXPLICITLY EXEMPT — the same shape of ruling as the two
 *   `null` rules below: `{}` is this feature's documented way to CLEAR a
 *   schema-carrying field (Task 4 decision 1), and clearing is an
 *   OPERATION, not a value that has to satisfy the declared shape.
 *   Record-rooted schemas are unaffected (a record's keys are
 *   caller-chosen ids; there is no such thing as a required one), which is
 *   the M&V case and therefore most real schemas.
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
 * Before any of those four looks at any value at all, the `merge` LIST
 * itself is validated (final review, Important 1): every name in it must
 * be a `json` field that this same write sends a value for, or the whole
 * write is refused (`mergeUnknownFieldMessage`). `merge` entries were
 * never checked — `merge?.includes(key)` simply failed to match an entry
 * that named nothing, the field fell through to the REPLACE branch, and
 * the write succeeded having deleted every stored key the value sent did
 * not mention. A capitalisation slip in one list entry (`"Felder"` for
 * `felder`) is the single most likely error a model makes here, and it
 * degraded in the destructive direction with no refusal: exactly the data
 * loss this feature exists to prevent, through the one input nothing
 * validated. Note the consequence for a non-`json` field named in `merge`:
 * that used to be silently replaced (Task 3 review, Important 4 — the type
 * gate is still there and still stops `mergeJson` running on it), and is
 * now refused instead, which is the same ruling applied to the same
 * mistake.
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
 * round 2, Important 4; widened in the final review, Important 3): a
 * MERGE-listed field whose incoming value is non-null but still not a
 * plain object (an array, a string, a number...) is ALSO refused
 * unconditionally, for the identical reason — merging into something that
 * isn't a keyed structure has no defined meaning, and without this it
 * silently fell through to a plain REPLACE that overwrote the whole value,
 * reachable in production on `users.favourite_items`/`favourite_artifacts`/
 * `favourite_projects` (all schema-less json ARRAY columns). It fires for
 * a field with NO schema and for one whose schema does not commit to an
 * object/record shape — the two cases the shape check below cannot speak
 * for, because `requiresPlainObject` is false for both. Scoping it to
 * `!schema` alone left an array- or union-rooted DECLARED schema one
 * condition away from the same silent replace (see
 * `mergeNonObjectRefusalMessage`'s own doc comment for the repro). A
 * schema that DOES commit to an object/record shape gets the equivalent,
 * better-informed refusal from the shape check below instead, which can
 * cite the schema's valid paths.
 *
 * Checked next, specifically for a REPLACE and nowhere else (Task 4 fix
 * round 4, Critical): a json field's top-level value being `null` is
 * exempt from schema validation ENTIRELY — it skips the shape check above,
 * `unknownPaths`, and `leafViolations` outright, rather than being
 * evaluated against any of them. The reasoning, because it generalises: a
 * schema describes the shape of a value that EXISTS; whether a column may
 * be `null` at all is a separate concern this codebase already expresses
 * via `required` (see the very next rule) — conflating the two is what
 * caused the defect this rule fixes. Reachable constantly in production: a
 * blank CSV cell is the most common sparse-column shape there is, and
 * `coerce.ts` maps one to a literal `null` (never `""`, never an error) —
 * so before this rule, declaring a schema broke every sparse column's bulk
 * import, refusing a perfectly normal blank cell as "the value must be a
 * JSON object... but null was sent". This exemption is REPLACE-only on
 * purpose: the merge-null rule two paragraphs up is untouched by it and
 * still refuses `null` unconditionally under `merge`, because merge means
 * patch and null-as-the-whole-patch is an operation question, not a shape
 * one, regardless of what this rule says about replace.
 *
 * "`null`" here means BOTH spellings of it (final review, "also fold in"):
 * a literal `null` and the string `"null"`, which is what a json field's
 * serialized wire form looks like when the value is null. Both store jsonb
 * `null` after each write path's own stringify loop, so one stored result
 * cannot have two opposite answers — the literal exempted here and the
 * string refused by the shape check as "null was sent" was a seam, not two
 * rules. This rule therefore reads `checkValue` (the parsed form), exactly
 * as the merge-null rule above it already did for the same reason, and as
 * `mergeJson`'s own one-level-in `null` sentinel does.
 *
 * Folded into the replace-null block as its first branch is the one case
 * the exemption does NOT cover (Task 4 fix round 5, Important 1 —
 * completing the fix round 4 ruling above rather than contradicting it): a
 * `required: true` json field that ALSO declares a schema has its REPLACE
 * `null` refused instead of exempted (`requiredNullRefusalMessage`). The
 * round 4 ruling leaned on `required` already being the codebase's answer
 * to "may this column be null" — checked, rather than assumed, and found
 * true for only two of four write doors: the bulk-import row builder
 * rejects a blank cell on a `required` field before it ever reaches this
 * module, and the generated tool cannot send `null` at all. For GraphQL
 * and any other programmatic write, nothing enforced it anywhere — not the
 * jsonb column definition (`t.jsonb(name)`, no `notNullable`), not
 * `createItemsTable`, not the generated Input type (which omits `required`
 * while the OUTPUT type still declares the field `JSON!`) — so a
 * `required: true` json field could be set to `null` and every subsequent
 * READ of it would then error against that non-null output type.
 *
 * The `&& schema` half of that condition is the final review's Important 2,
 * correcting round 5's own ruling: round 5 scoped the rule to json and
 * forgot to scope it to SCHEMA-CARRYING json, which broke the one
 * guarantee the plan calls absolute — a json field with NO declared schema
 * and a write with no `merge` behaves exactly as it did before this
 * feature, which is the path almost every real write in the system takes,
 * since nothing in the repo declares a schema yet. There are twelve live
 * `required` json columns across eleven tables (`workflow_templates.
 * steps_json`, `platform_configurations.config_value`, `context_projections.
 * mean/basis/map/intercept`, `test_cases.inputs`, `eval_sets.*`,
 * `workflow_triggers.config`, `memory_conflicts.members`,
 * `image_generations.image_keys`, `context_presets.preset_items`,
 * `memory_conflict_scans.context_ids`), and any existing client that clears
 * one works today and would have started throwing on merge. The gap still
 * closes for every field this feature introduces: a field only reaches any
 * rule in this module by declaring a schema. Still scoped to json fields
 * only beyond that — enforcing `required` for every field type, across
 * every table in the system, is a real behaviour change this module does
 * not make and a fix round does not get to decide.
 *
 * Checked right after the two null-handling rules above, about `existing`
 * rather than the incoming value (Task 4 fix round 4, Important — the
 * other half of rule 2's revision at the top of this comment): once a
 * MERGE patch is confirmed to be a plain object, the STORED value under
 * that key must be `null`, `undefined`, or itself a plain object, or the
 * write is refused (`mergeStoredNonObjectRefusalMessage`) rather than
 * merged. Without this, `mergeJson` (json-field-schema.ts) treats ANY
 * non-plain-object stored value — deliberately `null`/`undefined` (a field
 * never written, where starting the merge from `{}` is correct), but also,
 * silently, a stored array or scalar — as "nothing there yet", discarding
 * it and replacing it with an object built from only the patch's own keys.
 * Live and reachable specifically because of this plan's own earlier
 * rounds: `users.favourite_items` is a stored json ARRAY with no schema,
 * `merge` is advertised on it (Task 4, routing `UpdateOne` through this
 * module), and a string patch that parses to a plain object can reach
 * `mergeJson` at all only since the string-parsing rule above — so
 * `'{"0":"x"}'` under `merge` would otherwise have silently replaced the
 * whole favourites list. The refusal message deliberately names the
 * STORED value, not the patch, and is worded differently from the
 * patch-side non-object refusal above — a caller told "your patch isn't an
 * object" when the real problem is what is already in the column would go
 * fix the wrong end.
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
 *
 * **Merge is not concurrency-safe, and nothing here claims it is** (final
 * review, Important 7). A merge is a read-modify-write across two separate
 * statements: each write path fetches the row, calls this function, and
 * writes the combined object back, with no transaction, no row lock and no
 * SQL-side `jsonb_set`. Two merges that are SERIALIZED (each fully awaited
 * before the next begins) both land — that is what the merge feature
 * delivers over a plain replace, and what `item-write-parity.test.ts`
 * actually tests. Two merges that OVERLAP in time can still lose one of
 * them: both read the same stored value, and the second write's object,
 * built from the value the first had not written yet, overwrites the first
 * one's key. That is the ordinary lost-update shape of any unlocked
 * read-modify-write, and it is the limitation the spec's own M&V scenario
 * (two analysts editing one pitch matrix through a 600 ms per-field
 * debounce) runs straight into. Adding locking has real performance
 * consequences and is a deliberate separate decision, not something a fix
 * round gets to slip in. Recorded HERE, and in the two places a human and
 * a model actually read the promise — `src/graphql/schemas/index.ts`'s SDL
 * description and `src/templates/tools/context-write-tools.ts`'s `merge`
 * description — because documenting it only inside a test file (where it
 * was, before this review) is documenting it where nobody affected by it
 * looks.
 *
 * **Two residuals this module knowingly does not close.** Recorded so the
 * next reader does not have to rediscover them: (1) an array- or
 * union-rooted declared schema is validated by nothing here, for any value
 * — `unknownPaths`, `leafViolations` and `missingRequiredKeys` all return
 * "nothing wrong" for it by construction (see `requiresPlainObject`'s own
 * doc comment). As of the final review it can no longer silently REPLACE a
 * merge-listed field, which was the data-loss half; what remains is that
 * its contents are unchecked. (2) `loosenForTransport` does not recognise
 * `intersection`/`pipe`/`transform`/`catch`/`lazy`/`readonly`/`tuple`, so
 * a strict `z.object()` nested inside one of those is returned untouched
 * and the AI SDK's own parse would strip a key the model sent that the
 * schema did not declare — the never-strip anti-goal, reached through a
 * zod node kind rather than through this module. Both would be closed at
 * once by refusing such a schema at boot (the `attachments.
 * documentProcessor` precedent); that needs an allowlist walk over zod's
 * node kinds, which is a change of its own size and not a fix-round
 * decision. Neither is reachable today: nothing in the repo declares a
 * schema at all.
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
 * Names the KIND of a value for a refusal message, with the right article.
 * Hand-rolled `a ${typeof value}` produced "a undefined" and "a object"
 * (final review, "also fold in") — a model is not confused by it, but a
 * refusal message is the one thing this module ships to a reader, and
 * three separate messages were building the same phrase three times.
 * `null` and `undefined` are named bare, without an article, because they
 * are the values themselves rather than a class of value. The `an
 * <vowel>` branch is defensive: the only vowel-initial `typeof` is
 * "object", and every caller is guarded by `!isPlainObject`, so nothing
 * can currently reach it.
 */
function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  const kind = typeof value;
  return /^[aeiou]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

/**
 * `Object.prototype.hasOwnProperty.call`, never `key in input` or
 * `input[key]`: `input` is model-supplied and `key` comes from the
 * caller's `merge` list, so a name like `"toString"` would otherwise
 * resolve against `Object.prototype` and report a key the caller never
 * sent as present. Same rule, same reason, as `json-field-schema.ts`'s own
 * `hasOwn`.
 */
function hasOwnKey(target: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
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
 * Task 4 fix round 5, Important 1: the refusal for a REPLACE's `null` on a
 * `required: true` json field — the one case round 4's "null is exempt
 * from schema validation" ruling does not cover, because `required` (not
 * the schema) is the thing that says this field may not be null. Checked
 * instead of the round-4 exemption, never alongside it: a required field
 * never reaches that exemption at all (see the call site).
 *
 * Scoped in the final review (Important 2) to a `required` json field that
 * also DECLARES A SCHEMA. Round 5 scoped it to json and stopped there,
 * which broke the one guarantee the plan calls absolute: a json field with
 * no declared schema behaves exactly as it did before this feature. Twelve
 * live `required` json columns across eleven tables fall in that gap, and
 * any existing client that clears one works today and would have started
 * throwing. See the call site for the full list and reasoning.
 */
function requiredNullRefusalMessage(fieldName: string): string {
  return (
    `Write to field "${fieldName}" rejected: this field is required and cannot be null. ` +
    `Send a value for "${fieldName}", or omit it from this write to leave it unchanged.`
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
 * description.
 *
 * Widened in the final review (Important 3) from `!schema` to "no schema
 * OR a schema that does not commit to an object/record shape". Scoping it
 * to `!schema` left the identical silent-replace one condition away: an
 * array- or union-rooted declared schema satisfies neither this check (it
 * HAS a schema) nor the shape check below (`requiresPlainObject` is false
 * for it), so it reached the replace branch —
 *
 *     fields: [{ name: "list", type: "json", schema: z.array(z.object({ a: z.string() })) }]
 *     stored: list = [{ a: "keep" }]
 *     input:  { list: [{ a: "new" }] }, merge: ["list"]
 *     result: ok: true -> list = [{ a: "new" }]   // "keep" gone, no refusal
 *
 * — the same shape as the `users.favourite_items` bug this message was
 * added for, reached through a declared schema instead of no schema. The
 * fix is at this chokepoint rather than as a boot-time refusal of
 * non-object-rooted schemas, because this check covers every caller
 * including a context constructed outside the app's boot path; what a boot
 * check would additionally have covered (`loosenForTransport`'s unhandled
 * wrapper kinds) is recorded as a residual in the module doc instead.
 */
function mergeNonObjectRefusalMessage(fieldName: string, value: unknown): string {
  // One input still produces the literal phrase "a string was sent" here,
  // and it is the one case where that phrasing is accurate rather than the
  // misleading half the round-3 ruling called out: `value` is `checkValue`
  // (the PARSED form) at every call site, so `typeof value === "string"`
  // only happens when the original was a JSON string that itself parsed
  // to ANOTHER string -- e.g. `'"text"'` parses to the string `"text"`.
  // The CONTENT genuinely is a string there, so saying so is correct; the
  // misleading case round 3 fixed was reporting "a string was sent" about
  // the WIRE FORM while the content was a well-formed object.
  const kind = describeKind(value);
  return (
    `Write to field "${fieldName}" rejected: a merge patch must be a JSON object with named keys, ` +
    `but ${kind} was sent (${safeStringify(value)}). A merge patch cannot be ${kind} — only its ` +
    `object keys are merged. To replace "${fieldName}" entirely with ${kind}, resend it WITHOUT "merge".`
  );
}

/**
 * Task 4 fix round 4, Important: the merge-branch counterpart to
 * `mergeNonObjectRefusalMessage` above — that one names a bad PATCH; this
 * one names a bad STORED value, which is a different mistake for a caller
 * to fix. Without this, `mergeJson` (json-field-schema.ts) silently
 * discarded a stored array or scalar — it treats ANY non-plain-object
 * stored value the same as "nothing stored yet" and starts the merge from
 * `{}`, which is correct for `null`/`undefined` (Review Focus 3) but is
 * DATA LOSS for an array or a scalar: the whole stored value vanishes,
 * replaced by an object built from only the patch's own keys. Reachable
 * today: `users.favourite_items` is a stored json ARRAY, `merge` is
 * advertised on every json field including it, and (Task 4 fix round 3) a
 * string patch that parses to a plain object can now reach `mergeJson` at
 * all — `favouriteItemsUpdate(input: { favourite_items: '{"0":"x"}' },
 * merge: ["favourite_items"])` would otherwise silently replace the whole
 * list with `{"0":"x"}`.
 */
function mergeStoredNonObjectRefusalMessage(fieldName: string, stored: unknown): string {
  const kind = describeKind(stored);
  return (
    `Write to field "${fieldName}" rejected: the STORED value is ${kind}, not a JSON object with ` +
    `named keys (${safeStringify(stored)}), so a merge patch cannot be combined into it. A merge ` +
    `combines keys into an EXISTING object; "${fieldName}" does not currently hold one. To replace ` +
    `"${fieldName}" entirely, resend it WITHOUT "merge".`
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
  const kind = describeKind(value);
  const validPaths = schemaPaths(schema);
  const validList = validPaths.length > 0 ? validPaths.join(", ") : "(the schema declares no paths)";

  return (
    `Write to field "${fieldName}" rejected: the value must be a JSON object with named keys, ` +
    `but ${kind} was sent (${safeStringify(value)}). ` +
    `Valid paths for "${fieldName}": ${validList}.`
  );
}

/**
 * Final review, Important 1: the refusal for a `merge` entry that does not
 * name a `json` field this same write sends a value for. `merge` entries
 * were never validated — `merge?.includes(key)` simply failed to match,
 * the field fell through to the REPLACE branch, and the write returned
 * `ok: true` having deleted every stored key the patch did not mention:
 *
 *     stored felder = { a: {...}, b: {...} }
 *     input  { felder: { a: {...} } }, merge: ["Felder"]   // capital F
 *     result ok: true -> felder = { a: {...} }             // b is gone
 *
 * A capitalisation or spelling slip in one list entry is the single most
 * likely error a model makes here, and it degraded in the destructive
 * direction with no refusal at all — the exact data loss this whole
 * feature exists to prevent. So an unmatched entry is now refused outright
 * rather than ignored: there is no reading of "merge this field" that
 * "replace this field" satisfies, and silence is not available as an
 * answer to a request the system cannot carry out.
 *
 * Two distinct reasons get two distinct wordings, because they are fixed
 * at different ends: the name is not a `json` field of this item at all
 * (a typo, or a non-json field named by mistake — `merge` is a concept
 * spec Part B defines for `json` fields only), or it IS a json field but
 * this write sends no value for it (nothing to merge; the caller probably
 * meant a field it did send). "What is available instead" is the list of
 * json fields this write could actually merge into, which is also what
 * shows a case-typo its own correct spelling.
 */
function mergeUnknownFieldMessage(
  name: string,
  reason: "not-json" | "absent",
  mergeableNames: string[],
): string {
  const availableList =
    mergeableNames.length > 0
      ? mergeableNames.map((mergeable) => `"${mergeable}"`).join(", ")
      : "(none — this write sends no json field, so there is nothing to merge into)";
  const why =
    reason === "not-json"
      ? `"${name}" is not a json field of this item`
      : `"${name}" is a json field but this write sends no value for it`;

  return (
    `Write rejected: "merge" names "${name}", but ${why}. Every name in "merge" must be a json ` +
    `field that this same write sends a value for — an unmatched name would otherwise silently ` +
    `REPLACE that field instead of merging into it, deleting every stored key the value sent does ` +
    `not mention. json fields this write can merge into: ${availableList}.`
  );
}

/**
 * Final review, Important 6: the refusal for a REPLACE that omits a
 * top-level key an object-rooted schema declares as required.
 * `leafViolations` only ever checks the keys that are PRESENT — correct
 * for a merge patch, which legitimately omits what it is not touching, and
 * wrong for a create or a non-merge update, which is the whole value. A
 * create of `{ a: "x" }` against `z.object({ a: z.string(), b: z.string()
 * })` therefore stored a row violating the very schema the model was
 * shown.
 *
 * `{}` is deliberately exempt at the call site, not here: an empty object
 * is this feature's documented way to CLEAR a schema-carrying field (Task
 * 4 decision 1, now that `null` under `merge` is refused), and clearing is
 * an OPERATION, not a value that has to satisfy the declared shape — the
 * same reasoning the two `null` rules above rest on. "What is available
 * instead" names both escapes explicitly, because a model that is told
 * only "a key is missing" will resend the whole object and lose the stored
 * keys it never meant to touch.
 */
function missingKeysRefusalMessage(
  fieldName: string,
  missing: string[],
  schema: NonNullable<ExuluContextFieldDefinition["schema"]>,
): string {
  const plural = missing.length > 1;
  const missingList = missing.map((key) => `"${key}"`).join(", ");
  const validPaths = schemaPaths(schema);
  const validList = validPaths.length > 0 ? validPaths.join(", ") : "(the schema declares no paths)";

  return (
    `Write to field "${fieldName}" rejected: required ${plural ? "keys" : "key"} ${missingList} ` +
    `${plural ? "are" : "is"} missing. This write REPLACES "${fieldName}" (it is not named in ` +
    `"merge"), so the value sent must be complete. To change only some keys and keep the rest, ` +
    `resend this write with "merge": ["${fieldName}"]. To clear "${fieldName}" entirely, send {}. ` +
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
 * Checks and shapes one write's values.
 *
 * First, once, before any value is examined: every name in `merge` must be
 * a `json` field that `input` itself sends a value for, or the whole write
 * is refused (final review, Important 1 — see `mergeUnknownFieldMessage`).
 *
 * Then, for each key in `input`:
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
 *     `unknownPaths`, then `leafViolations`, and — for a REPLACE of a
 *     non-empty object only — `missingRequiredKeys`. Any of them finding
 *     something refuses the *entire* write (fail fast; a write is one
 *     unit, not a bag of independently-committable fields).
 * - If the field is `type: "json"` AND the key is named in `merge`, the
 *   stored value and the incoming patch are combined with `mergeJson` — and
 *   the (possibly just-parsed) incoming value is guaranteed to be a plain
 *   object by then: a schema-carrying field whose schema commits to an
 *   object/record shape is refused by the shape check above, and every
 *   other non-object patch (no schema, or an array-/union-rooted one) by
 *   the widened non-object merge guard (final review, Important 3). Gating
 *   on `type === "json"` (not just membership in `merge`) matters: `merge`
 *   is a concept Part B defines for `json` fields only, so a non-`json`
 *   field named there by mistake must not have `mergeJson` run against it
 *   (Task 3 review, Important 4) — and, since the final review, is refused
 *   outright rather than silently replaced.
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
 *
 * **Two more rules this summary would otherwise omit (Task 4 fix rounds 4
 * and 5).** A REPLACE's top-level `null` — literal or the string `"null"`,
 * which are one write — is exempt from every check above UNLESS the field
 * is `required: true` AND declares a schema, in which case it is refused
 * instead — see the module doc's paragraphs on both rules for the full
 * reasoning (why null is a `required` question, not a schema question, and
 * why `required` needed its own rule here rather than being safe to assume
 * enforced elsewhere). And once a MERGE patch is confirmed to be a plain
 * object, the STORED value it would merge into must itself be `null`,
 * `undefined`, or a plain object, or the write is refused rather than
 * silently discarding whatever was actually stored — see the module doc's
 * paragraph on `existing` for why that is a deliberate narrowing of rule 2,
 * not a violation of it.
 */
export function prepareItemWrite(args: PrepareItemWriteArgs): PrepareItemWriteResult {
  const { fields, existing, input, merge } = args;
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const values: Record<string, unknown> = {};

  // Final review, Important 1: every `merge` entry has to NAME something
  // this write can merge, checked before a single value is looked at. An
  // entry that matches nothing used to be silently ignored, which turned
  // the write into a REPLACE of the field the caller was trying to patch —
  // see `mergeUnknownFieldMessage` for the repro. Refused as a whole write
  // rather than per field: a write is one unit here, same as every other
  // refusal in this function.
  if (merge && merge.length > 0) {
    const mergeableNames = Object.keys(input).filter((name) => fieldsByName.get(name)?.type === "json");
    for (const name of merge) {
      if (fieldsByName.get(name)?.type !== "json") {
        return { ok: false, message: mergeUnknownFieldMessage(String(name), "not-json", mergeableNames) };
      }
      if (!hasOwnKey(input, name)) {
        return { ok: false, message: mergeUnknownFieldMessage(String(name), "absent", mergeableNames) };
      }
    }
  }

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

    // A plain REPLACE whose value IS null — the two rules that answer
    // "may this column be null", kept in one block because they are one
    // question with two answers (Task 4 fix rounds 4 and 5; scope
    // corrected and the two spellings of null unified in the final
    // review).
    //
    // Keyed on `checkValue`, not the literal `value` (final review, "also
    // fold in"): the literal `null` and the string `"null"` are the same
    // write — both store jsonb `null` after each write path's stringify
    // loop — and used to get opposite answers, the literal exempted here
    // and the string refused by the shape check below as "null was sent".
    // Two inputs, one stored result, so one rule. The merge-null rule
    // above already read `checkValue` for exactly this reason; this is the
    // replace half catching up, and it also matches what `mergeJson`'s
    // own one-level-in `null` sentinel does with the two spellings.
    //
    // 1. `required: true` AND a declared schema: refused. Nothing else
    //    enforces `required` for a json column on the GraphQL/programmatic
    //    doors (`map-types.ts` emits a bare `t.jsonb(name)`,
    //    `createItemsTable` never reads `field.required`, and the generated
    //    Input type omits `required` while the OUTPUT type still declares
    //    the field `JSON!`), so a `null` there produced a row that errors
    //    on every subsequent read.
    //
    //    `&& schema` is the final review's Important 2 (correcting round
    //    5's own ruling, which scoped this to json and forgot to scope it
    //    to SCHEMA-CARRYING json): without it, this rule changed the
    //    no-schema path the plan guarantees is untouched. There are twelve
    //    live `required` json columns across eleven tables today
    //    (`workflow_templates.steps_json`, `platform_configurations.
    //    config_value`, `context_projections.mean/basis/map/intercept`,
    //    `test_cases.inputs`, `eval_sets.*`, `workflow_triggers.config`,
    //    `memory_conflicts.members`, `image_generations.image_keys`,
    //    `context_presets.preset_items`, `memory_conflict_scans.
    //    context_ids`) and every existing client that clears one works
    //    today and would have thrown after this merge. The gap still
    //    closes for every field this feature introduces, because a field
    //    only reaches the rest of this module by declaring a schema.
    //
    // 2. Otherwise: exempt from schema validation ENTIRELY — the shape
    //    check, `unknownPaths` and `leafViolations` are all skipped rather
    //    than evaluated. A schema describes the shape of a value that
    //    EXISTS; `required` is this codebase's answer to whether a column
    //    may be null at all. Reachable constantly in production: a blank
    //    CSV cell is the commonest sparse-column shape there is and
    //    `coerce.ts` maps one to a literal `null`, so without this,
    //    declaring a schema broke every sparse column's bulk import.
    //
    // Replace-only on purpose either way: `null` under `merge` is refused
    // unconditionally by the rule above, because merge means patch and
    // null-as-the-whole-patch is an operation question, not a shape one.
    if (!isMergeField && field?.type === "json" && checkValue === null) {
      if (schema && field.required === true) {
        return { ok: false, message: requiredNullRefusalMessage(key) };
      }
      Object.defineProperty(values, key, { value, writable: true, enumerable: true, configurable: true });
      continue;
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
    if (isMergeField && (!schema || !requiresPlainObject(schema)) && !isPlainObject(checkValue)) {
      return { ok: false, message: mergeNonObjectRefusalMessage(key, checkValue) };
    }

    // Task 4 fix round 4, Important: the merge-branch counterpart to the
    // check above, about the STORED side rather than the patch. `mergeJson`
    // (json-field-schema.ts) treats ANY non-plain-object stored value —
    // deliberately `null`/`undefined` (Review Focus 3: nothing was ever
    // written yet, so starting from `{}` is correct), but also, silently,
    // an array or a scalar — as "nothing there yet" and starts from `{}`.
    // For an array or a scalar that is DATA LOSS: the whole stored value
    // is discarded and replaced by an object built from only the patch's
    // keys. Checked here, once the patch itself is confirmed to be a plain
    // object (an unparseable/non-object PATCH is already refused by the two
    // checks above and below; this is specifically "patch is fine, but
    // there is nothing object-shaped to merge it INTO"). Only `null`/
    // `undefined` are exempt — anything else non-object is refused.
    if (isMergeField && isPlainObject(checkValue)) {
      const stored = existing?.[key];
      if (stored !== null && stored !== undefined && !isPlainObject(stored)) {
        return { ok: false, message: mergeStoredNonObjectRefusalMessage(key, stored) };
      }
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

      // Final review, Important 6: checked LAST of the three, and only for
      // a REPLACE. `leafViolations` above checks the keys that are present;
      // this checks the declared keys that are not. A merge patch is
      // exempt by construction (it is a patch — omitting a key is what it
      // is FOR), and so is `{}`, which is this feature's documented way to
      // clear a schema-carrying field rather than a value claiming to
      // satisfy the shape. Last rather than first so a model that mistyped
      // a key name gets told about the typo (whose message lists every
      // valid path) instead of being told the correctly-spelled key is
      // absent, which is the same mistake described from the far end.
      if (!isMergeField && isPlainObject(checkValue) && Object.keys(checkValue).length > 0) {
        const missing = missingRequiredKeys(schema, checkValue);
        if (missing.length > 0) {
          return { ok: false, message: missingKeysRefusalMessage(key, missing, schema) };
        }
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
