import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { schemaPaths, unknownPaths } from "@SRC/exulu/json-field-schema";

/**
 * Raised by the `contains` branch below when a `json` field declares a
 * schema (Task 2) and the filter's containment value names a path that
 * schema does not accept. Carries the structured pieces (field, the
 * specific offending paths, the full list of paths the schema DOES define)
 * rather than a bare string, because `applyFilters` is the one chokepoint
 * for every filter surface (generated pagination resolvers, mutation
 * `where` lookups, agentic retrieval's `itemFilters`) — a discriminated
 * return value here would ripple through all of them for no gain, so this
 * is a typed throw instead. `.message` alone is already the complete
 * four-part refusal (what was rejected, why, what was expected, what is
 * available instead), so whatever boundary ends up catching it needs
 * nothing more than that to hand the model something it can act on.
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
      // Only when the field actually declares a schema (Task 2) -- a json
      // field with none filters exactly as before, on every surface, which
      // is almost every real query today since nothing in the repo
      // declares a schema yet. `field` is already resolved once above;
      // reusing it here (rather than a second `table?.fields.find(...)`)
      // is deliberate, not an oversight.
      if (field?.schema) {
        const badPaths = unknownPaths(field.schema, operators.contains);
        if (badPaths.length > 0) {
          throw new UnknownFilterPathError(field.name, badPaths, schemaPaths(field.schema));
        }
      }
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
      // Also include empty / null values as well as 0 values
      query = query.whereNull(fieldName).orWhere(fieldName, "=", 0);
    } else {
      query = query.where(fieldName, "<=", operators.lte);
    }
  }
  if (operators.gte !== undefined) {
    query = query.where(fieldName, ">=", operators.gte);
  }
  return query;
};
