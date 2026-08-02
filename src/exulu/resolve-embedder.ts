import type { User } from "@EXULU_TYPES/models/user";
import type { Project } from "@EXULU_TYPES/models/project";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor";
import { provisionDefaultUserBudget } from "./litellm/budget-service";
import { buildTags } from "./tags";
import { getEmbeddingModelInfo } from "./litellm/parse-embedding-models";
import { resolveLiteLLMTarget } from "./litellm/env";

/**
 * resolveEmbedder — the embedding-side counterpart of resolveModel.
 *
 * Unlike resolveModel, this is LiteLLM-ONLY: embeddings always go through the
 * spawned LiteLLM proxy's OpenAI-compatible `/v1/embeddings` endpoint. There is
 * no in-code provider/catalog fallback — a context just names a LiteLLM
 * `model` and it works, with cost attribution via tags (including the context
 * itself, so RAG spend is attributable per context — see buildTags()).
 *
 * Vector dimensions, the default chunker's token budget, and the per-request
 * batch size are read from `config.litellm.yaml` → the embedding model's
 * `model_info` (see parse-embedding-models.ts).
 */

export type ResolveEmbedderInput = {
  /** LiteLLM model_name of the embedding model (e.g. "gemini-embedding-001"). */
  model: string;
  /** Context this embedding belongs to — emitted as context_id_/context_name_ tags. */
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

export type ResolvedEmbedder = {
  model: string;
  /** Vector dimensions — used to create the chunks table's vector(N) column. */
  dimensions: number;
  /** Target chunk size (tokens) for the built-in default chunker. */
  maxChunkSize: number;
  /** Max inputs per /v1/embeddings call. */
  maxBatchSize: number;
  /**
   * Embed one or more strings, returning one vector per input in order.
   * Batches inputs by maxBatchSize under the hood.
   */
  embed: (
    inputs: string[],
    opts?: { inputType?: "document" | "query" },
  ) => Promise<number[][]>;
};

export type ResolveEmbedderErrorCode =
  | "LITELLM_NOT_CONFIGURED"
  | "LITELLM_NOT_READY";

export class ResolveEmbedderError extends Error {
  constructor(public code: ResolveEmbedderErrorCode, message: string) {
    super(message);
    this.name = "ResolveEmbedderError";
  }
}

type EmbeddingApiResponse = {
  data?: { index?: number; embedding?: number[] }[];
};

export async function resolveEmbedder(
  input: ResolveEmbedderInput,
): Promise<ResolvedEmbedder> {
  const { model, contextId, contextName, user, userId, roleId, project, agent, routine } =
    input;

  if (!isLiteLLMEnabled()) {
    throw new ResolveEmbedderError(
      "LITELLM_NOT_CONFIGURED",
      "resolveEmbedder requires EXULU_USE_LITELLM=true — embeddings are served exclusively through the LiteLLM proxy.",
    );
  }

  try {
    await waitForLiteLLMReady();
  } catch (err) {
    throw new ResolveEmbedderError(
      "LITELLM_NOT_READY",
      `LiteLLM is not ready: ${(err as Error).message}`,
    );
  }

  const { baseUrl, authHeaders } = resolveLiteLLMTarget();

  // Lazily provision the global per-user budget tag if a default is configured.
  // Swallows its own errors; never blocks resolution.
  const resolvedUserId = user?.id ?? userId;
  if (resolvedUserId) await provisionDefaultUserBudget(resolvedUserId);

  // Dimensions / chunk size / batch size from config.litellm.yaml model_info.
  // Throws a fail-fast, actionable error if the model is undeclared.
  const { dimensionality, maxChunkSize, maxBatchSize } = getEmbeddingModelInfo(model);

  // Identity + context tags for LiteLLM cost attribution. Context is the key
  // new dimension; user/role/project/agent/routine are added when available.
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

  const endpoint = `${baseUrl}/v1/embeddings`;

  const embedBatch = async (batch: string[]): Promise<number[][]> => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: batch,
        encoding_format: "float",
        // Pin the output size to the configured column dimensions. LiteLLM's
        // `drop_params: true` silently drops this for providers that don't
        // support it; for those, a dimensionality mismatch surfaces as an
        // insert error (the correct fail-fast).
        dimensions: dimensionality,
        // LiteLLM reads metadata.tags for tag-based spend tracking — same
        // mechanism createTaggedFetch uses for chat completions.
        metadata: { tags },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `[EXULU] LiteLLM /v1/embeddings returned ${res.status} for model "${model}": ${text}`,
      );
    }

    const json = (await res.json()) as EmbeddingApiResponse;
    const data = json.data ?? [];
    // Order by `index` so results line up with `batch` regardless of how the
    // proxy ordered them.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((d) => d.embedding ?? []);
    if (vectors.length !== batch.length) {
      throw new Error(
        `[EXULU] LiteLLM /v1/embeddings returned ${vectors.length} vectors for ${batch.length} inputs (model "${model}").`,
      );
    }
    return vectors;
  };

  const embed: ResolvedEmbedder["embed"] = async (inputs) => {
    // TODO(input_type): map opts.inputType → provider-specific document/query
    // hint (Cohere input_type, Vertex/Gemini task_type, NVIDIA input_type) for
    // better retrieval. Currently a no-op so behavior is identical across
    // providers; this is the single place to wire it.
    if (inputs.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += maxBatchSize) {
      const batch = inputs.slice(i, i + maxBatchSize);
      const vectors = await embedBatch(batch);
      out.push(...vectors);
    }
    return out;
  };

  return {
    model,
    dimensions: dimensionality,
    maxChunkSize,
    maxBatchSize,
    embed,
  };
}
