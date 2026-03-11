import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";
import type { allFileTypes } from "@EXULU_TYPES/file-types";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { ExuluStorage } from "@SRC/exulu/storage.ts";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import type { ExuluConfig } from "./app";
import pgvector from "pgvector/knex"; // DONT REMOVE THIS
import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluContextProcessor } from "@EXULU_TYPES/context-processor";
import type { RateLimiterRule } from "@EXULU_TYPES/models/rate-limiter-rules";
import type { ExuluEmbedder } from "./embedder";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { ExuluStatisticParams, STATISTICS_LABELS } from "@EXULU_TYPES/statistics";
import { bullmqDecorator } from "@SRC/queues/decorator";
import { postgresClient } from "@SRC/postgres/client";
import type { SearchFilters } from "@SRC/graphql/types";
import type { User } from "@EXULU_TYPES/models/user";
import type { VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import { vectorSearch, type VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { applyFilters } from "@SRC/graphql/resolvers/apply-filters";
import { mapType } from "@SRC/utils/map-types";
import { ExuluTool } from "./tool";
import { z } from "zod";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import { updateStatistic } from "./statistics";

export type ExuluContextFieldDefinition = {
  name: string;
  type: ExuluFieldTypes;
  editable?: boolean;
  unique?: boolean;
  required?: boolean;
  default?: any;
  calculated?: boolean;
  index?: boolean;
  enumValues?: string[];
  allowedFileTypes?: allFileTypes[];
};

export const getTableName = (id: string) => {
  return sanitizeName(id) + "_items";
};

export const getChunksTableName = (id: string) => {
  return sanitizeName(id) + "_chunks";
};

export type ExuluContextSource = {
  id: string;
  name: string;
  description: string;
  config?: {
    schedule?: string; // cron expression
    queue?: Promise<ExuluQueueConfig>;
    retries?: number;
    backoff?: {
      type: "exponential" | "linear";
      delay: number; // in milliseconds
    };
    params?: {
      name: string;
      description: string;
      default?: string;
    }[];
  };

  execute: (inputs: { exuluConfig: ExuluConfig; [key: string]: any }) => Promise<Item[]>;
};
export class ExuluContext {
  // Must begin with a letter (a-z) or underscore (_). Subsequent characters in a name can be letters, digits (0-9), or
  // underscores and be a max length of 80 characters and at least 5 characters long.
  // The ID is used for the table name in the database, so it is important it does not change.
  public id: string;
  public name: string;
  public active: boolean;
  public fields: ExuluContextFieldDefinition[];
  public processor?: ExuluContextProcessor;
  public rateLimit?: RateLimiterRule;
  public description: string;
  public embedder?: ExuluEmbedder;
  public queryRewriter?: (query: string) => Promise<string>;
  public resultReranker?: (
    results: {
      chunk_content: string;
      chunk_index: number;
      chunk_id: string;
      chunk_source: string;
      chunk_metadata: Record<string, string>;
      chunk_created_at: string;
      chunk_updated_at: string;
      item_id: string;
      item_external_id: string;
      item_name: string;
    }[],
  ) => Promise<
    {
      chunk_content: string;
      chunk_index: number;
      chunk_id: string;
      chunk_source: string;
      chunk_metadata: Record<string, string>;
      chunk_created_at: string;
      chunk_updated_at: string;
      item_id: string;
      item_external_id: string;
      item_name: string;
    }[]
  >;
  public configuration: {
    calculateVectors?: "manual" | "onUpdate" | "onInsert" | "always";
    maxRetrievalResults?: number; // max number of results to return for retrieval
    defaultRightsMode?: ExuluRightsMode;
    enableAsTool?: boolean;
    cutoffs?: {
      cosineDistance?: number;
      tsvector?: number;
      hybrid?: number;
    };
    expand?: {
      before?: number;
      after?: number;
    };
    languages?: ("german" | "english")[];
  };
  public sources: ExuluContextSource[] = [];

  constructor({
    id,
    name,
    description,
    embedder,
    processor,
    active,
    rateLimit,
    fields,
    queryRewriter,
    resultReranker,
    configuration,
    sources,
  }: {
    id: string;
    name: string;
    fields: ExuluContextFieldDefinition[];
    description: string;
    embedder?: ExuluEmbedder;
    sources: ExuluContextSource[];
    category?: string;
    active: boolean;
    processor?: ExuluContextProcessor;
    rateLimit?: RateLimiterRule;
    queryRewriter?: (query: string) => Promise<string>;
    resultReranker?: (results: any[]) => Promise<any[]>;
    configuration?: {
      calculateVectors?: "manual" | "onUpdate" | "onInsert" | "always";
      defaultRightsMode?: ExuluRightsMode;
      enableAsTool?: boolean;
      languages?: ("german" | "english")[];
      maxRetrievalResults?: number;
      expand?: {
        before?: number;
        after?: number;
      };
      cutoffs?: {
        cosineDistance?: number;
        tsvector?: number;
        hybrid?: number;
      };
    };
  }) {
    this.id = id;
    this.name = name;
    this.fields = fields || [];
    this.sources = sources || [];
    this.processor = processor;
    this.configuration = configuration || {
      calculateVectors: "manual",
      languages: ["english"],
      defaultRightsMode: "private",
      maxRetrievalResults: 10,
      expand: {
        before: 0,
        after: 0,
      },
      cutoffs: {
        cosineDistance: 0.5,
        tsvector: 0.5,
        hybrid: 0.5,
      },
    };
    this.description = description;
    this.embedder = embedder;
    this.active = active;
    this.rateLimit = rateLimit;
    this.queryRewriter = queryRewriter;
    this.resultReranker = resultReranker;
  }

  public processField = async (
    trigger: STATISTICS_LABELS,
    item: Item,
    exuluConfig: ExuluConfig,
    user?: number,
    role?: string,
  ): Promise<{
    result: Item | undefined;
    job?: string;
  }> => {
    // todo add tracking for processor execution
    console.log("[EXULU] processing item, ", item, " in context", this.id);
    const exuluStorage = new ExuluStorage({ config: exuluConfig });

    if (!this.processor) {
      throw new Error(`Processor is not set for this context: ${this.id}.`);
    }

    if (this.processor.filter) {
      const result = await this.processor.filter({
        item,
        user,
        role,
        utils: {
          storage: exuluStorage,
        },
        exuluConfig,
      });

      if (!result) {
        return {
          result: undefined,
          job: undefined,
        };
      }
    }

    const queue = await this.processor.config?.queue;
    if (queue?.queue.name) {
      console.log("[EXULU] processor is in queue mode, scheduling job.");
      const job = await bullmqDecorator({
        timeoutInSeconds: this.processor.config?.timeoutInSeconds || 600,
        label: `${this.name} ${this.processor.name} data processor`,
        processor: `${this.id}-${this.processor.name}`,
        context: this.id,
        inputs: item,
        item: item.id,
        queue: queue.queue,
        backoff: queue.backoff || {
          type: "exponential",
          delay: 2000,
        },
        retries: queue.retries || 2,
        user,
        role,
        trigger: trigger,
      });

      return {
        result: undefined,
        job: job.id,
      };
    }

    console.log("[EXULU] POS 1 -- EXULU CONTEXT PROCESS FIELD");
    const processorResult = await this.processor.execute({
      item,
      user,
      role,
      utils: {
        storage: exuluStorage,
      },
      exuluConfig,
    });

    if (!processorResult) {
      throw new Error("Processor result is required for updating the item in the db.");
    }

    const { db } = await postgresClient();

    // The field key is used to define a processor, but is
    // not part of the database, so remove it here before
    // we upadte the item in the db.
    delete processorResult.field;

    // Update the item in the db with the processor result
    await db
      .from(getTableName(this.id))
      .where({
        id: processorResult.id,
      })
      .update({
        ...processorResult,
        last_processed_at: new Date().toISOString(),
      });

    if (this.processor?.config?.generateEmbeddings) {
      // If the processor was configured to automatically trigger
      // the generation of embeddings, we trigger it here.
      // IMPORTANT: We need to fetch the complete item from the database
      // to ensure we have all fields (especially external_id) for embeddings
      const fullItem = await db
        .from(getTableName(this.id))
        .where({
          id: processorResult.id,
        })
        .first();

      if (!fullItem) {
        throw new Error(
          `[EXULU] Item ${processorResult.id} not found after processor update in context ${this.id}`,
        );
      }

      const { job: embeddingsJob } = await this.embeddings.generate.one({
        item: fullItem,
        user: user,
        role: role,
        trigger: "processor",
        config: exuluConfig,
      });

      if (embeddingsJob) {
        return {
          result: processorResult,
          job: embeddingsJob,
        };
      }
    }

    return {
      result: processorResult,
      job: undefined,
    };
  };

  public search = async (options: {
    query?: string;
    keywords?: string[];
    itemFilters: SearchFilters;
    chunkFilters: SearchFilters;
    user?: User;
    role?: string;
    method: VectorMethod;
    sort: any;
    trigger: STATISTICS_LABELS;
    limit: number;
    page: number;
    cutoffs?: {
      cosineDistance?: number;
      tsvector?: number;
      hybrid?: number;
    };
    expand?: {
      before?: number;
      after?: number;
    };
  }): Promise<{
    itemFilters: SearchFilters;
    chunkFilters: SearchFilters;
    query?: string;
    keywords?: string[];
    method: VectorMethod;
    context: {
      name: string;
      id: string;
      embedder: string;
    };
    chunks: VectorSearchChunkResult[];
  }> => {
    const { db } = await postgresClient();

    const result = await vectorSearch({
      ...options,
      user: options.user,
      role: options.role,
      itemFilters: options.itemFilters,
      chunkFilters: options.chunkFilters,
      context: this,
      db,
      limit: options?.limit || this.configuration.maxRetrievalResults || 10,
      cutoffs: options.cutoffs,
      expand: options.expand,
    });

    return result;
  };

  public deleteAll = async (): Promise<{
    count: number;
    results: any; // todo
    errors?: string[];
  }> => {
    const { db } = await postgresClient();
    await db.from(getTableName(this.id)).delete();
    await db.from(getChunksTableName(this.id)).delete();
    return {
      count: 0,
      results: [],
    };
  };

  public executeSource = async (
    source: ExuluContextSource,
    inputs: any,
    exuluConfig: ExuluConfig,
  ): Promise<Item[]> => {
    return await source.execute({
      ...inputs,
      exuluConfig,
    });
  };

  public tableExists = async () => {
    const { db } = await postgresClient();
    const tableName = getTableName(this.id);
    console.log("[EXULU] checking if table exists.", tableName);
    const tableExists = await db.schema.hasTable(tableName);
    return tableExists;
  };

  public chunksTableExists = async () => {
    const { db } = await postgresClient();
    const chunksTableName = getChunksTableName(this.id);
    const chunksTableExists = await db.schema.hasTable(chunksTableName);
    return chunksTableExists;
  };

  public createAndUpsertEmbeddings = async (
    item: Item,
    config: ExuluConfig,
    user?: number,
    statistics?: ExuluStatisticParams,
    role?: string,
    job?: string,
  ): Promise<{
    id: string;
    chunks?: number;
    job?: string;
  }> => {
    if (!this.embedder) {
      throw new Error("Embedder is not set for this context.");
    }

    if (!item.id) {
      throw new Error("Item id is required for generating embeddings.");
    }

    const { db } = await postgresClient();

    const { id: source, chunks } = await this.embedder.generateFromDocument(
      this.id,
      {
        ...item,
        id: item.id,
      },
      config,
      {
        label: statistics?.label || this.name,
        trigger: statistics?.trigger || "agent",
      },
      user,
      role,
    );

    // first delete all chunks with source = id
    await db.from(getChunksTableName(this.id)).where({ source }).delete();

    // then insert the new / updated chunks
    if (chunks?.length) {
      await db.from(getChunksTableName(this.id)).insert(
        chunks.map((chunk) => ({
          source,
          metadata: chunk.metadata,
          content: chunk.content,
          chunk_index: chunk.index,
          embedding: pgvector.toSql(chunk.vector),
        })),
      );
    }

    await db
      .from(getTableName(this.id))
      .where({ id: item.id })
      .update({
        chunks_count: chunks?.length || 0,
        embeddings_updated_at: new Date().toISOString(),
      })
      .returning("id");

    return {
      id: item.id,
      chunks: chunks?.length || 0,
      job,
    };
  };

  public createItem = async (
    item: Item,
    config: ExuluConfig,
    user?: number,
    role?: string,
    upsert?: boolean,
    generateEmbeddingsOverwrite?: boolean,
  ): Promise<{ item: Item; job?: string }> => {
    console.log("[EXULU] creating item", item, upsert);
    if (upsert && !item.id && !item.external_id) {
      throw new Error("Item id or external id is required for upsert.");
    }

    const { db } = await postgresClient();

    // Check for each field if it is a json field, and if
    // so, check if it is an object or array and convert
    // it to a string.
    Object.keys(item).forEach((key) => {
      if (this.fields.find((field) => field.name === key)?.type === "json") {
        if (typeof item[key] === "object" || Array.isArray(item[key])) {
          item[key] = JSON.stringify(item[key]);
        }
      }
    });

    const mutation = db
      .from(getTableName(this.id))
      .insert({
        ...item,
        tags: item.tags ? (Array.isArray(item.tags) ? item.tags.join(",") : item.tags) : undefined,
      })
      .returning("id");

    if (upsert) {
      if (item.external_id) {
        mutation.onConflict("external_id").merge();
      } else if (item.id) {
        mutation.onConflict("id").merge();
      } else {
        throw new Error("Either id or external_id must be provided for upsert");
      }
    }

    const results = await mutation;

    if (!results[0]) {
      throw new Error("Failed to create item.");
    }

    console.log("[EXULU] context configuration", this.configuration);

    let jobs: string[] = [];

    let shouldGenerateEmbeddings =
      this.embedder &&
      generateEmbeddingsOverwrite !== false &&
      (generateEmbeddingsOverwrite ||
        this.configuration.calculateVectors === "onInsert" ||
        this.configuration.calculateVectors === "always");

    if (this.processor) {
      const processor = this.processor;

      console.log("[EXULU] Processor found", processor);

      if (
        processor &&
        (processor?.config?.trigger === "onInsert" ||
          processor?.config?.trigger === "onUpdate" ||
          processor?.config?.trigger === "always")
      ) {
        const { job: processorJob, result: processorResult } = await this.processField(
          "api",
          {
            ...item,
            id: results[0].id,
          },
          config,
          user,
          role,
        );

        if (processorJob) {
          jobs.push(processorJob);
        }

        if (!processorJob) {
          // Update the item in the db with the processor result
          await db
            .from(getTableName(this.id))
            .where({ id: results[0].id })
            .update({
              ...processorResult,
            });

          if (processor.config?.generateEmbeddings) {
            // means the processor finished already, so we can trigger embeddings
            // generation directly if the processor has the generateEmbeddings flag
            // set to true.
            shouldGenerateEmbeddings = true;
          }
        }
      }
    }

    if (shouldGenerateEmbeddings) {
      console.log("[EXULU] generating embeddings for item", results[0].id);
      const { job: embeddingsJob } = await this.embeddings.generate.one({
        item: {
          ...item,
          id: results[0].id,
        },
        user: user,
        role: role,
        trigger: "api",
        config: config,
      });

      if (embeddingsJob) {
        jobs.push(embeddingsJob);
      }
    }

    return {
      item: results[0],
      job: jobs.length > 0 ? jobs.join(",") : undefined,
    };
  };

  public updateItem = async (
    item: Item,
    config: ExuluConfig,
    user?: number,
    role?: string,
    generateEmbeddingsOverwrite?: boolean,
  ): Promise<{ item: Item; job?: string }> => {
    console.log("[EXULU] updating item", item);
    const { db } = await postgresClient();

    if (item.field) {
      delete item.field;
    }

    const record = await db.from(getTableName(this.id)).where({ id: item.id }).first();

    if (!record) {
      throw new Error("Item not found.");
    }

    // Check for each field if it is a json field, and if
    // so, check if it is an object or array and convert
    // it to a string.
    Object.keys(item).forEach((key) => {
      if (this.fields.find((field) => field.name === key)?.type === "json") {
        if (typeof item[key] === "object" || Array.isArray(item[key])) {
          item[key] = JSON.stringify(item[key]);
        }
      }
    });

    const mutation = db
      .from(getTableName(this.id))
      .where({ id: record.id })
      .update({
        ...item,
        tags: item.tags ? (Array.isArray(item.tags) ? item.tags.join(",") : item.tags) : undefined,
      })
      .returning("id");

    await mutation;

    let jobs: string[] = [];

    let shouldGenerateEmbeddings =
      this.embedder &&
      generateEmbeddingsOverwrite !== false &&
      (generateEmbeddingsOverwrite ||
        this.configuration.calculateVectors === "onUpdate" ||
        this.configuration.calculateVectors === "always");

    if (this.processor) {
      // On purpose only running over the fields included in the item's payload
      // from graphql, as we dont want to process fields that were not provided
      // in the update call, assuming they did not change.
      const processor = this.processor;

      if (
        processor &&
        (processor?.config?.trigger === "onInsert" ||
          processor?.config?.trigger === "onUpdate" ||
          processor?.config?.trigger === "always")
      ) {
        const { job: processorJob, result: processorResult } = await this.processField(
          "api",
          {
            ...item,
            id: record.id,
          },
          config,
          user,
          role,
        );

        if (processorJob) {
          jobs.push(processorJob);
        }

        if (!processorJob) {
          // Update the item in the db with the processor result
          await db
            .from(getTableName(this.id))
            .where({ id: record.id })
            .update({
              ...processorResult,
            });

          if (processor.config?.generateEmbeddings) {
            // means the processor finished already, so we can trigger embeddings
            // generation directly if the processor has the generateEmbeddings flag
            // set to true.
            shouldGenerateEmbeddings = true;
          }
        }
      }
    }

    if (shouldGenerateEmbeddings) {
      const { job: embeddingsJob } = await this.embeddings.generate.one({
        item: record, // important we need to full record here with all fields for the embedder
        user: user,
        role: role,
        trigger: "api",
        config: config,
      });
      if (embeddingsJob) {
        jobs.push(embeddingsJob);
      }
    }

    return {
      item: record,
      job: jobs.length > 0 ? jobs.join(",") : undefined,
    };
  };

  public deleteItem = async (
    item: Item,
    user?: number,
    role?: string,
  ): Promise<{ id: string; job?: string }> => {
    const { db } = await postgresClient();

    if (!item.id && !item.external_id) {
      throw new Error("Item id or external id is required for deleting an item.");
    }

    if (!item.id?.length && item?.external_id) {
      item = await db.from(getTableName(this.id)).where({ external_id: item.external_id }).first();
      if (!item || !item.id) {
        throw new Error(`Item not found for external id ${item?.external_id || "undefined"}.`);
      }
    }

    const chunkTableExists = await this.chunksTableExists();
    if (chunkTableExists) {
      const chunks = await db
        .from(getChunksTableName(this.id))
        .where({ source: item.id })
        .select("id");

      if (chunks.length > 0) {
        // delete chunks first
        await db.from(getChunksTableName(this.id)).where({ source: item.id }).delete();
      }
    }

    await db.from(getTableName(this.id)).where({ id: item.id }).delete();

    return {
      id: item.id!,
      job: undefined,
    };
  };

  public getItem = async ({ item }: { item: Item }): Promise<Item> => {
    // Note this method does not apply access control, the developer that uses
    // it is responsible for applying access control themselves. This is on
    // to expose a method to retrieve items for internal user.
    const { db } = await postgresClient();

    if (!item.id && !item.external_id) {
      throw new Error("Item id or external id is required to get an item.");
    }

    const result = await db
      .from(getTableName(this.id))
      .where({
        ...(item.id ? { id: item.id } : {}),
        ...(item.external_id ? { external_id: item.external_id } : {}),
      })
      .first();

    if (result) {
      const chunksCount = await db
        .from(getChunksTableName(this.id))
        .where({ source: result.id })
        .count("id");
      result.chunksCount = Number(chunksCount[0].count) || 0;
    }

    return result;
  };

  public getItems = async ({
    filters,
    fields,
  }: {
    filters?: any[];
    fields?: string[];
  }): Promise<Item[]> => {
    // Note this method does not apply access control, the developer that uses
    // it is responsible for applying access control themselves. This is on
    // to expose a method to retrieve items for internal user.
    const { db } = await postgresClient();
    let query = db.from(getTableName(this.id)).select(fields || "*");
    const tableDefinition = convertContextToTableDefinition(this);
    query = applyFilters(query, filters || [], tableDefinition);
    const items = await query;
    return items;
  };

  public embeddings = {
    generate: {
      one: async ({
        item,
        user,
        role,
        trigger,
        config,
      }: {
        item: Item;
        user?: number;
        role?: string;
        trigger: STATISTICS_LABELS;
        config: ExuluConfig;
      }): Promise<{
        id: string;
        job?: string;
        chunks?: number;
      }> => {
        console.log("[EXULU] Generating embeddings for item", item.id);

        if (!this.embedder) {
          throw new Error("Embedder is not set for this context.");
        }

        if (!item.id) {
          throw new Error("Item id is required for generating embeddings.");
        }

        const { db } = await postgresClient();

        // Load the full record here so we make sure we have all the fields
        // needed for generating embeddings, which is not guaranteed if for
        // example the item in the input parameters comes from a graphql query
        // with a limited set of fields.
        const record = await db.from(getTableName(this.id)).where({ id: item.id }).first();
        if (!record) {
          throw new Error("Item not found.");
        }

        item = record;

        const queue = await this.embedder.queue;
        if (queue?.queue.name) {
          console.log("[EXULU] embedder is in queue mode, scheduling job.");
          const job = await bullmqDecorator({
            timeoutInSeconds: queue.timeoutInSeconds || 180,
            label: `${this.embedder.name}`,
            embedder: this.embedder.id,
            context: this.id,
            backoff: queue.backoff || {
              type: "exponential",
              delay: 2000,
            },
            retries: queue.retries || 2,
            inputs: item,
            item: item.id,
            queue: queue.queue,
            user: user,
            role: role,
            trigger: trigger || "agent",
          });

          return {
            id: item.id!,
            job: job.id,
            chunks: 0,
          };
        }

        // If no queue set, calculate embeddings directly.
        return await this.createAndUpsertEmbeddings(
          item,
          config,
          user,
          {
            label: this.embedder.name,
            trigger: trigger || "agent",
          },
          role,
          undefined,
        );
      },
      all: async (
        config: ExuluConfig,
        userId?: number,
        roleId?: string,
        limit?: number,
      ): Promise<{
        jobs: string[];
        items: number;
      }> => {
        const { db } = await postgresClient();

        let query = db.from(getTableName(this.id)).select("*");

        if (limit) {
          query = query.limit(limit);
        }

        const items = await query;

        const jobs: string[] = [];

        const queue = await this.embedder?.queue;
        // Safeguard against too many items
        if (!queue?.queue.name && items.length > 2000) {
          throw new Error(`Embedder is not in queue mode, cannot generate embeddings for more than 
                          2.000 items at once, if you need to generate embeddings for more items please configure 
                          the embedder to use a queue. You can configure the embedder to use a queue by setting 
                          the queue property in the embedder configuration.`);
        }

        for (const item of items) {
          const { job } = await this.embeddings.generate.one({
            item,
            user: userId,
            role: roleId,
            trigger: "api",
            config: config,
          });
          if (job) {
            jobs.push(job);
          }
        }

        return {
          jobs: jobs || [],
          items: items.length,
        };
      },
    },
  };

  public createItemsTable = async () => {
    const { db } = await postgresClient();
    const tableName = getTableName(this.id);
    console.log("[EXULU] Creating table: " + tableName);
    return await db.schema.createTable(tableName, (table) => {
      console.log("[EXULU] Creating fields for table.", this.fields);
      table.uuid("id").primary().defaultTo(db.fn.uuid());
      table.text("name");
      table.text("description");
      table.text("tags");
      table.boolean("archived").defaultTo(false);
      table.text("external_id").unique();
      table.text("created_by");
      table.text("ttl");
      table.text("rights_mode").defaultTo(this.configuration?.defaultRightsMode ?? "private");
      table.timestamp("embeddings_updated_at").defaultTo(null);
      table.timestamp("last_processed_at").defaultTo(null);
      table.integer("textlength");
      table.text("source");
      table.integer("chunks_count").defaultTo(0);
      for (const field of this.fields) {
        let { type, name, unique } = field;
        if (!type || !name) {
          continue;
        }
        if (type === "file") {
          name = name + "_s3key";
        }
        mapType(table, type, sanitizeName(name), undefined, unique);
      }
      table.timestamp("createdAt").defaultTo(db.fn.now());
      table.timestamp("updatedAt").defaultTo(db.fn.now());
    });
  };

  public createChunksTable = async () => {
    const { db } = await postgresClient();
    const tableName = getChunksTableName(this.id);
    console.log("[EXULU] Creating table: " + tableName);

    await db.schema.createTable(tableName, (table) => {
      if (!this.embedder) {
        throw new Error(
          "Embedder must be set for context " + this.name + " to create chunks table.",
        );
      }
      table.uuid("id").primary().defaultTo(db.fn.uuid());
      table.uuid("source").references("id").inTable(getTableName(this.id));
      table.text("content");
      // Metadata column
      table.jsonb("metadata");
      table.integer("chunk_index");
      table.specificType("embedding", `vector(${this.embedder.vectorDimensions})`);

      // Generated tsvector column (PG 12+)
      const languages = this.configuration.languages?.length
        ? this.configuration.languages
        : ["english"];
      const tsvectorExpression = languages
        .map((lang) => `to_tsvector('${lang}', coalesce(content, ''))`)
        .join(" || ");

      table.specificType(
        "fts",
        `tsvector GENERATED ALWAYS AS (${tsvectorExpression}) STORED`,
      );

      // GIN index on the tsvector and hnsw index on the embedding
      table.index(["fts"], `${tableName}_fts_gin_idx`, "gin");
      table.index(["source"], `${tableName}_source_idx`);
      table.timestamp("createdAt").defaultTo(db.fn.now());
      table.timestamp("updatedAt").defaultTo(db.fn.now());
    });

    // HNSW for ANN search (pgvector >= 0.5)
    await db.raw(`
              CREATE INDEX IF NOT EXISTS ${tableName}_embedding_hnsw_cosine
              ON ${tableName}
              USING hnsw (embedding vector_cosine_ops)
              WITH (m = 16, ef_construction = 64)
              WHERE embedding IS NOT NULL
          `);

    return;
  };

  // Exports the context as a tool that can be used by an agent
  public tool = (): ExuluTool | null => {
    if (this.configuration.enableAsTool === false) {
      return null;
    }
    return new ExuluTool({
      id: this.id,
      name: `${this.name}_context_search`,
      type: "context",
      category: "contexts",
      inputSchema: z.object({
        query: z.string().describe("The original question that the user asked"),
        keywords: z
          .array(z.string())
          .describe(
            "The keywords that are relevant to the user's question, for example names of specific products, systems or parts, IDs, etc.",
          ),
        method: z
          .enum(["keyword", "semantic", "hybrid"])
          .default("hybrid")
          .describe(
            "Search method: 'hybrid' (best for most queries - combines semantic understanding with exact term matching), 'keyword' (best for exact terms, technical names, IDs, or specific phrases), 'semantic' (best for conceptual queries where synonyms and paraphrasing matter)",
          ),
      }),
      config: [],
      description: `Gets information from the context called: ${this.name}. The context description is: ${this.description}.`,
      execute: async ({ query, keywords, user, role, method }: any) => {
        const { db } = await postgresClient();
        // todo make trigger more specific with the agent name
        // todo roadmap, auto add the normal filter criteria of a context as input schema so the agent can
        //   next to semantic search also add regular filters.
        const result = await vectorSearch({
          page: 1,
          limit: this.configuration.maxRetrievalResults ?? 10,
          query: query,
          keywords: keywords,
          itemFilters: [],
          chunkFilters: [],
          user,
          role,
          method:
            method === "hybrid"
              ? "hybridSearch"
              : method === "keyword"
                ? "tsvector"
                : "cosineDistance",
          context: this,
          db,
          sort: undefined,
          trigger: "agent",
        });

        await updateStatistic({
          name: "count",
          label: this.name,
          type: STATISTICS_TYPE_ENUM.TOOL_CALL as STATISTICS_TYPE,
          trigger: "tool",
          count: 1,
          user: user?.id,
          role: user?.role?.id,
        });

        return {
          result: JSON.stringify(
            result.chunks.map((chunk: VectorSearchChunkResult) => ({
              ...chunk,
              context: {
                name: this.name,
                id: this.id,
              },
            })),
          ),
        };
      },
    });
  };
}
