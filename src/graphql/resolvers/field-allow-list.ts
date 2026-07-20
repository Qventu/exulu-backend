import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";

/**
 * Fields that are always safe to group/sort by regardless of the table schema.
 * They are synthetic/timestamp columns that never hold secrets.
 */
const ALWAYS_ALLOWED = new Set(["id", "createdAt", "updatedAt"]);

/**
 * Returns the set of field names that are safe to use in GROUP BY / ORDER BY.
 * Allowed = non-hidden named fields + id, createdAt, updatedAt.
 */
export function groupableFields(table: ExuluTableDefinition): Set<string> {
  const allowed = new Set<string>(ALWAYS_ALLOWED);
  for (const field of table.fields) {
    if (field.hidden !== true) {
      allowed.add(field.name);
    }
  }
  return allowed;
}

/**
 * Throws if `fieldName` is not in the allow-list for the given table.
 * Call this before passing user-supplied column names to Knex.
 *
 * @param table   - The ExuluTableDefinition for the table being queried.
 * @param fieldName - The raw user-supplied field name (no table prefix).
 * @param label   - Human-readable label for the error message ("group" | "sort").
 */
export function assertAllowedField(
  table: ExuluTableDefinition,
  fieldName: string,
  label: "group" | "sort",
): void {
  const allowed = groupableFields(table);
  if (!allowed.has(fieldName)) {
    throw new Error(`Cannot ${label} by "${fieldName}".`);
  }
}
