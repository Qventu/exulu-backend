import type { User } from "@EXULU_TYPES/models/user";
import type { Project } from "@EXULU_TYPES/models/project";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor";
import { provisionDefaultUserBudget } from "./litellm/budget-service";
import { buildTags } from "./tags";
import fs from "fs";

/**
 * resolveReranker — the rerank-side counterpart of resolveEmbedder / resolveOcr.
 *
 * Like those, this is LiteLLM-ONLY: reranking always goes through the spawned
 * LiteLLM proxy's cohere-compatible `/v1/rerank` endpoint. There is no in-code
 * provider/SDK fallback — a caller just names a LiteLLM `model` (a model_name
 * declared in config.litellm.yaml with `model_info.type: reranker`) and it
 * works, with cost attribution via tags (user/role/project/agent/routine/
 * context, when provided — see buildTags()).
 *
 * Routing rerank through the proxy means we cost-control it through the same
 * tag-based budgets as chat / embeddings / OCR, and switch the underlying
 * provider (cohere / vertex_ai / together_ai / ...) by editing
 * config.litellm.yaml without touching this code.
 *
 * `rerank` takes the chunks directly, builds each document as
 * `item_name + ": " + chunk_content` (the standard retrieval convention), calls
 * the proxy, and maps the relevance scores back onto the chunks (reordered,
 * `rerank_score` attached). The item type is constrained structurally
 * (item_name / chunk_content) so both ChunkResult and VectorSearchChunkResult
 * work without importing either — no src/exulu → retrieval/GraphQL dependency.
 *
 * LiteLLM follows the Cohere rerank request/response shape:
 *   https://docs.cohere.com/reference/rerank
 */

export type ResolveRerankerInput = {
  /** LiteLLM model_name of the reranker (e.g. "rerank-v4.0-pro"). */
  model: string;
  /** Context this rerank belongs to — emitted as context_id_/context_name_ tags. */
  contextId?: string;
  contextName?: string;
  user?: User;
  /** When only a numeric user id is available (background ingestion jobs). */
  userId?: number;
  roleId?: string;
  project?: Project;
  agent?: ExuluAgent;
  routine?: { id: string; name: string };
};

/** Minimal chunk shape rerank() needs to build a document. */
export type RerankableChunk = {
  item_name?: string;
  chunk_content?: string;
};

export type ResolvedReranker = {
  model: string;
  /**
   * Rerank `chunks` against `query`. Each document is built as
   * `item_name + ": " + chunk_content`. Returns the chunks reordered desc by
   * relevance with a `rerank_score` attached. No score cutoff is applied — the
   * caller decides how many to keep. `opts.topN` defaults to chunks.length
   * (score/reorder everything).
   */
  rerank: <T extends RerankableChunk>(
    query: string,
    chunks: T[],
    opts?: { topN?: number },
  ) => Promise<(T & { rerank_score: number })[]>;
};

export type ResolveRerankerErrorCode =
  | "LITELLM_NOT_CONFIGURED"
  | "LITELLM_NOT_READY";

export class ResolveRerankerError extends Error {
  constructor(public code: ResolveRerankerErrorCode, message: string) {
    super(message);
    this.name = "ResolveRerankerError";
  }
}

type RerankApiResponse = {
  results?: { index?: number; relevance_score?: number }[];
};

export async function resolveReranker(
  input: ResolveRerankerInput,
): Promise<ResolvedReranker> {
  const { model, contextId, contextName, user, userId, roleId, project, agent, routine } =
    input;

  if (!isLiteLLMEnabled()) {
    throw new ResolveRerankerError(
      "LITELLM_NOT_CONFIGURED",
      "resolveReranker requires EXULU_USE_LITELLM=true — reranking is served exclusively through the LiteLLM proxy.",
    );
  }

  try {
    await waitForLiteLLMReady();
  } catch (err) {
    throw new ResolveRerankerError(
      "LITELLM_NOT_READY",
      `LiteLLM is not ready: ${(err as Error).message}`,
    );
  }

  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    throw new ResolveRerankerError(
      "LITELLM_NOT_CONFIGURED",
      "LITELLM_MASTER_KEY is required when EXULU_USE_LITELLM=true",
    );
  }

  // Lazily provision the global per-user budget tag if a default is configured.
  // Swallows its own errors; never blocks resolution.
  const resolvedUserId = user?.id ?? userId;
  if (resolvedUserId) await provisionDefaultUserBudget(resolvedUserId);

  // Identity + context tags for LiteLLM cost attribution — same mechanism
  // createTaggedFetch / resolveEmbedder / resolveOcr use.
  const role = user?.role;
  const tags = buildTags({
    user_id: resolvedUserId,
    role_id: role?.id ?? roleId,
    project_id: (project ?? user?.project)?.id,
    agent_id: agent?.id,
    team_id: user?.team?.id,
    routine_id: routine?.id,
    context_id: contextId,
    user_name: !user
      ? undefined
      : user.type === "api"
        ? (user.firstname ?? user.email)
        : user.email,
    role_name: role?.name,
    project_name: (project ?? user?.project)?.name,
    agent_name: agent?.name,
    team_name: user?.team?.name,
    routine_name: routine?.name,
    context_name: contextName,
  });

  const endpoint = `http://${host}:${port}/v1/rerank`;

  const rerank: ResolvedReranker["rerank"] = async (query, chunks, opts) => {
    try {
    if (chunks.length === 0) return [];

    const documents = chunks.map(
      (c) => `${c.item_name ?? ""}: ${c.chunk_content ?? ""}`,
    );

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        // Default to scoring every document so callers can fully reorder; a
        // caller can pass a smaller topN as an optimization hint.
        top_n: opts?.topN ?? documents.length,
        // LiteLLM reads metadata.tags for tag-based spend tracking.
        metadata: { tags },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `[EXULU] LiteLLM /v1/rerank returned ${res.status} for model "${model}": ${text}`,
      );
    }

    const json = (await res.json()) as RerankApiResponse;
    if (!Array.isArray(json.results)) {
      throw new Error(
        `[EXULU] LiteLLM /v1/rerank returned no results for model "${model}".`,
      );
    }

    // Map each scored result back onto its chunk (proxy returns one result per
    // scored document), then order desc by relevance. Out-of-range indices are
    // skipped defensively.
    const reranked = json.results
      .filter(
        (r): r is { index: number; relevance_score?: number } =>
          typeof r.index === "number" && !!chunks[r.index],
      )
      .map((r) => ({
        ...chunks[r.index]!,
        rerank_score: r.relevance_score ?? 0,
      }));
    reranked.sort((a, b) => b.rerank_score - a.rerank_score);

    fs.writeFileSync("reranked.json", JSON.stringify(reranked, null, 2));
    return reranked;
    } catch (err) {
      console.error("[EXULU] Error reranking:", err);
      fs.writeFileSync("reranked.json", JSON.stringify(err, null, 2));
      return [];
    }
  };

  return { model, rerank };
}
