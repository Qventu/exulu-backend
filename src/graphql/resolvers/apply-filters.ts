import type { SearchFilters } from "../types";
import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { convertGraphqlOperatorToPostgresQuery } from "../utilities/convert-graphql-filter-operator-to-pg-query";

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
