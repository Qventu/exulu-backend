import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { assertAllowedField } from "./field-allow-list";

export const applySorting = (
  query: any,
  sort?: { field: string; direction: "ASC" | "DESC" },
  field_prefix?: string,
  table?: ExuluTableDefinition,
) => {
  const prefix = field_prefix ? field_prefix + "." : "";
  if (sort) {
    if (table) {
      assertAllowedField(table, sort.field, "sort");
    }
    sort.field = prefix + sort.field;
    query = query.orderBy(sort.field, sort.direction.toLowerCase());
  }
  return query;
};
