import type { LanguageModel } from "ai";
import CryptoJS from "crypto-js";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { postgresClient } from "@SRC/postgres/client";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import type { ExuluTeam, User, UserRole } from "@EXULU_TYPES/models/user";
import type { ExuluProvider } from "./provider";
import { isLiteLLMEnabled, waitForLiteLLMReady } from "./litellm/supervisor";
import { buildTags, createTaggedFetch } from "./tags";
import { provisionDefaultUserBudget } from "./litellm/budget-service";
import type { Role } from "@mistralai/mistralai/models/components";
import type { Project } from "@EXULU_TYPES/models/project";
import type { ExuluAgent } from "@EXULU_TYPES/models/agent";

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
  exuluProvider: ExuluProvider;
  apiKey: string | undefined;
};

export type ResolveModelInput = {
  modelId: string;
  user?: User;
  providers: ExuluProvider[];
  agent?: ExuluAgent;
  project?: Project;
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

/**
 * Sentinel returned in place of ExuluProvider when LiteLLM mode is on.
 * Reading any property other than `id` throws — call sites that try to access
 * provider.capabilities / .workflows / etc. fail loudly rather than silently
 * returning undefined. Code paths that need ExuluProvider metadata MUST check
 * isLiteLLMEnabled() first and degrade.
 */
export const LITELLM_PROVIDER_SENTINEL: ExuluProvider = new Proxy(
  {} as ExuluProvider,
  {
    get(_target, prop) {
      if (prop === "id") return "litellm";
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "[LiteLLMProviderSentinel]";
      }
      // log stack trace
      console.error(`ExuluProvider.${String(prop)} is not available in LiteLLM mode. `, new Error().stack);
      throw new Error(
        `ExuluProvider.${String(prop)} is not available in LiteLLM mode. ` +
          `Code paths that depend on the in-code provider catalog must check ` +
          `isLiteLLMEnabled() and degrade.`,
      );
    },
  },
);

export class ResolveModelError extends Error {
  constructor(public code: ResolveModelErrorCode, message: string) {
    super(message);
    this.name = "ResolveModelError";
  }
}

/**
 * Memoized OpenAI-compatible provider pointing at the spawned LiteLLM proxy.
 * Built once on first use in LiteLLM mode.
 */
let _litellmProvider: ReturnType<typeof createOpenAICompatible> | undefined;
const getLiteLLMProvider = ({
  user,
  role,
  project,
  agent,
  team
}: {
  user?: User;
  role?: UserRole;
  project?: Project;
  agent?: ExuluAgent;
  team?: ExuluTeam;
}) => {
  if (_litellmProvider) return _litellmProvider;
  const host = process.env.LITELLM_HOST ?? "127.0.0.1";
  const port = process.env.LITELLM_PORT ?? "4000";
  const masterKey = process.env.LITELLM_MASTER_KEY;
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
  });
  if (!masterKey) {
    throw new ResolveModelError(
      "LITELLM_NOT_CONFIGURED",
      "LITELLM_MASTER_KEY is required when EXULU_USE_LITELLM=true",
    );
  }
  _litellmProvider = createOpenAICompatible({
    name: "litellm",
    baseURL: `http://${host}:${port}/v1`,
    apiKey: masterKey,
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
  });
  return _litellmProvider;
};

/**
 * Test-only: reset the memoized provider so tests can rebuild it with
 * different env vars between cases.
 */
export const __resetLiteLLMProviderForTesting = () => {
  _litellmProvider = undefined;
};

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {
  const { modelId, user, providers, agent, project, rbacBypass } = input;
  const rbacRequest = input.rbacRequest ?? "read";

  // ─────────── LiteLLM branch ───────────
  // When LiteLLM mode is on, bypass the DB + ExuluProvider lookup entirely.
  // modelId is treated as the LiteLLM model_name string (e.g., "vertex-flash").
  // RBAC at the model level is delegated to LiteLLM's own auth (virtual keys);
  // agent-level RBAC still applies higher up via checkRecordAccess(agent, ...).
  if (isLiteLLMEnabled()) {
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
      project: project,
      agent: agent,
      team: user?.team,
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
      model: syntheticModel,
      exuluProvider: LITELLM_PROVIDER_SENTINEL,
      apiKey: undefined,
    };
  }

  // ─────────── Catalog branch (Spec A, unchanged) ───────────
  const { db } = await postgresClient();
  const model: ModelRow | undefined = await db.from("models").where({ id: modelId }).first();
  if (!model) {
    throw new ResolveModelError("MODEL_NOT_FOUND", `Model ${modelId} not found`);
  }
  if (!model.active) {
    throw new ResolveModelError("MODEL_INACTIVE", `Model ${model.name} is inactive`);
  }

  if (!rbacBypass) {
    const ok = await checkRecordAccess(model, rbacRequest, user);
    if (!ok) {
      throw new ResolveModelError(
        "MODEL_FORBIDDEN",
        `No ${rbacRequest} access to model ${model.name}`,
      );
    }
  }

  const exuluProvider = providers.find((p) => p.id === model.provider);
  if (!exuluProvider) {
    throw new ResolveModelError(
      "PROVIDER_NOT_FOUND",
      `ExuluProvider ${model.provider} (referenced by model ${model.name}) not registered in this instance`,
    );
  }
  if (!exuluProvider.config?.model?.create) {
    throw new ResolveModelError(
      "PROVIDER_NO_MODEL",
      `ExuluProvider ${exuluProvider.id} has no model.create()`,
    );
  }

  let apiKey: string | undefined;
  if (model.authvariable) {
    const variable = await db.from("variables").where({ name: model.authvariable }).first();
    if (!variable) {
      throw new ResolveModelError(
        "AUTH_VAR_NOT_FOUND",
        `Auth variable ${model.authvariable} (referenced by model ${model.name}) not found`,
      );
    }
    if (!variable.encrypted) {
      throw new ResolveModelError(
        "AUTH_VAR_NOT_ENCRYPTED",
        `Auth variable ${model.authvariable} must be encrypted`,
      );
    }
    const bytes = CryptoJS.AES.decrypt(variable.value, process.env.NEXTAUTH_SECRET!);
    apiKey = bytes.toString(CryptoJS.enc.Utf8);
  }

  const languageModel = exuluProvider.config.model.create({
    apiKey,
    user: user?.id,
    role: user?.role?.id,
    project: project?.id,
    agent: agent?.id,
  });

  return { languageModel, model, exuluProvider, apiKey };
}
