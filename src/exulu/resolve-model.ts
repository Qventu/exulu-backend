import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ExuluTeam, User, UserRole } from "@EXULU_TYPES/models/user";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor";
import { buildTags, createTaggedFetch } from "./tags";
import { provisionDefaultUserBudget } from "./litellm/budget-service";
import type { Project } from "@EXULU_TYPES/models/project";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";
import { resolveLiteLLMTarget } from "./litellm/env";

export type ModelRow = {
  id: string;
  name: string;
  description?: string;
  provider: string;
  authvariable?: string;
  active: boolean;
  rights_mode: string;
  created_by: string;
  requests_per_window?: number;
  window_seconds?: number;
  token_budget?: number;
  cost_budget_usd?: number;
  budget_window?: string;
};

export type ResolvedModel = {
  languageModel: LanguageModel;
  model: ModelRow;
};

export type ResolveModelInput = {
  modelId: string;
  user?: User;
  agent?: ExuluAgent;
  project?: Project;
  /**
   * Set when the LLM call originates from a workflow_template run (one-shot or
   * cron). Threaded through to buildTags() as routine_id_/routine_name_ so
   * /analytics and /admin/budgets can attribute spend per routine. Independent
   * of `agent` — both tags are emitted side-by-side, matching the dedupe
   * invariant that user_id_<X> is always present.
   */
  routine?: { id: string; name: string };
  rbacRequest?: "read" | "write";
  rbacBypass?: boolean;
};

export type ResolveModelErrorCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_INACTIVE"
  | "MODEL_FORBIDDEN"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_NO_MODEL"
  | "AUTH_VAR_NOT_FOUND"
  | "AUTH_VAR_NOT_ENCRYPTED"
  | "LITELLM_NOT_CONFIGURED"
  | "LITELLM_NOT_READY";

export class ResolveModelError extends Error {
  constructor(public code: ResolveModelErrorCode, message: string) {
    super(message);
    this.name = "ResolveModelError";
  }
}

/**
 * Build an OpenAI-compatible provider pointing at the spawned LiteLLM proxy.
 *
 * IMPORTANT: this MUST be built per request, never memoized. The provider's
 * `fetch` wrapper closes over the caller's identity `tags` (user/role/project/
 * agent/team) and stamps them onto every outgoing request. A module-level
 * singleton would bake in the first caller's tags and reuse them for every
 * subsequent user in the process — a cross-user identity leak that also routes
 * LiteLLM access-control and budget decisions to the wrong user.
 * `createOpenAICompatible` is a cheap object construction, so building it on
 * each call has negligible cost.
 */
export const getLiteLLMProvider = ({
  user,
  role,
  project,
  agent,
  team,
  routine,
}: {
  user?: User;
  role?: UserRole;
  project?: Project;
  agent?: ExuluAgent;
  team?: ExuluTeam;
  routine?: { id: string; name: string };
}) => {
  const { baseUrl, authHeaders } = resolveLiteLLMTarget();
  const tags = buildTags({
    user_id: user?.id,
    role_id: role?.id,
    project_id: project?.id,
    agent_id: agent?.id,
    user_name: !user ? undefined : user.type === "api" ? (user.firstname ?? user.email) : user.email,
    role_name: role?.name,
    project_name: project?.name,
    agent_name: agent?.name,
    team_id: team?.id,
    team_name: team?.name,
    routine_id: routine?.id,
    routine_name: routine?.name,
  });
  return createOpenAICompatible({
    name: "litellm",
    baseURL: `${baseUrl}/v1`,
    // createOpenAICompatible requires a non-empty apiKey; real auth for remote mode is the
    // exulu-api-key header (added via `headers`). The passthrough strips/ignores Authorization.
    apiKey: process.env.LITELLM_MASTER_KEY ?? process.env.EXULU_API_KEY ?? "x",
    headers: authHeaders,
    fetch: createTaggedFetch(tags),
    // Without this flag the openai-compatible provider strips any
    // responseFormat.schema before sending and warns
    // "JSON response format schema is only supported with structuredOutputs".
    // Models then return free-form JSON that fails Zod parsing in callers
    // using `Output.object({ schema })`. LiteLLM forwards
    // `response_format: { type: "json_schema", ... }` to every upstream it
    // supports — including Vertex Gemini, which translates it into
    // responseSchema/responseMimeType — so enabling this matches the actual
    // proxy contract.
    supportsStructuredOutputs: true,
    // Request token usage on STREAMED responses. Without this the openai-compatible
    // provider omits `stream_options: { include_usage: true }`, so LiteLLM returns no
    // usage for streaming calls — which zeroes out the per-request token metrics and
    // the message-footer token count (both read the AI SDK `totalUsage`/finish-part usage).
    includeUsage: true,
  });
};

/**
 * Test-only: no-op kept for backwards compatibility. The provider is no longer
 * memoized, so there is nothing to reset between cases.
 */
export const __resetLiteLLMProviderForTesting = () => {};

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {

  const { modelId, user, agent, project, routine } = input;

  if (!isLiteLLMEnabled()) {
    throw new Error("Litellm not configured or available.")
  }

  try {
    await waitForLiteLLMReady();
  } catch (err) {
    throw new ResolveModelError(
      "LITELLM_NOT_READY",
      `LiteLLM is not ready: ${(err as Error).message}`,
    );
  }

  // Lazily provision the global per-user budget tag if a default is configured.
  // Swallows its own errors; never blocks resolution.
  if (user?.id) await provisionDefaultUserBudget(user.id);

  const litellm = getLiteLLMProvider({
    user: user,
    role: user?.role,
    // Fall back to the caller's own project (set on API keys) when no
    // explicit request project is supplied, so API-triggered requests are
    // attributed to the key's project.
    project: project ?? user?.project,
    agent: agent,
    team: user?.team,
    routine: routine,
  });
  const languageModel = litellm(modelId);

  const syntheticModel: ModelRow = {
    id: modelId,
    name: modelId,
    provider: modelId,
    active: true,
    rights_mode: "public",
    created_by: "litellm",
  };

  return {
    languageModel,
    model: syntheticModel
  };

}
