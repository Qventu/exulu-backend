import {
  resolveReranker,
  type ResolveRerankerInput,
  type RerankableChunk,
} from "./resolve-reranker";

/**
 * Public, package-facing reranker — the counterpart of
 * `ExuluDocumentProcessor.process`. A drop-in replacement for a hand-rolled
 * Cohere / Google reranker: pass `{ query, items, model }` and get the items
 * back reordered desc by relevance with a `rerank_score` attached.
 *
 * `model` is a LiteLLM model_name declared in config.litellm.yaml with
 * `model_info.type: reranker`, so the SAME call works against any supported
 * provider (cohere / vertex_ai / together_ai / ...) — switch providers in
 * config, not in code — and reranking is cost-attributed via the optional
 * identity/context fields (user / role / project / agent / routine / context).
 *
 * Each document is built as `item_name + ": " + chunk_content` (the standard
 * retrieval convention). Items are constrained structurally, so any chunk shape
 * carrying `item_name` / `chunk_content` works and the extra fields are
 * preserved on the returned objects.
 */
export type ExuluRerankInput<T extends RerankableChunk> = {
  query: string;
  items: T[];
  /** Only score/return the top N items (optional optimization hint). */
  topN?: number;
} & ResolveRerankerInput;

export async function rerank<T extends RerankableChunk>(
  input: ExuluRerankInput<T>,
): Promise<(T & { rerank_score: number })[]> {
  const { query, items, topN, ...resolveInput } = input;
  if (!items?.length) return [];

  const resolved = await resolveReranker(resolveInput);
  return resolved.rerank(query, items, { topN });
}
