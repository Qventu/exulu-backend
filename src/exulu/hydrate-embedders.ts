/**
 * Applies each context's stored embedder override onto the live instance.
 *
 * `context.embedder` stays the single SYNCHRONOUS source of truth everywhere
 * (30 read sites across 8 files, several of which — the knex createTable
 * callback, GraphQL schema generation, the bullmq validators — cannot be
 * async). Rather than resolve the override at each read, we resolve it once
 * and assign it here.
 *
 * Nothing in this module may throw. It runs inside initExuluDb; an exception
 * means the application does not start. Every failure path logs and leaves
 * the context on whatever it already had.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md §2
 */
import { exuluApp } from "@SRC/exulu/app/singleton";
import type { ExuluContext } from "./context";
import { resolveContextEmbedder, type ContextEmbedderInfo } from "./embedder-settings";
import { getEmbeddingModelInfo } from "./litellm/parse-embedding-models";

export type HydrateDeps = {
  resolve: (context: Pick<ExuluContext, "id" | "embedder">) => Promise<ContextEmbedderInfo>;
  modelInfo: (model: string) => { dimensionality: number };
  queues: () => { queue: { name: string } }[];
};

const defaultDeps = (): HydrateDeps => ({
  resolve: resolveContextEmbedder,
  modelInfo: getEmbeddingModelInfo,
  queues: () => {
    try {
      return exuluApp.get().queues() as { queue: { name: string } }[];
    } catch {
      // The app singleton is not initialised in every context (e.g. early
      // boot, tests). No registry means no queue — inline is a valid answer.
      return [];
    }
  },
});

export const hydrateContextEmbedders = async (
  contexts: ExuluContext[],
  deps: Partial<HydrateDeps> = {},
): Promise<void> => {
  const { resolve, modelInfo, queues } = { ...defaultDeps(), ...deps };

  for (const context of contexts) {
    try {
      const info = await resolve(context);

      // No override: whatever the constructor set already stands.
      if (info.source !== "database" || !info.databaseModel) continue;

      // A stored model that has since been removed from config.litellm.yaml
      // would make createChunksTable throw during boot. Refuse the override
      // instead and leave the code default (or nothing) in place.
      try {
        modelInfo(info.databaseModel);
      } catch (err) {
        console.error(
          `[EXULU] Context "${context.id}" has a stored embedder "${info.databaseModel}" that is ` +
            `not a usable embedding model (${(err as Error).message.split("\n")[0]}). ` +
            `Ignoring the override and falling back to the model declared in code` +
            `${info.codeModel ? ` ("${info.codeModel}")` : " (none)"}.`,
        );
        continue;
      }

      const queueName = info.databaseQueue;
      let queue = context.embedder?.queue;
      if (queueName) {
        const found = queues().find((q) => q.queue?.name === queueName);
        if (found) {
          queue = Promise.resolve(found as never);
        } else {
          queue = undefined;
          console.warn(
            `[EXULU] Context "${context.id}" names embedder queue "${queueName}", which is not ` +
              `registered. Embedding will run inline.`,
          );
        }
      }

      context.embedder = { model: info.databaseModel, queue };
    } catch (err) {
      console.error(
        `[EXULU] Could not hydrate the embedder for context "${context.id}":`,
        (err as Error).message,
      );
    }
  }
};

const REFRESH_INTERVAL_MS = 30_000;
let lastRefresh = 0;

/**
 * Re-hydrates at most every 30 seconds. Called from the async entry points
 * that already await, so the synchronous read sites stay untouched and are
 * at worst 30 seconds stale. Bounds the window in which a replica that did
 * not serve the change keeps embedding at the old dimensionality.
 *
 * Takes the same optional `deps` as `hydrateContextEmbedders` so tests can
 * control what a refresh resolves to without reaching into module internals.
 */
export const refreshContextEmbeddersIfStale = async (
  contexts: ExuluContext[],
  now: number = Date.now(),
  deps: Partial<HydrateDeps> = {},
): Promise<void> => {
  if (now - lastRefresh < REFRESH_INTERVAL_MS) return;
  lastRefresh = now;
  await hydrateContextEmbedders(contexts, deps);
};

/** Test seam — forces the next call to refresh. */
export const __resetEmbedderRefreshClock = () => {
  lastRefresh = 0;
};
