import { sanitizeName } from "@SRC/utils/sanitize-name";

/**
 * A single entity type a context extracts (e.g. { name: "Person", description: "..." }).
 * Declared in code on the ExuluContext `entities.types`, and/or in the DB via the
 * `entity_type_settings` admin table. The effective set is the union of both.
 */
export type EntityTypeDefinition = {
  name: string;
  description: string;
};

/**
 * The opt-in entity-layer configuration on an ExuluContext. When this block is
 * absent (and no admin types exist for the context) the entity layer is OFF and
 * retrieval/ingestion behave exactly as before.
 */
export type ExuluEntitiesConfig = {
  /** Entity types declared in code. Merged (union) with admin-declared types. */
  types?: EntityTypeDefinition[];
  /** models.id used for extraction. Resolved via resolveModel(). Falls back to a platform default. */
  model?: string;
  /** Where to extract from. "chunks" (default) locates each mention to a chunk. */
  extractFrom?: "chunks" | "document";
  /** Weight of the shared-entity boost term in retrieval ranking. Default 0.3. */
  boostWeight?: number;
  /** Drop mentions below this extractor confidence (0..1). Default 0.5. */
  confidenceThreshold?: number;
  /** Target language for canonical entity names. Default "english". */
  canonicalLanguage?: string;
};

/** A mention produced by the extractor for a single chunk. */
export type EntityMention = {
  /** Index of the chunk this mention was found in. */
  chunkIndex: number;
  /** Entity type name (must be one of the effective types). */
  type: string;
  /** Original surface form as it appeared in the text (any language). */
  mention: string;
  /** Canonical, language-normalized name used to resolve the entity. */
  canonical: string;
  /** Extractor confidence 0..1. */
  confidence: number;
};

/** A related entity surfaced via derived co-occurrence. */
export type RelatedEntity = {
  id: string;
  name: string;
  type: string;
  /** Relatedness weight (normalized Jaccard over shared documents). */
  weight: number;
};

/** Entity intelligence for one query entity, returned to the calling agent. */
export type QueryEntityInsight = {
  id: string;
  type: string;
  name: string;
  /** How many of the returned chunks mention this entity. */
  matchedInResults: number;
  /** Distinct documents in the context mentioning this entity (maintained counter). */
  relatedDocCount: number;
  /** Top-K co-occurring entities, weighted. */
  relatedEntities: RelatedEntity[];
};

export type EntityInsights = {
  queryEntities: QueryEntityInsight[];
};

/** A resolved entity row from `<ctx>_entities`. */
export type EntityRow = {
  id: string;
  type: string;
  canonical_key: string;
  display_name: string;
  mention_count: number;
  doc_count: number;
  metadata: Record<string, any> | null;
};

/** Caller-supplied entity filter for agent-driven exploration. */
export type EntityFilter = {
  /** Resolve directly by entity id. */
  entityIds?: string[];
  /** Or resolve by (type, name) — name is normalized to a canonical key. */
  entities?: { type: string; name: string }[];
  /** "any" (default): chunk mentions at least one. "all": chunk mentions all. */
  mode?: "any" | "all";
};

export const getEntitiesTableName = (id: string) => sanitizeName(id) + "_entities";
export const getChunkEntitiesTableName = (id: string) => sanitizeName(id) + "_chunk_entities";
