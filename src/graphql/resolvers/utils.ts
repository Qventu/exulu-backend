import type { ExuluContext } from "src/exulu/context";
import type { ExuluConfig } from "src/exulu/app";
import type { Item } from "@EXULU_TYPES/models/item";

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

    return fields.filter((field) => field !== "pageInfo" && field !== "items" && field !== "RBAC");
  }
  if (itemsSelection) {
    fields = Object.keys(
      itemsSelection.selectionSet.selections.reduce((acc, field) => {
        acc[field.name.value] = true;
        return acc;
      }, {}),
    );

    return fields.filter((field) => field !== "pageInfo" && field !== "items" && field !== "RBAC");
  }

  fields = Object.keys(
    selections.reduce((acc, field) => {
      acc[field.name.value] = true;
      return acc;
    }, {}),
  );

  return fields.filter((field) => field !== "pageInfo" && field !== "items" && field !== "RBAC");

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
