import type { ExuluTableDefinition } from "src/exulu/routes";
import {
  getChunksTableName,
  getTableName,
  updateStatistic,
  type ExuluAgent,
} from "src/exulu/classes";
import type { ExuluContext } from "src/exulu/classes";
import type { ExuluReranker } from "src/exulu/classes";
import type { ExuluTool } from "src/exulu/classes";
import type { ExuluConfig } from "src/exulu/app";
import { contextItemsProcessorHandler } from "../resolvers/utils";
import { applyAccessControl } from "../utilities/access-control";
import { getRequestedFields } from "../resolvers/utils";
import { SALT_ROUNDS } from "src/auth/generate-key.ts";
import { postgresClient } from "src/postgres/client";
import { applyFilters } from "../resolvers/apply-filters.ts";
import { validateCreateOrRemoveSuperAdminPermission } from "../utilities/validate-super-admin-update.ts";
import { encryptSensitiveFields } from "../utilities/encrypt-sensitive-fields.ts";
import bcrypt from "bcryptjs";
import { finalizeRequestedFields } from "../utilities/sanitize-and-hydrate-fields.ts";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics.ts";
import { itemsPaginationRequest, sanitizeRequestedFields } from "../resolvers/index.ts";
import { handleRBACUpdate } from "../resolvers/rbac-update.ts";

const postprocessDeletion = async ({
  table,
  requestedFields,
  agents,
  contexts,
  tools,
  result,
}: {
  table: ExuluTableDefinition;
  requestedFields: string[];
  agents: ExuluAgent[];
  contexts: ExuluContext[];
  tools: ExuluTool[];
  result: any | [];
}) => {
  if (!result) {
    return result;
  }
  if (Array.isArray(result)) {
    result = result.map((item) => {
      return postprocessDeletion({
        table,
        requestedFields,
        agents,
        contexts,
        tools,
        result: item,
      });
    });
  } else {
    if (table.type === "items") {
      if (!result.id) {
        return result;
      }
      const context = contexts.find((context) => context.id === table.id);
      if (!context) {
        throw new Error("Context " + table.id + " not found in registry.");
      }
      if (!context.embedder) {
        return result;
      }
      const { db } = await postgresClient();
      console.log("[EXULU] Deleting chunks for item", result.id);
      const chunks = await db
        .from(getChunksTableName(context.id))
        .where({ source: result.id })
        .select("id");

      if (chunks.length > 0) {
        // delete chunks first
        await db.from(getChunksTableName(context.id)).where({ source: result.id }).delete();
      }
      return result;
    }
    if (table.type === "agent_sessions") {
      if (!result.id) {
        return result;
      }
      const { db } = await postgresClient();
      // delete all messages for the session
      await db
        .from("agent_messages")
        .where({ session: result.id })
        .where({ session: result.id })
        .delete();
    }
    if (table.type === "eval_runs") {
      if (!result.id) {
        return result;
      }
      const { db } = await postgresClient();
      // Find any entries in job_results
      // that contain the eval run id as
      // part of the label.
      await db
        .from("job_results")
        .where({ label: { contains: result.id } })
        .del();
      await db.from("eval_runs").where({ id: result.id }).del();
    }
  }
  return result;
};

const postprocessUpdate = async ({
  table,
  requestedFields,
  agents,
  contexts,
  tools,
  result,
  user,
  role,
  config,
}: {
  table: ExuluTableDefinition;
  requestedFields: string[];
  agents: ExuluAgent[];
  contexts: ExuluContext[];
  tools: ExuluTool[];
  result: any;
  user: number;
  role: string;
  config: ExuluConfig;
}): Promise<{
  result: any;
  job?: string;
}> => {
  if (!result) {
    return result;
  }
  if (Array.isArray(result)) {
    result = result.map((item) => {
      return postprocessDeletion({
        table,
        requestedFields,
        agents,
        contexts,
        tools,
        result: item,
      });
    });
  } else {
    if (table.type === "items") {
      if (!result.id) {
        return result;
      }
      const context = contexts.find((context) => context.id === table.id);
      if (!context) {
        throw new Error("Context " + table.id + " not found in registry.");
      }
      if (!context.embedder) {
        return result;
      }

      if (
        context.embedder &&
        (context.configuration.calculateVectors === "onUpdate" ||
          context.configuration.calculateVectors === "always")
      ) {
        const { db } = await postgresClient();
        console.log("[EXULU] Deleting chunks for item", result.id);

        const exists = await context.chunksTableExists();
        // delete chunks first
        if (exists) {
          await db.from(getChunksTableName(context.id)).where({ source: result.id }).delete();
          console.log("[EXULU] Deleted chunks for item", result.id);
        }

        console.log("[EXULU] Embedder", context.embedder);
        console.log("[EXULU] Configuration", context.configuration);
        console.log("[EXULU] Generating embeddings for item", result.id);

        const { job } = await context.embeddings.generate.one({
          item: result,
          user: user,
          role: role,
          trigger: "api",
          config: config,
        });
        return {
          result: result,
          job,
        };
      }

      if (
        context.processor &&
        (context.processor.config?.trigger === "onUpdate" ||
          context.processor.config?.trigger === "always")
      ) {
        const { jobs } = await contextItemsProcessorHandler(context, config, [result], user, role);
        return {
          result: result,
          job: jobs[0],
        };
      }

      return result;
    }
  }
  return result;
};

export function createMutations(
  table: ExuluTableDefinition,
  agents: ExuluAgent[],
  contexts: ExuluContext[],
  rerankers: ExuluReranker[],
  tools: ExuluTool[],
  config: ExuluConfig,
) {
  const tableNamePlural = table.name.plural.toLowerCase();
  const tableNameSingular = table.name.singular.toLowerCase();
  const validateWriteAccess = async (id: string, context: any) => {
    try {
      const { db, user } = context;
      if (user.super_admin === true) {
        return true; // todo roadmap - scoping api users to specific resources
      }

      if (
        !user.super_admin &&
        (table.name.plural === "agents" ||
          table.name.plural === "workflow_templates" ||
          table.name.plural === "variables" ||
          table.name.plural === "users" ||
          table.name.plural === "test_cases" ||
          table.name.plural === "eval_sets" ||
          table.name.plural === "eval_runs") &&
        (!user.role ||
          (!(table.name.plural === "agents" && user.role.agents === "write") &&
            !(table.name.plural === "workflow_templates" && user.role.workflows === "write") &&
            !(table.name.plural === "variables" && user.role.variables === "write") &&
            !(table.name.plural === "users" && user.role.users === "write") &&
            !(
              (table.name.plural === "test_cases" ||
                table.name.plural === "eval_sets" ||
                table.name.plural === "eval_runs") &&
              user.role.evals === "write"
            )))
      ) {
        console.error(
          "Access control error: no role found for current user or no access to entity type.",
        );
        // Return empty result on error
        throw new Error(
          "Access control error: no role found for current user or no access to entity type.",
        );
      }

      // Check if this table has RBAC enabled or legacy access control fields
      const hasRBAC = table.RBAC === true;

      if (!hasRBAC) {
        return true; // No access control needed
      }

      const record = await db
        .from(tableNamePlural)
        .select(["rights_mode", "created_by"])
        .where({ id })
        .first();

      if (!record) {
        throw new Error("Record not found");
      }

      // Check if record is public (any user can edit)
      if (record.rights_mode === "public") {
        return true;
      }

      // Check if record is private and user is creator
      if (record.rights_mode === "private") {
        if (record.created_by === user.id) {
          return true;
        }
        throw new Error("Only the creator can edit this private record");
      }

      // Check if user has write access via RBAC table
      if (record.rights_mode === "users") {
        const rbacRecord = await db
          .from("rbac")
          .where({
            entity: table.name.singular,
            target_resource_id: id,
            access_type: "User",
            user_id: user.id,
            rights: "write",
          })
          .first();

        if (rbacRecord) {
          return true;
        }
        throw new Error("Insufficient user permissions to edit this record");
      }

      // Check if user has write access via role in RBAC table
      if (record.rights_mode === "roles" && user.role) {
        const rbacRecord = await db
          .from("rbac")
          .where({
            entity: table.name.singular,
            target_resource_id: id,
            access_type: "Role",
            role_id: user.role,
            rights: "write",
          })
          .first();

        if (rbacRecord) {
          return true;
        }
        throw new Error("Insufficient role permissions to edit this record");
      }
      throw new Error("Insufficient permissions to edit this record");
    } catch (error) {
      console.error("Write access validation error:", error);
      throw error;
    }
  };

  const mutations = {
    [`${tableNamePlural}CopyOneById`]: async (_, args, context, info) => {
      const { db } = context;
      const requestedFields = getRequestedFields(info);
      let { id } = args;

      if (!id) {
        throw new Error("ID is required for copying a record.");
      }

      await validateWriteAccess(id, context);

      const item = await db.from(tableNamePlural).select("*").where({ id }).first();
      if (!item) {
        throw new Error("Record not found");
      }

      // For copied records we set the rights
      // mode to private and the created_by to
      // the current user.
      if (item.rights_mode) {
        item.rights_mode = "private";
      }

      if (item.created_at) {
        item.created_at = new Date();
      }
      if (item.createdAt) {
        item.createdAt = new Date();
      }
      if (item.updated_at) {
        item.updated_at = new Date();
      }
      if (item.updatedAt) {
        item.updatedAt = new Date();
      }
      if (item.created_by) {
        item.created_by = context.user.id;
      }
      if (item.createdBy) {
        item.createdBy = context.user.id;
      }

      if (item.name) {
        item.name = item.name + " (Copy)";
      }

      // Check for each field if it is a json field, and if
      // so, check if it is an object or array and convert
      // it to a string.
      Object.keys(item).forEach((key) => {
        if (table.fields.find((field) => field.name === key)?.type === "json") {
          if (typeof item[key] === "object" || Array.isArray(item[key])) {
            item[key] = JSON.stringify(item[key]);
          }
        }
      });

      const insert = db(tableNamePlural)
        .insert({
          ...item,
          id: db.fn.uuid(),
        })
        .returning("*");

      const result = await insert;
      if (!result[0]) {
        throw new Error("Failed to copy record.");
      }
      return {
        item: finalizeRequestedFields({
          args,
          table,
          requestedFields,
          agents,
          contexts,
          rerankers,
          tools,
          result: result[0],
          user: context.user,
        }),
      };
    },
    [`${tableNamePlural}CreateOne`]: async (_, args, context, info) => {
      const { db } = context;
      const requestedFields = getRequestedFields(info);
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
        throw new Error("You are not authorized to create users");
      }

      if (table.name.singular === "user" && input.password) {
        console.log("[EXULU] Hashing password", input.password);
        input.password = await bcrypt.hash(input.password, SALT_ROUNDS);
        console.log("[EXULU] Hashed password", input.password);
      }

      // Check for each field if it is a json field, and if
      // so, check if it is an object or array and convert
      // it to a string.
      Object.keys(input).forEach((key) => {
        if (table.fields.find((field) => field.name === key)?.type === "json") {
          if (typeof input[key] === "object" || Array.isArray(input[key])) {
            input[key] = JSON.stringify(input[key]);
          }
        }
      });

      if (!input.id) {
        const idField = table.fields.find((field) => field.name === "id");
        if (!idField || idField?.type !== "number") {
          input.id = db.fn.uuid();
        }
      }

      // We need to retrieve all the columns for potential post processing
      // operations that might need to be performed on the fields.
      const columns = await db(tableNamePlural).columnInfo();
      const insert = db(tableNamePlural)
        .insert({
          ...input,
          ...(table.RBAC ? { rights_mode: "private" } : {}),
        })
        .returning(Object.keys(columns));

      // https://knexjs.org/guide/query-builder.html#onconflict
      if (args.upsert) {
        insert.onConflict().merge();
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
        config: config,
      });
      return {
        // Filter result to only include requested fields
        item: finalizeRequestedFields({
          args,
          table,
          requestedFields,
          agents,
          contexts,
          rerankers,
          tools,
          result: results[0],
          user: context.user,
        }),
        job,
      };
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
        console.log("[EXULU] Hashing password", input.password);
        input.password = await bcrypt.hash(input.password, SALT_ROUNDS);
        console.log("[EXULU] Hashed password", input.password);
      }

      // Check for each field if it is a json field, and if
      // so, check if it is an object or array and convert
      // it to a string.
      Object.keys(input).forEach((key) => {
        if (table.fields.find((field) => field.name === key)?.type === "json") {
          if (typeof input[key] === "object" || Array.isArray(input[key])) {
            input[key] = JSON.stringify(input[key]);
          }
        }
      });

      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);

      // Get item and validate access
      const item = await db.from(tableNamePlural).select(sanitizedFields).where(where).first();
      if (!item) {
        throw new Error("Record not found");
      }
      await validateWriteAccess(item.id, context);

      // We need to retrieve all the columns for potential post processing
      // operations that might need to be performed on the fields.
      const columns = await db(tableNamePlural).columnInfo();

      // Update item
      const result = await db(tableNamePlural)
        .where({ id: item.id })
        .update({
          ...input,
          updatedAt: new Date(),
        })
        .returning(Object.keys(columns));

      if (!result.id) {
        throw new Error("Something went wrong with the update, no id returned.");
      }

      // Update RBAC records if provided
      if (table.RBAC && rbacData && result.id) {
        const existingRbacRecords = await db
          .from("rbac")
          .where({
            entity: table.name.singular,
            target_resource_id: result.id,
          })
          .select("*");

        await handleRBACUpdate(db, table.name.singular, result.id, rbacData, existingRbacRecords);
      }

      const { job } = await postprocessUpdate({
        table,
        requestedFields,
        agents,
        contexts,
        tools,
        result,
        user: context.user.id,
        role: context.user.role?.id,
        config,
      });
      return {
        item: finalizeRequestedFields({
          args,
          table,
          requestedFields,
          agents,
          contexts,
          rerankers,
          tools,
          result,
          user: context.user.id,
        }),
        job,
      };
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
        console.log("[EXULU] Hashing password", input.password);
        input.password = await bcrypt.hash(input.password, SALT_ROUNDS);
        console.log("[EXULU] Hashed password", input.password);
      }

      // Check for each field if it is a json field, and if
      // so, check if it is an object or array and convert
      // it to a string.
      Object.keys(input).forEach((key) => {
        if (table.fields.find((field) => field.name === key)?.type === "json") {
          if (typeof input[key] === "object" || Array.isArray(input[key])) {
            input[key] = JSON.stringify(input[key]);
          }
        }
      });

      await db(tableNamePlural)
        .where({ id })
        .update({
          ...input,
          updatedAt: new Date(),
        });

      // Handle RBAC records if provided
      if (table.RBAC && rbacData) {
        const existingRbacRecords = await db
          .from("rbac")
          .where({
            entity: table.name.singular,
            target_resource_id: id,
          })
          .select("*");

        await handleRBACUpdate(db, table.name.singular, id, rbacData, existingRbacRecords);
      }

      const requestedFields = getRequestedFields(info);
      // We need to retrieve all the columns for potential post processing
      // operations that might need to be performed on the fields.
      const columns = await db(tableNamePlural).columnInfo();
      const result = await db
        .from(tableNamePlural)
        .select(Object.keys(columns))
        .where({ id })
        .first();
      const { job } = await postprocessUpdate({
        table,
        requestedFields,
        agents,
        contexts,
        tools,
        result,
        user: context.user.id,
        role: context.user.role?.id,
        config,
      });
      return {
        item: finalizeRequestedFields({
          args,
          table,
          requestedFields,
          agents,
          contexts,
          rerankers,
          tools,
          result,
          user: context.user.id,
        }),
        job,
      };
    },
    [`${tableNamePlural}RemoveOneById`]: async (_, args, context, info) => {
      const { id } = args;
      const { db } = context;

      // For access-controlled tables, validate write access
      await validateWriteAccess(id, context);

      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);
      const result = await db.from(tableNamePlural).select(sanitizedFields).where({ id }).first();

      if (!result) {
        throw new Error("Record not found");
      }

      if (table.type === "items") {
        const context = contexts.find((context) => context.id === table.id);
        if (!context) {
          throw new Error("Context " + table.id + " not found in registry.");
        }
        const chunksTableExists = await context.chunksTableExists();
        if (chunksTableExists) {
          await db.from(getChunksTableName(context.id)).where({ source: result.id }).del();
        }
      }

      await db(tableNamePlural).where({ id }).del();

      if (table.RBAC) {
        await db
          .from("rbac")
          .where({
            entity: table.name.singular,
            target_resource_id: id,
          })
          .del();
      }

      await postprocessDeletion({
        table,
        requestedFields,
        agents,
        contexts,
        tools,
        result,
      });
      return finalizeRequestedFields({
        args,
        table,
        requestedFields,
        agents,
        contexts,
        rerankers,
        tools,
        result,
        user: context.user.id,
      });
    },
    [`${tableNamePlural}RemoveOne`]: async (_, args, context, info) => {
      const { where } = args;
      const { db } = context;

      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);
      const result = await db.from(tableNamePlural).select(sanitizedFields).where(where).first();
      if (!result) {
        throw new Error("Record not found");
      }
      // For access-controlled tables, validate write access
      await validateWriteAccess(result.id, context);

      if (table.type === "items") {
        const context = contexts.find((context) => context.id === table.id);
        if (!context) {
          throw new Error("Context " + table.id + " not found in registry.");
        }
        const chunksTableExists = await context.chunksTableExists();
        if (chunksTableExists) {
          await db.from(getChunksTableName(context.id)).where({ source: result.id }).del();
        }
      }

      // Delete the record
      await db(tableNamePlural).where(where).del();
      await postprocessDeletion({
        table,
        requestedFields,
        agents,
        contexts,
        tools,
        result,
      });
      return finalizeRequestedFields({
        args,
        table,
        requestedFields,
        agents,
        contexts,
        rerankers,
        tools,
        result,
        user: context.user.id,
      });
    },
  };

  if (table.type === "items") {
    if (table.processor) {
      mutations[`${tableNameSingular}ProcessItem`] = async (
        _,
        args,
        context,
        info,
      ): Promise<{
        message: string;
        results: string[];
        jobs: string[];
      }> => {
        if (!context.user?.super_admin) {
          throw new Error(
            "You are not authorized to process fields via API, user must be super admin.",
          );
        }
        if (!args.item) {
          throw new Error("Item argument missing, the item argument is required.");
        }
        const { db } = context;
        let query = db.from(tableNamePlural).select("*").where({ id: args.item });
        query = applyAccessControl(table, query, context.user);
        const item = await query.first();

        if (!item) {
          throw new Error("Item not found, or your user does not have access to it.");
        }

        const exists = contexts.find((context) => context.id === table.id);

        if (!exists) {
          throw new Error(`Context ${table.id} not found.`);
        }

        return contextItemsProcessorHandler(
          exists,
          config,
          [item],
          context.user.id,
          context.user.role?.id,
        );
      };

      mutations[`${tableNameSingular}ProcessItems`] = async (
        _,
        args,
        context,
        info,
      ): Promise<{
        message: string;
        results: string[];
        jobs: string[];
      }> => {
        if (!context.user?.super_admin) {
          throw new Error(
            "You are not authorized to process fields via API, user must be super admin.",
          );
        }
        const { limit = 10, filters = [], sort } = args;
        const { db } = context;

        const { items } = await itemsPaginationRequest({
          db,
          limit,
          page: 0,
          filters,
          sort,
          table,
          user: context.user,
          fields: "*",
        });

        const exists = contexts.find((context) => context.id === table.id);

        if (!exists) {
          throw new Error(`Context ${table.id} not found.`);
        }

        return contextItemsProcessorHandler(
          exists,
          config,
          items,
          context.user.id,
          context.user.role?.id,
        );
      };
    }
    mutations[`${tableNameSingular}ExecuteSource`] = async (_, args, context, info) => {
      console.log("[EXULU] Executing source", args);

      if (!context.user?.super_admin) {
        throw new Error(
          "You are not authorized to execute sources via API, user must be super admin.",
        );
      }

      if (!args.source) {
        throw new Error("Source argument missing, the source argument is required.");
      }

      const exists = contexts.find((context) => context.id === table.id);

      if (!exists) {
        throw new Error(`Context ${table.id} not found.`);
      }

      const source = exists.sources.find((source) => source.id === args.source);

      if (!source) {
        throw new Error(`Source ${args.source} not found in context ${exists.id}.`);
      }

      if (source?.config?.queue) {
        console.log("[EXULU] Executing source function in queue mode");
        const queue = await source.config.queue;

        if (!queue) {
          throw new Error(`Queue not found for source ${source.id}.`);
        }

        const job = await queue.queue?.add(source.id, {
          source: source.id,
          context: exists.id,
          type: "source",
          inputs: args.inputs,
          user: context.user.id,
          role: context.user.role?.id,
        });

        console.log("[EXULU] Source function job scheduled", job.id);

        return {
          message: "Job scheduled for source execution.",
          jobs: [job?.id],
          items: [],
        };
      }

      console.log("[EXULU] Executing source function directly");
      const result = await source.execute({
        ...args.inputs,
        exuluConfig: config,
      });

      let jobs: string[] = [];
      let items: string[] = [];

      for (const item of result) {
        const { item: createdItem, job } = await exists.createItem(
          item,
          config,
          context.user.id,
          context.user.role?.id,
          item.external_id || item.id ? true : false,
        );

        if (job) {
          jobs.push(job);
          console.log(
            `[EXULU] Scheduled job through source update job for item ${createdItem.id} (Job ID: ${job})`,
          );
        }

        if (createdItem.id) {
          items.push(createdItem.id);
          console.log(`[EXULU] created item through source update job ${createdItem.id}`);
        }
      }

      await updateStatistic({
        name: "count",
        label: source.id,
        type: STATISTICS_TYPE_ENUM.SOURCE_UPDATE as STATISTICS_TYPE,
        trigger: "api",
        count: 1,
        user: context?.user?.id,
        role: context?.user?.role?.id,
      });

      return {
        message: "Items created successfully.",
        jobs,
        items,
      };
    };
    mutations[`${tableNameSingular}GenerateChunks`] = async (_, args, context, info) => {
      // Dont need to validate write access here, as we limit it to super admin only.
      const { db } = await postgresClient();
      const exists = contexts.find((context) => context.id === table.id);
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
        if (!context.user?.super_admin) {
          throw new Error(
            "You are not authorized to generate all chunks via API, user must be super admin.",
          );
        }

        const { jobs, items } = await embeddings.generate.all(
          config,
          context.user.id,
          context.user.role?.id,
          args.limit,
        );
        return {
          message: "Chunks generated successfully.",
          items: items,
          jobs: jobs.slice(0, 100),
        };
      }

      // Generating chunks for the items in the context
      // that match the where clause.
      query = applyFilters(query, args.where, table);

      if (args.limit) {
        query = query.limit(args.limit);
      }

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
          config: config,
        });
        if (job) {
          jobs.push(job);
        }
      }
      return {
        message: "Chunks generated successfully.",
        items: items.length,
        jobs: jobs.slice(0, 100),
      };
    };
    mutations[`${tableNameSingular}DeleteChunks`] = async (_, args, context, info) => {
      // Dont need to validate write access here, as we limit it to super admin only.
      const { db } = await postgresClient();
      const id = contexts.find((context) => context.id === table.id)?.id;

      if (!id) {
        throw new Error(`Context ${table.id} not found.`);
      }

      if (args.where) {
        // Allow filtering by the parent item of the chunks
        let query = db.from(getTableName(id)).select("id");
        query = applyFilters(query, args.where, table);
        query = applyAccessControl(table, query, context.user);

        if (args.limit) {
          query = query.limit(args.limit);
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
          jobs: [],
        };
      } else {
        // Delete all chunks for the context if no filter criteria are provided
        if (!context.user?.super_admin) {
          throw new Error(
            "You are not authorized to delete all chunks via API, user must be super admin.",
          );
        }

        let count = 0;
        if (!args.limit) {
          const result = await db.from(getChunksTableName(id)).count();
          count = parseInt(result[0].count);
          await db.from(getChunksTableName(id)).truncate();
        } else {
          count = await db.from(getChunksTableName(id)).limit(args.limit).delete();
        }

        return {
          message: "Chunks deleted successfully.",
          items: count,
          jobs: [],
        };
      }
    };
  }

  return mutations;
}
