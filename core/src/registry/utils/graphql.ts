import type { ExuluTableDefinition } from "../routes";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from 'graphql-type-json';

function createTypeDefs(table: ExuluTableDefinition): string {
    const fields = table.fields.map(field => {
        let type: string;
        switch (field.type) {
            case "text":
            case "shortText":
            case "longText":
            case "code":
                type = "String";
                break;
            case "number":
                type = "Float";
                break;
            case "boolean":
                type = "Boolean";
                break;
            case "json":
                type = "String";
                break;
            case "date":
                type = "String";
                break;
            default:
                type = "String";
        }

        const required = field.required ? "!" : "";
        return `  ${field.name}: ${type}${required}`;
    });

    const typeDef = `
  type ${table.name.singular} {
  ${fields.join("\n")}
    id: ID!
    createdAt: String!
    updatedAt: String!
  }
  `;

    const inputDef = `
input ${table.name.singular}Input {
${table.fields.map(f => `  ${f.name}: String`).join("\n")}
}
`;

    return typeDef + inputDef;
}

function createFilterTypeDefs(table: ExuluTableDefinition): string {
    const fieldFilters = table.fields.map(field => {
        let type: string;
        switch (field.type) {
            case "text":
            case "shortText":
            case "longText":
            case "code":
                type = "String";
                break;
            case "number":
                type = "Float";
                break;
            case "boolean":
                type = "Boolean";
                break;
            case "json":
                type = "JSON";
                break;
            case "date":
                type = "String";
                break;
            default:
                type = "String";
        }

        return `
  ${field.name}: FilterOperator${type}`;
    });

    const tableNameSingularUpperCaseFirst = table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);
    
    // Create filter operator types for each field type
    const operatorTypes = `
input FilterOperatorString {
  eq: String
  ne: String
  in: [String]
}

input FilterOperatorFloat {
  eq: Float
  ne: Float
  in: [Float]
}

input FilterOperatorBoolean {
  eq: Boolean
  ne: Boolean
  in: [Boolean]
}

input FilterOperatorJSON {
  eq: JSON
  ne: JSON
  in: [JSON]
}

input SortBy {
  field: String!
  direction: SortDirection!
}

enum SortDirection {
  ASC
  DESC
}

input Filter${tableNameSingularUpperCaseFirst} {
${fieldFilters.join("\n")}
}`;

    return operatorTypes;
}

const getRequestedFields = (info: any) => {
    const selections = info.operation.selectionSet.selections[0].selectionSet.selections;
    const itemsSelection = selections.find(s => s.name.value === 'items');
    const fields = itemsSelection 
        ? Object.keys(itemsSelection.selectionSet.selections.reduce((acc, field) => {
            acc[field.name.value] = true;
            return acc;
        }, {}))
        : Object.keys(selections.reduce((acc, field) => {
            acc[field.name.value] = true;
            return acc;
        }, {}));
    // remove pageInfo and items
    return fields.filter(field => field !== "pageInfo" && field !== "items");
}

function createMutations(table: ExuluTableDefinition) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const tableNameSingular = table.name.singular.toLowerCase();

    return {
        [`${tableNamePlural}CreateOne`]: async (_, args, context, info) => {
            const { db } = context;

            const requestedFields = getRequestedFields(info)

            const results = await db(tableNamePlural).insert(args.input).returning(requestedFields);

            console.log("requestedFields", requestedFields);
            
            // Filter result to only include requested fields
            return results[0];
        },
        [`${tableNamePlural}UpdateOne`]: async (_, args, context, info) => {
            const { db } = context;
            const { where, input } = args;
            await db(tableNamePlural).where(where).update(input);
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where(where).first();
            return result;
        },
        [`${tableNamePlural}UpdateOneById`]: async (_, args, context, info) => {
            const { id, input } = args;
            const { db } = context;
            await db(tableNamePlural).where({ id }).update(input);
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where({ id }).first();
            return result;
        },
        [`${tableNamePlural}RemoveOne`]: async (_, args, context, info) => {
            const { db } = context;
            const { where } = args;
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where(where).first();
            await db(tableNamePlural).where(where).del();
            return result;
        },
        [`${tableNamePlural}RemoveOneById`]: async (_, args, context, info) => {
            const { id } = args;
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where({ id }).first();
            await db(tableNamePlural).where({ id }).del();
            return result;
        }
    };
}

function createQueries(table: ExuluTableDefinition) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const tableNameSingular = table.name.singular.toLowerCase();

    const applyFilters = (query: any, filters: any[]) => {
        filters.forEach(filter => {
            Object.entries(filter).forEach(([fieldName, operators]: [string, any]) => {
                if (operators) {
                    if (operators.eq !== undefined) {
                        query = query.where(fieldName, operators.eq);
                    }
                    if (operators.ne !== undefined) {
                        query = query.whereNot(fieldName, operators.ne);
                    }
                    if (operators.in !== undefined) {
                        query = query.whereIn(fieldName, operators.in);
                    }
                }
            });
        });
        return query;
    };

    const applySorting = (query: any, sort?: { field: string; direction: 'ASC' | 'DESC' }) => {
        if (sort) {
            query = query.orderBy(sort.field, sort.direction.toLowerCase());
        }
        return query;
    };

    return {
        [`${tableNameSingular}ById`]: async (_, args, context, info) => {
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where({ id: args.id }).first();
            return result;
        },
        [`${tableNameSingular}One`]: async (_, args, context, info) => {
            const { filters = [], sort } = args;
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            let query = db.from(tableNamePlural).select(requestedFields);
            query = applyFilters(query, filters);
            query = applySorting(query, sort);
            const result = await query.first();
            return result;
        },
        [`${tableNamePlural}Pagination`]: async (_, args, context, info) => {
            const { limit = 10, page = 0, filters = [], sort } = args;
            const { db } = context;

            console.log("page", page);
            
            // Create base query with filters
            let baseQuery = db(tableNamePlural);
            baseQuery = applyFilters(baseQuery, filters);
            
            // Get total count without sorting
            const [{ count }] = await baseQuery.clone().count('* as count');
            const itemCount = Number(count);
            const pageCount = Math.ceil(itemCount / limit);
            const currentPage = page;
            const hasPreviousPage = currentPage > 0;
            const hasNextPage = currentPage < pageCount - 1;

            // Apply sorting only to the data query
            let dataQuery = baseQuery.clone();
            const requestedFields = getRequestedFields(info)
            dataQuery = applySorting(dataQuery, sort);
            if (page > 1) {
                dataQuery = dataQuery.offset((page - 1) * limit);
            }
            const items = await dataQuery.select(requestedFields).limit(limit);

            console.log("query", dataQuery.toQuery());
            return {
                pageInfo: {
                    pageCount,
                    itemCount,
                    currentPage,
                    hasPreviousPage,
                    hasNextPage
                },
                items: items
            };
        }
    };
}

export function createSDL(tables: ExuluTableDefinition[]) {
    let typeDefs = `
    scalar JSON
    
    type Query {
    `;
    
    let mutationDefs = `
    type Mutation {
    `;
    
    let modelDefs = "";
    const resolvers = { JSON: GraphQLJSON, Query: {}, Mutation: {} };
    
    // todo add the contexts from Exulu to the schema
    for (const table of tables) {
        const tableNamePlural = table.name.plural.toLowerCase();
        const tableNameSingular = table.name.singular.toLowerCase();
        const tableNameSingularUpperCaseFirst = table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

        typeDefs += `
      ${tableNameSingular}ById(id: ID!): ${tableNameSingular}
      ${tableNamePlural}Pagination(limit: Int, page: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingularUpperCaseFirst}PaginationResult
      ${tableNameSingular}One(filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}
    `;
    // todo add the fields of each table as filter options
        mutationDefs += `
      ${tableNamePlural}CreateOne(input: ${tableNameSingular}Input!): ${tableNameSingular}
      ${tableNamePlural}UpdateOne(where: JSON!, input: ${tableNameSingular}Input!): ${tableNameSingular}
      ${tableNamePlural}UpdateOneById(id: ID!, input: ${tableNameSingular}Input!): ${tableNameSingular}
      ${tableNamePlural}RemoveOne(where: JSON!): ${tableNameSingular}
      ${tableNamePlural}RemoveOneById(id: ID!): ${tableNameSingular}
    `;
        modelDefs += createTypeDefs(table);
        modelDefs += createFilterTypeDefs(table);
        modelDefs += `
type ${tableNameSingularUpperCaseFirst}PaginationResult {
  pageInfo: PageInfo!
  items: [${tableNameSingular}]!
}

type PageInfo {
  pageCount: Int!
  itemCount: Int!
  currentPage: Int!
  hasPreviousPage: Boolean!
  hasNextPage: Boolean!
}
`;
        Object.assign(resolvers.Query, createQueries(table));
        Object.assign(resolvers.Mutation, createMutations(table));
    }
    
    typeDefs += "}\n";
    mutationDefs += "}\n";
    
    const fullSDL = typeDefs + mutationDefs + modelDefs;
    
    // -------------- Create Schema ------------------
    
    const schema = makeExecutableSchema({
      typeDefs: fullSDL,
      resolvers
    });

    // Log schema information in table format
    console.log('\n📊 GraphQL Schema Overview\n');

    // Prepare data for tables
    const queriesTable = Object.keys(resolvers.Query).map(query => ({
      'Operation Type': 'Query',
      'Name': query,
      'Description': 'Retrieves data'
    }));

    const mutationsTable = Object.keys(resolvers.Mutation).map(mutation => ({
      'Operation Type': 'Mutation',
      'Name': mutation,
      'Description': 'Modifies data'
    }));

    const typesTable = tables.flatMap(table => 
      table.fields.map(field => ({
        'Type': table.name.singular,
        'Field': field.name,
        'Field Type': field.type,
        'Required': field.required ? 'Yes' : 'No'
      }))
    );

    // Log tables
    console.log('🔍 Operations:');
    console.table([...queriesTable, ...mutationsTable]);
    
    console.log('\n📝 Types and Fields:');
    console.table(typesTable);
    
    console.log('\n');

    return schema;
}