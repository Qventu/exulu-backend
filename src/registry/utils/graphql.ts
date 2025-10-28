import type { ExuluTableDefinition } from "../routes";
import { makeExecutableSchema } from "@graphql-tools/schema";
import GraphQLJSON from 'graphql-type-json';
import { GraphQLScalarType, Kind } from 'graphql';
import CryptoJS from 'crypto-js';
import { requestValidators } from '../route-validators';
import bcrypt from "bcryptjs";
import { ExuluAgent, ExuluEval, ExuluTool, getChunksTableName, getTableName, updateStatistic, type ExuluContext, type ExuluQueueConfig, type STATISTICS_LABELS } from "../classes";
import { addCoreFields } from "../../postgres/core-schema";
import { sanitizeName } from "./sanitize-name";
import type { User } from "@EXULU_TYPES/models/user";
import { postgresClient } from "../../postgres/client";
import { VectorMethodEnum, type VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import { Knex as KnexType } from 'knex';
import { checkRecordAccess, loadAgent, loadAgents } from "../utils";
import type { Agent } from "@EXULU_TYPES/models/agent";
import type { EvalRun } from "@EXULU_TYPES/models/eval-run";
import type { ExuluConfig } from "..";
import { SALT_ROUNDS } from "../../auth/generate-key";
import type { Job, JobState, Queue } from "bullmq";
import { ExuluQueues } from "../..";
import { redisClient as getRedisClient } from "../../redis/client";
import type { BullMqJobData } from "../decoraters/bullmq";
import { v4 as uuidv4 } from 'uuid';
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";

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
        case "markdown":
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

    if (table.type === "items") {
        fields.push("  averageRelevance: Float")
        fields.push("  totalRelevance: Float")
        fields.push("  chunks: [ItemChunks]")
    }

    if (table.name.singular === "agent") {
        fields.push("  providerName: String")
        fields.push("  modelName: String")
        fields.push("  rateLimit: RateLimiterRule")
        fields.push("  streaming: Boolean")
        fields.push("  capabilities: AgentCapabilities")
        fields.push("  maxContextLength: Int")
        fields.push("  provider: String")
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

    let operatorTypes = "";
    let enumFilterOperators: string[] = [];
    const tableNameSingularUpperCaseFirst = table.name.singular.charAt(0).toUpperCase() + table.name.singular.slice(1);

    // Create enum-specific filter operators
    enumFilterOperators = table.fields
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
        });

    // Create filter operator types for each field type
    operatorTypes += `
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

${enumFilterOperators.join("\n")}

input Filter${tableNameSingularUpperCaseFirst} {
${fieldFilters.join("\n")}
}`;

    return operatorTypes;
}

const getRequestedFields = (info: any): string[] => {
    const selections = info.operation.selectionSet.selections[0].selectionSet.selections;
    const itemSelection = selections.find(s => s.name.value === 'item');
    const itemsSelection = selections.find(s => s.name.value === 'items');
    let fields: string[] = [];
    if (itemSelection) {
        fields = Object.keys(itemSelection.selectionSet.selections.reduce((acc, field) => {
            acc[field.name.value] = true;
            return acc;
        }, {}));

        return fields.filter(field => field !== "pageInfo" && field !== "items" && field !== "RBAC");
    }
    if (itemsSelection) {
        fields = Object.keys(itemsSelection.selectionSet.selections.reduce((acc, field) => {
            acc[field.name.value] = true;
            return acc;
        }, {}))

        return fields.filter(field => field !== "pageInfo" && field !== "items" && field !== "RBAC");
    }

    fields = Object.keys(selections.reduce((acc, field) => {
        acc[field.name.value] = true;
        return acc;
    }, {}))

    return fields.filter(field => field !== "pageInfo" && field !== "items" && field !== "RBAC");

    // remove pageInfo and items

}

// Helper function to handle RBAC updates
const handleRBACUpdate = async (db: any, entityName: string, resourceId: string, rbacData: any, existingRbacRecords: any[]) => {
    const { users = [], roles = [], projects = [] } = rbacData;

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
    const newProjectRecords = new Set(projects.map((p: any) => `${p.id}:${p.rights}`));
    const existingUserRecords = new Set(existingRbacRecords
        .filter(r => r.access_type === 'User')
        .map(r => `${r.user_id}:${r.rights}`));
    const existingRoleRecords = new Set(existingRbacRecords
        .filter(r => r.access_type === 'Role')
        .map(r => `${r.role_id}:${r.rights}`));
    const existingProjectRecords = new Set(existingRbacRecords
        .filter(r => r.access_type === 'Project')
        .map(r => `${r.project_id}:${r.rights}`));

    // Records to create
    const usersToCreate = users.filter((u: any) => !existingUserRecords.has(`${u.id}:${u.rights}`));
    const rolesToCreate = roles.filter((r: any) => !existingRoleRecords.has(`${r.id}:${r.rights}`));
    const projectsToCreate = projects.filter((p: any) => !existingProjectRecords.has(`${p.id}:${p.rights}`));

    // Records to remove
    const usersToRemove = existingRbacRecords
        .filter(r => r.access_type === 'User' && !newUserRecords.has(`${r.user_id}:${r.rights}`));
    const rolesToRemove = existingRbacRecords
        .filter(r => r.access_type === 'Role' && !newRoleRecords.has(`${r.role_id}:${r.rights}`));
    const projectsToRemove = existingRbacRecords
        .filter(r => r.access_type === 'Project' && !newProjectRecords.has(`${r.project_id}:${r.rights}`));

    // Remove obsolete records
    if (usersToRemove.length > 0) {
        await db.from('rbac').whereIn('id', usersToRemove.map(r => r.id)).del();
    }
    if (rolesToRemove.length > 0) {
        await db.from('rbac').whereIn('id', rolesToRemove.map(r => r.id)).del();
    }
    if (projectsToRemove.length > 0) {
        await db.from('rbac').whereIn('id', projectsToRemove.map(r => r.id)).del();
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

    projectsToCreate.forEach((project: any) => {
        recordsToInsert.push({
            entity: entityName,
            access_type: 'Project',
            target_resource_id: resourceId,
            project_id: project.id,
            rights: project.rights,
            createdAt: new Date(),
            updatedAt: new Date()
        });
    });

    if (recordsToInsert.length > 0) {
        await db.from('rbac').insert(recordsToInsert);
    }
};

function createMutations(table: ExuluTableDefinition, agents: ExuluAgent[], contexts: ExuluContext[], tools: ExuluTool[], config: ExuluConfig) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const validateWriteAccess = async (id: string, context: any) => {

        try {
            const { db, req, user } = context;
            if (user.super_admin === true) {
                return true; // todo roadmap - scoping api users to specific resources
            }

            if (!user.super_admin && (!user.role || (
                !(table.name.plural === "agents" && user.role.agents === "write") &&
                !(table.name.plural === "workflow_templates" && user.role.workflows === "write") &&
                !(table.name.plural === "variables" && user.role.variables === "write") &&
                !(table.name.plural === "users" && user.role.users === "write") &&
                !((table.name.plural === "test_cases" || table.name.plural === "eval_sets" || table.name.plural === "eval_runs") && user.role.evals === "write")
            ))) {
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

            if (record.rights_mode === 'projects') {
                // For example when retrieving an item
                // we check if that item has the rights_mode
                // project, and if so, retrieve all RBAC entries
                // which is an array of projects the item has
                // been shared with, we then check if the user
                // has read access to the item via any of the projects.
                const projects = await db.from('rbac')
                    .where({
                        entity: table.name.singular,
                        target_resource_id: id,
                        access_type: 'Project',
                        rights: 'write'
                    })

                if (projects.length === 0) {
                    throw new Error('Entity ${table.name.singular} has its rights mode set to projects, but is not shared with any projects.');
                }

                const checks = await Promise.all(projects.map(async (project) => {
                    if (
                        project.rights_mode === 'private' &&
                        project.created_by !== user.id
                    ) {
                        return false
                    }
                    // Check if user has write access via RBAC table
                    if (project.rights_mode === 'users') {
                        const rbacRecord = await db.from('rbac')
                            .where({
                                entity: "project",
                                target_resource_id: project.id,
                                access_type: 'User',
                                user_id: user.id,
                                rights: 'write'
                            })
                            .first();
                        if (rbacRecord) {
                            return true;
                        }
                        return false;
                    }

                    // Check if user has write access via role in RBAC table
                    if (record.rights_mode === 'roles' && user.role) {
                        const rbacRecord = await db.from('rbac')
                            .where({
                                entity: "project",
                                target_resource_id: project.id,
                                access_type: 'Role',
                                role_id: user.role,
                                rights: 'write'
                            })
                            .first();

                        if (rbacRecord) {
                            return true;
                        }
                        return false;
                    }

                    return false;
                }));

                if (checks.some(check => check)) {
                    return true;
                }
            }

            throw new Error('Insufficient permissions to edit this record');



        } catch (error) {
            console.error('Write access validation error:', error);
            throw error;
        }
    };

    const mutations = {
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
                console.log("[EXULU] Hashing password", input.password)
                input.password = await bcrypt.hash(input.password, SALT_ROUNDS);
                console.log("[EXULU] Hashed password", input.password)
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

            if (!input.id) {
                const idField = table.fields.find(field => field.name === "id");
                if (!idField || idField?.type !== "number") {
                    input.id = db.fn.uuid();
                }
            }

            // We need to retrieve all the columns for potential post processing
            // operations that might need to be performed on the fields.
            const columns = await db(tableNamePlural).columnInfo();
            const insert = db(tableNamePlural).insert({
                ...input,
                ...(table.RBAC ? { rights_mode: 'private' } : {})
            }).returning(Object.keys(columns));

            // https://knexjs.org/guide/query-builder.html#onconflict
            if (args.upsert) {
                insert.onConflict().merge()
            }

            let results = await insert;

            // Handle RBAC records if provided
            if (table.RBAC && rbacData && results[0]) {
                await handleRBACUpdate(db, table.name.singular, results[0].id, rbacData, []);
            }

            const { job } = await postprocessUpdate({
                table,
                requestedFields,
                agents,
                contexts,
                tools,
                result: results[0],
                user: context.user.id,
                role: context.user.role?.id,
                config: config
            })
            return {
                // Filter result to only include requested fields
                item: finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result: results[0], user: context.user }),
                job
            }
        },
        [`${tableNamePlural}UpdateOne`]: async (_, args, context, info) => {
            const { db, req } = context;
            let { where, input } = args;

            await validateCreateOrRemoveSuperAdminPermission(tableNamePlural, input, req);

            // For access-controlled tables, validate write access

            // Handle RBAC input
            const rbacData = input.RBAC;
            delete input.RBAC;

            // Remove created_by field to prevent mutation
            delete input.created_by;

            input = encryptSensitiveFields(input);

            if (table.name.singular === "user" && input.password) {
                console.log("[EXULU] Hashing password", input.password)
                input.password = await bcrypt.hash(input.password, SALT_ROUNDS);
                console.log("[EXULU] Hashed password", input.password)
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

            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)

            // Get item and validate access
            const item = await db.from(tableNamePlural).select(sanitizedFields).where(where).first();
            if (!item) {
                throw new Error('Record not found');
            }
            await validateWriteAccess(item.id, context);


            // We need to retrieve all the columns for potential post processing
            // operations that might need to be performed on the fields.
            const columns = await db(tableNamePlural).columnInfo();

            // Update item
            const result = await db(tableNamePlural).where({ id: item.id }).update({
                ...input,
                updatedAt: new Date()
            }).returning(Object.keys(columns));

            if (!result.id) {
                throw new Error("Something went wrong with the update, no id returned.");
            }

            // Update RBAC records if provided
            if (table.RBAC && rbacData && result.id) {
                const existingRbacRecords = await db.from('rbac')
                    .where({
                        entity: table.name.singular,
                        target_resource_id: result.id
                    })
                    .select('*');

                await handleRBACUpdate(db, table.name.singular, result.id, rbacData, existingRbacRecords);
            }

            const { job } = await postprocessUpdate({ table, requestedFields, agents, contexts, tools, result, user: context.user.id, role: context.user.role?.id, config })
            return {
                item: finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user.id }),
                job
            }
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

            if (table.name.singular === "user" && input.password) {
                console.log("[EXULU] Hashing password", input.password)
                input.password = await bcrypt.hash(input.password, SALT_ROUNDS);
                console.log("[EXULU] Hashed password", input.password)
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
            // We need to retrieve all the columns for potential post processing
            // operations that might need to be performed on the fields.
            const columns = await db(tableNamePlural).columnInfo();
            const result = await db.from(tableNamePlural).select(Object.keys(columns)).where({ id }).first();
            const { job } = await postprocessUpdate({ table, requestedFields, agents, contexts, tools, result, user: context.user.id, role: context.user.role?.id, config })
            return {
                item: finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user.id }),
                job
            }
        },
        [`${tableNamePlural}RemoveOneById`]: async (_, args, context, info) => {
            const { id } = args;
            const { db } = context;

            // For access-controlled tables, validate write access
            await validateWriteAccess(id, context);

            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            const result = await db.from(tableNamePlural).select(sanitizedFields).where({ id }).first();

            if (!result) {
                throw new Error('Record not found');
            }

            if (table.type === "items") {
                const context = contexts.find(context => context.id === table.id)
                if (!context) {
                    throw new Error("Context " + table.id + " not found in registry.")
                }
                const chunksTableExists = await context.chunksTableExists();
                if (chunksTableExists) {
                    await db.from(getChunksTableName(context.id))
                        .where({ source: result.id })
                        .del();
                }
            }

            await db(tableNamePlural).where({ id }).del();

            if (table.RBAC) {
                await db.from('rbac').where({
                    entity: table.name.singular,
                    target_resource_id: id
                }).del();
            }

            await postprocessDeletion({ table, requestedFields, agents, contexts, tools, result })
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user.id })
        },
        [`${tableNamePlural}RemoveOne`]: async (_, args, context, info) => {
            const { where } = args;
            const { db } = context;

            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            const result = await db.from(tableNamePlural).select(sanitizedFields).where(where).first();
            if (!result) {
                throw new Error('Record not found');
            }
            // For access-controlled tables, validate write access
            await validateWriteAccess(result.id, context);

            if (table.type === "items") {
                const context = contexts.find(context => context.id === table.id)
                if (!context) {
                    throw new Error("Context " + table.id + " not found in registry.")
                }
                const chunksTableExists = await context.chunksTableExists();
                if (chunksTableExists) {
                    await db.from(getChunksTableName(context.id))
                        .where({ source: result.id })
                        .del();
                }
            }

            // Delete the record
            await db(tableNamePlural).where(where).del();
            await postprocessDeletion({ table, requestedFields, agents, contexts, tools, result })
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user.id })
        }
    };

    if (table.type === "items" && table.fields.some(field => field.processor?.execute)) {
        mutations[`${tableNamePlural}ProcessItemField`] = async (_, args, context, info) => {
            if (!context.user?.super_admin) {
                throw new Error("You are not authorized to process fields via API, user must be super admin.");
            }

            const exists = contexts.find(context => context.id === table.id)
            if (!exists) {
                throw new Error(`Context ${table.id} not found.`);
            }

            if (!args.field) {
                throw new Error("Field argument missing, the field argument is required.");
            }

            if (!args.item) {
                throw new Error("Item argument missing, the item argument is required.");
            }

            const name = args.field?.replace("_s3key", "");
            console.log("[EXULU] name", name)
            console.log("[EXULU] fields", exists.fields.map(field => field.name))
            const field = exists.fields.find(field => field.name === name)
            if (!field) {
                throw new Error(`Field ${name} not found in context ${exists.id}.`);
            }

            if (!field.processor) {
                throw new Error(`Processor not set for field ${args.field} in context ${exists.id}.`);
            }

            const { db } = context;
            let query = db.from(tableNamePlural).select("*").where({ id: args.item });
            query = applyAccessControl(table, context.user, query);
            const item = await query.first();

            if (!item) {
                throw new Error("Item not found, or your user does not have access to it.");
            }

            const { job, result } = await exists.process(
                "api",
                context.user.id,
                context.user.role?.id,
                {
                    ...item,
                    field: args.field
                },
                config
            )

            return {
                message: job ? "Processing job scheduled." : "Item processed successfully.",
                result: result,
                job
            }

        },
            mutations[`${tableNamePlural}GenerateChunks`] = async (_, args, context, info) => {
                if (!context.user?.super_admin) {
                    throw new Error("You are not authorized to delete chunks via API, user must be super admin.");
                }
                // Dont need to validate write access here, as we limit it to super admin only.

                const { db } = await postgresClient();
                const exists = contexts.find(context => context.id === table.id)
                if (!exists) {
                    throw new Error(`Context ${table.id} not found.`);
                }

                const { id, embeddings } = exists;

                const mainTable = getTableName(id);

                // Make sure we get all columns as they are needed for
                // the embeddings generation.
                const columns = await db(mainTable).columnInfo();
                let query = db.from(mainTable).select(Object.keys(columns));

                // Generating all chunks for the context.
                if (!args.where) {
                    const {
                        jobs,
                        items
                    } = await embeddings.generate.all(
                        config,
                        context.user.id,
                        context.user.role?.id
                    );

                    return {
                        message: "Chunks generated successfully.",
                        items: items,
                        jobs: jobs.slice(0, 100)
                    }
                }

                // Generating chunks for the items in the context 
                // that match the where clause.
                query = applyFilters(query, args.where);

                const items = await query;
                if (items.length === 0) {
                    throw new Error("No items found to generate chunks for.");
                }

                const jobs: string[] = [];
                for (const item of items) {
                    const { job } = await embeddings.generate.one({
                        item,
                        user: context.user.id,
                        role: context.user.role?.id,
                        trigger: "api",
                        config: config
                    });
                    if (job) {
                        jobs.push(job);
                    }
                }
                return {
                    message: "Chunks deleted successfully.",
                    items: items.length,
                    jobs: jobs.slice(0, 100)
                }

            },
            mutations[`${tableNamePlural}DeleteChunks`] = async (_, args, context, info) => {
                if (!context.user?.super_admin) {
                    throw new Error("You are not authorized to delete chunks via API, user must be super admin.");
                }

                // Dont need to validate write access here, as we limit it to super admin only.

                const { db } = await postgresClient();
                const id = contexts.find(context => context.id === table.id)?.id
                if (!id) {
                    throw new Error(`Context ${table.id} not found.`);
                }

                let query = db.from(getTableName(id)).select("id");

                if (args.where) {
                    query = applyFilters(query, args.where);
                }

                const items = await query;
                if (items.length === 0) {
                    throw new Error("No items found to delete chunks for.");
                }

                for (const item of items) {
                    await db.from(getChunksTableName(id)).where({ source: item.id }).delete();
                }
                return {
                    message: "Chunks deleted successfully.",
                    items: items.length,
                    jobs: []
                }

            }
    }

    return mutations;
}

export const applyAccessControl = (table: ExuluTableDefinition, user: User, query: any) => {

    const tableNamePlural = table.name.plural.toLowerCase();

    // If a user is super admin, they can see everything, except if
    // the table is agent_sessions, in which case we always enforce
    // the regular rbac rules set for the session (defaults to private).
    if (table.name.plural !== "agent_sessions" && user.super_admin === true) {
        return query; // todo roadmap - scoping api users to specific resources
    }

    console.log("[EXULU] user.role", user.role)
    console.log("[EXULU] table.name.plural", table.name.plural)
    if (!user.super_admin && (!user.role || (
        !(table.name.plural === "agents" && (user.role.agents === "read" || user.role.agents === "write")) &&
        !(table.name.plural === "workflow_templates" && (user.role.workflows === "read" || user.role.workflows === "write")) &&
        !(table.name.plural === "variables" && (user.role.variables === "read" || user.role.variables === "write")) &&
        !(table.name.plural === "users" && (user.role.users === "read" || user.role.users === "write")) &&
        !((table.name.plural === "test_cases" || table.name.plural === "eval_sets" || table.name.plural === "eval_runs") && (user.role.evals === "read" || user.role.evals === "write"))
    ))) {
        console.error('==== Access control error: no role found or no access to entity type. ====');
        // Return empty result on error
        return query.where('id', '=', '0');
    }

    const hasRBAC = table.RBAC === true;
    console.log("[EXULU] hasRBAC", hasRBAC)
    if (!hasRBAC) {
        return query;
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
                this.orWhere(function (this: any) {
                    this.where('rights_mode', 'roles')
                        .whereExists(function (this: any) {
                            this.select('*')
                                .from('rbac')
                                .whereRaw('rbac.target_resource_id = ' + tableNamePlural + '.id')
                                .where('rbac.entity', table.name.singular)
                                .where('rbac.access_type', 'Role')
                                .where('rbac.role_id', user.role.id);
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
    "capabilities",
    "maxContextLength",
    "provider"
]

const removeAgentFields = (requestedFields: string[]) => {
    const filtered = requestedFields.filter(field => !backendAgentFields.includes(field));
    // Always add the backend field as we need it to get specific fields
    // we sanitize this out again in the finalizeRequestedFields step.
    filtered.push("backend")
    return filtered;
}

const addAgentFields = async (requestedFields: string[], agents: ExuluAgent[], result: any, tools: ExuluTool[], user: User) => {
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
    if (requestedFields.includes("tools")) {
        if (result.tools) {
            result.tools = await Promise.all(result.tools.map(async (tool: {
                config: any,
                id: string
                type: "function" | "agent" | "context",
                category: string
            }): Promise<Omit<ExuluTool, "tool"> | null | undefined> => {

                let hydrated: ExuluTool | null | undefined;
                if (
                    tool.type === "agent"
                ) {
                    if (tool.id === result.id) {
                        return null;
                    }
                    const instance = await loadAgent(tool.id) // for agents used as tools, the tool id === the agent id
                    if (!instance) {
                        throw new Error("Trying to load a tool of type 'agent', but the associated agent with id " + tool.id + " was not found in the database.")
                    }
                    const backend = agents.find(a => a.id === instance.backend)
                    if (!backend) {
                        throw new Error("Trying to load a tool of type 'agent', but the associated agent with id " + tool.id + " does not have a backend set for it.")
                    }

                    // if no access do not return it
                    const hasAccessToAgent = await checkRecordAccess(instance, "read", user);

                    if (!hasAccessToAgent) {
                        return null;
                    }

                    hydrated = await backend.tool(instance.id, agents)
                } else {
                    hydrated = tools.find(t => t.id === tool.id)
                }
                const hydratedTool = {
                    ...tool,
                    name: hydrated?.name || "",
                    description: hydrated?.description || "",
                    category: tool?.category || "default"
                }
                console.log("[EXULU] hydratedTool", hydratedTool)
                return hydratedTool;
            }))
            result.tools = result.tools.filter(tool => tool !== null)
        } else {
            result.tools = []
        }
    }
    if (requestedFields.includes("streaming")) {
        result.streaming = backend?.streaming || false
    }
    if (requestedFields.includes("capabilities")) {
        result.capabilities = backend?.capabilities || []
    }
    if (requestedFields.includes("maxContextLength")) {
        result.maxContextLength = backend?.maxContextLength || 0
    }
    if (requestedFields.includes("provider")) {
        result.provider = backend?.provider || ""
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
    if (requestedFields.includes("chunks")) {
        // remove from array
        requestedFields = requestedFields.filter(field => field !== "chunks")
    }
    return requestedFields;
}

const postprocessUpdate = async ({
    table,
    requestedFields,
    agents,
    contexts,
    tools,
    result,
    user,
    role,
    config
}: {
    table: ExuluTableDefinition,
    requestedFields: string[],
    agents: ExuluAgent[],
    contexts: ExuluContext[],
    tools: ExuluTool[],
    result: any | [],
    user: number,
    role: string,
    config: ExuluConfig
}): Promise<{
    result: any | []
    job?: string
}> => {
    if (!result) {
        return result;
    }
    if (Array.isArray(result)) {
        result = result.map(item => {
            return postprocessDeletion({ table, requestedFields, agents, contexts, tools, result: item })
        })
    } else {
        if (table.type === "items") {
            if (!result.id) {
                return result;
            }
            const context = contexts.find(context => context.id === table.id)
            if (!context) {
                throw new Error("Context " + table.id + " not found in registry.")
            }
            if (!context.embedder) {
                return result;
            }
            const { db } = await postgresClient();
            console.log("[EXULU] Deleting chunks for item", result.id)
            // delete chunks first
            await db.from(getChunksTableName(context.id))
                .where({ source: result.id })
                .delete();

            console.log("[EXULU] Deleted chunks for item", result.id)

            console.log("[EXULU] Embedder", context.embedder)
            console.log("[EXULU] Configuration", context.configuration)

            if (
                context.embedder && (
                    context.configuration.calculateVectors === "onUpdate" ||
                    context.configuration.calculateVectors === "always"
                )
            ) {
                console.log("[EXULU] Generating embeddings for item", result.id)
                const { job } = await context.embeddings.generate.one({
                    item: result,
                    user: user,
                    role: role,
                    trigger: "api",
                    config: config
                });
                return {
                    result: result,
                    job
                };
            }

            return result;
        }
    }
    return result;
}

const postprocessDeletion = async ({
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
            return postprocessDeletion({ table, requestedFields, agents, contexts, tools, result: item })
        })
    } else {
        if (table.type === "items") {
            if (!result.id) {
                return result;
            }
            const context = contexts.find(context => context.id === table.id)
            if (!context) {
                throw new Error("Context " + table.id + " not found in registry.")
            }
            if (!context.embedder) {
                return result;
            }
            const { db } = await postgresClient();
            console.log("[EXULU] Deleting chunks for item", result.id)
            const chunks = await db.from(getChunksTableName(context.id))
                .where({ source: result.id })
                .select("id");

            if (chunks.length > 0) {
                // delete chunks first
                await db.from(getChunksTableName(context.id))
                    .where({ source: result.id })
                    .delete();
            }
            return result;
        }
    }
    return result;
}

const finalizeRequestedFields = async ({
    table,
    requestedFields,
    agents,
    contexts,
    tools,
    result,
    user
}: {
    table: ExuluTableDefinition,
    requestedFields: string[],
    agents: ExuluAgent[],
    contexts: ExuluContext[],
    tools: ExuluTool[],
    result: any | []
    user: User
}) => {
    if (!result) {
        return result;
    }
    if (!requestedFields.includes("id")) {
        delete result.id
    }
    if (Array.isArray(result)) {
        result = result.map(item => {
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result: item, user: user })
        })
    } else {
        if (table.name.singular === "agent") {
            result = await addAgentFields(requestedFields, agents, result, tools, user)
            if (!requestedFields.includes("backend")) {
                delete result.backend
            }
        }
        if (table.type === "items") {
            if (requestedFields.includes("chunks")) {
                if (!result.id) {
                    result.chunks = []
                    return result;
                }
                const context = contexts.find(context => context.id === table.id)
                if (!context) {
                    throw new Error("Context " + table.id + " not found in registry.")
                }
                if (!context.embedder) {
                    result.chunks = []
                    return result;
                }
                const { db } = await postgresClient();
                const query = db.from(getChunksTableName(context.id))
                    .where({ source: result.id })
                    .select("id", "content", "source", "chunk_index", "createdAt", "updatedAt");
                query.select(
                    db.raw('vector_dims(??) as embedding_size', [`embedding`])
                );
                const chunks = await query;

                result.chunks = chunks.map((chunk: any) => ({
                    cosine_distance: 0,
                    fts_rank: 0,
                    hybrid_score: 0,
                    content: chunk.content,
                    source: chunk.source,
                    chunk_index: chunk.chunk_index,
                    chunk_id: chunk.id,
                    chunk_created_at: chunk.createdAt,
                    chunk_updated_at: chunk.updatedAt,
                    embedding_size: chunk.embedding_size,
                }))
            }
        }
    }
    return result;
}

const applyFilters = (query: any, filters: any[]) => {
    filters.forEach(filter => {
        Object.entries(filter).forEach(([fieldName, operators]: [string, any]) => {
            if (operators) {
                if (operators.and !== undefined) {
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

function createQueries(table: ExuluTableDefinition, agents: ExuluAgent[], tools: ExuluTool[], contexts: ExuluContext[]) {
    const tableNamePlural = table.name.plural.toLowerCase();
    const tableNameSingular = table.name.singular.toLowerCase();
    const queries = {
        [`${tableNameSingular}ById`]: async (_, args, context, info) => {
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            let query = db.from(tableNamePlural).select(sanitizedFields).where({ id: args.id });
            query = applyAccessControl(table, context.user, query);
            let result = await query.first();
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user })
        },
        [`${tableNameSingular}ByIds`]: async (_, args, context, info) => {
            const { db } = context;
            const requestedFields = getRequestedFields(info)
            const sanitizedFields = sanitizeRequestedFields(table, requestedFields)
            let query = db.from(tableNamePlural).select(sanitizedFields).whereIn('id', args.ids);
            query = applyAccessControl(table, context.user, query);
            let result = await query;
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user })
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
            return finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result, user: context.user })
        },
        [`${tableNamePlural}Pagination`]: async (_, args, context, info) => {
            const { limit = 10, page = 0, filters = [], sort } = args;
            const { db } = context;

            if (limit > 500) {
                throw new Error("Limit cannot be greater than 500.")
            }

            // Create count query  
            let countQuery = db(tableNamePlural);
            countQuery = applyFilters(countQuery, filters);
            countQuery = applyAccessControl(table, context.user, countQuery);

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
                items: finalizeRequestedFields({ table, requestedFields, agents, contexts, tools, result: items, user: context.user })
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
    }
    if (table.type === "items") {
        queries[`${tableNamePlural}VectorSearch`] = async (_, args, context, info) => {
            const exists = contexts.find(context => context.id === table.id)
            if (!exists) {
                throw new Error("Context " + table.id + " not found in registry.")
            }
            const { limit = 10, page = 0, filters = [], sort } = args;
            return await vectorSearch({
                limit,
                page,
                filters,
                sort,
                context: exists,
                db: context.db,
                query: args.query,
                method: args.method,
                user: context.user,
                role: context.user?.role?.id,
                trigger: "api"
            })
        }
    }

    return queries;
}

export const vectorSearch = async ({
    limit,
    page,
    filters,
    sort,
    context,
    db,
    query,
    method,
    user,
    role,
    trigger
}: {
    limit: number
    page: number
    filters: any[]
    sort: any
    context: ExuluContext
    db: KnexType
    query: string
    method: VectorMethod
    user: User
    role: string
    trigger: STATISTICS_LABELS
}): Promise<{
    filters: any[]
    query: string
    method: VectorMethod
    context: {
        name: string
        id: string
        embedder: string
    },
    items: any[]
}> => {

    const table = contextToTableDefinition(context)

    console.log("[EXULU] Called vector search.", {
        limit,
        page,
        filters,
        sort,
        context: context.id,
        query,
        method,
        user,
        role
    })

    if (limit > 50) {
        throw new Error("Limit cannot be greater than 50.")
    }

    if (!query) {
        throw new Error("Query is required.")
    }

    if (!method) {
        throw new Error("Method is required.")
    }

    if (!Object.values(VectorMethodEnum).includes(method)) {
        throw new Error("Invalid method, must be one of: " + Object.values(VectorMethodEnum).join(", "))
    }

    const { id, queryRewriter, embedder, configuration, resultReranker } = context

    if (!embedder) {
        throw new Error("Embedder is not set for this context.")
    }

    const mainTable = getTableName(id)
    const chunksTable = getChunksTableName(id);
    // Create count query  
    let countQuery = db(mainTable);
    countQuery = applyFilters(countQuery, filters);
    countQuery = applyAccessControl(table, user, countQuery);

    // Create separate data query
    const columns = await db(mainTable).columnInfo();

    let itemsQuery = db(mainTable).select((Object.keys(columns).map(column => mainTable + "." + column)));
    itemsQuery = applyFilters(itemsQuery, filters);
    itemsQuery = applyAccessControl(table, user, itemsQuery);
    itemsQuery = applySorting(itemsQuery, sort);
    if (queryRewriter) {
        query = await queryRewriter(query);
    }

    // For semantic search we increase the scope, so we 
    // can rerank the results.
    itemsQuery.limit(limit * 3);

    itemsQuery.leftJoin(chunksTable, function () {
        // @ts-ignore
        this.on(chunksTable + ".source", "=", mainTable + ".id")
    })

    itemsQuery.select(chunksTable + ".id as chunk_id")
    itemsQuery.select(chunksTable + ".source")
    itemsQuery.select(chunksTable + ".content")
    itemsQuery.select(chunksTable + ".chunk_index")
    itemsQuery.select(chunksTable + ".createdAt as chunk_created_at")
    itemsQuery.select(chunksTable + ".updatedAt as chunk_updated_at")
    itemsQuery.select(db.raw('vector_dims(??) as embedding_size', [`${chunksTable}.embedding`]))

    const { chunks } = await embedder.generateFromQuery(query, {
        label: table.name.singular,
        trigger
    }, user.id, role)

    if (!chunks?.[0]?.vector) {
        throw new Error("No vector generated for query.")
    }

    const vector = chunks[0].vector;
    const vectorStr = `ARRAY[${vector.join(",")}]`;
    const vectorExpr = `${vectorStr}::vector`; // => ARRAY[0.1,0.2,0.3]::vector

    const language = (configuration.language || 'english');

    let items: any[] = [];

    switch (method) {
        case "tsvector":
            // rank + filter + sort (DESC)
            itemsQuery
                .select(db.raw(
                    `ts_rank(${chunksTable}.fts, websearch_to_tsquery(?, ?)) as fts_rank`,
                    [language, query]
                ))
                .whereRaw(
                    `${chunksTable}.fts @@ websearch_to_tsquery(?, ?)`,
                    [language, query]
                )
                .orderByRaw(`fts_rank DESC`);
            items = await itemsQuery;
            break;

        case "cosineDistance":
        default:
            // Ensure we don't rank rows without embeddings
            itemsQuery.whereNotNull(`${chunksTable}.embedding`);

            // Select cosine *similarity* for display/stats:
            // similarity = 1 - cosine_distance  (cosine_distance in [0,2])
            // If you prefer pure distance in your stats, change the alias below accordingly.
            itemsQuery.select(
                db.raw(`1 - (${chunksTable}.embedding <=> ${vectorExpr}) AS cosine_distance`)
            );

            // Very important: ORDER BY the raw distance expression so pgvector can use the index
            itemsQuery.orderByRaw(
                `${chunksTable}.embedding <=> ${vectorExpr} ASC NULLS LAST`
            );
            items = await itemsQuery;
            break;
        case "hybridSearch":

            // Tunables
            const matchCount = Math.min(limit * 5, 30);
            const fullTextWeight = 1.0;
            const semanticWeight = 1.0;
            const rrfK = 50;

            const hybridSQL = `
            WITH full_text AS (
              SELECT
                c.id,
                c.source,
                row_number() OVER (
                  ORDER BY ts_rank_cd(c.fts, websearch_to_tsquery(?, ?)) DESC
                ) AS rank_ix
              FROM ${chunksTable} c
              WHERE c.fts @@ websearch_to_tsquery(?, ?)
              ORDER BY rank_ix
              LIMIT LEAST(?, 15) * 2
            ),
            semantic AS (
              SELECT
                c.id,
                c.source,
                row_number() OVER (
                  ORDER BY c.embedding <=> ${vectorExpr} ASC
                ) AS rank_ix
              FROM ${chunksTable} c
              WHERE c.embedding IS NOT NULL
              ORDER BY rank_ix
              LIMIT LEAST(?, 15) * 2
            )
            SELECT
              m.*,
              c.id AS chunk_id,
              c.source,
              c.content,
              c.chunk_index,
              c."createdAt" AS chunk_created_at,
              c."updatedAt" AS chunk_updated_at,
              vector_dims(c.embedding) as embedding_size,
        
              /* Per-signal scores for introspection */
              ts_rank(c.fts, websearch_to_tsquery(?, ?)) AS fts_rank,
              (1 - (c.embedding <=> ${vectorExpr})) AS cosine_distance,
        
              /* Hybrid RRF score */
              (
                COALESCE(1.0 / (? + ft.rank_ix), 0.0) * ?
                +
                COALESCE(1.0 / (? + se.rank_ix), 0.0) * ?
              )::float AS hybrid_score
        
            FROM full_text ft
            FULL OUTER JOIN semantic se
              ON ft.id = se.id
            JOIN ${chunksTable} c
              ON COALESCE(ft.id, se.id) = c.id
            JOIN ${mainTable} m
              ON m.id = c.source
            ORDER BY hybrid_score DESC
            LIMIT LEAST(?, 10)
            OFFSET 0
          `;

            const bindings = [
                // full_text: websearch_to_tsquery(lang, query) in rank and where
                language, query,
                language, query,
                matchCount,                    // full_text limit

                matchCount,                    // semantic limit

                // fts_rank (ts_rank) call
                language, query,

                // RRF fusion parameters
                rrfK, fullTextWeight,
                rrfK, semanticWeight,

                matchCount                     // final limit
            ];
            items = await db.raw(hybridSQL, bindings).then(r => r.rows ?? r);
    }

    // Filter out duplicate sources, keeping only the first occurrence
    // because the vector search returns multiple chunks for the same
    // source.
    const seenSources = new Map();
    items = items.reduce((acc, item) => {
        if (!seenSources.has(item.source)) {
            seenSources.set(item.source, {
                ...Object.fromEntries(
                    Object.keys(item)
                        .filter(key =>
                            key !== "cosine_distance" &&   // kept per chunk below
                            key !== "fts_rank" &&          // kept per chunk below
                            key !== "hybrid_score" &&      // we will compute per item below
                            key !== "content" &&
                            key !== "source" &&
                            key !== "chunk_index" &&
                            key !== "chunk_id" &&
                            key !== "chunk_created_at" &&
                            key !== "chunk_updated_at" &&
                            key !== "embedding_size"
                        )
                        .map(key => [key, item[key]])
                ),
                chunks: [{
                    content: item.content,
                    chunk_index: item.chunk_index,
                    chunk_id: item.chunk_id,
                    source: item.source,
                    chunk_created_at: item.chunk_created_at,
                    chunk_updated_at: item.chunk_updated_at,
                    embedding_size: item.embedding_size,
                    ...(method === "cosineDistance" && { cosine_distance: item.cosine_distance }),
                    ...((method === "tsvector" || method === "hybridSearch") && { fts_rank: item.fts_rank }),
                    ...(method === "hybridSearch" && { hybrid_score: item.hybrid_score })
                }]
            });
            acc.push(seenSources.get(item.source));
        } else {
            seenSources.get(item.source).chunks.push({
                content: item.content,
                chunk_index: item.chunk_index,
                chunk_id: item.chunk_id,
                chunk_created_at: item.chunk_created_at,
                embedding_size: item.embedding_size,
                source: item.source,
                chunk_updated_at: item.chunk_updated_at,
                ...(method === "cosineDistance" && { cosine_distance: item.cosine_distance }),
                ...((method === "tsvector" || method === "hybridSearch") && { fts_rank: item.fts_rank }),
                ...(method === "hybridSearch" && { hybrid_score: item.hybrid_score })
            });
        }
        return acc;
    }, []);

    items.forEach(item => {
        if (!item.chunks?.length) { return; }

        if (method === "tsvector") {
            const ranks = item.chunks
                .map(c => (typeof c.fts_rank === 'number' ? c.fts_rank : 0));
            const total = ranks.reduce((a, b) => a + b, 0);
            const average = ranks.length ? total / ranks.length : 0;
            item.averageRelevance = average;
            item.totalRelevance = total;

        } else if (method === "cosineDistance") {
            let methodProperty = "cosine_distance";
            const average = item.chunks.reduce((acc, item) => {
                return acc + item[methodProperty];
            }, 0) / item.chunks.length;

            const total = item.chunks.reduce((acc, item) => {
                return acc + item[methodProperty];
            }, 0);
            item.averageRelevance = average;
            item.totalRelevance = total;

        } else if (method === "hybridSearch") {

            // we multiply by 10 and add 1 to somewhat normalize the score against when cosine distance is used
            const scores = item.chunks.map(c => (typeof c.hybrid_score === 'number' ? (c.hybrid_score * 10) + 1 : 0));
            const total = scores.reduce((a, b) => a + b, 0);
            const average = scores.length ? total / scores.length : 0;
            item.averageRelevance = average;
            item.totalRelevance = total;
        }
    })

    // todo if query && resultReranker, rerank the results
    if (resultReranker && query) {
        items = await resultReranker(items);
    }

    items = items.slice(0, limit);

    await updateStatistic({
        name: "count",
        label: table.name.singular,
        type: STATISTICS_TYPE_ENUM.CONTEXT_RETRIEVE as STATISTICS_TYPE,
        trigger,
        user: user?.id,
        role: role
    })

    return {
        filters,
        query,
        method,
        context: {
            name: table.name.singular,
            id: table.id || "",
            embedder: embedder.name
        },
        items
    }
}

export const RBACResolver = async (
    db: any,
    entityName: string,
    resourceId: string,
    rights_mode: string
): Promise<{
    type: string,
    users: any[],
    roles: any[],
    projects: any[]
}> => {

    // Get RBAC records for this resource
    const rbacRecords = await db.from('rbac')
        .where({
            entity: entityName,
            target_resource_id: resourceId
        })
        .select('*');

    const users = rbacRecords
        .filter(r => r.access_type === 'User')
        ?.map(r => ({ id: r.user_id, rights: r.rights }));

    const roles = rbacRecords
        .filter(r => r.access_type === 'Role')
        ?.map(r => ({ id: r.role_id, rights: r.rights }));

    const projects = rbacRecords
        .filter(r => r.access_type === 'Project')
        ?.map(r => ({ id: r.project_id, rights: r.rights }));

    // Determine the type based on rights_mode or presence of records
    let type = rights_mode || 'private';
    if (type === 'users' && users.length === 0) type = 'private';
    if (type === 'roles' && roles.length === 0) type = 'private';
    if (type === 'projects' && projects.length === 0) type = 'private';

    return {
        type,
        users,
        roles,
        projects
    };
}

const contextToTableDefinition = (context: ExuluContext): ExuluTableDefinition => {

    const tableName = getTableName(context.id) as any;
    const definition: ExuluTableDefinition = {
        type: "items",
        id: context.id,
        name: {
            singular: tableName,
            plural: tableName?.endsWith("s") ? tableName : tableName + "s" as any,
        },
        RBAC: true,
        fields: context.fields.map(field => ({
            name: sanitizeName(field.name) as any,
            type: field.type,
            processor: field.processor,
            required: field.required,
            default: field.default,
            index: field.index,
            enumValues: field.enumValues,
            allowedFileTypes: field.allowedFileTypes,
            unique: field.unique
        }))
    }
    definition.fields.push({
        name: "id",
        type: "text",
    })
    definition.fields.push({
        // important: the contexts use the default knex timestamp 
        // fields which are different to the regular 
        // ExuluTableDefinition, i.e. created_at vs. createdAt.
        name: "createdAt",
        type: "date",
    })
    definition.fields.push({
        name: "source",
        type: "text",
    })
    definition.fields.push({
        name: "updatedAt",
        type: "date",
    })
    definition.fields.push({
        name: "textlength",
        type: "number",
    })
    definition.fields.push({
        name: "ttl",
        type: "text",
    })
    definition.fields.push({
        name: "embeddings_updated_at",
        type: "date",
    })
    definition.fields.push({
        name: "name",
        type: "text",
    })
    definition.fields.push({
        name: "description",
        type: "text",
    })
    definition.fields.push({
        name: "external_id",
        type: "text",
    })
    definition.fields.push({
        name: "tags",
        type: "text",
    })
    definition.fields.push({
        name: "archived",
        type: "boolean",
    })
    return addCoreFields(definition)
}

export function createSDL(
    tables: ExuluTableDefinition[],
    contexts: ExuluContext[],
    agents: ExuluAgent[],
    tools: ExuluTool[],
    config: ExuluConfig,
    evals: ExuluEval[],
    queues: {
        queue: Queue,
        ratelimit: number
        concurrency: number
    }[]
) {

    const contextSchemas: ExuluTableDefinition[] = contexts.map(context => contextToTableDefinition(context))

    // Adding fields to SDL that are not defined via
    // ExuluContext instances but added in the
    // backend at createItemsTable().
    tables.forEach(table => {
        if (!table.fields.some(field => field.name === "createdAt")) {
            table.fields.push({
                name: "createdAt",
                type: "date",
            })
        }
        if (!table.fields.some(field => field.name === "updatedAt")) {
            table.fields.push({
                name: "updatedAt",
                type: "date",
            })
        }
    })

    tables = [...tables, ...contextSchemas]

    console.log("[EXULU] Creating SDL.")
    let typeDefs = `
    scalar JSON
    scalar Date
    
    type RBACData {
      type: String!
      users: [RBACUser!]
      roles: [RBACRole!]
      projects: [RBACProject!]
    }
    
    type RBACUser {
      id: ID!
      rights: String!
    }
    
    type RBACRole {
      id: ID!
      rights: String!
    }
    
    type RBACProject {
      id: ID!
      rights: String!
    }
    
    input RBACInput {
      users: [RBACUserInput!]
      roles: [RBACRoleInput!]
      projects: [RBACProjectInput!]
    }
    
    input RBACUserInput {
      id: ID!
      rights: String!
    }
    
    input RBACRoleInput {
      id: ID!
      rights: String!
    }
    
    input RBACProjectInput {
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

        const processorFields = table.fields.filter(field => field.processor?.execute)

        typeDefs += `
      ${tableNameSingular}ById(id: ID!): ${tableNameSingular}
      ${tableNameSingular}ByIds(ids: [ID!]!): [${tableNameSingular}]!
      ${tableNamePlural}Pagination(limit: Int, page: Int, filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingularUpperCaseFirst}PaginationResult
      ${tableNameSingular}One(filters: [Filter${tableNameSingularUpperCaseFirst}], sort: SortBy): ${tableNameSingular}
      ${tableNamePlural}Statistics(filters: [Filter${tableNameSingularUpperCaseFirst}], groupBy: String): [StatisticsResult]!
    `;
        if (table.type === "items") {
            typeDefs += `
      ${tableNamePlural}VectorSearch(query: String!, method: VectorMethodEnum!, filters: [Filter${tableNameSingularUpperCaseFirst}]): ${tableNameSingular}VectorSearchResult
    `;
        }
        // todo add the fields of each table as filter options
        mutationDefs += `
      ${tableNamePlural}CreateOne(input: ${tableNameSingular}Input!, upsert: Boolean): ${tableNameSingular}MutationPayload
      ${tableNamePlural}UpdateOne(where: [Filter${tableNameSingularUpperCaseFirst}], input: ${tableNameSingular}Input!): ${tableNameSingular}MutationPayload
      ${tableNamePlural}UpdateOneById(id: ID!, input: ${tableNameSingular}Input!): ${tableNameSingular}MutationPayload
      ${tableNamePlural}RemoveOneById(id: ID!): ${tableNameSingular}
      ${tableNamePlural}RemoveOne(where: JSON!): ${tableNameSingular}
    `;

        if (table.type === "items") {
            mutationDefs += `
    ${tableNameSingular}GenerateChunks(where: [Filter${tableNameSingularUpperCaseFirst}]): ${tableNameSingular}GenerateChunksReturnPayload
    ${tableNameSingular}DeleteChunks(where: [Filter${tableNameSingularUpperCaseFirst}]): ${tableNameSingular}DeleteChunksReturnPayload
    `

            if (processorFields?.length > 0) {
                mutationDefs += `
    ${tableNameSingular}ProcessItemField(item: ID!, field: ${tableNameSingular}ProcessorFieldEnum!): ${tableNameSingular}ProcessItemFieldReturnPayload
    `
            }

            modelDefs += `
    type ${tableNameSingular}GenerateChunksReturnPayload {
        message: String!
        items: Int!
        jobs: [String!]
    }

    type ${tableNameSingular}ProcessItemFieldReturnPayload {
        message: String!
        result: String!
        job: String
    }

    type ${tableNameSingular}DeleteChunksReturnPayload {
        message: String!
        items: Int!
        jobs: [String!]
    }

    enum VectorMethodEnum {
        cosineDistance
        hybridSearch
        tsvector
    }

    ${processorFields.length > 0 ? `
    enum ${tableNameSingular}ProcessorFieldEnum {
        ${processorFields.map(field => field.name).join("\n")}
    }
    ` : ""}
 

  type ${tableNameSingular}VectorSearchResult {
        items: [${tableNameSingular}]!
        context: VectoSearchResultContext!
        filters: JSON!
        query: String!
        method: VectorMethodEnum!
    }

    type VectoSearchResultContext {
        name: String!
        id: ID!
        embedder: String!
    }

`
        }

        modelDefs += createTypeDefs(table);
        modelDefs += createFilterTypeDefs(table);

        modelDefs += `type ${tableNameSingular}MutationPayload {
        item: ${tableNameSingular}!
        job: String
      }`
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
        Object.assign(resolvers.Mutation, createMutations(table, agents, contexts, tools, config));

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
                return RBACResolver(db, entityName, resourceId, rights_mode)
            }
        }
    }

    // add additional resolvers
    typeDefs += `
   providers: ProviderPaginationResult
    `

    typeDefs += `
    queue(queue: QueueEnum!): QueueResult
    `

    typeDefs += `
    evals: EvalPaginationResult
    `

    typeDefs += `
    contexts: ContextPaginationResult
    `

    typeDefs += `
    contextById(id: ID!): Context
    `

    mutationDefs += `
    runEval(id: ID!, test_case_ids: [ID!]): RunEvalReturnPayload
    `

    mutationDefs += `
    drainQueue(queue: QueueEnum!): JobActionReturnPayload
    `

    mutationDefs += `
    pauseQueue(queue: QueueEnum!): JobActionReturnPayload
    `
    mutationDefs += `
    resumeQueue(queue: QueueEnum!): JobActionReturnPayload
    `

    mutationDefs += `
    deleteJob(queue: QueueEnum!, id: String!): JobActionReturnPayload
    `

    typeDefs += `
   tools(search: String, category: String, limit: Int, page: Int): ToolPaginationResult
   toolCategories: [String!]!
    `

    typeDefs += `
   jobs(queue: QueueEnum!, statusses: [JobStateEnum!]): JobPaginationResult
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

    resolvers.Query["queue"] = async (_, args, context, info) => {
        if (!args.queue) {
            throw new Error("Queue name is required");
        }
        const queue = ExuluQueues.list.get(args.queue);
        if (!queue) {
            throw new Error("Queue not found");
        }
        const config = await queue.use();
        return {
            name: config.queue.name,
            concurrency: config.concurrency,
            ratelimit: config.ratelimit,
            isMaxed: await config.queue.isMaxed(),
            isPaused: await config.queue.isPaused(),
            jobs: {
                paused: await config.queue.isPaused(),
                completed: await config.queue.getJobCountByTypes("completed"),
                failed: await config.queue.getJobCountByTypes("failed"),
                waiting: await config.queue.getJobCountByTypes("waiting"),
                active: await config.queue.getJobCountByTypes("active"),
                delayed: await config.queue.getJobCountByTypes("delayed"),
            },

        }
    }

    resolvers.Mutation["runEval"] = async (_, args, context, info) => {
        console.log("[EXULU] /evals/run/:id", args.id);

        const user = context.user;
        const eval_run_id = args.id;

        // Check user has evals write access or is super admin
        if (!user.super_admin && (!user.role || user.role.evals !== "write")) {
            throw new Error("You don't have permission to run evals. Required: super_admin or evals write access.");
        }

        const { db } = await postgresClient();

        // Fetch the eval run
        const evalRun: EvalRun = await db.from("eval_runs").where({ id: eval_run_id }).first();
        if (!evalRun) {
            throw new Error("Eval run not found in database.");
        }

        // Check RBAC access to eval run
        const hasAccessToEvalRun = await checkRecordAccess(evalRun, "write", user);
        if (!hasAccessToEvalRun) {
            throw new Error("You don't have access to this eval run.");
        }

        // Get test case IDs and eval function IDs from eval run
        let testCaseIds: string[] = evalRun.test_case_ids ? (typeof evalRun.test_case_ids === 'string' ? JSON.parse(evalRun.test_case_ids) : evalRun.test_case_ids) : [];
        const eval_functions = evalRun.eval_functions ? (typeof evalRun.eval_functions === 'string' ? JSON.parse(evalRun.eval_functions) : evalRun.eval_functions) : [];

        if (!testCaseIds || testCaseIds.length === 0) {
            throw new Error("No test cases selected for this eval run.");
        }

        if (!eval_functions || eval_functions.length === 0) {
            throw new Error("No eval functions selected for this eval run.");
        }
        
        if (args.test_case_ids) {
            testCaseIds = testCaseIds.filter(testCase => args.test_case_ids.includes(testCase));
        }

        console.log("[EXULU] test cases ids filtered", testCaseIds);

        // Fetch test cases
        const testCases = await db.from("test_cases").whereIn("id", testCaseIds);
        if (testCases.length === 0) {
            throw new Error("No test cases found for eval run.");
        }

        // Load the agent instance to validate it exists
        const agentInstance = await loadAgent(evalRun.agent_id);
        if (!agentInstance) {
            throw new Error("Agent instance not found for eval run.");
        }

        // Use a general eval queue for the main eval jobs
        const evalQueue = await ExuluQueues.register("eval_runs", 1, 1).use();

        // Create one job per test case
        const jobIds: string[] = [];

        for (const testCase of testCases) {
            const jobData: BullMqJobData = {
                label: `Eval Run ${eval_run_id} - Test Case ${testCase.id}`,
                trigger: "api",
                timeoutInSeconds: evalRun.timeout_in_seconds || 180, // default to 3 minutes
                type: "eval_run",
                eval_run_id,
                eval_run_name: evalRun.name,
                test_case_id: testCase.id,
                test_case_name: testCase.name,
                eval_functions, // Array of eval function IDs - worker will create child jobs for these
                agent_id: evalRun.agent_id,
                inputs: testCase.inputs,
                expected_output: testCase.expected_output,
                expected_tools: testCase.expected_tools,
                expected_knowledge_sources: testCase.expected_knowledge_sources,
                expected_agent_tools: testCase.expected_agent_tools,
                config: evalRun.config,
                scoring_method: evalRun.scoring_method,
                pass_threshold: evalRun.pass_threshold,
                user: user.id,
                role: user.role?.id
            }

            const redisId = uuidv4();

            // Create job with type "eval" - worker will handle running agent + creating eval function jobs
            const job = await evalQueue.queue.add("eval_run", jobData, {
                jobId: redisId,
                // Setting it to 3 as a sensible default, as
                // many AI services are quite unstable.
                attempts: evalQueue.retries || 1,
                removeOnComplete: 5000,
                removeOnFail: 10000,
                backoff: evalQueue.backoff || {
                    type: 'exponential',
                    delay: 2000,
                },
            });

            jobIds.push(job.id as string);
        }

        const response = {
            jobs: jobIds,
            count: jobIds.length
        }

        const requestedFields = getRequestedFields(info)
        const mapped = {}
        requestedFields.forEach(field => {
            mapped[field] = response[field]
        })
        return mapped
    }

    /**
     * Drains the queue, i.e., removes all jobs that are waiting
     * or delayed, but not active, completed or failed.
     */
    resolvers.Mutation["drainQueue"] = async (_, args, context, info) => {
        if (!args.queue) {
            throw new Error("Queue name is required");
        }
        const queue = ExuluQueues.list.get(args.queue);
        if (!queue) {
            throw new Error("Queue not found");
        }
        const config = await queue.use();
        await config.queue.drain()
        return { success: true }
    }

    resolvers.Mutation["pauseQueue"] = async (_, args, context, info) => {
        if (!args.queue) {
            throw new Error("Queue name is required");
        }
        const queue = ExuluQueues.list.get(args.queue);
        if (!queue) {
            throw new Error("Queue not found");
        }
        const config = await queue.use();
        await config.queue.pause()
        return { success: true }
    }


    resolvers.Mutation["resumeQueue"] = async (_, args, context, info) => {
        if (!args.queue) {
            throw new Error("Queue name is required");
        }
        const queue = ExuluQueues.list.get(args.queue);
        if (!queue) {
            throw new Error("Queue not found");
        }
        const config = await queue.use();
        await config.queue.resume()
        return { success: true }
    }

    resolvers.Mutation["deleteJob"] = async (_, args, context, info) => {
        if (!args.id) {
            throw new Error("Job ID is required");
        }
        if (!args.queue) {
            throw new Error("Queue name is required");
        }
        const queue = ExuluQueues.list.get(args.queue);
        if (!queue) {
            throw new Error("Queue not found");
        }
        const config = await queue.use();
        await config.queue.remove(args.id)
        return { success: true }
    }

    resolvers.Query["evals"] = async (_, args, context, info) => {
        const requestedFields = getRequestedFields(info)
        return {
            items: evals.map((_eval: ExuluEval) => {
                const object = {}
                requestedFields.forEach(field => {
                    object[field] = _eval[field]
                })
                return object
            })
        }
    }


    resolvers.Query["jobs"] = async (_, args, context, info) => {

        if (!args.queue) {
            throw new Error("Queue name is required");
        }

        const { client } = await getRedisClient();
        if (!client) {
            throw new Error("Redis client not created properly");
        }

        const {
            jobs,
            count
        } = await getJobsByQueueAndName(
            args.queue,
            args.statusses,
            args.page || 1,
            args.limit || 100
        );

        console.log("[EXULU] jobs", jobs.map(job => job.name));

        const requestedFields = getRequestedFields(info)
        return {
            items: await Promise.all(jobs.map(async job => {
                const object = {}
                for (const field of requestedFields) {
                    if (field === "data") {
                        object[field] = job[field]
                    } else if (field === "timestamp") {
                        object[field] = new Date(job[field]).toISOString()
                    } else if (field === "state") {
                        object[field] = await job.getState()
                    } else {
                        object[field] = job[field]
                    }
                }
                return object
            })),
            pageInfo: {
                pageCount: Math.ceil(count / (args.limit || 100)),
                itemCount: count,
                currentPage: args.page || 1,
                hasPreviousPage: (args.page && args.page > 1) ? true : false,
                hasNextPage: (args.page && args.page < Math.ceil(jobs.length / (args.limit || 100))) ? true : false
            }
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
                    label: field.name?.replace("_s3key", "")
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
            fields: await Promise.all(data.fields.map(async field => {
                const label = field.name?.replace("_s3key", "");
                if (field.type === "file" && !field.name.endsWith("_s3key")) {
                    field.name = field.name + "_s3key";
                }
                let queue: ExuluQueueConfig | null = null;
                if (field.processor?.config?.queue) {
                    queue = await field.processor.config.queue;
                }
                return {
                    ...field,
                    name: sanitizeName(field.name),
                    ...(field.type === "file" ? {
                        allowedFileTypes: field.allowedFileTypes,
                    } : {}),
                    ...(field.processor ? {
                        processor: {
                            description: field.processor?.description,
                            config: {
                                trigger: field.processor?.config?.trigger,
                                queue: {
                                    name: queue?.queue.name || undefined,
                                    ratelimit: queue?.ratelimit || undefined,
                                    concurrency: queue?.concurrency || undefined,
                                },
                            },
                            execute: "function",
                        },
                    } : {}),
                    label
                }
            })),
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
        const { search, category, limit = 100, page = 0 } = args;
        
        // Get all active agents and add them as tools
        // so agents can call other agents as tools.
        const instances = await loadAgents();
        let agentTools = await Promise.all(
            instances.map(async (instance: Agent) => {
                const backend: ExuluAgent | undefined = agents.find(a => a.id === instance.backend);
                if (!backend) {
                    return null;
                }
                return await backend.tool(instance.id, agents);
            }))

        const filtered: ExuluTool[] = agentTools.filter(tool => tool !== null) as ExuluTool[];
        let allTools = [...filtered, ...tools];

        // Apply search filter
        if (search && search.trim()) {
            const searchTerm = search.toLowerCase().trim();
            allTools = allTools.filter(tool => 
                tool.name?.toLowerCase().includes(searchTerm) ||
                tool.description?.toLowerCase().includes(searchTerm)
            );
        }

        // Apply category filter
        if (category && category.trim()) {
            allTools = allTools.filter(tool => tool.category === category);
        }

        // Apply pagination
        const total = allTools.length;
        const start = page * limit;
        const end = start + limit;
        const paginatedTools = allTools.slice(start, end);

        return {
            items: paginatedTools.map(tool => {
                const object = {}
                requestedFields.forEach(field => {
                    object[field] = tool[field]
                })
                return object
            }),
            total,
            page,
            limit
        }
    }

    resolvers.Query["toolCategories"] = async () => {
        // Extract unique categories from all tools
        const array = tools
        .map(tool => tool.category)
        .filter(category => category && typeof category === 'string')
        array.push("contexts");
        array.push("agents");
        return [...new Set(array)].sort();
    }

    modelDefs += `
    type ProviderPaginationResult {
        items: [Provider]!
    }
    `

    modelDefs += `
    type QueueResult {
        name: String!
        concurrency: Int!
        ratelimit: Int!
        isMaxed: Boolean!
        isPaused: Boolean!
        jobs: QueueJobsCounts
    }
    `
    modelDefs += `
    type QueueJobsCounts {
        paused: Int!
        completed: Int!
        failed: Int!
        waiting: Int!
        active: Int!
        delayed: Int!
    }
    `

    modelDefs += `
    type EvalPaginationResult {
    items: [Eval]!
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
    total: Int!
    page: Int!
    limit: Int!
    }
    `

    modelDefs += `
    type JobPaginationResult {
        items: [Job]!
        pageInfo: PageInfo!
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

type AgentEvalFunction {
    id: ID!
    name: String!
    description: String!
    config: [AgentEvalFunctionConfig!]
}

type AgentEvalFunctionConfig {
    name: String!
    description: String!
}

type ItemChunks {
    cosine_distance: Float
    fts_rank: Float
    hybrid_score: Float
    content: String
    source: ID
    chunk_index: Int
    chunk_id: ID
    chunk_created_at: Date
    chunk_updated_at: Date
    embedding_size: Float
}

type Provider {
  id: ID!
  name: String!
  description: String
  providerName: String
  provider: String
  modelName: String
  type: EnumProviderType!
}

type Eval {
    id: ID!
    name: String!
    description: String!
    llm: Boolean!
    config: [EvalConfig!]
}

type EvalConfig {
    name: String!
    description: String!
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

type RunEvalReturnPayload {
    jobs: [String!]!
    count: Int!
}

type JobActionReturnPayload {
    success: Boolean!
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
  category: String
  type: String
  config: JSON
}

type Job {
  id: String!
  name: String!
  returnvalue: JSON
  stacktrace: [String]
  failedReason: String
  state: String!
  data: JSON
  timestamp: Date
}

enum EnumProviderType {
  agent
}

enum QueueEnum {
  ${ExuluQueues.list.keys().toArray().join("\n")}
}

enum JobStateEnum {
  ${JOB_STATUS_ENUM.active}
  ${JOB_STATUS_ENUM.waiting}
  ${JOB_STATUS_ENUM.delayed}
  ${JOB_STATUS_ENUM.failed}
  ${JOB_STATUS_ENUM.completed}
  ${JOB_STATUS_ENUM.paused}
  ${JOB_STATUS_ENUM.stuck}
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

async function getJobsByQueueAndName(queueName: string, statusses?: JobState[], page?: number, limit?: number): Promise<{
    jobs: Job[],
    count: number
}> {
    const queue = ExuluQueues.list.get(queueName);
    if (!queue) {
        throw new Error(`Queue ${queueName} not found`);
    }
    const config = await queue.use()
    const startIndex = (page || 1) - 1;
    const endIndex = startIndex + (limit || 100);
    const jobs = await config.queue.getJobs(statusses || [], startIndex, endIndex, false);
    const counts = await config.queue.getJobCounts(...(statusses || []));
    let total = 0;
    if (counts) {
        total = Object.keys(counts).reduce((acc, key) => acc + (counts[key] || 0), 0);
    }
    return {
        jobs,
        count: total
    };
}
