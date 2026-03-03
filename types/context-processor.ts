import type { ExuluStorage } from "src/exulu/storage";
import type { Item } from "./models/item";
import type { ExuluConfig } from "src/exulu/app";
import type { ExuluQueueConfig } from "./queue-config";

export type ExuluContextProcessor = {
    name: string;
    description: string;
    filter: ({
        item,
        user,
        role,
        utils,
        exuluConfig,
    }: {
        item: Item;
        user?: number;
        role?: string;
        utils: {
            storage: ExuluStorage;
        };
        exuluConfig: ExuluConfig;
    }) => Promise<Item | undefined | null>;
    execute: ({
        item,
        user,
        role,
        utils,
        exuluConfig,
    }: {
        item: Item;
        user?: number;
        role?: string;
        utils: {
            storage: ExuluStorage;
        };
        exuluConfig: ExuluConfig;
    }) => Promise<Item>;
    config?: {
        queue?: Promise<ExuluQueueConfig>;
        timeoutInSeconds?: number; // 3 minutes default
        trigger: "manual" | "onUpdate" | "onInsert" | "always";
        generateEmbeddings?: boolean; // defines if embeddings are generated after the processor finishes executing
    };
};