import type { ExuluContext } from "@SRC/exulu/context";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { Item } from "@EXULU_TYPES/models/item";

// GraphQL composite/meta selections that are NOT database columns and must
// never reach the SQL SELECT. `__`-prefixed names are graphql-js meta-fields
// (__typename, __schema, __type) — an Apollo client with addTypename:true
// injects __typename into every selection set; graphql-js still resolves it
// in the response from the schema type, so stripping it here is safe.
const NON_COLUMN_SELECTIONS = new Set(["pageInfo", "items", "RBAC"]);
const isSelectableColumn = (field: string): boolean =>
  !NON_COLUMN_SELECTIONS.has(field) && !field.startsWith("__");

export const getRequestedFields = (info: any): string[] => {
  const selections = info.operation.selectionSet.selections[0].selectionSet.selections;
  const itemSelection = selections.find((s) => s.name.value === "item");
  const itemsSelection = selections.find((s) => s.name.value === "items");
  let fields: string[] = [];
  if (itemSelection) {
    fields = Object.keys(
      itemSelection.selectionSet.selections.reduce((acc, field) => {
        acc[field.name.value] = true;
        return acc;
      }, {}),
    );

    return fields.filter(isSelectableColumn);
  }
  if (itemsSelection) {
    fields = Object.keys(
      itemsSelection.selectionSet.selections.reduce((acc, field) => {
        acc[field.name.value] = true;
        return acc;
      }, {}),
    );

    return fields.filter(isSelectableColumn);
  }

  fields = Object.keys(
    selections.reduce((acc, field) => {
      acc[field.name.value] = true;
      return acc;
    }, {}),
  );

  return fields.filter(isSelectableColumn);

  // remove pageInfo and items
};

export const contextItemsProcessorHandler = async (
  context: ExuluContext,
  config: ExuluConfig,
  items: Item[],
  user?: number,
  role?: string,
): Promise<{
  message: string;
  results: string[];
  jobs: string[];
}> => {
  let jobs: string[] = [];
  let results: Item[] = [];
  await Promise.all(
    items.map(async (item): Promise<void> => {
      const result = await context.processField("api", item, config, user, role);
      if (result.job) {
        jobs.push(result.job);
      }
      if (result.result) {
        results.push(result.result);
      }
    }),
  );

  return {
    message: jobs.length > 0 ? "Processing job scheduled." : "Items processed successfully.",
    results: results.map((result) => JSON.stringify(result)),
    jobs: jobs,
  };
};
