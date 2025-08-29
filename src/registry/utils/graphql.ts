import type { ExuluTableDefinition } from "../routes";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from 'graphql-type-json';
import { GraphQLScalarType, Kind } from 'graphql';
import CryptoJS from 'crypto-js';
import { requestValidators } from '../route-validators';
import bcrypt from "bcryptjs";
import { ExuluAgent, ExuluTool, getTableName, type ExuluContext } from "../classes";
import { addRBACfields } from "../../postgres/core-schema";
import { sanitizeName } from "./sanitize-name";

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
        case "enum":
            type = field.enumValues ? `${field.name}Enum` : "String";
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

    // Generate enum definitions for enum fields
    const enumDefs = table.fields
        .filter(field => field.type === "enum" && field.enumValues)
        .map(field => {
            // @ts-ignore
            const enumValues = field.enumValues
                .map(value => {
                    // Convert enum values to valid GraphQL identifiers
                    const sanitized = String(value)
                        .replace(/[^a-zA-Z0-9_]/g, '_')
                        .replace(/^[0-9]/, '_$&')
                        .toUpperCase();
                    return `  ${sanitized}`;
                })
                .join("\n");
            return `
enum ${field.name}Enum {
${enumValues}
}`;
        })
        .join("\n");

    let fields = table.fields.map(field => {
        let type: string;
        type = map(field);
        const required = field.required ? "!" : "";
        return `  ${field.name}: ${type}${required}`;
    });

    if (table.name.singular === "agent") {
        fields.push("  providerName: String")
        fields.push("  modelName: String")
        fields.push("  rateLimit: RateLimiterRule")
        fields.push("  streaming: Boolean")
        fields.push("  capabilities: AgentCapabilities")
        fields.push("  slug: String")
    }

    // Add RBAC field if enabled
    const rbacField = table.RBAC ? '  RBAC: RBACData' : '';


    // Allow defining a custom id type (for example the users entity has type number because of next-auth)
    const typeDef = `
  type ${table.name.singular} {
  ${fields.join("\n")}
    ${table.fields.find(field => field.name === "id") ? "" : "id: ID!"}
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

    return enumDefs + typeDef + inputDef;
}

function createFilterTypeDefs(table: ExuluTableDefinition): string {
    const fieldFilters = table.fields.map(field => {
        let type: string;
        if (field.type === "enum" && field.enumValues) {
            type = `${field.name}Enum`;
        } else {
            type = map(field);
        }
        return `
  ${field.name}: FilterOperator${type}`;
    });

    const tableNameSingularUpperCaseFirst = table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

    // Create enum-specific filter operators
    const enumFilterOperators = table.fields
        .filter(field => field.type === "enum" && field.enumValues)
        .map(field => {
            const enumTypeName = `${field.name}Enum`;
            return `
input FilterOperator${enumTypeName} {
  eq: ${enumTypeName}
  ne: ${enumTypeName}
  in: [${enumTypeName}]
  and: [FilterOperator${enumTypeName}]
  or: [FilterOperator${enumTypeName}]
}`;
        })
        .join("\n");

    // Create filter operator types for each field type
    const operatorTypes = `
input FilterOperatorString {
  eq: String
  ne: String
  in: [String]
  contains: String
  and: [FilterOperatorString]
  or: [FilterOperatorString]
}

input FilterOperatorDate {
  lte: Date
  gte: Date
  and: [FilterOperatorDate]
  or: [FilterOperatorDate]
}

input FilterOperatorFloat {
  eq: Float
  ne: Float
  in: [Float]
  and: [FilterOperatorFloat]
  or: [FilterOperatorFloat]
}

input FilterOperatorBoolean {
  eq: Boolean
  ne: Boolean
  in: [Boolean]
  and: [FilterOperatorBoolean]
  or: [FilterOperatorBoolean]
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

${enumFilterOperators}

input Filter${tableNameSingularUpperCaseFirst} {
${fieldFilters.join("\n")}
}`;

    return operatorTypes;
}

const getRequestedFields = (info: any): string[] => {
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

function createMutations(table: ExuluTableDefinition, agents: ExuluAgent[], contexts: ExuluContext[], tools: ExuluTool[]) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const validateWriteAccess = async (id: string, context: any) => {

        try {

            const { db, req, user } = context;

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

            // Check if this table has RBAC enabled or legacy access control fields
            const hasRBAC = table.RBAC === true;

            if (!hasRBAC) {
                return true; // No access control needed
            }

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
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
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
            }).returning(sanitizedFields);

            // Handle RBAC records if provided
            if (table.RBAC && rbacData && results[0]) {
                await handleRBACUpdate(db, table.name.singular, results[0].id, rbacData, []);
            }

            // Filter result to only include requested fields
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result: results[0] })
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
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            const result = await db.from(tableNamePlural).select(sanitizedFields).where(where).first();
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result })
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
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            const result = await db.from(tableNamePlural).select(sanitizedFields).where({ id }).first();
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result })
        },
        [`${tableNamePlural}RemoveOneById`]: async (_, args, context, info) => {
            const { id } = args;
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            const result = await db.from(tableNamePlural).select(sanitizedFields).where({ id }).first();

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

            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result })
        }
    };
}

export const applyAccessControl = (table: ExuluTableDefinition, user: any, query: any) => {

    console.log("table", table)
    const tableNamePlural = table.name.plural.toLowerCase();

    if (!user.super_admin && table.name.plural === "jobs") {
        // If a user is not super admin, they 
        // can only see their own jobs.
        // todo we could potentially check the if the request is for jobs with type embeddder, and then filter on jobs where the user has access to the context source of the embedder.
        query = query.where('created_by', user.id);
        return query;
    }

    const hasRBAC = table.RBAC === true;
    if (!hasRBAC) {
        return query;
    }

    // If a user is super admin, they can see everything, except if
    // the table is agent_sessions, in which case we always enforce
    // the regular rbac rules set for the session (defaults to private).
    if (table.name.plural !== "agent_sessions" && user.super_admin === true) {
        return query; // todo roadmap - scoping api users to specific resources
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

const converOperatorToQuery = (query: any, fieldName: string, operators: any) => {
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
    if (operators.lte !== undefined) {
        query = query.where(fieldName, '<=', operators.lte);
    }
    if (operators.gte !== undefined) {
        query = query.where(fieldName, '>=', operators.gte);
    }
    return query;
}

const backendAgentFields = [
    "providerName",
    "modelName",
    "slug",
    "rateLimit",
    "streaming",
    "capabilities"
]

const removeAgentFields = (requestedFields: string[]) => {
    const filtered = requestedFields.filter(field => !backendAgentFields.includes(field));
    // Always add the backend field as we need it to get specific fields
    // we sanitize this out again in the finalizeRequestedFields step.
    filtered.push("backend")
    return filtered;
}

const addAgentFields = (requestedFields: string[], agents: ExuluAgent[], result: any) => {
    let backend = agents.find(a => a.id === result?.backend);
    if (requestedFields.includes("providerName")) {
        result.providerName = backend?.providerName || ""
    }
    if (requestedFields.includes("modelName")) {
        result.modelName = backend?.modelName || ""
    }
    if (requestedFields.includes("slug")) {
        result.slug = backend?.slug || ""
    }
    if (requestedFields.includes("rateLimit")) {
        result.rateLimit = backend?.rateLimit || ""
    }
    if (requestedFields.includes("streaming")) {
        result.streaming = backend?.streaming || false
    }
    if (requestedFields.includes("capabilities")) {
        result.capabilities = backend?.capabilities || []
    }
    if (!requestedFields.includes("backend")) {
        delete result.backend
    }
    return result;
}

const sanitizeRequestedFields = (table: ExuluTableDefinition, requestedFields: string[]) => {

    if (table.name.singular === "agent") {
        requestedFields = removeAgentFields(requestedFields)
    }
    if (!requestedFields.includes("id")) {
        // We always add the id for the postgres selection
        // to avoid issues with rbac, which needs this field.
        // We remove it again during the "finalizeRequestedFields"
        // step in case it wasnt requested for the final payload.
        requestedFields.push("id")
    }
    return requestedFields;
}

const finalizeRequestedFields = ({
    table,
    requestedFields,
    agents,
    contexts,
    tools,
    result
}: {
    table: ExuluTableDefinition,
    requestedFields: string[],
    agents: ExuluAgent[],
    contexts: ExuluContext[],
    tools: ExuluTool[],
    result: any | []
}) => {
    if (!result) {
        return result;
    }
    if (Array.isArray(result)) {
        result = result.map(item => {
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result: item })
        })
    } else {
        if (table.name.singular === "agent") {
            result = addAgentFields(requestedFields, agents, result)
            if (!requestedFields.includes("backend")) {
                delete result.backend
            }
        }
    }
    return result;
}

function createQueries(table: ExuluTableDefinition, agents: ExuluAgent[], tools: ExuluTool[], contexts: ExuluContext[]) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const tableNameSingular = table.name.singular.toLowerCase();

    const applyFilters = (query: any, filters: any[]) => {
        filters.forEach(filter => {
            Object.entries(filter).forEach(([fieldName, operators]: [string, any]) => {
                if (operators) {
                    if (operators.and !== undefined) {
                        console.log("operators.and", operators.and)
                        operators.and.forEach(operator => {
                            query = converOperatorToQuery(query, fieldName, operator);
                        });
                    }
                    if (operators.or !== undefined) {
                        operators.or.forEach(operator => {
                            query = converOperatorToQuery(query, fieldName, operator);
                        });
                    }
                    query = converOperatorToQuery(query, fieldName, operators)
                    console.log("query", query)
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
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            let query = db.from(tableNamePlural).select(sanitizedFields).where({ id: args.id });
            query = applyAccessControl(table, context.user, query);
            let result = await query.first();
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result })
        },
        [`${tableNameSingular}ByIds`]: async (_, args, context, info) => {
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            let query = db.from(tableNamePlural).select(sanitizedFields).whereIn('id', args.ids);
            query = applyAccessControl(table, context.user, query);
            let result = await query;
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result })
        },
        [`${tableNameSingular}One`]: async (_, args, context, info) => {
            const { filters = [], sort } = args;
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            let query = db.from(tableNamePlural).select(sanitizedFields);
            query = applyFilters(query, filters);
            query = applyAccessControl(table, context.user, query);
            query = applySorting(query, sort);
            let result = await query.first();
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result })
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
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            let items = await dataQuery.select(sanitizedFields).limit(limit);
            return {
                pageInfo: {
                    pageCount,
                    itemCount,
                    currentPage,
                    hasPreviousPage,
                    hasNextPage
                },
                items: finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result: items })
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
                query = query
                    .select(groupBy)
                    .groupBy(groupBy);

                // if table is tracking, then instead of counting we sum the total column
                if (tableNamePlural === "tracking") {
                    query = query.sum('total as count');
                } else {
                    query = query.count('* as count')
                }
                const results = await query
                console.log("!!! results !!!", results)
                return results.map(r => ({
                    group: r[groupBy],
                    count: r.count ? Number(r.count) : 0
                }));
            } else {
                // Just return total count
                // if table is tracking, then instead of counting we sum the total column
                if (tableNamePlural === "tracking") {
                    query = query.sum('total as count');
                    const [{ count }] = await query.sum('total as count');
                    console.log("!!! count !!!", count)
                    return [{
                        group: 'total',
                        count: count ? Number(count) : 0
                    }];
                } else {
                    const [{ count }] = await query.count('* as count');
                    return [{
                        group: 'total',
                        count: count ? Number(count) : 0
                    }];
                }
            }
        }
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

export function createSDL(tables: ExuluTableDefinition[], contexts: ExuluContext[], agents: ExuluAgent[], tools: ExuluTool[]) {

    const contextSchemas: ExuluTableDefinition[] = []

    console.log("============= Agents =============", agents?.length)

    contexts.forEach(context => {
        const tableName = getTableName(context.id) as any;
        const definition: ExuluTableDefinition = {
            name: {
                singular: tableName,
                plural: tableName?.endsWith("s") ? tableName : tableName + "s" as any,
            },
            RBAC: true,
            fields: context.fields.map(field => ({
                name: sanitizeName(field.name) as any,
                type: field.type
            }))
        }
        contextSchemas.push(addRBACfields(definition))
    })

    // Adding fields to SDL that are not defined via
    // ExuluContext instances but added in the
    // backend at createItemsTable().
    contextSchemas.forEach(contextSchema => {
        contextSchema.fields.push({
            // important: the contexts use the default knex timestamp 
            // fields which are different to the regular 
            // ExuluTableDefinition, i.e. created_at vs. createdAt.
            name: "created_at",
            type: "date",
        })
        contextSchema.fields.push({
            name: "updated_at",
            type: "date",
        })
        contextSchema.fields.push({
            name: "name",
            type: "text",
        })
        contextSchema.fields.push({
            name: "description",
            type: "text",
        })
        contextSchema.fields.push({
            name: "tags",
            type: "text",
        })
        contextSchema.fields.push({
            name: "archived",
            type: "boolean",
        })
    })

    tables.forEach(table => {
        table.fields.push({
            name: "createdAt",
            type: "date",
        })
        table.fields.push({
            name: "updatedAt",
            type: "date",
        })
    })

    tables = [...tables, ...contextSchemas]

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
      ${tableNameSingular}ByIds(ids: [ID!]!): [${tableNameSingular}]!
      ${tableNamePlural}Pagination(limit: Int, page: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingularUpperCaseFirst}PaginationResult
      ${tableNameSingular}One(filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}
      ${tableNamePlural}Statistics(filters: [Filter${tableNameSingularUpperCaseFirst}], groupBy: String): [StatisticsResult]!
    `;
        // todo add the fields of each table as filter options
        mutationDefs += `
      ${tableNamePlural}CreateOne(input: ${tableNameSingular}Input!): ${tableNameSingular}
      ${tableNamePlural}UpdateOne(where: JSON!, input: ${tableNameSingular}Input!): ${tableNameSingular}
      ${tableNamePlural}UpdateOneById(id: ID!, input: ${tableNameSingular}Input!): ${tableNameSingular}
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
        Object.assign(resolvers.Query, createQueries(table, agents, tools, contexts));
        Object.assign(resolvers.Mutation, createMutations(table, agents, contexts, tools));

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

    // add additional resolvers

    typeDefs += `
   providers: ProviderPaginationResult
    `

    typeDefs += `
    contexts: ContextPaginationResult
    `

    typeDefs += `
    contextById(id: ID!): Context
    `

    typeDefs += `
   tools: ToolPaginationResult
    `

    resolvers.Query["providers"] = async (_, args, context, info) => {
        const requestedFields = getRequestedFields(info)
        return {
            items: agents.map(agent => {
                const object = {}
                requestedFields.forEach(field => {
                    object[field] = agent[field]
                })
                return object
            })
        }
    }

    resolvers.Query["contexts"] = async (_, args, context, info) => {

        const data = contexts.map(context => ({
            id: context.id,
            name: context.name,
            description: context.description,
            embedder: context.embedder?.name || undefined,
            slug: "/contexts/" + context.id,
            active: context.active,
            fields: context.fields.map(field => {
                return {
                    ...field,
                    name: sanitizeName(field.name),
                    label: field.name
                }
            })
        }))

        const requestedFields = getRequestedFields(info)
        return {
            items: data.map(context => {
                const object = {}
                requestedFields.forEach(field => {
                    object[field] = context[field]
                })
                return object
            })
        }
    }

    resolvers.Query["contextById"] = async (_, args, context, info) => {

        let data: ExuluContext | undefined = contexts.find(context => context.id === args.id);

        if (!data) {
            return null;
        }

        const clean = {
            id: data.id,
            name: data.name,
            description: data.description,
            embedder: data.embedder?.name || undefined,
            slug: "/contexts/" + data.id,
            active: data.active,
            fields: data.fields.map(field => {
                return {
                    ...field,
                    name: sanitizeName(field.name),
                    label: field.name
                }
            }),
            configuration: data.configuration
        }

        const requestedFields = getRequestedFields(info)
        const mapped = {}
        requestedFields.forEach(field => {
            mapped[field] = clean[field]
        })
        return mapped
    }

    resolvers.Query["tools"] = async (_, args, context, info) => {
        const requestedFields = getRequestedFields(info)
        return {
            items: tools.map(tool => {
                const object = {}
                requestedFields.forEach(field => {
                    object[field] = tool[field]
                })
                return object
            })
        }
    }

    modelDefs += `
    type ProviderPaginationResult {
    items: [Provider]!
    }
    `

    modelDefs += `
    type ContextPaginationResult {
    items: [Context]!
    }
    `

    modelDefs += `
    type ToolPaginationResult {
    items: [Tool]!
    }
    `

    typeDefs += "}\n";
    mutationDefs += "}\n";

    // Add generic types used across all tables
    const genericTypes = `

type RateLimiterRule {
    name: String
    rate_limit: RateLimiterRuleRateLimit
}

type RateLimiterRuleRateLimit {
    time: Int
    limit: Int
}

type AgentCapabilities {
    text: Boolean
    images: [String]
    files: [String]
    audio: [String]
    video: [String]
}

type Provider {
  id: ID!
  name: String!
  description: String
  providerName: String
  modelName: String
  type: EnumProviderType!
}

type Context {
    id: ID!
    name: String!
    description: String
    embedder: String
    slug: String
    active: Boolean
    fields: JSON
    configuration: JSON
}

type ContextField {
    name: String!
    type: String!
    unique: Boolean
    label: String
}

type Tool {
  id: ID!
  name: String!
  description: String
  type: String
  config: JSON
}

enum EnumProviderType {
  agent
  custom
}

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