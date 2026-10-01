/**
 * Item tables store `created_by` as TEXT (see createItemsTable in context.ts),
 * so a row's creator arrives from Postgres as "4" while user ids are numbers
 * everywhere else, and rows created through the SDK can have none at all.
 * Every creator comparison and user lookup in the memory code normalises
 * through here instead of testing `typeof === "number"`.
 */
export function creatorId(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return n > 0 ? n : null;
  }
  return null;
}
