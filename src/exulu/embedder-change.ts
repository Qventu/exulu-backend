/**
 * Changing a context's embedder, as one orchestrated operation.
 *
 * The chunks table bakes the vector dimension into its column
 * (`vector(n)`, context.ts:1319), so a model with a different dimensionality
 * needs the table rebuilt, not just emptied. A model change ALWAYS needs
 * regeneration, even at identical dimensions — vectors from a different
 * model occupy a different space.
 *
 * Built from injected deps so the decision table and the ordering are
 * testable without a database.
 *
 * Design doc: docs/superpowers/specs/2026-09-30-context-embedder-settings-design.md §3
 */
import type { ExuluContext } from "./context";

export type RebuildCase = "create" | "truncate" | "recreate" | "cleared";

export type ChangeEmbedderDeps = {
  currentDimensionality: (contextId: string) => Promise<number | null>;
  modelInfo: (model: string) => { dimensionality: number };
  chunksTableExists: (context: ExuluContext) => Promise<boolean>;
  dropChunksTable: (context: ExuluContext) => Promise<void>;
  createChunksTable: (context: ExuluContext) => Promise<void>;
  deleteAllChunks: (context: ExuluContext) => Promise<void>;
  persist: (contextId: string, model: string | null, queue: string | null) => Promise<void>;
  hydrate: (contexts: ExuluContext[]) => Promise<void>;
  queueRegeneration: (context: ExuluContext) => Promise<{ jobs: string[]; items: number }>;
  /**
   * The model this context declares in code, or null. Injected rather than
   * read off `context.embedder`, which by this point names the override that
   * hydration assigned — not the default clearing falls back to.
   */
  codeModel: (context: ExuluContext) => string | null;
};

/**
 * `existing` is the dimension actually found on the column, not the one the
 * previously-configured model claims — that model may since have been removed
 * from config.litellm.yaml. Unknown means rebuild: rebuilding when we did not
 * need to costs time, while skipping a needed rebuild leaves a column that
 * rejects every insert.
 */
export const decideRebuildCase = (
  existing: number | null,
  next: number,
  tableExists: boolean,
): RebuildCase => {
  if (!tableExists) return "create";
  if (existing === null) return "recreate";
  return existing === next ? "truncate" : "recreate";
};

export const changeContextEmbedder = async (
  context: ExuluContext,
  model: string | null,
  queue: string | null,
  deps: ChangeEmbedderDeps,
): Promise<{ case: RebuildCase; items: number; jobs: string[] }> => {
  const tableExists = await deps.chunksTableExists(context);

  // Clearing is not an operation of its own: spec §3 makes it the same change
  // with the code default as the target. Only a context that declares no
  // model in code genuinely loses its embedder.
  const target = model ?? deps.codeModel(context);

  if (!target) {
    // Nothing left to embed with: the context becomes unsearchable by design,
    // and the table has no valid shape to keep.
    if (tableExists) await deps.dropChunksTable(context);
    await deps.persist(context.id, null, null);
    await deps.hydrate([context]);
    return { case: "cleared", items: 0, jobs: [] };
  }

  // Validate first — this throws with an actionable message naming the exact
  // config.litellm.yaml entry to add, and nothing has been touched yet.
  const { dimensionality } = deps.modelInfo(target);

  const existing = await deps.currentDimensionality(context.id);
  const rebuild = decideRebuildCase(existing, dimensionality, tableExists);

  // Destructive work. Ordered so that a failure here leaves the persisted
  // setting untouched and the context still on its previous embedder.
  if (rebuild === "recreate") {
    // Concurrency: two admins changing the same context is safe because the
    // caller wires dropChunksTable to `dropTableIfExists`, so a drop of a table
    // the other admin already dropped is a no-op. Reaching "recreate" always
    // means the table existed at decision time.
    await deps.dropChunksTable(context);
    await deps.createChunksTable(context);
  } else if (rebuild === "create") {
    await deps.createChunksTable(context);
  } else {
    await deps.deleteAllChunks(context);
  }

  // `model` — not `target`. Clearing still deletes the override row; what
  // changed is that the table was rebuilt for the code default it falls back
  // to, and its chunks are queued for regeneration below.
  await deps.persist(context.id, model, queue);
  await deps.hydrate([context]);

  const { jobs, items } = await deps.queueRegeneration(context);
  return { case: rebuild, items, jobs };
};
