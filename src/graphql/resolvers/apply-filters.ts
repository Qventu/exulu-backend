import type { SearchFilters } from "../types";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { convertGraphqlOperatorToPostgresQuery } from "../utilities/convert-graphql-filter-operator-to-pg-query";

/**
 * applyFilters, inside its own where-group — the form every caller should use.
 *
 * Every query in this codebase applies filters BEFORE the access predicate
 * (`applyAccessControl`), and `{ lte: 0 }` compiles to `col IS NULL OR col = 0`.
 * Ungrouped, that OR reaches across the AND that follows it:
 * `col IS NULL OR (col = 0 AND <access control>)` — i.e. every NULL-valued row
 * of every other user came back unfiltered (found reviewing the generated
 * `find_<ctx>_items` tool, which hands the operator to a model; fix round 1,
 * F1). The operator itself is parenthesised at the source now; this group is
 * the structural guarantee, so the NEXT operator that compiles to an OR cannot
 * reintroduce the bypass at any call site.
 *
 * Knex drops an empty group, so no filters still means no WHERE clause.
 */
export const applyFiltersGrouped = (
  query: any,
  filters: SearchFilters,
  table?: ExuluTableDefinition,
  field_prefix?: string,
) =>
  query.where(function (this: any) {
    applyFilters(this, filters, table, field_prefix);
  });

export const applyFilters = (
  query: any,
  filters: SearchFilters,
  table?: ExuluTableDefinition,
  field_prefix?: string,
) => {
  if (!filters) {
    return query;
  }
  filters.forEach((filter) => {
    Object.entries(filter).forEach(([fieldName, operators]: [string, any]) => {
      if (operators) {
        if (operators.and !== undefined) {
          operators.and.forEach((operator) => {
            query = convertGraphqlOperatorToPostgresQuery(
              query,
              fieldName,
              operator,
              table,
              field_prefix,
            );
          });
        }
        if (operators.or !== undefined) {
          query = query.where((builder: any) => {
            operators.or.forEach((operator: any) => {
              builder.orWhere((subBuilder: any) => {
                convertGraphqlOperatorToPostgresQuery(
                  subBuilder,
                  fieldName,
                  operator,
                  table,
                  field_prefix,
                );
              });
            });
          });
        }
        query = convertGraphqlOperatorToPostgresQuery(
          query,
          fieldName,
          operators,
          table,
          field_prefix,
        );
      }
    });
  });
  return query;
};
