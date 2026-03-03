import CryptoJS from "crypto-js";

import type { Item } from "@EXULU_TYPES/models/item";
import { ExuluStorage } from "./storage";
import type { ExuluQueueConfig } from "@EXULU_TYPES/queue-config";
import { generateSlug } from "src/utils/generate-slug";
import { postgresClient } from "src/postgres/client";
import type { ExuluConfig } from "./app";
import { updateStatistic } from "./statistics";
import { STATISTICS_TYPE_ENUM, type STATISTICS_TYPE } from "@EXULU_TYPES/enums/statistics";
import type { ExuluStatisticParams } from "@EXULU_TYPES/statistics";

type ExuluEmbedderConfig = {
  name: string;
  description: string;
  default?: string;
};

type VectorGenerationResponse = Promise<{
  id: string;
  chunks: {
    content: string;
    index: number;
    metadata: Record<string, string>;
    vector: number[];
  }[];
}>;

type VectorGenerateOperation = (
  inputs: ChunkerResponse,
  settings: Record<string, string>,
) => VectorGenerationResponse;

type ChunkerOperation = (
  item: Item & { id: string },
  maxChunkSize: number,
  utils: {
    storage: ExuluStorage;
  },
  config: Record<string, string>,
) => Promise<ChunkerResponse>;

type ChunkerResponse = {
  item: Item & { id: string };
  chunks: {
    content: string;
    index: number;
  }[];
};

export class ExuluEmbedder {
  public id: string;
  public name: string;
  public slug: string = "";
  public queue?: Promise<ExuluQueueConfig>;
  private generateEmbeddings: VectorGenerateOperation;
  public description: string;
  public vectorDimensions: number;
  public config?: ExuluEmbedderConfig[];
  public maxChunkSize: number;
  public _chunker: ChunkerOperation;
  constructor({
    id,
    name,
    description,
    generateEmbeddings,
    queue,
    vectorDimensions,
    maxChunkSize,
    chunker,
    config,
  }: {
    id: string;
    name: string;
    description: string;
    config?: ExuluEmbedderConfig[];
    generateEmbeddings: VectorGenerateOperation;
    chunker: ChunkerOperation;
    queue?: Promise<ExuluQueueConfig>;
    vectorDimensions: number;
    maxChunkSize: number;
  }) {
    this.id = id;
    this.name = name;
    this.config = config;
    this.description = description;
    this.vectorDimensions = vectorDimensions;
    this.maxChunkSize = maxChunkSize;

    this._chunker = chunker;
    this.slug = `/embedders/${generateSlug(this.name)}/run`;
    this.queue = queue;
    this.generateEmbeddings = generateEmbeddings;
  }

  public chunker = async (
    context: string,
    item: Item & { id: string },
    maxChunkSize: number,
    config: ExuluConfig,
  ) => {
    const utils = {
      storage: new ExuluStorage({ config }),
    };
    const settings = await this.hydrateEmbedderConfig(context);
    return this._chunker(item, maxChunkSize, utils, settings);
  };

  private hydrateEmbedderConfig = async (context: string): Promise<Record<string, string>> => {
    const hydrated: {
      id: string;
      name: string;
      value: string;
    }[] = [];

    const { db } = await postgresClient();

    const variables = await db.from("embedder_settings").where({
      context: context,
      embedder: this.id,
    });

    for (const config of this.config || []) {
      const name = config.name;
      const setting = variables.find((v) => v.name === name);

      if (!setting) {
        throw new Error(
          "Setting value not found for embedder setting: " +
            name +
            ", for context: " +
            context +
            " and embedder: " +
            this.id +
            ". Make sure to set the value for this setting in the embedder settings.",
        );
      }

      const { value: variableName, id } = setting;

      let value = "";

      // Look up the variable from the variables table
      const variable = await db.from("variables").where({ name: variableName }).first();
      if (!variable) {
        throw new Error(
          "Variable not found for embedder setting: " +
            name +
            " in context: " +
            context +
            " and embedder: " +
            this.id,
        );
      }

      if (variable.encrypted) {
        if (!process.env.NEXTAUTH_SECRET) {
          throw new Error(
            "NEXTAUTH_SECRET environment variable is not set, cannot decrypt variable: " + name,
          );
        }

        try {
          const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET);
          const decrypted = bytes.toString(CryptoJS.enc.Utf8);

          if (!decrypted) {
            throw new Error("Decryption returned empty string - invalid key or corrupted data");
          }

          value = decrypted;
        } catch (error) {
          throw new Error(
            `Failed to decrypt variable "${name}" for embedder setting in context "${context}": ${error instanceof Error ? error.message : "Unknown error"}. Verify that NEXTAUTH_SECRET matches the key used during encryption.`,
          );
        }
      } else {
        value = variable.value;
      }

      hydrated.push({
        id: id || "",
        name: name,
        value: value || "",
      });
    }
    return hydrated.reduce((acc, curr) => {
      acc[curr.name] = curr.value;
      return acc;
    }, {});
  };

  public async generateFromQuery(
    context: string,
    query: string,
    statistics?: ExuluStatisticParams,
    user?: number,
    role?: string,
  ): VectorGenerationResponse {
    if (statistics) {
      await updateStatistic({
        name: "count",
        label: statistics.label,
        type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
        trigger: statistics.trigger,
        count: 1,
        user: user,
        role: role,
      });
    }

    const settings = await this.hydrateEmbedderConfig(context);

    return await this.generateEmbeddings(
      {
        item: {
          id: "placeholder",
        },
        chunks: [
          {
            content: query,
            index: 1,
          },
        ],
      },
      settings,
    );
  }

  public async generateFromDocument(
    context: string,
    input: Item,
    config: ExuluConfig,
    statistics?: ExuluStatisticParams,
    user?: number,
    role?: string,
  ): VectorGenerationResponse {
    if (statistics) {
      await updateStatistic({
        name: "count",
        label: statistics.label,
        type: STATISTICS_TYPE_ENUM.EMBEDDER_GENERATE as STATISTICS_TYPE,
        trigger: statistics.trigger,
        count: 1,
        user: user,
        role: role,
      });
    }

    if (!this.chunker) {
      throw new Error("Chunker not found for embedder " + this.name);
    }

    if (!input.id) {
      throw new Error("Item id is required for generating embeddings.");
    }

    const settings = await this.hydrateEmbedderConfig(context);

    const output = await this.chunker(
      context,
      input as Item & { id: string },
      this.maxChunkSize,
      config,
    );

    console.log("[EXULU] Generating embeddings.");

    return await this.generateEmbeddings(output, settings);
  }
}
