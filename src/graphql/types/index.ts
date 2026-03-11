import { GraphQLScalarType, Kind } from "graphql";

/**
 * Base operator type with comparison operations
 */
type BaseOperator<T> = {
  /** Equals */
  eq?: T;
  /** Not equals */
  ne?: T;
  /** In array */
  in?: T[];
  /** AND conditions */
  and?: BaseOperator<T>[];
  /** OR conditions */
  or?: BaseOperator<T>[];
  /** Contains (case-insensitive substring match) */
  contains?: string;
};

/**
 * String field filter operators
 */
type StringOperator = BaseOperator<string> & {
  /** Contains (case-insensitive substring match) */
  contains?: string;
};

/**
 * Number field filter operators
 */
type NumberOperator = BaseOperator<number> & {
  /** Less than or equal to */
  lte?: number;
  /** Greater than or equal to */
  gte?: number;
};

/**
 * Date field filter operators
 */
type DateOperator = BaseOperator<Date | string> & {
  /** Less than or equal to */
  lte?: Date | string;
  /** Greater than or equal to */
  gte?: Date | string;
};

/**
 * Boolean field filter operators
 */
type BooleanOperator = BaseOperator<boolean>;

/**
 * JSON field filter operators
 */
type JsonOperator = BaseOperator<any> & {
  /** Contains (PostgreSQL @> operator for JSON containment) */
  contains?: any;
};

/**
 * Filter operator type based on field type
 */
type FilterOperator =
  | BaseOperator<any>
  | StringOperator
  | NumberOperator
  | DateOperator
  | BooleanOperator
  | JsonOperator;

/**
 * Single filter object - a record of field names to their filter operators
 */
type Filter = Record<string, FilterOperator>;

/**
 * Type for the filters parameter used throughout the codebase
 * Filters is an array of filter objects, where each object contains field names mapped to their operators
 *
 * @example
 * ```typescript
 * const filters: Filters = [
 *   { name: { contains: "test" } },
 *   { age: { gte: 18, lte: 65 } },
 *   { status: { in: ["active", "pending"] } }
 * ];
 * ```
 */
export type SearchFilters = Filter[];

// Custom Date scalar to handle timestamp conversion
export const GraphQLDate = new GraphQLScalarType({
  name: "Date",
  description: "Date custom scalar type",
  serialize(value) {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "number") {
      return new Date(value).toISOString();
    }
    if (typeof value === "string") {
      return new Date(value).toISOString();
    }
    return value;
  },
  parseValue(value) {
    if (typeof value === "string") {
      return new Date(value);
    }
    if (typeof value === "number") {
      return new Date(value);
    }
    return value;
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING) {
      return new Date(ast.value);
    }
    if (ast.kind === Kind.INT) {
      return new Date(parseInt(ast.value, 10));
    }
    return null;
  },
});
