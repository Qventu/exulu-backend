import type { ExuluContext } from "./context";

/**
 * Context field definitions in the shape addMissingFields expects, with file
 * fields renamed to <name>_s3key.
 *
 * createItemsTable applies that suffix when it creates the table
 * (context.ts:1233) but addMissingFields does not, so feeding it raw context
 * fields would add a second, wrongly-named column for every file field.
 * addMissingFields sanitizes the name itself, so no sanitizing here.
 */
export const contextFieldsForSync = (
  context: Pick<ExuluContext, "fields">,
): { name: string; type: string; default?: unknown; unique?: boolean }[] =>
  (context.fields ?? [])
    .filter((field) => !!field?.name && !!field?.type)
    .map((field) => ({
      ...field,
      name: field.type === "file" ? `${field.name}_s3key` : field.name,
    })) as { name: string; type: string; default?: unknown; unique?: boolean }[];
