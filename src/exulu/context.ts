import type { ExuluFieldTypes } from "@EXULU_TYPES/enums/field-types";
import type { allFileTypes } from "@EXULU_TYPES/file-types";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { ExuluStorage } from "@SRC/exulu/storage.ts";
import { sanitizeName } from "@SRC/utils/sanitize-name";
import { getTableName, getChunksTableName } from "@SRC/exulu/table-names";
export { getTableName, getChunksTableName };
import type { ExuluConfig } from "./app";
import pgvector from "pgvector/knex"; // DONT REMOVE THIS
import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluContextProcessor } from "@EXULU_TYPES/context-processor";
import type { ChunkerOperation } from "./chunker";
import { defaultChunker } from "./chunker";
import { resolveEmbedder } from "./resolve-embedder";
import { getEmbeddingModelInfo } from "./litellm/parse-embedding-models";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { ExuluStatisticParams, STATISTICS_LABELS } from "@EXULU_TYPES/statistics";
import { updateStatistic } from "./statistics";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import { postgresClient } from "@SRC/postgres/client";
import type { SearchFilters } from "@SRC/graphql/types";
import type { User } from "@EXULU_TYPES/models/user";
import type { VectorMethod } from "@EXULU_TYPES/models/vector-methods";
import { vectorSearch, type VectorSearchChunkResult } from "@SRC/graphql/resolvers/vector-search";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import { applyFilters } from "@SRC/graphql/resolvers/apply-filters";
import { mapType } from "@SRC/utils/map-types";
import { bullmqDecorator } from "@EE/queues/decorator";
import type { ExuluEntitiesConfig, EntityFilter, EntityInsights } from "./entities/types";
import {
  captureEntitiesBeforeReembed,
  detachEntitiesForItem,
  extractAndIngestEntities,
  hydrateEntityTypes,
  computeTypesSignature,
  entitiesEnabled,
  entitiesTableExists,
  getEntitiesTableName,
} from "./entities";

/**
 * A context's embedder is now just a reference to a LiteLLM embedding model
 * (plus an optional queue), not an ExuluEmbedder instance. Embedding generation
 * goes through resolveEmbedder; chunking is configured separately via the
 * context's `chunker` (or the built-in default chunker).
 */
export type ExuluContextEmbedder = {
  /** LiteLLM model_name of the embedding model (declared in config.litellm.yaml). */
  model: string;
  /** When set, embedding generation runs as a background job on this queue. */
  queue?: Promise<ExuluQueueConfig>;
};

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
  public description: string;
  public embedder?: ExuluContextEmbedder;
  /**
   * Splits an item into embeddable chunks. Moved here from the removed
   * ExuluEmbedder. When omitted, the built-in `defaultChunker` (SentenceChunker)
   * is used so a context works from just an embedder model name.
   */
  public chunker?: ChunkerOperation;
  public queryRewriter?: (query: string) => Promise<string>;
  public resultReranker?: (
    results: {
      chunk_content: string;
      chunk_index: number;
      chunk_id: string;
      chunk_source: string;
      chunk_metadata: Record<string, unknown>;
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
      chunk_metadata: Record<string, unknown>;
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
  /**
   * Optional entity-layer configuration. When present (or when an admin has
   * configured entity types for this context) the graph/entity retrieval
   * features are switched on. Absent → identical behavior to before.
   */
  public entities?: ExuluEntitiesConfig;
  public sources: ExuluContextSource[] = [];

  constructor({
    id,
    name,
    description,
    embedder,
    chunker,
    processor,
    active,
    fields,
    queryRewriter,
    resultReranker,
    configuration,
    entities,
    sources,
  }: {
    id: string;
    name: string;
    fields: ExuluContextFieldDefinition[];
    description: string;
    embedder?: ExuluContextEmbedder;
    chunker?: ChunkerOperation;
    sources: ExuluContextSource[];
    category?: string;
    active: boolean;
    processor?: ExuluContextProcessor;
    queryRewriter?: (query: string) => Promise<string>;
    resultReranker?: (results: any[]) => Promise<any[]>;
    configuration?: {
      calculateVectors?: "manual" | "onUpdate" | "onInsert" | "always";
      defaultRightsMode?: ExuluRightsMode;
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
    entities?: ExuluEntitiesConfig;
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
    this.chunker = chunker;
    this.active = active;
    this.queryRewriter = queryRewriter;
    this.resultReranker = resultReranker;
    this.entities = entities;
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
        console.log("[EXULU] Item filtered out by processor, skipping processing execution...");
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
    // fts is a generated column (tsvector GENERATED ALWAYS AS ... STORED)
    // and Postgres rejects any explicit update to it.
    delete processorResult.fts;

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
    entityFilter?: EntityFilter;
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
    entityInsights?: EntityInsights;
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
      entityFilter: options.entityFilter,
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
    // Deleting chunks cascades to the chunk_entities junction; clear the entity
    // catalog separately if it exists.
    await db.from(getChunksTableName(this.id)).delete();
    if (await entitiesTableExists(this)) {
      await db.from(getEntitiesTableName(this.id)).delete();
    }
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

    if (statistics) {
      await updateStatistic({
        name: "count",
        label: statistics.label,
        type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
        trigger: statistics.trigger,
        count: 1,
        user,
        role,
      });
    }

    const source = item.id;

    // 1) Chunk the item — custom chunker if configured, else the built-in
    //    SentenceChunker. resolveEmbedder gives us the chunk-size budget.
    const resolved = await resolveEmbedder({
      model: this.embedder.model,
      contextId: this.id,
      contextName: this.name,
      userId: user,
      roleId: role,
    });

    const chunkerFn = this.chunker ?? defaultChunker;
    const { chunks: produced } = await chunkerFn(
      { ...item, id: item.id } as Item & { id: string },
      resolved.maxChunkSize,
      { storage: new ExuluStorage({ config }) },
    );

    // 2) Embed every chunk's content via LiteLLM (batched internally).
    console.log("[EXULU] Generating embeddings.");
    const contents = produced.map((c) => c.content);
    const vectors = contents.length
      ? await resolved.embed(contents, { inputType: "document" })
      : [];

    const chunks = produced.map((c, i) => ({
      content: c.content,
      index: c.index,
      metadata: c.metadata ?? {},
      vector: vectors[i] ?? [],
    }));

    // Capture the entities linked to this item BEFORE deleting its chunks. The
    // junction's ON DELETE CASCADE clears those mention rows when chunks are
    // deleted, so we grab the affected entity ids first to recompute their
    // counters after re-ingestion. No-op when the entity layer is disabled.
    const previousEntityIds = await captureEntitiesBeforeReembed(this, item.id);

    // first delete all chunks with source = id
    await db.from(getChunksTableName(this.id)).where({ source }).delete();

    // then insert the new / updated chunks
    if (chunks?.length) {
      // Helper function to sanitize strings by removing null bytes
      const sanitizeString = (str: string | null | undefined): string => {
        if (!str) return '';
        return str.replace(/\0/g, '');
      };

      // Helper function to sanitize metadata object
      const sanitizeMetadata = (metadata: Record<string, any> | null | undefined): Record<string, any> => {
        if (!metadata) return {};
        const sanitized: Record<string, any> = {};
        for (const [key, value] of Object.entries(metadata)) {
          if (typeof value === 'string') {
            sanitized[key] = sanitizeString(value);
          } else {
            sanitized[key] = value;
          }
        }
        return sanitized;
      };

      await db.from(getChunksTableName(this.id)).insert(
        chunks.map((chunk) => ({
          // Sanitize source to remove null bytes
          source: sanitizeString(source),
          // Sanitize metadata to remove null bytes from string values
          metadata: sanitizeMetadata(chunk.metadata),
          // Remove null bytes (0x00) which are invalid in PostgreSQL UTF8 encoding
          content: sanitizeString(chunk.content),
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

    // Extract & persist entities for the freshly embedded chunks. Best-effort:
    // failures are logged inside and never propagate, so embeddings are durable
    // even if entity extraction fails. No-op when the entity layer is disabled.
    await extractAndIngestEntities({ context: this, itemId: item.id, previousEntityIds });

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

    console.log("[EXULU] Creating item", item);
    const mutation = db
      .from(getTableName(this.id))
      .insert({
        ...item,
        tags: item.tags ? (Array.isArray(item.tags) ? item.tags.join(",") : item.tags) : undefined,
      })
      .returning("id");

    console.log("[EXULU] Upsert", upsert);
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

        if (!processorJob && processorResult) {
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
    runProcessorOverwrite?: boolean,
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
        runProcessorOverwrite !== false &&
        (runProcessorOverwrite ||
          processor?.config?.trigger === "onInsert" ||
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

        if (!processorJob && processorResult) {
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
            label: `${this.embedder.model}`,
            embedder: this.embedder.model,
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
            label: this.embedder.model,
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

  /**
   * Entity-layer administration: backfill extraction over existing items,
   * count stale items (for the admin "run backfill?" prompt), and purge a type.
   */
  public entityLayer = {
    /** Count items whose entities were extracted with an out-of-date type set. */
    countStale: async (): Promise<number> => {
      if (!(await entitiesEnabled(this))) return 0;
      const { db } = await postgresClient();
      const itemsTable = getTableName(this.id);
      if (!(await db.schema.hasColumn(itemsTable, "entity_types_signature"))) {
        // Column not created yet → every item is effectively stale.
        const rows = await db(itemsTable).count("id as count");
        return Number((rows[0] as any)?.count) || 0;
      }
      const types = await hydrateEntityTypes(this);
      const signature = computeTypesSignature(types);
      const rows = await db(itemsTable)
        .where(function () {
          this.whereNull("entity_types_signature").orWhere(
            "entity_types_signature",
            "!=",
            signature,
          );
        })
        .count("id as count");
      return Number((rows[0] as any)?.count) || 0;
    },

    /**
     * Full re-extraction over items. `onlyStale` (default true) limits to items
     * whose type-set signature is out of date. Runs inline in batches with a
     * safeguard cap; entity extraction (not re-embedding) is what runs here.
     */
    backfill: async ({
      onlyStale = true,
      limit,
    }: {
      onlyStale?: boolean;
      limit?: number;
    } = {}): Promise<{ processed: number; skipped: number }> => {
      if (!(await entitiesEnabled(this))) {
        return { processed: 0, skipped: 0 };
      }
      const { db } = await postgresClient();
      const itemsTable = getTableName(this.id);

      const SAFEGUARD_CAP = limit ?? 5000;
      const types = await hydrateEntityTypes(this);
      const signature = computeTypesSignature(types);

      let query = db(itemsTable).select("id");
      if (onlyStale && (await db.schema.hasColumn(itemsTable, "entity_types_signature"))) {
        query = query.where(function () {
          this.whereNull("entity_types_signature").orWhere(
            "entity_types_signature",
            "!=",
            signature,
          );
        });
      }
      const all = await query;
      const batch = all.slice(0, SAFEGUARD_CAP);
      const skipped = all.length - batch.length;
      if (skipped > 0) {
        console.warn(
          `[EXULU] Entity backfill cap (${SAFEGUARD_CAP}) reached for context ${this.id}: ${skipped} items not processed this run.`,
        );
      }

      for (const it of batch) {
        await extractAndIngestEntities({ context: this, itemId: it.id });
      }

      return { processed: batch.length, skipped };
    },

    /**
     * Extract + ingest entities for a SINGLE item — powers the item detail
     * page's "Extract entities" test action. Returns the number of mentions
     * found so the UI can report the result.
     */
    extractItem: async (itemId: string): Promise<{ extracted: number }> => {
      if (!(await entitiesEnabled(this))) {
        throw new Error(
          "Entity extraction is not configured for this context (no entity types, or no embedder).",
        );
      }
      const extracted = await extractAndIngestEntities({ context: this, itemId });
      return { extracted };
    },

    /** Detach all entities from a single item (drops links, prunes orphans). */
    detachItem: async (itemId: string): Promise<{ detached: number }> => {
      const detached = await detachEntitiesForItem(this, itemId);
      return { detached };
    },

    /** Remove all entities (and their mentions via cascade) of a given type. */
    purgeType: async (typeName: string): Promise<{ removed: number }> => {
      if (!(await entitiesTableExists(this))) return { removed: 0 };
      const { db } = await postgresClient();
      const removed = await db(getEntitiesTableName(this.id))
        .where({ type: typeName })
        .delete();
      return { removed: Number(removed) || 0 };
    },
  };

  public createItemsTable = async () => {
    const { db } = await postgresClient();
    const tableName = getTableName(this.id);
    console.log("[EXULU] Creating table: " + tableName);
    await db.schema.createTable(tableName, (table) => {
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

      // Generated tsvector column for FTS on name, description, and external_id (PG 12+)
      // Includes both original text and normalized versions (special characters removed)
      // to support matching IDs like "FST_2XT" when searching for "FST2XT"
      const languages = this.configuration.languages?.length
        ? this.configuration.languages
        : ["english"];
      const tsvectorExpression = languages
        .map((lang) => `to_tsvector('${lang}', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(external_id, '') || ' ' || regexp_replace(coalesce(name, ''), '[_\\-\\s]+', '', 'g') || ' ' || regexp_replace(coalesce(external_id, ''), '[_\\-\\s]+', '', 'g'))`)
        .join(" || ");

      table.specificType(
        "fts",
        `tsvector GENERATED ALWAYS AS (${tsvectorExpression}) STORED`,
      );

      // GIN index on the tsvector for natural language search and fuzzy ID matching
      table.index(["fts"], `${tableName}_fts_gin_idx`, "gin");
    });

    return;
  };

  public createChunksTable = async () => {
    const { db } = await postgresClient();
    const tableName = getChunksTableName(this.id);
    console.log("[EXULU] Creating table: " + tableName);

    if (!this.embedder) {
      throw new Error(
        "Embedder must be set for context " + this.name + " to create chunks table.",
      );
    }
    // Vector dimensions come from the embedding model's model_info in
    // config.litellm.yaml (throws if the model isn't declared / lacks
    // dimensionality). Resolved before createTable since that callback is sync.
    const { dimensionality } = getEmbeddingModelInfo(this.embedder.model);

    await db.schema.createTable(tableName, (table) => {
      table.uuid("id").primary().defaultTo(db.fn.uuid());
      table.uuid("source").references("id").inTable(getTableName(this.id));
      table.text("content");
      // Metadata column
      table.jsonb("metadata");
      table.integer("chunk_index");
      table.specificType("embedding", `vector(${dimensionality})`);

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
}
