import { postgresClient } from "@SRC/postgres/client";
import type { ExuluContext } from "../context";
import type { EntityTypeDefinition, SuggestedType } from "./types";

/**
 * Resolve the effective entity types for a context: the UNION of the
 * code-declared `entities.types` and the admin-managed `entity_type_settings`
 * rows (active only), deduped by lowercased name. On a name collision the admin
 * row wins (operators tune the live system). If a context declares no entities
 * block but an admin added types for it, the layer activates from admin config.
 */
export const hydrateEntityTypes = async (
  context: ExuluContext,
): Promise<EntityTypeDefinition[]> => {
  const byName = new Map<string, EntityTypeDefinition>();

  for (const t of context.entities?.types || []) {
    if (!t?.name) continue;
    byName.set(t.name.toLowerCase().trim(), { name: t.name, description: t.description || "" });
  }

  try {
    const { db } = await postgresClient();
    const adminRows = await db
      .from("entity_type_settings")
      .where({ context: context.id, active: true });

    for (const row of adminRows) {
      if (!row?.name) continue;
      // Admin wins on collision.
      byName.set(row.name.toLowerCase().trim(), {
        name: row.name,
        description: row.description || "",
      });
    }
  } catch (err) {
    // entity_type_settings may not exist yet during early boot; fall back to code types.
    console.warn("[EXULU] Could not read entity_type_settings:", (err as Error).message);
  }

  return Array.from(byName.values());
};

/**
 * Whether the entity layer is active for this context. True when there is at
 * least one effective entity type (code or admin) AND the context has an
 * embedder (entities link to chunks, which require an embedder).
 */
export const entitiesEnabled = async (context: ExuluContext): Promise<boolean> => {
  if (!context.embedder) return false;
  const types = await hydrateEntityTypes(context);
  return types.length > 0;
};

// ───────────────────────── suggested types (discovery) ─────────────────────────

/**
 * Persist entity TYPES the extractor proposed (not in the configured set) as
 * "suggested" rows on entity_type_settings — `active:false, status:"suggested"`
 * so they never affect extraction until an operator promotes them. Deduped
 * against existing rows (any status) so we never duplicate or re-suggest a
 * name that already exists. Best-effort.
 */
export const upsertEntitySuggestions = async (
  context: ExuluContext,
  suggestions: SuggestedType[],
): Promise<void> => {
  if (!suggestions.length) return;
  try {
    const { db } = await postgresClient();
    const existing = await db
      .from("entity_type_settings")
      .where({ context: context.id })
      .select("name");
    const existingNames = new Set(
      existing.map((r: { name?: string }) =>
        String(r.name || "").toLowerCase().trim(),
      ),
    );
    const rows = suggestions
      .filter((s) => s.name && !existingNames.has(s.name.toLowerCase().trim()))
      .map((s) => ({
        name: s.name,
        description: s.example
          ? `${s.description} (e.g. ${s.example})`
          : s.description,
        context: context.id,
        active: false,
        status: "suggested",
      }));
    if (rows.length) {
      await db.from("entity_type_settings").insert(rows);
    }
  } catch (err) {
    console.warn(
      "[EXULU] Could not persist entity suggestions:",
      (err as Error).message,
    );
  }
};

// ───────────────────────── entity extraction model ─────────────────────────

const entityModelKey = (contextId: string) => `entity_extraction_model:${contextId}`;

export type EntityModelSource = "database" | "code" | "env";

export interface EntityModelInfo {
  /** The model entity extraction will actually use, or null when none. */
  effectiveModel: string | null;
  /** Where the effective model came from. */
  source: EntityModelSource | null;
  /** The UI-configured override stored in platform_configurations. */
  databaseModel: string | null;
  /** `context.entities.model` declared in code, if any. */
  codeModel: string | null;
}

/** The UI-configured entity model for a context (platform_configurations). */
export const getEntityModelSetting = async (
  contextId: string,
): Promise<string | null> => {
  try {
    const { db } = await postgresClient();
    const row = await db
      .from("platform_configurations")
      .where({ config_key: entityModelKey(contextId) })
      .first();
    if (!row?.config_value) return null;
    // config_value is a `json` column. pg may return it already parsed (the
    // scalar string) or as raw JSON text — handle both, mirroring budget-service.
    const raw = row.config_value;
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch (err) {
    console.warn("[EXULU] Could not read entity model setting:", (err as Error).message);
    return null;
  }
};

/** Set (or clear, when null/empty) the UI-configured entity model. */
export const setEntityModelSetting = async (
  contextId: string,
  modelId: string | null,
): Promise<void> => {
  const { db } = await postgresClient();
  const key = entityModelKey(contextId);
  if (!modelId || !modelId.trim()) {
    await db.from("platform_configurations").where({ config_key: key }).del();
    return;
  }
  // config_value is a `json` column — store the model name as a JSON string
  // literal (a bare string is invalid JSON), matching budget-service.
  const value = JSON.stringify(modelId.trim());
  await db
    .from("platform_configurations")
    .insert({
      config_key: key,
      config_value: value,
      description: `Entity extraction model for context ${contextId}`,
    })
    .onConflict("config_key")
    .merge({ config_value: value });
};

/**
 * Resolve the model entity extraction should use, with precedence
 * database (UI override) → code (`context.entities.model`) → env
 * (EXULU_ENTITY_EXTRACTION_MODEL). The UI override wins so operators can fix /
 * tune the live system (mirrors hydrateEntityTypes' "admin wins" rule).
 */
export const resolveEntityModel = async (
  context: ExuluContext,
): Promise<EntityModelInfo> => {
  const databaseModel = await getEntityModelSetting(context.id);
  const codeModel = context.entities?.model ?? null;
  const envModel = process.env.EXULU_ENTITY_EXTRACTION_MODEL ?? null;

  if (databaseModel) {
    return { effectiveModel: databaseModel, source: "database", databaseModel, codeModel };
  }
  if (codeModel) {
    return { effectiveModel: codeModel, source: "code", databaseModel, codeModel };
  }
  if (envModel) {
    return { effectiveModel: envModel, source: "env", databaseModel, codeModel };
  }
  return { effectiveModel: null, source: null, databaseModel, codeModel };
};
