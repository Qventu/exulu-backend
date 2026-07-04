import { z } from "zod";

export const KB_KINDS = ["documents", "conversations", "records"] as const;
export type KbKind = (typeof KB_KINDS)[number];

export const DEFAULT_PREFILTER_CUTOFF = 2.5;
export const RRF_K = 60;
export const CHUNK_GROUP_MAX = 10;

const kbProfileSchema = z.object({
  enabled: z.boolean().default(true),
  kind: z.enum(KB_KINDS).default("documents"),
  instructions: z.string().default(""),
  overrides: z
    .object({
      limit: z.number().int().positive().optional(),
      expand: z.number().int().min(0).optional(),
      multiQuery: z.boolean().optional(),
      hyde: z.boolean().optional(),
    })
    .default({}),
});
const knowledgeBasesSchema = z.record(z.string(), kbProfileSchema);

const routingRuleSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  main: z.array(z.string()),
  fallback: z.array(z.string()).default([]),
});
const routingSchema = z.object({ rules: z.array(routingRuleSchema).default([]) });

const identifierSetSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  examples: z.array(z.string()).default([]),
  strategy: z.enum(["fuzzy", "exact"]),
  contexts: z.array(z.string()).default([]),
});
const vocabularySchema = z.object({
  glossary: z.array(z.object({ term: z.string(), meaning: z.string() })).default([]),
  identifiers: z.array(identifierSetSchema).default([]),
  rewrites: z.array(z.object({ find: z.string(), replace: z.string() })).default([]),
  styleHint: z.string().default(""),
});
const memorySchema = z.object({
  enabled: z.boolean().default(true),
  override: z.boolean().default(false),
  filePrioritization: z.boolean().default(false),
  queryAugmentation: z.boolean().default(true),
});
const tuningSchema = z.object({
  topK: z.number().int().positive().default(5),
  fallbackThreshold: z.number().min(0).max(1).default(0.95),
  pinBoost: z.number().min(0).max(1).default(0.15),
  identifierBoost: z.number().min(0).max(1).default(0.15),
  pageWindow: z.number().int().min(0).default(1),
  maxQueriesPerContext: z.number().int().positive().default(5),
});

export type KbProfile = z.infer<typeof kbProfileSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type IdentifierSet = z.infer<typeof identifierSetSchema>;

export type PipelineConfig = {
  instructions: string;
  reranker: string;
  managedContext: boolean;
  requirePreselectedContexts: boolean;
  logging: boolean;
  utilityModel: string;
  knowledgeBases: Record<string, KbProfile>;
  routing: z.infer<typeof routingSchema>;
  vocabulary: z.infer<typeof vocabularySchema>;
  memory: z.infer<typeof memorySchema>;
  tuning: z.infer<typeof tuningSchema>;
};

const boolVal = (v: unknown): boolean => v === true || v === "true" || v === 1;
const strVal = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback;

/** Parse one json-typed option: accepts an object (already hydrated), a JSON string,
 * or anything else (→ schema default). Schema failures fall back to defaults with a warning. */
function jsonVal<S extends z.ZodTypeAny>(name: string, schema: S, v: unknown): z.infer<S> {
  let candidate: unknown = v;
  if (typeof v === "string" && v.trim().length > 0) {
    try {
      candidate = JSON.parse(v);
    } catch (err) {
      console.warn(`[EXULU pipeline] config "${name}" is not valid JSON — using defaults.`, err);
      candidate = undefined;
    }
  } else if (typeof v !== "object" || v === null) {
    candidate = undefined;
  }
  if (candidate !== undefined) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    console.warn(`[EXULU pipeline] config "${name}" failed validation — using defaults.`, parsed.error.message);
  }
  // Final fallback: try defaultFor, then undefined, then cast as last resort (never throw)
  try {
    return schema.parse(defaultFor(name));
  } catch (err) {
    console.warn(`[EXULU pipeline] failed to parse fallback for option "${name}" — falling back to schema.parse(undefined).`, err);
    try {
      return schema.parse(undefined);
    } catch {
      return defaultFor(name) as z.infer<S>;
    }
  }
}

function defaultFor(name: string): unknown {
  switch (name) {
    case "knowledge_bases": return {};
    case "routing": return { rules: [] };
    case "vocabulary": return { glossary: [], identifiers: [], rewrites: [], styleHint: "" };
    case "memory": return {};
    case "tuning": return {};
    default: return {};
  }
}

export function parsePipelineConfig(raw?: Record<string, unknown>): PipelineConfig {
  const r = raw ?? {};
  return {
    instructions: strVal(r["instructions"], ""),
    reranker: strVal(r["reranker"], "none"),
    managedContext: boolVal(r["managed_context"]),
    requirePreselectedContexts: boolVal(r["require_preselected_contexts"]),
    logging: boolVal(r["logging"]),
    utilityModel: strVal(r["utility_model"], ""),
    knowledgeBases: jsonVal("knowledge_bases", knowledgeBasesSchema, r["knowledge_bases"]),
    routing: jsonVal("routing", routingSchema, r["routing"]),
    vocabulary: jsonVal("vocabulary", vocabularySchema, r["vocabulary"]),
    memory: jsonVal("memory", memorySchema, r["memory"]),
    tuning: jsonVal("tuning", tuningSchema, r["tuning"]),
  };
}

export const KIND_PRESETS: Record<
  KbKind,
  { limit: number; expand: number; multiQuery: boolean; hyde: boolean; keywordPrefilter: boolean }
> = {
  documents: { limit: 100, expand: 7, multiQuery: true, hyde: true, keywordPrefilter: false },
  conversations: { limit: 20, expand: 5, multiQuery: false, hyde: false, keywordPrefilter: true },
  records: { limit: 20, expand: 2, multiQuery: false, hyde: false, keywordPrefilter: false },
};

export type EffectiveKbSettings = {
  kind: KbKind;
  instructions: string;
  limit: number;
  expand: { before: number; after: number } | undefined;
  cutoffs: { cosineDistance?: number; tsvector?: number; hybrid?: number } | undefined;
  multiQuery: boolean;
  hyde: boolean;
  keywordPrefilter: boolean;
};

/** Precedence per setting: profile.overrides > ctx.configuration > kind preset. */
export function effectiveKbSettings(
  profile: KbProfile | undefined,
  ctx: { configuration?: { expand?: { before?: number; after?: number }; cutoffs?: any; maxRetrievalResults?: number } },
): EffectiveKbSettings {
  const kind: KbKind = profile?.kind ?? "documents";
  const preset = KIND_PRESETS[kind];
  const o = profile?.overrides ?? {};
  const conf = ctx.configuration ?? {};
  const expandN = o.expand ?? undefined;
  const expand = expandN !== undefined
    ? expandN === 0 ? undefined : { before: expandN, after: expandN }
    : conf.expand && (conf.expand.before || conf.expand.after)
      ? { before: conf.expand.before ?? 0, after: conf.expand.after ?? 0 }
      : { before: preset.expand, after: preset.expand };
  return {
    kind,
    instructions: profile?.instructions ?? "",
    limit: o.limit ?? conf.maxRetrievalResults ?? preset.limit,
    expand,
    cutoffs: conf.cutoffs ?? undefined,
    multiQuery: o.multiQuery ?? preset.multiQuery,
    hyde: o.hyde ?? preset.hyde,
    keywordPrefilter: preset.keywordPrefilter,
  };
}
