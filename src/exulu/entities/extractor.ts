import { generateText, Output } from "ai";
import { z } from "zod";
import { resolveModel } from "../resolve-model";
import { exuluApp } from "../app/singleton";
import type { ExuluContext } from "../context";
import type { EntityMention, EntityTypeDefinition } from "./types";

/** Max chunks sent to the model in a single extraction call. Large items are split. */
const CHUNK_BATCH_SIZE = 30;

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
});

const buildSystemPrompt = (
  types: EntityTypeDefinition[],
  canonicalLanguage: string,
): string => {
  const typeList = types.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  return [
    "You are an entity extraction engine. Extract entities of ONLY the following types from the provided text chunks.",
    "",
    "Entity types:",
    typeList,
    "",
    "Rules:",
    `- For each entity, output a "mention" (the exact surface form as it appears, in its original language) and a "canonical" name normalized to ${canonicalLanguage}.`,
    `- The canonical name merges variants and translations: e.g. "München" and "MUC" both canonicalize to the ${canonicalLanguage} form "Munich". "Acme Inc" and "ACME" both canonicalize to "Acme".`,
    "- DO NOT translate or alter identifiers, case numbers, SKUs, product codes, or proper product names — keep those verbatim as their own canonical.",
    "- Only use the entity types listed above. Ignore anything that does not fit a listed type.",
    "- Set chunkIndex to the index of the chunk the entity was found in.",
    "- Return an empty array if no entities are present.",
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
}): Promise<EntityMention[]> => {
  if (!types.length || !chunks.length) return [];

  const modelId = context.entities?.model || process.env.EXULU_ENTITY_EXTRACTION_MODEL;
  if (!modelId) {
    console.warn(
      `[EXULU] Entity extraction skipped for context ${context.id}: no entities.model configured and EXULU_ENTITY_EXTRACTION_MODEL is unset.`,
    );
    return [];
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
    return [];
  }

  const system = buildSystemPrompt(types, canonicalLanguage);
  const validTypeNames = new Set(types.map((t) => t.name.toLowerCase().trim()));

  // Split into batches to keep prompts within context limits.
  const batches: { index: number; content: string }[][] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
    batches.push(chunks.slice(i, i + CHUNK_BATCH_SIZE));
  }

  const mentions: EntityMention[] = [];

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
        // Only keep types we asked for (model can hallucinate types).
        if (!validTypeNames.has(e.type.toLowerCase().trim())) continue;
        // Normalize the type name back to the declared casing.
        const declared = types.find((t) => t.name.toLowerCase().trim() === e.type.toLowerCase().trim());
        mentions.push({
          chunkIndex: e.chunkIndex,
          type: declared?.name || e.type,
          mention: e.mention,
          canonical: e.canonical,
          confidence: e.confidence,
        });
      }
    } catch (err) {
      console.error(
        `[EXULU] Entity extraction batch failed for context ${context.id} (continuing):`,
        (err as Error).message,
      );
      // Continue with other batches; partial extraction is acceptable.
    }
  }

  return mentions;
};
