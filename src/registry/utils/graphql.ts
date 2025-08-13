import type { ExuluTableDefinition } from "../routes";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from 'graphql-type-json';
import { GraphQLScalarType, Kind } from 'graphql';
import CryptoJS from 'crypto-js';
import { requestValidators } from '../route-validators';

// Custom Date scalar to handle timestamp conversion
const GraphQLDate = new GraphQLScalarType({
    name: 'Date',
    description: 'Date custom scalar type',
    serialize(value) {
        if (value instanceof Date) {
            return value.toISOString();
        }
        if (typeof value === 'number') {
            return new Date(value).toISOString();
        }
        if (typeof value === 'string') {
            return new Date(value).toISOString();
        }
        return value;
    },
    parseValue(value) {
        if (typeof value === 'string') {
            return new Date(value);
        }
        if (typeof value === 'number') {
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

const map = (field: any) => {
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
            type = "Date";
            break;
        default:
            type = "String";
    }
    return type;
}

function createTypeDefs(table: ExuluTableDefinition): string {
    const fields = table.fields.map(field => {
        let type: string;
        type = map(field);
        const required = field.required ? "!" : "";
        return `  ${field.name}: ${type}${required}`;
    });

    const typeDef = `
  type ${table.name.singular} {
  ${fields.join("\n")}
    id: ID!
    createdAt: Date!
    updatedAt: Date!
  }
  `;

    const inputDef = `
input ${table.name.singular}Input {
${table.fields.map(f => `  ${f.name}: ${map(f)}`).join("\n")}
}
`;

    return typeDef + inputDef;
}

function createFilterTypeDefs(table: ExuluTableDefinition): string {
    const fieldFilters = table.fields.map(field => {
        let type: string;
        type = map(field);
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
  contains: String
}

input FilterOperatorDate {
  lte: Date
  gte: Date
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
            let { input } = args;
            input = encryptSensitiveFields(input);

            // Check for each field if it is a json field, and if 
            // so, check if it is an object or array and convert 
            // it to a string.
            Object.keys(input).forEach(key => {
                if (table.fields.find(field => field.name === key)?.type === "json") {
                    if (typeof input[key] === "object" || Array.isArray(input[key])) {
                        input[key] = JSON.stringify(input[key]);
                    }
                }
            });

            const results = await db(tableNamePlural).insert({
                ...input,
                createdAt: new Date(),
                updatedAt: new Date()
            }).returning(requestedFields);

            // Filter result to only include requested fields
            return results[0];
        },
        [`${tableNamePlural}UpdateOne`]: async (_, args, context, info) => {
            const { db, req } = context;
            let { where, input } = args;
            
            await validateSuperAdminPermission(tableNamePlural, input, req);
            
            input = encryptSensitiveFields(input);

            // Check for each field if it is a json field, and if 
            // so, check if it is an object or array and convert 
            // it to a string.
            Object.keys(input).forEach(key => {
                if (table.fields.find(field => field.name === key)?.type === "json") {
                    if (typeof input[key] === "object" || Array.isArray(input[key])) {
                        input[key] = JSON.stringify(input[key]);
                    }
                }
            });


            await db(tableNamePlural).where(where).update({
                ...input,
                updatedAt: new Date()
            });
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where(where).first();
            return result;
        },
        [`${tableNamePlural}UpdateOneById`]: async (_, args, context, info) => {
            const { db, req } = context;
            let { id, input } = args;
            
            await validateSuperAdminPermission(tableNamePlural, input, req);
            
            input = encryptSensitiveFields(input);

            // Check for each field if it is a json field, and if 
            // so, check if it is an object or array and convert 
            // it to a string.
            Object.keys(input).forEach(key => {
                if (table.fields.find(field => field.name === key)?.type === "json") {
                    if (typeof input[key] === "object" || Array.isArray(input[key])) {
                        input[key] = JSON.stringify(input[key]);
                    }
                }
            });


            await db(tableNamePlural).where({ id }).update({
                ...input,
                updatedAt: new Date()
            });
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
                        query = query.whereRaw(`?? IS DISTINCT FROM ?`, [fieldName, operators.ne])
                    }
                    if (operators.in !== undefined) {
                        query = query.whereIn(fieldName, operators.in);
                    }
                    if (operators.contains !== undefined) {
                        query = query.where(fieldName, 'like', `%${operators.contains}%`);
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

            // Create base query with filters
            let baseQuery = db(tableNamePlural);
            baseQuery = applyFilters(baseQuery, filters);

            // Get total count without sorting
            const [{ count }] = await baseQuery.clone().count('* as count');
            const itemCount = Number(count);
            const pageCount = Math.ceil(itemCount / limit);
            const currentPage = page;
            const hasPreviousPage = currentPage > 1;
            const hasNextPage = currentPage < pageCount - 1;

            // Apply sorting only to the data query
            let dataQuery = baseQuery.clone();
            const requestedFields = getRequestedFields(info)
            dataQuery = applySorting(dataQuery, sort);
            if (page > 1) {
                dataQuery = dataQuery.offset((page - 1) * limit);
            }
            const items = await dataQuery.select(requestedFields).limit(limit);
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
        },
        // Add jobStatistics query for jobs table
        ...(tableNamePlural === 'jobs' ? {
            jobStatistics: async (_, args, context, info) => {
                const { user, agent, from, to } = args;
                const { db } = context;
                
                let query = db('jobs');
                
                // Apply filters
                if (user) {
                    query = query.where('user', user);
                }
                if (agent) {
                    query = query.where('agent', agent);
                }
                if (from) {
                    query = query.where('createdAt', '>=', from);
                }
                if (to) {
                    query = query.where('createdAt', '<=', to);
                }
                
                // Get completed jobs count
                const completedQuery = query.clone().where('status', 'completed');
                const [{ completedCount }] = await completedQuery.count('* as completedCount');
                
                // Get failed jobs count
                const failedQuery = query.clone().where('status', 'failed');
                const [{ failedCount }] = await failedQuery.count('* as failedCount');
                
                // Calculate average duration for completed jobs using the "duration" field (in seconds)
                const durationQuery = query.clone()
                    .where('status', 'completed')
                    .whereNotNull('duration')
                    .select(db.raw('AVG("duration") as averageDuration'));
                const [{ averageDuration }] = await durationQuery;
                
                return {
                    completedCount: Number(completedCount),
                    failedCount: Number(failedCount),
                    averageDuration: averageDuration ? Number(averageDuration) : 0
                };
            }
        } : {})
    };
}

export function createSDL(tables: ExuluTableDefinition[]) {
    console.log("[EXULU] Creating SDL")
    let typeDefs = `
    scalar JSON
    scalar Date
    
    type Query {
    `;

    let mutationDefs = `
    type Mutation {
    `;

    let modelDefs = "";
    const resolvers = { JSON: GraphQLJSON, Date: GraphQLDate, Query: {}, Mutation: {} };

    // todo add the contexts from Exulu to the schema
    for (const table of tables) {
        const tableNamePlural = table.name.plural.toLowerCase();
        const tableNameSingular = table.name.singular.toLowerCase();
        const tableNameSingularUpperCaseFirst = table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

        console.log("[EXULU] Adding table >>>>>", tableNamePlural)
        typeDefs += `
      ${tableNameSingular}ById(id: ID!): ${tableNameSingular}
      ${tableNamePlural}Pagination(limit: Int, page: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingularUpperCaseFirst}PaginationResult
      ${tableNameSingular}One(filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}
      ${tableNamePlural === 'jobs' ? `jobStatistics(user: ID, agent: String, from: String, to: String): JobStatistics` : ''}
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
        
        // Add JobStatistics type for jobs table
        if (tableNamePlural === 'jobs') {
            modelDefs += `
type JobStatistics {
  completedCount: Int!
  failedCount: Int!
  averageDuration: Float!
}
`;
        }
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

const encryptSensitiveFields = (input: any) => {
    
    // Special handling for variables table - encrypt value if encrypted flag is true
    if (input.value && input.encrypted === true) {
        input.value = CryptoJS.AES.encrypt(input.value, process.env.NEXTAUTH_SECRET).toString();
    }
    
    return input;
}

const validateSuperAdminPermission = async (tableNamePlural: string, input: any, req: any) => {
    // Check if trying to update super_admin field for users table
    if (tableNamePlural === 'users' && input.super_admin !== undefined) {
        const authResult = await requestValidators.authenticate(req);
        
        if (authResult.error || !authResult.user) {
            throw new Error('Authentication failed');
        }
        
        // Only super_admin can update super_admin field
        if (!authResult.user.super_admin) {
            throw new Error('Only super administrators can modify super_admin status');
        }
    }
}