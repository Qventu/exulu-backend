import type { User } from "@EXULU_TYPES/models/user";
import type { Project } from "@EXULU_TYPES/models/project";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor";
import { provisionDefaultUserBudget } from "./litellm/budget-service";
import { buildTags } from "./tags";

/**
 * resolveOcr — the OCR-side counterpart of resolveEmbedder.
 *
 * Like resolveEmbedder, this is LiteLLM-ONLY: OCR always goes through the
 * spawned LiteLLM proxy's Mistral-compatible `/v1/ocr` endpoint. There is no
 * in-code provider/SDK fallback — a caller just names a LiteLLM `model` (e.g.
 * "mistral-ocr", "vertex-ocr") and it works, with cost attribution via tags
 * (user/role/project/agent/routine/context, when provided — see buildTags()).
 *
 * Routing OCR through the proxy means we can cost-control it through the same
 * tag-based budgets as chat and embeddings, and switch the underlying provider
 * (mistral / azure_ai / vertex_ai) by editing config.litellm.yaml without
 * touching this code.
 *
 * LiteLLM follows the Mistral OCR request/response shape:
 *   https://docs.mistral.ai/capabilities/vision/#optical-character-recognition-ocr
 */

export type ResolveOcrInput = {
  /** LiteLLM model_name of the OCR model (e.g. "mistral-ocr"). */
  model: string;
  /** Context this OCR belongs to — emitted as context_id_/context_name_ tags. */
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

/**
 * Document descriptor passed to the OCR endpoint. Mirrors Mistral's
 * `document` field — a public/remote URL or a base64 `data:` URI.
 */
export type OcrDocument =
  | { type: "document_url"; document_url: string }
  | { type: "image_url"; image_url: string };

export type OcrOptions = {
  /** Only process specific (0-indexed) pages. */
  pages?: number[];
  /** Include extracted images as base64 strings in the response. */
  includeImageBase64?: boolean;
  /** Max number of images to return. */
  imageLimit?: number;
  /** Min size (pixels) for images to include. */
  imageMinSize?: number;
};

export type OcrPage = {
  index: number;
  markdown: string;
  dimensions?: { dpi?: number; height?: number; width?: number };
  images?: {
    image_base64?: string;
    bbox?: { x: number; y: number; width: number; height: number };
  }[];
};

export type OcrResponse = {
  pages: OcrPage[];
  model?: string;
  usage_info?: { pages_processed?: number; doc_size_bytes?: number };
};

export type ResolvedOcr = {
  model: string;
  /**
   * Run OCR over a single document, returning the parsed pages in order.
   */
  ocr: (document: OcrDocument, opts?: OcrOptions) => Promise<OcrResponse>;
};

export type ResolveOcrErrorCode =
  | "LITELLM_NOT_CONFIGURED"
  | "LITELLM_NOT_READY";

export class ResolveOcrError extends Error {
  constructor(public code: ResolveOcrErrorCode, message: string) {
    super(message);
    this.name = "ResolveOcrError";
  }
}

export async function resolveOcr(input: ResolveOcrInput): Promise<ResolvedOcr> {
  const { model, contextId, contextName, user, userId, roleId, project, agent, routine } =
    input;

  if (!isLiteLLMEnabled()) {
    throw new ResolveOcrError(
      "LITELLM_NOT_CONFIGURED",
      "resolveOcr requires EXULU_USE_LITELLM=true — OCR is served exclusively through the LiteLLM proxy.",
    );
  }

  try {
    await waitForLiteLLMReady();
  } catch (err) {
    throw new ResolveOcrError(
      "LITELLM_NOT_READY",
      `LiteLLM is not ready: ${(err as Error).message}`,
    );
  }

  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
  if (!masterKey) {
    throw new ResolveOcrError(
      "LITELLM_NOT_CONFIGURED",
      "LITELLM_MASTER_KEY is required when EXULU_USE_LITELLM=true",
    );
  }

  // Lazily provision the global per-user budget tag if a default is configured.
  // Swallows its own errors; never blocks resolution.
  const resolvedUserId = user?.id ?? userId;
  if (resolvedUserId) await provisionDefaultUserBudget(resolvedUserId);

  // Identity + context tags for LiteLLM cost attribution. Currently the
  // document processor doesn't yet thread attribution through, so `tags` is
  // typically empty — but the wiring is in place so cost-control by user /
  // context / project works the moment callers start passing it.
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

  const endpoint = `http://${host}:${port}/v1/ocr`;

  const ocr: ResolvedOcr["ocr"] = async (document, opts) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        document,
        // Mistral OCR optional params — only sent when provided.
        ...(opts?.pages ? { pages: opts.pages } : {}),
        ...(opts?.includeImageBase64 !== undefined
          ? { include_image_base64: opts.includeImageBase64 }
          : {}),
        ...(opts?.imageLimit !== undefined ? { image_limit: opts.imageLimit } : {}),
        ...(opts?.imageMinSize !== undefined
          ? { image_min_size: opts.imageMinSize }
          : {}),
        // LiteLLM reads metadata.tags for tag-based spend tracking — same
        // mechanism createTaggedFetch / resolveEmbedder use.
        metadata: { tags },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `[EXULU] LiteLLM /v1/ocr returned ${res.status} for model "${model}": ${text}`,
      );
    }

    const json = (await res.json()) as OcrResponse;
    if (!Array.isArray(json.pages)) {
      throw new Error(
        `[EXULU] LiteLLM /v1/ocr returned no pages for model "${model}".`,
      );
    }
    return json;
  };

  return { model, ocr };
}
