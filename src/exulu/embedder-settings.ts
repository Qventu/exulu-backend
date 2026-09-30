/**
 * The admin-configurable embedding model for a context.
 *
 * Shaped after src/exulu/entities/config.ts: the value declared in code is a
 * default, a row in platform_configurations overrides it, and callers get an
 * "effective" value plus where it came from. The payload here is an object
 * ({ model, queue }) rather than a bare string, because an embedder also needs
 * the queue its jobs run on (spec §6).
 *
 * Every read is failure-tolerant on purpose: these run during boot, and an
 * unreadable setting must degrade a context to its code default rather than
 * stop the application from starting.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md §1
 */
import { postgresClient } from "@SRC/postgres/client";
import type { ExuluContext } from "./context";

export type EmbedderSource = "database" | "code";

export type StoredEmbedder = { model: string; queue: string | null };

export interface ContextEmbedderInfo {
  /** The model embedding will actually use, or null when the context has none. */
  effectiveModel: string | null;
  /** Where the effective model came from; null when there is none. */
  source: EmbedderSource | null;
  /** The UI-configured override in platform_configurations. */
  databaseModel: string | null;
  /** `context.embedder.model` declared in code, if any. */
  codeModel: string | null;
  /** Queue name stored with the override; null means inline embedding. */
  databaseQueue: string | null;
}

export const embedderKey = (contextId: string) => `context_embedder:${contextId}`;

export const getEmbedderSetting = async (
  contextId: string,
): Promise<StoredEmbedder | null> => {
  try {
    const { db } = await postgresClient();
    const row = await db
      .from("platform_configurations")
      .where({ config_key: embedderKey(contextId) })
      .first();
    if (!row?.config_value) return null;
    // config_value is a `json` column. pg may hand it back already parsed or
    // as raw JSON text — handle both, mirroring getEntityModelSetting.
    const raw = row.config_value;
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    const { model, queue } = value as { model?: unknown; queue?: unknown };
    if (typeof model !== "string" || !model.trim()) return null;
    return {
      model: model.trim(),
      queue: typeof queue === "string" && queue.trim() ? queue.trim() : null,
    };
  } catch (err) {
    console.warn(
      `[EXULU] Could not read the embedder setting for "${contextId}":`,
      (err as Error).message,
    );
    return null;
  }
};

export const setEmbedderSetting = async (
  contextId: string,
  model: string,
  queue: string | null,
): Promise<void> => {
  const { db } = await postgresClient();
  const value = JSON.stringify({ model: model.trim(), queue: queue?.trim() || null });
  await db
    .from("platform_configurations")
    .insert({
      config_key: embedderKey(contextId),
      config_value: value,
      description: `Embedding model for context ${contextId}`,
    })
    .onConflict("config_key")
    .merge({ config_value: value });
};

export const clearEmbedderSetting = async (contextId: string): Promise<void> => {
  const { db } = await postgresClient();
  await db
    .from("platform_configurations")
    .where({ config_key: embedderKey(contextId) })
    .del();
};

export const resolveContextEmbedder = async (
  context: Pick<ExuluContext, "id" | "embedder">,
): Promise<ContextEmbedderInfo> => {
  const stored = await getEmbedderSetting(context.id);
  const codeModel = context.embedder?.model ?? null;
  const databaseModel = stored?.model ?? null;
  const databaseQueue = stored?.queue ?? null;

  if (databaseModel) {
    return { effectiveModel: databaseModel, source: "database", databaseModel, codeModel, databaseQueue };
  }
  if (codeModel) {
    return { effectiveModel: codeModel, source: "code", databaseModel, codeModel, databaseQueue };
  }
  return { effectiveModel: null, source: null, databaseModel, codeModel, databaseQueue };
};
