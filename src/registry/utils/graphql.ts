import type { ExuluTableDefinition } from "../routes";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from 'graphql-type-json';
import { GraphQLScalarType, Kind } from 'graphql';
import CryptoJS from 'crypto-js';
import { requestValidators } from '../route-validators';
import bcrypt from "bcryptjs";

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

    // Add RBAC field if enabled
    const rbacField = table.RBAC ? '  RBAC: RBACData' : '';


    // Allow defining a custom id type (for example the users entity has type number because of next-auth)
    const typeDef = `
  type ${table.name.singular} {
  ${fields.join("\n")}
    ${table.fields.find(field => field.name === "id") ? "" : "id: ID!"}
    createdAt: Date!
    updatedAt: Date!
${rbacField}
  }
  `;

    // Add RBAC input field if enabled
    const rbacInputField = table.RBAC ? '  RBAC: RBACInput' : '';

    const inputDef = `
input ${table.name.singular}Input {
${table.fields.map(f => `  ${f.name}: ${map(f)}`).join("\n")}
${rbacInputField}
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
    return fields.filter(field => field !== "pageInfo" && field !== "items" && field !== "RBAC");
}

// Helper function to handle RBAC updates
const handleRBACUpdate = async (db: any, entityName: string, resourceId: string, rbacData: any, existingRbacRecords: any[]) => {
    const { users = [], roles = [] } = rbacData;

    // Get existing RBAC records if not provided
    if (!existingRbacRecords) {
        existingRbacRecords = await db.from('rbac')
            .where({
                entity: entityName,
                target_resource_id: resourceId
            })
            .select('*');
    }

    // Create sets for comparison
    const newUserRecords = new Set(users.map((u: any) => `${u.id}:${u.rights}`));
    const newRoleRecords = new Set(roles.map((r: any) => `${r.id}:${r.rights}`));
    const existingUserRecords = new Set(existingRbacRecords
        .filter(r => r.access_type === 'User')
        .map(r => `${r.user_id}:${r.rights}`));
    const existingRoleRecords = new Set(existingRbacRecords
        .filter(r => r.access_type === 'Role')
        .map(r => `${r.role_id}:${r.rights}`));

    // Records to create
    const usersToCreate = users.filter((u: any) => !existingUserRecords.has(`${u.id}:${u.rights}`));
    const rolesToCreate = roles.filter((r: any) => !existingRoleRecords.has(`${r.id}:${r.rights}`));

    // Records to remove
    const usersToRemove = existingRbacRecords
        .filter(r => r.access_type === 'User' && !newUserRecords.has(`${r.user_id}:${r.rights}`));
    const rolesToRemove = existingRbacRecords
        .filter(r => r.access_type === 'Role' && !newRoleRecords.has(`${r.role_id}:${r.rights}`));

    // Remove obsolete records
    if (usersToRemove.length > 0) {
        await db.from('rbac').whereIn('id', usersToRemove.map(r => r.id)).del();
    }
    if (rolesToRemove.length > 0) {
        await db.from('rbac').whereIn('id', rolesToRemove.map(r => r.id)).del();
    }

    // Create new records
    const recordsToInsert: any[] = [];

    usersToCreate.forEach((user: any) => {
        recordsToInsert.push({
            entity: entityName,
            access_type: 'User',
            target_resource_id: resourceId,
            user_id: user.id,
            rights: user.rights,
            createdAt: new Date(),
            updatedAt: new Date()
        });
    });

    rolesToCreate.forEach((role: any) => {
        recordsToInsert.push({
            entity: entityName,
            access_type: 'Role',
            target_resource_id: resourceId,
            role_id: role.id,
            rights: role.rights,
            createdAt: new Date(),
            updatedAt: new Date()
        });
    });

    if (recordsToInsert.length > 0) {
        await db.from('rbac').insert(recordsToInsert);
    }
};

function createMutations(table: ExuluTableDefinition) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const validateWriteAccess = async (id: string, context: any) => {

        try {
            const { db, req, user } = context;

            const record = await db.from(tableNamePlural)
                .select(['rights_mode', 'created_by'])
                .where({ id })
                .first();

            if (!record) {
                throw new Error('Record not found');
            }

            // Special rules for jobs.
            if (tableNamePlural === "jobs") {
                // If a user is not super admin, they 
                // can only see their own jobs.
                // todo we could potentially check the if the request is for jobs with type embeddder, and then filter on jobs where the user has access to the context source of the embedder.
                if (!user.super_admin && record.created_by !== user.id) {
                    throw new Error('You are not authorized to edit this record');
                }
            }

            // Check if this table has RBAC enabled or legacy access control fields
            const hasRBAC = table.RBAC === true;

            if (!hasRBAC) {
                return true; // No access control needed
            }

            if (user.super_admin === true) {
                return true; // todo roadmap - scoping api users to specific resources
            }

            if (!user.role || (
                !(table.name.plural === "agents" && user.role.agents === "write") &&
                !(table.name.plural === "workflow_templates" && user.role.workflows === "write") &&
                !(table.name.plural === "variables" && user.role.variables === "write") &&
                !(table.name.plural === "users" && user.role.users === "write")
            )) {
                console.error('Access control error: no role found for current user or no access to entity type.');
                // Return empty result on error
                throw new Error('Access control error: no role found for current user or no access to entity type.');
            }

            // Check if record is public (any user can edit)
            if (record.rights_mode === 'public') {
                return true;
            }

            // Check if record is private and user is creator
            if (record.rights_mode === 'private') {
                if (record.created_by === user.id) {
                    return true;
                }
                throw new Error('Only the creator can edit this private record');
            }

            // Check if user has write access via RBAC table
            if (record.rights_mode === 'users') {
                const rbacRecord = await db.from('rbac')
                    .where({
                        entity: table.name.singular,
                        target_resource_id: id,
                        access_type: 'User',
                        user_id: user.id,
                        rights: 'write'
                    })
                    .first();

                if (rbacRecord) {
                    return true;
                }
                throw new Error('Insufficient user permissions to edit this record');
            }

            // Check if user has write access via role in RBAC table
            if (record.rights_mode === 'roles' && user.role) {
                const rbacRecord = await db.from('rbac')
                    .where({
                        entity: table.name.singular,
                        target_resource_id: id,
                        access_type: 'Role',
                        role_id: user.role,
                        rights: 'write'
                    })
                    .first();

                if (rbacRecord) {
                    return true;
                }
                throw new Error('Insufficient role permissions to edit this record');
            }

            throw new Error('Insufficient permissions to edit this record');



        } catch (error) {
            console.error('Write access validation error:', error);
            throw error;
        }
    };

    return {
        [`${tableNamePlural}CreateOne`]: async (_, args, context, info) => {
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            let { input } = args;

            // Handle RBAC input
            const rbacData = input.RBAC;
            delete input.RBAC;

            // Remove created_by field to prevent mutation
            delete input.created_by;

            input = encryptSensitiveFields(input);

            if (table.RBAC) {
                input.created_by = context.user.id;
            }

            if (table.name.singular === "user" && context.user?.super_admin !== true) {
                throw new Error('You are not authorized to create users');
            }

            if (table.name.singular === "user" && input.password) {
                input.password = await bcrypt.hash(input.password, 10);
            }

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
                ...(table.RBAC ? { rights_mode: 'private' } : {}),
                createdAt: new Date(),
                updatedAt: new Date()
            }).returning(requestedFields);

            // Handle RBAC records if provided
            if (table.RBAC && rbacData && results[0]) {
                await handleRBACUpdate(db, table.name.singular, results[0].id, rbacData, []);
            }

            // Filter result to only include requested fields
            return results[0];
        },
        [`${tableNamePlural}UpdateOne`]: async (_, args, context, info) => {
            const { db, req } = context;
            let { where, input } = args;

            await validateCreateOrRemoveSuperAdminPermission(tableNamePlural, input, req);

            // For access-controlled tables, validate write access
            if (where.id) {
                await validateWriteAccess(where.id, context);
            }

            // Handle RBAC input
            const rbacData = input.RBAC;
            delete input.RBAC;

            // Remove created_by field to prevent mutation
            delete input.created_by;

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

            // Handle RBAC records if provided
            if (table.RBAC && rbacData && where.id) {
                const existingRbacRecords = await db.from('rbac')
                    .where({
                        entity: table.name.singular,
                        target_resource_id: where.id
                    })
                    .select('*');

                await handleRBACUpdate(db, table.name.singular, where.id, rbacData, existingRbacRecords);
            }

            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where(where).first();
            return result;
        },
        [`${tableNamePlural}UpdateOneById`]: async (_, args, context, info) => {
            const { db, req } = context;
            let { id, input } = args;

            await validateCreateOrRemoveSuperAdminPermission(tableNamePlural, input, req);

            // For access-controlled tables, validate write access
            await validateWriteAccess(id, context);

            // Handle RBAC input
            const rbacData = input.RBAC;
            delete input.RBAC;

            // Remove created_by field to prevent mutation
            delete input.created_by;

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

            // Handle RBAC records if provided
            if (table.RBAC && rbacData) {
                const existingRbacRecords = await db.from('rbac')
                    .where({
                        entity: table.name.singular,
                        target_resource_id: id
                    })
                    .select('*');

                await handleRBACUpdate(db, table.name.singular, id, rbacData, existingRbacRecords);
            }

            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where({ id }).first();
            return result;
        },
        [`${tableNamePlural}RemoveOne`]: async (_, args, context, info) => {
            const { db } = context;
            const { where } = args;
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where(where).first();

            if (!result) {
                throw new Error('Record not found');
            }

            await db(tableNamePlural).where(where).del();

            if (table.RBAC) {
                await db.from('rbac').where({
                    entity: table.name.singular,
                    target_resource_id: result.id
                }).del();
            }

            return result;
        },
        [`${tableNamePlural}RemoveOneById`]: async (_, args, context, info) => {
            const { id } = args;
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const result = await db.from(tableNamePlural).select(requestedFields).where({ id }).first();

            if (!result) {
                throw new Error('Record not found');
            }

            await db(tableNamePlural).where({ id }).del();

            if (table.RBAC) {
                await db.from('rbac').where({
                    entity: table.name.singular,
                    target_resource_id: id
                }).del();
            }

            return result;
        }
    };
}

export const applyAccessControl = (table: ExuluTableDefinition, user: any, query: any) => {

    console.log("table", table)
    const tableNamePlural = table.name.plural.toLowerCase();

    const hasRBAC = table.RBAC === true;
    if (!hasRBAC) {
        return query;
    }

    if (user.super_admin === true) {
        return query; // todo roadmap - scoping api users to specific resources
    }

    if (table.name.plural === "jobs") {
        // If a user is not super admin, they 
        // can only see their own jobs.
        // todo we could potentially check the if the request is for jobs with type embeddder, and then filter on jobs where the user has access to the context source of the embedder.
        query = query.where('created_by', user.id);
        return query;
    }

    if (!user.role || (
        !(table.name.plural === "agents" && (user.role.agents === "read" || user.role.agents === "write")) &&
        !(table.name.plural === "workflow_templates" && (user.role.workflows === "read" || user.role.workflows === "write")) &&
        !(table.name.plural === "variables" && (user.role.variables === "read" || user.role.variables === "write")) &&
        !(table.name.plural === "users" && (user.role.users === "read" || user.role.users === "write"))
    )) {
        console.error('Access control error: no role found or no access to entity type.');
        // Return empty result on error
        return query.where('1', '=', '0');
    }

    try {
        // New RBAC system
        query = query.where(function (this: any) {
            // Public records
            this.where('rights_mode', 'public');
            this.orWhere('created_by', user.id);

            // Records shared with users via RBAC table
            this.orWhere(function (this: any) {
                this.where('rights_mode', 'users')
                    .whereExists(function (this: any) {
                        this.select('*')
                            .from('rbac')
                            .whereRaw('rbac.target_resource_id = ' + tableNamePlural + '.id')
                            .where('rbac.entity', table.name.singular)
                            .where('rbac.access_type', 'User')
                            .where('rbac.user_id', user.id);
                    });
            });

            // Records shared with roles via RBAC table (if user has a role)
            if (user.role) {
                console.log("user.role", user.role)
                this.orWhere(function (this: any) {
                    this.where('rights_mode', 'roles')
                        .whereExists(function (this: any) {
                            this.select('*')
                                .from('rbac')
                                .whereRaw('rbac.target_resource_id = ' + tableNamePlural + '.id')
                                .where('rbac.entity', table.name.singular)
                                .where('rbac.access_type', 'Role')
                                .where('rbac.role_id', user.role);
                        });
                });
            }
        });
    } catch (error) {
        console.error('Access control error:', error);
        // Return empty result on error
        return query.where('1', '=', '0');
    }

    return query;
};

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
            let query = db.from(tableNamePlural).select(requestedFields).where({ id: args.id });
            query = applyAccessControl(table, context.user, query);
            const result = await query.first();
            return result;
        },
        [`${tableNameSingular}One`]: async (_, args, context, info) => {
            const { filters = [], sort } = args;
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            let query = db.from(tableNamePlural).select(requestedFields);
            query = applyFilters(query, filters);
            query = applyAccessControl(table, context.user, query);
            query = applySorting(query, sort);
            const result = await query.first();
            return result;
        },
        [`${tableNamePlural}Pagination`]: async (_, args, context, info) => {
            const { limit = 10, page = 0, filters = [], sort } = args;
            const { db } = context;

            // Create count query  
            let countQuery = db(tableNamePlural);
            countQuery = applyFilters(countQuery, filters);
            countQuery = applyAccessControl(table, context.user, countQuery);

            console.log("countQuery", countQuery)

            // Get total count
            const countResult = await countQuery.count('* as count');
            const itemCount = Number(countResult[0]?.count || 0);
            const pageCount = Math.ceil(itemCount / limit);
            const currentPage = page;
            const hasPreviousPage = currentPage > 1;
            const hasNextPage = currentPage < pageCount - 1;

            // Create separate data query
            let dataQuery = db(tableNamePlural);
            dataQuery = applyFilters(dataQuery, filters);
            dataQuery = applyAccessControl(table, context.user, dataQuery);

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
        // Add generic statistics query for all tables
        [`${tableNamePlural}Statistics`]: async (_, args, context, info) => {
            const { filters = [], groupBy } = args;
            const { db } = context;

            let query = db(tableNamePlural);
            query = applyFilters(query, filters);
            query = applyAccessControl(table, context.user, query);

            // Group by the specified field and count
            if (groupBy) {
                const results = await query
                    .select(groupBy)
                    .count('* as count')
                    .groupBy(groupBy);

                return results.map(r => ({
                    group: r[groupBy],
                    count: Number(r.count)
                }));
            } else {
                // Just return total count
                const [{ count }] = await query.count('* as count');
                return [{
                    group: 'total',
                    count: Number(count)
                }];
            }
        },
        // Add jobStatistics query for jobs table (backward compatibility)
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

                // Apply access control
                query = applyAccessControl(table, context.user, query);

                // Get running jobs count (active, waiting, delayed, paused)
                const runningQuery = query.clone().whereIn('status', ['active', 'waiting', 'delayed', 'paused']);
                const [{ runningCount }] = await runningQuery.count('* as runningCount');

                // Get errored jobs count (failed, stuck)
                const erroredQuery = query.clone().whereIn('status', ['failed', 'stuck']);
                const [{ erroredCount }] = await erroredQuery.count('* as erroredCount');

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
                    runningCount: Number(runningCount),
                    erroredCount: Number(erroredCount),
                    completedCount: Number(completedCount),
                    failedCount: Number(failedCount),
                    averageDuration: averageDuration ? Number(averageDuration) : 0
                };
            }
        } : {})
    };
}

export const RBACResolver = async (db: any, table: ExuluTableDefinition, entityName: string, resourceId: string, rights_mode: string) => {

    // Get RBAC records for this resource
    const rbacRecords = await db.from('rbac')
        .where({
            entity: entityName,
            target_resource_id: resourceId
        })
        .select('*');

    const users = rbacRecords
        .filter(r => r.access_type === 'User')
        .map(r => ({ id: r.user_id, rights: r.rights }));

    const roles = rbacRecords
        .filter(r => r.access_type === 'Role')
        .map(r => ({ id: r.role_id, rights: r.rights }));

    // Determine the type based on rights_mode or presence of records
    let type = rights_mode || 'private';
    if (type === 'users' && users.length === 0) type = 'private';
    if (type === 'roles' && roles.length === 0) type = 'private';

    return {
        type,
        users,
        roles
    };
}

export function createSDL(tables: ExuluTableDefinition[]) {
    console.log("[EXULU] Creating SDL")
    let typeDefs = `
    scalar JSON
    scalar Date
    
    type RBACData {
      type: String!
      users: [RBACUser!]
      roles: [RBACRole!]
    }
    
    type RBACUser {
      id: ID!
      rights: String!
    }
    
    type RBACRole {
      id: ID!
      rights: String!
    }
    
    input RBACInput {
      users: [RBACUserInput!]
      roles: [RBACRoleInput!]
    }
    
    input RBACUserInput {
      id: ID!
      rights: String!
    }
    
    input RBACRoleInput {
      id: ID!
      rights: String!
    }
    
    type Query {
    `;

    let mutationDefs = `
    type Mutation {
    `;

    let modelDefs = "";
    const resolvers = { JSON: GraphQLJSON, Date: GraphQLDate, Query: {}, Mutation: {} };

    // todo add the contexts from Exulu to the schema and then remove from the REST API make sure to also check if user has
    //   read / write access to the contexts table
    for (const table of tables) {
        // Skip tables with graphql: false
        if (table.graphql === false) {
            continue;
        }
        const tableNamePlural = table.name.plural.toLowerCase();
        const tableNameSingular = table.name.singular.toLowerCase();
        const tableNameSingularUpperCaseFirst = table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

        console.log("[EXULU] Adding table >>>>>", tableNamePlural)
        typeDefs += `
      ${tableNameSingular}ById(id: ID!): ${tableNameSingular}
      ${tableNamePlural}Pagination(limit: Int, page: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingularUpperCaseFirst}PaginationResult
      ${tableNameSingular}One(filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}
      ${tableNamePlural}Statistics(filters: [Filter${tableNameSingularUpperCaseFirst}], groupBy: String): [StatisticsResult]!
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
  runningCount: Int!
  erroredCount: Int!
  completedCount: Int!
  failedCount: Int!
  averageDuration: Float!
}
`;
        }
        Object.assign(resolvers.Query, createQueries(table));
        Object.assign(resolvers.Mutation, createMutations(table));

        // Add RBAC resolver if enabled
        if (table.RBAC) {
            const rbacResolverName = table.name.singular;
            if (!resolvers[rbacResolverName]) {
                resolvers[rbacResolverName] = {};
            }
            resolvers[rbacResolverName].RBAC = async (parent: any, args: any, context: any) => {
                const { db } = context;
                const resourceId = parent.id;
                const entityName = table.name.singular
                const rights_mode = parent.rights_mode;
                return RBACResolver(db, table, entityName, resourceId, rights_mode)
            }
        }
    }

    typeDefs += "}\n";
    mutationDefs += "}\n";

    // Add generic types used across all tables
    const genericTypes = `
type StatisticsResult {
  group: String!
  count: Int!
}
`;

    const fullSDL = typeDefs + mutationDefs + modelDefs + genericTypes;

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

const validateCreateOrRemoveSuperAdminPermission = async (tableNamePlural: string, input: any, req: any) => {
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