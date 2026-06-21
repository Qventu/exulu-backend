import { generateText, Output } from "ai";
import { z } from "zod";
import { resolveModel } from "../resolve-model";
import { exuluApp } from "../app/singleton";
import type { ExuluContext } from "../context";
import { resolveEntityModel } from "./config";
import type {
  EntityMention,
  EntityTypeDefinition,
  SuggestedType,
} from "./types";

/** Max chunks sent to the model in a single extraction call. Large items are split. */
const CHUNK_BATCH_SIZE = 30;
/** Max new type suggestions to request per extraction call. */
const MAX_SUGGESTIONS = 5;

const mentionSchema = z.object({
  entities: z.array(
    z.object({
      chunkIndex: z.number().int().describe("Index of the chunk this entity was found in."),
      type: z.string().describe("One of the provided entity type names."),
      mention: z.string().describe("The exact surface form as it appears in the text."),
      canonical: z
        .string()
        .describe("The canonical, language-normalized name used to merge variants."),
      confidence: z.number().min(0).max(1).describe("Confidence 0..1 that this is a valid entity."),
    }),
  ),
  suggestedTypes: z
    .array(
      z.object({
        name: z.string().describe("A concise NEW entity type name, e.g. 'Error Code', 'Component'."),
        description: z.string().describe("What this type captures, one sentence."),
        mentions: z
          .array(
            z.object({
              chunkIndex: z.number().int().describe("Index of the chunk this mention was found in."),
              mention: z.string().describe("The exact surface form as it appears in the text."),
              canonical: z.string().describe("Canonical, language-normalized name."),
              confidence: z.number().min(0).max(1).describe("Confidence 0..1."),
            }),
          )
          .describe("Every mention of this new type found in the provided chunks."),
      }),
    )
    .describe(
      "Entity TYPES that recur in the text but are NOT in the configured list and would be worth tracking. Empty array if none.",
    )
    .optional(),
});

const buildSystemPrompt = (
  types: EntityTypeDefinition[],
  canonicalLanguage: string,
): string => {
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const typeNames = types.map((t) => `"${t.name}"`).join(", ");
  return [
    "You are an entity extraction engine. Extract entities of ONLY the types listed below from the provided text chunks.",
    "",
    'Entity types (the "type" field of every entity you output MUST be exactly one of these names):',
    typeList,
    "",
    "For each entity, output an object with:",
    `- "type": EXACTLY one of these type names — ${typeNames}. NEVER put the description, a category value, or a generic label like "named entity"/"classification" in this field.`,
    '- "mention" and "canonical": the value (see how to choose them below).',
    '- "chunkIndex": the index of the chunk the entity was found in.',
    '- "confidence": your certainty the entity is valid (0..1).',
    "",
    "How to choose mention/canonical depends on each type's description:",
    `- If the type names concrete things mentioned in the text (a person, product, place, code, organization): output the exact surface form as it appears as "mention", and a "canonical" normalized to ${canonicalLanguage}. Output a SEPARATE entity object for every distinct value — a single chunk may contain many of these, including several of the SAME type (e.g. three different cities → three "City" entities) and several of different types. Never collapse them or limit yourself to one per chunk.`,
    `- If the type is a classification or property (the description defines a fixed set of categories, or asks you to judge a property of the content — e.g. "is this a fact or an instruction"): pick the single best-fitting category for the chunk and output that category as BOTH "mention" and "canonical", even if that exact word is not in the text. Output at most one entity of such a type per chunk.`,
    "",
    "Rules:",
    "- A chunk can yield MULTIPLE entities — of the same named-entity type and of different types. Extract every distinct entity you find. The one-per-chunk limit applies ONLY to classification/property types.",
    `- The canonical name merges variants and translations: e.g. "München" and "MUC" both canonicalize to the ${canonicalLanguage} form "Munich". "Acme Inc" and "ACME" both canonicalize to "Acme".`,
    "- DO NOT translate or alter identifiers, case numbers, SKUs, product codes, or proper product names — keep those verbatim as their own canonical.",
    "- Only put entities of the listed types in the `entities` array. Do NOT put anything else there.",
    "- Use an empty `entities` array when no listed type applies to the text.",
    "",
    `Separately, in "suggestedTypes", propose up to ${MAX_SUGGESTIONS} entity TYPES that recur in the text but are NOT in the list above and would be worth tracking (e.g. a kind of code, component, or product that keeps appearing). For each, give a concise name, a one-sentence description, and the full list of its "mentions" found in the chunks — extract those mentions exactly as you would for a configured named-entity type (each with its chunkIndex, the surface-form "mention", a normalized "canonical", and "confidence"). Leave the array empty if nothing stands out. Never put these in the "entities" array.`,
  ].join("\n");
};

const buildUserPrompt = (chunks: { index: number; content: string }[]): string => {
  return chunks
    .map((c) => `--- chunk ${c.index} ---\n${c.content}`)
    .join("\n\n");
};

/**
 * Extract entity mentions for one item's chunks using the configured extractor
 * model. Best-effort: on any failure (no model, LLM error) it logs and returns
 * an empty array so embedding ingestion is never blocked.
 */
export const extractEntitiesForItem = async ({
  context,
  chunks,
  types,
}: {
  context: ExuluContext;
  chunks: { index: number; content: string }[];
  types: EntityTypeDefinition[];
}): Promise<{ mentions: EntityMention[]; suggestions: SuggestedType[] }> => {
  const empty = {
    mentions: [] as EntityMention[],
    suggestions: [] as SuggestedType[],
  };
  if (!types.length || !chunks.length) return empty;

  const { effectiveModel: modelId } = await resolveEntityModel(context);
  if (!modelId) {
    console.warn(
      `[EXULU] Entity extraction skipped for context ${context.id}: no model configured. ` +
        `Select one in the Entities tab, set context.entities.model in code, or set EXULU_ENTITY_EXTRACTION_MODEL.`,
    );
    return empty;
  }

  const canonicalLanguage = context.entities?.canonicalLanguage || "english";
  const confidenceThreshold = context.entities?.confidenceThreshold ?? 0.5;

  let languageModel;
  try {
    const resolved = await resolveModel({
      modelId,
      providers: exuluApp.get().providers,
      rbacBypass: true,
    });
    languageModel = resolved.languageModel;
  } catch (err) {
    console.error(
      `[EXULU] Entity extraction skipped for context ${context.id}: could not resolve model ${modelId}:`,
      (err as Error).message,
    );
    return empty;
  }

  const system = buildSystemPrompt(types, canonicalLanguage);

  // Split into batches to keep prompts within context limits.
  const batches: { index: number; content: string }[][] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
    batches.push(chunks.slice(i, i + CHUNK_BATCH_SIZE));
  }

  const mentions: EntityMention[] = [];
  // Dedup suggested types by lowercased name within this item's extraction.
  const suggestionsByName = new Map<string, SuggestedType>();

  for (const batch of batches) {
    try {
      const { output } = await generateText({
        temperature: 0,
        model: languageModel,
        system,
        prompt: buildUserPrompt(batch),
        maxRetries: 2,
        output: Output.object({ schema: mentionSchema }),
      });

      for (const e of output.entities) {
        if (!e.mention || !e.canonical || !e.type) continue;
        if (e.confidence < confidenceThreshold) continue;
        // Map the model's reported type back to a declared type by NAME, also
        // tolerating models that echo the type DESCRIPTION into the type field
        // so a correct classification isn't dropped over a labelling quirk.
        const eType = e.type.toLowerCase().trim();
        const declared = types.find(
          (t) =>
            t.name.toLowerCase().trim() === eType ||
            (t.description || "").toLowerCase().trim() === eType,
        );
        if (!declared) continue;
        mentions.push({
          chunkIndex: e.chunkIndex,
          type: declared.name,
          mention: e.mention,
          canonical: e.canonical,
          confidence: e.confidence,
        });
      }

      // Collect proposed new types (deduped by name) AND ingest their mentions
      // now — linked to the item the same way configured types are — so that
      // promoting a suggested type later finds its entities already attached.
      for (const s of output.suggestedTypes ?? []) {
        const name = (s?.name || "").trim();
        if (!name) continue;
        const key = name.toLowerCase();
        // Ignore "new" types that actually duplicate a configured one — those
        // mentions belong in `entities` and are handled above.
        const isConfigured = types.some(
          (t) =>
            t.name.toLowerCase().trim() === key ||
            (t.description || "").toLowerCase().trim() === key,
        );
        if (isConfigured) continue;

        const sMentions = (s.mentions ?? []).filter(
          (m) => m.mention && m.canonical && m.confidence >= confidenceThreshold,
        );
        for (const m of sMentions) {
          mentions.push({
            chunkIndex: m.chunkIndex,
            type: name,
            mention: m.mention,
            canonical: m.canonical,
            confidence: m.confidence,
          });
        }

        if (!suggestionsByName.has(key)) {
          suggestionsByName.set(key, {
            name,
            description: (s.description || "").trim(),
            example: sMentions[0]?.mention || undefined,
          });
        }
      }
    } catch (err) {
      console.error(
        `[EXULU] Entity extraction batch failed for context ${context.id} (continuing):`,
        (err as Error).message,
      );
      // Continue with other batches; partial extraction is acceptable.
    }
  }

  const suggestions = [...suggestionsByName.values()];
  console.log(
    `[EXULU][entities] context ${context.id}: kept ${mentions.length} mention(s), ${suggestions.length} suggestion(s).`,
  );
  return { mentions, suggestions };
};
