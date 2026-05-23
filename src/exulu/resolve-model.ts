import type { LanguageModel } from "ai";
import CryptoJS from "crypto-js";
import { postgresClient } from "@SRC/postgres/client";
import { checkRecordAccess } from "@SRC/utils/check-record-access";
import type { User } from "@EXULU_TYPES/models/user";
import type { ExuluProvider } from "./provider";

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
  agent?: { id: string };
  project?: { id: string };
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
  | "AUTH_VAR_NOT_ENCRYPTED";

export class ResolveModelError extends Error {
  constructor(public code: ResolveModelErrorCode, message: string) {
    super(message);
    this.name = "ResolveModelError";
  }
}

export async function resolveModel(input: ResolveModelInput): Promise<ResolvedModel> {
  const { modelId, user, providers, agent, project, rbacBypass } = input;
  const rbacRequest = input.rbacRequest ?? "read";

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
