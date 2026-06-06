import { postgresClient } from "@SRC/postgres/client";
import type { ExuluContext } from "../context";
import type { EntityTypeDefinition } from "./types";

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
