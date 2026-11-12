import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { schemaPaths, unknownPaths } from "@SRC/exulu/json-field-schema";

/**
 * Raised by the path check below when a `json` field declares a schema
 * (Task 2) and a filter value on it names a path that schema does not
 * accept. Carries the structured pieces (field, the specific offending
 * paths, the full list of paths the schema DOES define) rather than a bare
 * string, because `applyFilters` is the one chokepoint for every filter
 * surface (generated pagination resolvers, mutation `where` lookups,
 * agentic retrieval's `itemFilters`) — a discriminated return value here
 * would ripple through all of them for no gain, so this is a typed throw
 * instead. `.message` alone is already the complete four-part refusal
 * (what was rejected, why, what was expected, what is available instead),
 * so a boundary catching it needs nothing more than that to hand the model
 * something it can act on.
 *
 * The throw is the mechanism; mapping it to a model-visible RESULT at each
 * boundary is the other half, and the spec is explicit that a refused
 * filter must come back as a normal tool result rather than a thrown error
 * (a bad filter is a typo the model fixes next call, not a turn-ending
 * condition). Through the generated pagination resolvers a throw already
 * surfaces as a GraphQL error, which is right. Through agentic retrieval it
 * was being swallowed into "Retrieval degraded due to an internal error —
 * returning partial results", i.e. partial results and no path list: Part
 * C's exact target failure in new wording. `ee/agentic-retrieval/pipeline/
 * index.ts` now surfaces `err.message` as the step text instead, and the
 * two intermediate catch-alls between the query and that boundary
 * (`pipeline/multi-query.ts`'s `singleSearch`, `pipeline/search.ts`'s
 * per-context catch) re-throw this error specifically so it can reach it
 * (final review, Important 4).
 *
 * This is the spec's own motivating case: a `contains` filter silently
 * compiles to `?? @> ?::jsonb` via `JSON.stringify`, which never throws —
 * so a filter on a path the schema does not define (e.g. `{ felder: {
 * contains: { konfidenz: "low" } } }` against a schema whose real shape is
 * `felder.<key>.konfidenz`) used to match zero rows with no error at all.
 * The model then reads an empty result as "there are none", which is wrong
 * and unrecoverable without this.
 */
export class UnknownFilterPathError extends Error {
  readonly field: string;
  readonly offendingPaths: string[];
  readonly validPaths: string[];

  constructor(field: string, offendingPaths: string[], validPaths: string[]) {
    const plural = offendingPaths.length > 1;
    const badList = offendingPaths.map((path) => `"${path}"`).join(", ");
    const validList = validPaths.length > 0 ? validPaths.join(", ") : "(the schema declares no paths)";

    super(
      `Filter on field "${field}" rejected: ${plural ? "paths" : "path"} ${badList} ` +
        `${plural ? "do" : "does"} not match the shape declared for "${field}". A filter on a path ` +
        `the schema does not define would silently match zero rows instead of erroring, which looks ` +
        `identical to "there are none" — so it is refused instead. Valid paths for "${field}": ${validList}.`,
    );
    this.name = "UnknownFilterPathError";
    this.field = field;
    this.offendingPaths = offendingPaths;
    this.validPaths = validPaths;
  }
}

export const convertGraphqlOperatorToPostgresQuery = (
  query: any,
  fieldName: string,
  operators: any,
  table?: ExuluTableDefinition,
  field_prefix?: string,
) => {
  // Check if field is JSON type
  const field = table?.fields.find((f) => f.name === fieldName);
  const isJsonField = field?.type === "json";

  const prefix = field_prefix ? field_prefix + "." : "";

  fieldName = prefix + fieldName;

  console.log("[EXULU] operators", operators);

  // Final review, Important 5: hoisted out of the `contains` branch so the
  // other operators that compile a json value into SQL get it too. `eq`
  // becomes `?? = ?::jsonb` and `in` an OR of the same; `ne` becomes `??
  // IS DISTINCT FROM ?::jsonb`. `JSON.stringify` never throws and the cast
  // never fails, so an undeclared path on any of them matches zero rows
  // (or, for `ne`, every row) with no error at all — the identical silence
  // Part C exists to end, which "an empty result means there are none"
  // then reports as fact. The spec's non-goals close the door on new
  // json OPERATORS; validating the paths of the ones that already exist is
  // Part C and explicitly in scope.
  //
  // `lte`/`gte` are deliberately not checked: they compile to a plain
  // scalar comparison on the column, not to a path lookup, so there is no
  // path in them to be wrong. Only ever runs when the field actually
  // DECLARES a schema (Task 2) — a json field with none filters exactly as
  // before, on every surface, which is still every real query today since
  // nothing in the repo declares a schema yet. `field.name` (never the
  // reassigned, possibly prefixed `fieldName`) is what the message names.
  if (isJsonField && field?.schema) {
    const filterValues: unknown[] = [];
    if (operators.eq !== undefined) filterValues.push(operators.eq);
    if (operators.ne !== undefined) filterValues.push(operators.ne);
    if (Array.isArray(operators.in)) filterValues.push(...operators.in);
    if (operators.contains !== undefined) filterValues.push(operators.contains);

    // De-duplicated across operators: the same bad path supplied to both
    // `eq` and `contains` is one mistake, and the message reads as one.
    const badPaths = new Set<string>();
    for (const value of filterValues) {
      for (const path of unknownPaths(field.schema, value)) badPaths.add(path);
    }
    if (badPaths.size > 0) {
      throw new UnknownFilterPathError(field.name, [...badPaths], schemaPaths(field.schema));
    }
  }

  if (operators.eq !== undefined) {
    if (isJsonField) {
      // For JSON fields, use JSON equality operator
      query = query.whereRaw(`?? = ?::jsonb`, [fieldName, JSON.stringify(operators.eq)]);
    } else {
      query = query.where(fieldName, operators.eq);
    }
  }
  if (operators.ne !== undefined) {
    if (isJsonField) {
      query = query.whereRaw(`?? IS DISTINCT FROM ?::jsonb`, [
        fieldName,
        JSON.stringify(operators.ne),
      ]);
    } else {
      query = query.whereRaw(`?? IS DISTINCT FROM ?`, [fieldName, operators.ne]);
    }
  }
  if (operators.in !== undefined) {
    if (isJsonField) {
      // For JSON fields with IN operator, check if the JSON value matches any in the array
      const conditions = operators.in.map(() => `?? = ?::jsonb`).join(" OR ");
      const bindings = operators.in.flatMap((val: any) => [fieldName, JSON.stringify(val)]);
      query = query.whereRaw(`(${conditions})`, bindings);
    } else {
      query = query.whereIn(fieldName, operators.in);
    }
  }
  if (operators.contains !== undefined) {
    if (isJsonField) {
      // The schema path check this branch used to own moved above every
      // operator branch (final review, Important 5) -- `eq`/`ne`/`in`
      // were silent on an undeclared path for exactly the same reason
      // `contains` was.
      // For JSON fields, use PostgreSQL's @> containment operator
      // This checks if the JSON field contains the provided value
      query = query.whereRaw(`?? @> ?::jsonb`, [fieldName, JSON.stringify(operators.contains)]);
    } else {
      // For text fields, use ILIKE for case-insensitive matching
      query = query.where(fieldName, "ilike", `%${operators.contains}%`);
    }
  }
  if (operators.lte !== undefined) {
    console.log("[EXULU] operators.lte", operators.lte);
    console.log("[EXULU] fieldName", fieldName);
    if (operators.lte === 0 || operators.lte === "0") {
      // Also include empty / null values as well as 0 values.
      //
      // GROUPED, and that is load-bearing: this is the only operator in this
      // file that compiles to an OR, and every caller applies filters BEFORE
      // access control (ExuluContext.getItems, the generated list resolvers).
      // Ungrouped, `col IS NULL OR col = 0 AND <access control>` binds as
      // `col IS NULL OR (col = 0 AND <access control>)` — every row with NULL
      // in that column came back with no access control at all. The generated
      // `find_<ctx>_items` tool hands this operator straight to a model,
      // which is how it was found (fix round 1, F1).
      query = query.where(function (this: any) {
        this.whereNull(fieldName).orWhere(fieldName, "=", 0);
      });
    } else {
      query = query.where(fieldName, "<=", operators.lte);
    }
  }
  if (operators.gte !== undefined) {
    query = query.where(fieldName, ">=", operators.gte);
  }
  return query;
};
