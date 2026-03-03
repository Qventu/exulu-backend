import type { ExuluTableDefinition } from "src/exulu/routes";

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
        query = query.whereRaw(`?? = ?::jsonb`, [
          fieldName,
          JSON.stringify(operators.eq),
        ]);
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
        query = query.whereRaw(`?? IS DISTINCT FROM ?`, [
          fieldName,
          operators.ne,
        ]);
      }
    }
    if (operators.in !== undefined) {
      if (isJsonField) {
        // For JSON fields with IN operator, check if the JSON value matches any in the array
        const conditions = operators.in
          .map(() => `?? = ?::jsonb`)
          .join(" OR ");
        const bindings = operators.in.flatMap((val: any) => [
          fieldName,
          JSON.stringify(val),
        ]);
        query = query.whereRaw(`(${conditions})`, bindings);
      } else {
        query = query.whereIn(fieldName, operators.in);
      }
    }
    if (operators.contains !== undefined) {
      if (isJsonField) {
        // For JSON fields, use PostgreSQL's @> containment operator
        // This checks if the JSON field contains the provided value
        query = query.whereRaw(`?? @> ?::jsonb`, [
          fieldName,
          JSON.stringify(operators.contains),
        ]);
      } else {
        // For text fields, use LIKE
        query = query.where(fieldName, "like", `%${operators.contains}%`);
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
  