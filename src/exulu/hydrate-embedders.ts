/**
 * Makes each live context instance reflect the RESOLVED embedder state.
 *
 * "Resolved" in all three directions, not just the override one: the stored
 * override when there is one, the model declared in code when the override
 * has just been cleared, and nothing at all when the context has neither.
 * Hydration that only ever assigns cannot undo itself, so a cleared override
 * would survive on every replica that did not serve the mutation — and the
 * chunks table it pointed at is already gone.
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
import type { ExuluContext, ExuluContextEmbedder } from "./context";
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

/**
 * The embedder each context was CONSTRUCTED with, captured the first time we
 * hydrate it.
 *
 * Hydration overwrites `context.embedder`, and `resolveContextEmbedder`
 * derives `codeModel` from exactly that field — so after one pass the
 * instance no longer knows what code declared, and "fall back to the code
 * default" would silently mean "keep the override". Keyed by the instance so
 * it holds nothing alive and needs no reset between tests.
 */
const codeEmbedders = new WeakMap<object, ExuluContextEmbedder | undefined>();

const codeEmbedderOf = (
  context: Pick<ExuluContext, "embedder">,
): ExuluContextEmbedder | undefined => {
  if (!codeEmbedders.has(context)) codeEmbedders.set(context, context.embedder);
  return codeEmbedders.get(context);
};

/**
 * What CODE declares for this context, as opposed to what hydration has since
 * assigned. Read-only: it never captures, so calling it cannot freeze an
 * override in as if it were the default.
 *
 * Exported because clearing an override is a change TO the code default
 * (spec §3), and by then `context.embedder` names the override. A context
 * this module has not hydrated yet still carries its constructor value, so
 * the live field is the right answer there.
 */
export const codeEmbedderFor = (
  context: Pick<ExuluContext, "embedder">,
): ExuluContextEmbedder | undefined =>
  codeEmbedders.has(context) ? codeEmbedders.get(context) : context.embedder;

export const hydrateContextEmbedders = async (
  contexts: ExuluContext[],
  deps: Partial<HydrateDeps> = {},
): Promise<void> => {
  const { resolve, modelInfo, queues } = { ...defaultDeps(), ...deps };

  for (const context of contexts) {
    try {
      const codeEmbedder = codeEmbedderOf(context);

      // Resolve against what CODE declared, never against the instance as it
      // currently stands — a previous hydration may already have replaced it
      // with an override, which would make that override look like the code
      // default and pin it forever.
      const info = await resolve({ id: context.id, embedder: codeEmbedder });

      // No override (never set, or just cleared): the resolved state is the
      // code default, or nothing at all. Assign it either way — this is the
      // branch that lets a cleared override actually take effect.
      if (info.source !== "database" || !info.databaseModel) {
        context.embedder = codeEmbedder;
        continue;
      }

      // A stored model that has since been removed from config.litellm.yaml
      // would make createChunksTable throw during boot. Refuse the override
      // instead and fall back to the code default (or nothing) — never to the
      // dead model.
      try {
        modelInfo(info.databaseModel);
      } catch (err) {
        console.error(
          `[EXULU] Context "${context.id}" has a stored embedder "${info.databaseModel}" that is ` +
            `not a usable embedding model (${(err as Error).message.split("\n")[0]}). ` +
            `Ignoring the override and falling back to the model declared in code` +
            `${info.codeModel ? ` ("${info.codeModel}")` : " (none)"}.`,
        );
        context.embedder = codeEmbedder;
        continue;
      }

      const queueName = info.databaseQueue;
      // Default to the code-declared queue, not to whatever the last
      // hydration left on the instance: an override that drops its queue name
      // must stop using the previous override's queue.
      let queue = codeEmbedder?.queue;
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
