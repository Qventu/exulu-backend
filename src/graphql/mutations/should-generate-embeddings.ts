export type CalculateVectors = "manual" | "onUpdate" | "onInsert" | "always";

/**
 * Whether a GraphQL item mutation should regenerate embeddings.
 *
 * The override is tri-state and deliberately allows suppression: `false` means
 * "do not embed" even when the context config says to, which is what lets a
 * caller save a draft without paying to re-embed it. `undefined` means the
 * caller expressed no preference and the context config decides.
 *
 * The operation split matters: postprocessUpdate serves both create and update
 * and used to check only `onUpdate`/`always`, so an `onInsert` context never
 * embedded anything created through the API.
 */
export const shouldGenerateEmbeddings = ({
  calculateVectors,
  operation,
  override,
}: {
  calculateVectors: CalculateVectors | undefined;
  operation: "create" | "update";
  override: boolean | undefined;
}): boolean => {
  if (override !== undefined) return override;
  if (calculateVectors === "always") return true;
  return operation === "create"
    ? calculateVectors === "onInsert"
    : calculateVectors === "onUpdate";
};
