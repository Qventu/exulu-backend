import type { ExuluTableDefinition } from "@EXULU_TYPES/exulu-table-definition";
import { exuluProviderFields } from "../utilities/provider-fields";
import { getChunksTableName, getTableName } from "@SRC/exulu/context";
import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluReranker } from "@SRC/exulu/reranker";
import type { ExuluTool } from "@SRC/exulu/tool";
import { vectorSearch } from "./vector-search";
import { finalizeRequestedFields } from "../utilities/sanitize-and-hydrate-fields";
import { applyAccessControl } from "../utilities/access-control";
import { getRequestedFields } from "./utils";
import { Knex as KnexType } from "knex";
import type { User } from "@EXULU_TYPES/models/user";
import { applySorting } from "./apply-sorting";
import { applyFilters } from "./apply-filters";
import type { ExuluProvider } from "@SRC/exulu/provider";
import { exuluApp } from "@SRC/exulu/app/singleton";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { checkRecordAccess } from "@SRC/utils/check-record-access";

export const itemsPaginationRequest = async ({
  db,
  limit,
  page,
  filters,
  sort,
  table,
  user,
  fields,
}: {
  db: KnexType;
  limit: number;
  page: number;
  filters: any[];
  sort: { field: string; direction: "ASC" | "DESC" };
  table: ExuluTableDefinition;
  user: User;
  fields?: string[] | "*";
}): Promise<{
  items: any[];
  pageInfo: {
    pageCount: number;
    itemCount: number;
    currentPage: number;
    hasPreviousPage: boolean;
    hasNextPage: boolean;
  };
}> => {
  if (limit > 10000) {
    throw new Error("Limit cannot be greater than 10.000.");
  }

  // Create count query
  const tableName = table.name.plural.toLowerCase();
  let countQuery = db(tableName);
  countQuery = applyFilters(countQuery, filters, table);
  countQuery = applyAccessControl(table, countQuery, user);

  // Get total count
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const countResult = await countQuery.count("* as count");
  const itemCount = Number(countResult[0]?.count || 0);
  const pageCount = Math.ceil(itemCount / limit);
  const currentPage = page;
  const hasPreviousPage = currentPage > 1;
  const hasNextPage = currentPage <= pageCount - 1;

  // Create separate data query
  let dataQuery = db(tableName);
  dataQuery = applyFilters(dataQuery, filters, table);
  dataQuery = applyAccessControl(table, dataQuery, user);

  dataQuery = applySorting(dataQuery, sort);
  if (page > 1) {
    dataQuery = dataQuery.offset((page - 1) * limit);
  }

  dataQuery = dataQuery.select(fields ? fields : "*").limit(limit);

  // eslint-disable-next-line @typescript-eslint/await-thenable
  let items = await dataQuery;

  return {
    items,
    pageInfo: {
      pageCount,
      itemCount,
      currentPage,
      hasPreviousPage,
      hasNextPage,
    },
  };
};

const removeProviderFields = (requestedFields: string[]) => {
  const filtered = requestedFields.filter((field) => !exuluProviderFields.includes(field));
  // Always add the provider field as we need it to get specific fields
  // we sanitize this out again in the finalizeRequestedFields step.
  filtered.push("provider");
  return filtered;
};

export const sanitizeRequestedFields = (
  table: ExuluTableDefinition,
  requestedFields: string[],
): string[] => {
  if (table.name.singular === "agent") {
    requestedFields = removeProviderFields(requestedFields);
  }
  if (table.name.singular === "workflow_template") {
    requestedFields.push("steps_json");
  }
  if (!requestedFields.includes("id")) {
    // We always add the id for the postgres selection
    // to avoid issues with rbac, which needs this field.
    // We remove it again during the "finalizeRequestedFields"
    // step in case it wasnt requested for the final payload.
    requestedFields.push("id");
  }
  if (requestedFields.includes("chunks")) {
    // remove from array
    requestedFields = requestedFields.filter((field) => field !== "chunks");
  }
  return requestedFields;
};

export function createQueries(
  table: ExuluTableDefinition,
  providers: ExuluProvider[],
  tools: ExuluTool[],
  contexts: ExuluContext[],
  rerankers: ExuluReranker[],
) {
  const tableNamePlural = table.name.plural.toLowerCase();
  const tableNameSingular = table.name.singular.toLowerCase();
  const queries = {
    [`${tableNameSingular}ById`]: async (_, args, context, info) => {

      let result: ExuluAgent | undefined;
      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);

      if (table.name.singular === "agent") {
        // First check if the agent is defined as code
        // and provided to the ExuluApp constructor.
        result = await exuluApp.get().agent(args.id);
        if (result) {
          const hasAccess = await checkRecordAccess(result, "read", context.user);
          if (!hasAccess) {
            result = undefined;
          } else {
            // Remove fields that are not requested.
            const object = {};
            requestedFields.forEach((field) => {
              object[field] = result![field];
            });
            result = object as ExuluAgent;
          }
        }
      } else {
        const { db } = context;
        let query = db.from(tableNamePlural).select(sanitizedFields).where({ id: args.id });
        query = applyAccessControl(table, query, context.user);
        result = await query.first();
      }

      return finalizeRequestedFields({
        args,
        table,
        requestedFields,
        providers,
        contexts,
        rerankers,
        tools,
        result,
        user: context.user,
      });
    },
    [`${tableNameSingular}ByIds`]: async (_, args, context, info) => {

      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);

      let result: ExuluAgent[] = [];
      if (table.name.singular === "agent") {
        for (const id of args.ids) {
          // First check if the agent is defined as code
          // and provided to the ExuluApp constructor.
          const agent = await exuluApp.get().agent(id);
          if (agent) {
            const hasAccess = await checkRecordAccess(agent, "read", context.user);
            if (hasAccess) {
              // Remove fields that are not requested.
              const object = {};
              requestedFields.forEach((field) => {
                object[field] = agent![field];
              });
              result.push(object as ExuluAgent);
            }
          }
        }
      } else {
        const { db } = context;
        let query = db.from(tableNamePlural).select(sanitizedFields).whereIn("id", args.ids);
        query = applyAccessControl(table, query, context.user);
        result = await query;
      }

      return finalizeRequestedFields({
        args,
        table,
        requestedFields,
        providers,
        contexts,
        rerankers,
        tools,
        result,
        user: context.user,
      });
    },
    [`${tableNameSingular}One`]: async (_, args, context, info) => {
      const { filters = [], sort } = args;
      const { db } = context;
      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);
      let query = db.from(tableNamePlural).select(sanitizedFields);
      query = applyFilters(query, filters, table);
      query = applyAccessControl(table, query, context.user);
      query = applySorting(query, sort);
      let result = await query.first();
      // todo add coding based agents
      return finalizeRequestedFields({
        args,
        table,
        requestedFields,
        providers,
        contexts,
        rerankers,
        tools,
        result,
        user: context.user,
      });
    },
    [`${tableNamePlural}Pagination`]: async (_, args, context, info) => {
      const { db } = context;
      const { limit = 10, page = 0, filters = [], sort } = args;
      const requestedFields = getRequestedFields(info);
      const sanitizedFields = sanitizeRequestedFields(table, requestedFields);
      const { items, pageInfo } = await itemsPaginationRequest({
        db,
        limit,
        page,
        filters,
        sort,
        table,
        user: context.user,
        fields: sanitizedFields,
      });
      // todo add coding based agents
      return {
        pageInfo,
        items: finalizeRequestedFields({
          args,
          table,
          requestedFields,
          providers,
          contexts,
          rerankers,
          tools,
          result: items,
          user: context.user,
        }),
      };
    },
    // Add generic statistics query for all tables
    [`${tableNamePlural}Statistics`]: async (_, args, context) => {
      const { filters = [], groupBy, limit = 10 } = args;
      const { db } = context;

      let query = db(tableNamePlural);
      query = applyFilters(query, filters, table);
      query = applyAccessControl(table, query, context.user);

      query = query.limit(limit);

      // Group by the specified field and count
      if (groupBy) {
        query = query.select(groupBy).groupBy(groupBy);

        // if table is tracking, then instead of counting we sum the total column
        if (tableNamePlural === "tracking") {
          query = query.sum("total as count");
        } else {
          query = query.count("* as count");
        }
        const results = await query;
        return results.map((r) => ({
          group: r[groupBy],
          count: r.count ? Number(r.count) : 0,
        }));
      } else {
        // Just return total count
        // if table is tracking, then instead of counting we sum the total column
        if (tableNamePlural === "tracking") {
          query = query.sum("total as count");
          const [{ count }] = await query.sum("total as count");
          return [
            {
              group: "total",
              count: count ? Number(count) : 0,
            },
          ];
        } else {
          const [{ count }] = await query.count("* as count");
          return [
            {
              group: "total",
              count: count ? Number(count) : 0,
            },
          ];
        }
      }
    },
  };
  if (table.type === "items") {
    queries[`${tableNamePlural}VectorSearch`] = async (_, args, context) => {
      const exists = contexts.find((context) => context.id === table.id);
      if (!exists) {
        throw new Error("Context " + table.id + " not found in registry.");
      }
      const { limit = 10, page = 0, itemFilters = [], chunkFilters = [], sort } = args;
      return await vectorSearch({
        limit: limit || exists.configuration.maxRetrievalResults || 10,
        page,
        itemFilters,
        chunkFilters,
        sort,
        context: exists,
        db: context.db,
        query: args.query,
        method: args.method,
        user: context.user,
        role: context.user?.role?.id,
        trigger: "api",
        cutoffs: args.cutoffs,
        expand: args.expand,
      });
    };
    queries[`${tableNameSingular}ChunkById`] = async (_, args, context) => {
      const exists = contexts.find((ctx) => ctx.id === table.id);
      if (!exists) {
        throw new Error("Context " + table.id + " not found in registry.");
      }
      const { db } = context;
      const chunksTable = getChunksTableName(exists.id);
      const mainTable = getTableName(exists.id);

      // Query the chunk with its associated item
      const chunk = await db(chunksTable + " as chunks")
        .select([
          "chunks.id as chunk_id",
          "chunks.source as chunk_source",
          "chunks.content as chunk_content",
          "chunks.chunk_index",
          "chunks.metadata as chunk_metadata",
          db.raw('chunks."createdAt" as chunk_created_at'),
          db.raw('chunks."updatedAt" as chunk_updated_at'),
          "items.id as item_id",
          "items.name as item_name",
          "items.external_id as item_external_id",
          db.raw('items."updatedAt" as item_updated_at'),
          db.raw('items."createdAt" as item_created_at'),
        ])
        .leftJoin(mainTable + " as items", "chunks.source", "items.id")
        .where("chunks.id", args.id)
        .first();

      if (!chunk) {
        return null;
      }

      return {
        chunk_content: chunk.chunk_content,
        chunk_index: chunk.chunk_index,
        chunk_id: chunk.chunk_id,
        chunk_source: chunk.chunk_source,
        chunk_metadata: chunk.chunk_metadata,
        chunk_created_at: chunk.chunk_created_at,
        chunk_updated_at: chunk.chunk_updated_at,
        item_id: chunk.item_id,
        item_name: chunk.item_name,
        item_external_id: chunk.item_external_id,
        item_updated_at: chunk.item_updated_at,
        item_created_at: chunk.item_created_at,
      };
    };
  }

  return queries;
}
