import { ExuluTool } from "@SRC/exulu/tool";
import { isLiteLLMEnabled } from "@SRC/exulu/litellm/supervisor.ts";
import {
  parseImageGenerationModels,
  type ImageGenerationModel,
} from "@SRC/exulu/litellm/parse-image-models.ts";
import { postgresClient } from "@SRC/postgres/client.ts";
import { RBACResolver } from "@EE/rbac-resolver.ts";
import { checkRecordAccess } from "@SRC/utils/check-record-access.ts";
import { z } from "zod";

/**
 * Cached list of image-generation models discovered from config.litellm.yaml
 * at boot. parseImageGenerationModels validates the YAML and throws on
 * misconfiguration — by the time the tool's execute runs, this list is
 * trusted to be well-formed and non-empty. We freeze it once so every
 * widget invocation sees the same configuration without re-reading the
 * file (LiteLLM never reloads model_list without a restart anyway).
 */
let _cachedImageModels: ImageGenerationModel[] | undefined;
export const setCachedImageModels = (models: ImageGenerationModel[]): void => {
  _cachedImageModels = models;
};

const buildDefaults = (models: ImageGenerationModel[]) => {
  // ExuluApp.create() only registers the widget tool when models.length >
  // 0, so models[0] is always defined at this point — guard anyway so this
  // helper is safe to use elsewhere in the future.
  const m = models[0];
  if (!m) {
    return { model: "", size: "1024x1024", quality: "auto", n: 1 };
  }
  return {
    model: m.model_name,
    size: m.sizes.includes("1024x1024") ? "1024x1024" : m.sizes[0]!,
    quality: m.qualities.includes("auto") ? "auto" : m.qualities[0]!,
    n: 1,
  };
};

type StyleOption = {
  id: string;
  name: string;
  description: string | null;
  owner: "user" | "shared";
};

/**
 * Load every saved image-generation style the calling user has read access
 * to. Styles live in platform_configurations under the prefixed key
 * `image_generation_style:<slug>` (the unique constraint is preserved; only
 * the prefix groups them logically). RBAC is enforced row by row via the
 * existing RBACResolver + checkRecordAccess helpers — same path agents and
 * other configuration consumers go through.
 */
const loadAvailableStyles = async (user: any): Promise<StyleOption[]> => {
  if (!user?.id) return [];
  const { db } = await postgresClient();

  const rows: any[] = await db
    .from("platform_configurations")
    .where("config_key", "like", "image_generation_style:%")
    .select("*");

  const visible: StyleOption[] = [];
  for (const row of rows) {
    const rbac = await RBACResolver(
      db,
      "platform_configurations",
      row.id,
      row.rights_mode || "private",
    );
    const hasAccess = await checkRecordAccess(
      { ...row, RBAC: rbac },
      "read",
      user,
    );
    if (!hasAccess) continue;

    const value = typeof row.config_value === "string"
      ? safeJsonParse(row.config_value)
      : row.config_value;

    visible.push({
      id: row.id,
      name: value?.name ?? row.config_key.replace(/^image_generation_style:/, ""),
      description: row.description ?? null,
      owner: String(row.created_by) === String(user.id) ? "user" : "shared",
    });
  }
  return visible;
};

const safeJsonParse = (s: string): any => {
  try { return JSON.parse(s); } catch { return null; }
};

/**
 * Build the unified `image_generation` tool. The tool itself does NOT call
 * LiteLLM — its only job is to gather configuration (available models,
 * available styles, the agent's prompt, defaults) and hand it to the
 * frontend widget, which then drives /images/generate, /images/edit and
 * /images/select directly.
 *
 * `needsApproval: false` so the widget opens immediately when the agent
 * invokes the tool — no confirmation chip in front of the user-facing UI.
 */
export const createImageGenerationWidgetTool = (
  models: ImageGenerationModel[],
): ExuluTool => {
  setCachedImageModels(models);

  return new ExuluTool({
    id: "image_generation",
    name: "image_generation",
    description:
      "Open an in-chat image generation widget pre-filled with your prompt. " +
      "The user picks the model, size, quality and count, optionally attaches " +
      "reference images for editing, applies a saved style, generates one or " +
      "more candidates, and selects the final image(s) to share back into the " +
      "conversation. Use this whenever the user asks to create or edit an image.",
    needsApproval: false,
    type: "function",
    config: [],
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          "Initial image prompt. The user can edit it before generating.",
        ),
    }),
    execute: async (
      { prompt, user, sessionID }: any,
      options: any,
    ) => {
      if (!isLiteLLMEnabled()) {
        throw new Error(
          "Image generation is not enabled on this deployment (EXULU_USE_LITELLM is not 'true').",
        );
      }
      if (!_cachedImageModels || _cachedImageModels.length === 0) {
        throw new Error(
          "No image-generation models are registered in config.litellm.yaml.",
        );
      }

      const toolCallId = options?.toolCallId;
      const styles = await loadAvailableStyles(user);

      return {
        result: JSON.stringify({
          type: "image_generation_widget",
          toolCallId,
          sessionId: sessionID,
          initialPrompt: prompt,
          models: _cachedImageModels.map((m) => ({
            name: m.model_name,
            sizes: m.sizes,
            qualities: m.qualities,
            supportsEdit: m.supports_edit,
            maxN: m.max_n,
          })),
          styles,
          defaults: buildDefaults(_cachedImageModels),
        }),
      };
    },
  });
};
