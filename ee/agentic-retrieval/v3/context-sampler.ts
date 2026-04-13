import { ExuluContext, getTableName } from "@SRC/exulu/context";
import { postgresClient } from "@SRC/postgres/client";
import { applyAccessControl } from "@SRC/graphql/utilities/access-control";
import { convertContextToTableDefinition } from "@SRC/graphql/utilities/convert-context-to-table-definition";
import type { User } from "@EXULU_TYPES/models/user";
import type { ContextSample } from "./types";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Pulls 1–2 example item records per context at agent initialization and caches
 * them in memory. These samples are injected into the classifier prompt so the
 * model understands what data is actually stored (not just field names).
 */
export class ContextSampler {
  private cache = new Map<string, ContextSample>();

  async getSamples(
    contexts: ExuluContext[],
    user?: User,
    role?: string,
  ): Promise<ContextSample[]> {
    return Promise.all(contexts.map((ctx) => this.getSample(ctx, user, role)));
  }

  private async getSample(
    ctx: ExuluContext,
    user?: User,
    role?: string,
  ): Promise<ContextSample> {
    const cached = this.cache.get(ctx.id);
    if (cached && Date.now() - cached.sampledAt < CACHE_TTL_MS) {
      return cached;
    }

    const { db } = await postgresClient();
    const tableName = getTableName(ctx.id);
    const tableDefinition = convertContextToTableDefinition(ctx);

    const customFieldNames = ctx.fields.map((f) => f.name);
    const selectFields = ["id", "name", "external_id", ...customFieldNames];

    let exampleItems: Record<string, any>[] = [];
    try {
      let query = db(tableName).select(selectFields).whereNull("archived").limit(2);
      query = applyAccessControl(tableDefinition, query, user, tableName);
      exampleItems = await query;
    } catch {
      // If table doesn't exist yet or column mismatch, return empty samples
    }

    const sample: ContextSample = {
      contextId: ctx.id,
      contextName: ctx.name,
      fields: ["name", "external_id", ...customFieldNames],
      exampleItems,
      sampledAt: Date.now(),
    };

    this.cache.set(ctx.id, sample);

    // Refresh in background after TTL without blocking the caller
    return sample;
  }

  /** Evict a context from cache so it's re-sampled on next use */
  invalidate(contextId: string): void {
    this.cache.delete(contextId);
  }
}
