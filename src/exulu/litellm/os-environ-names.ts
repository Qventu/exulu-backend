import { existsSync, readFileSync } from "node:fs";
import { resolveLiteLLMConfigPath } from "./parse-embedding-models";
import { ENV_CLASSIFICATION } from "@SRC/exulu/skill-env/inventory";

/**
 * LiteLLM references provider credentials from config.litellm.yaml with its
 * `os.environ/NAME` interpolation directive:
 *
 *   litellm_settings:
 *     master_key: os.environ/LITELLM_MASTER_KEY
 *   model_list:
 *     - model_name: claude-sonnet-4
 *       litellm_params:
 *         api_key: os.environ/ANTHROPIC_API_KEY
 *         vertex_credentials: os.environ/VERTEX_CREDENTIALS_PATH
 *
 * That set is open-ended by design: an operator adds a provider by naming a new
 * environment variable in their own config, which no inventory in this
 * repository can enumerate ahead of time. Parsing the resolved config closes
 * the class structurally instead of by enumeration.
 *
 * None of these names are document-toolchain runtime variables (PYMUPDF_*,
 * HF_HUB_*, LANG, fontconfig, CA bundles), so the allowlist objection from the
 * design does not apply here — this stays a denylist, just one sourced from the
 * deployment's own config rather than from a static list.
 *
 * `db-setup-check.ts` already dereferences this prefix for `database_url`; this
 * module generalises the same parse.
 */
const OS_ENVIRON_DIRECTIVE = /os\.environ\/([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Extract every `os.environ/NAME` name from LiteLLM config YAML text.
 *
 * Comments are scanned too, on purpose: a commented-out provider block is
 * exactly the case where the operator still has the credential exported in the
 * container environment. The one risk that buys is a doc comment naming a
 * runtime variable, so anything the inventory classifies `runtime` is dropped —
 * `os.environ/PATH` in a comment must never cost a skill its PATH.
 */
export const parseOsEnvironNames = (yamlText: string): string[] => {
  const found = new Set<string>();
  for (const match of yamlText.matchAll(OS_ENVIRON_DIRECTIVE)) {
    const name = match[1];
    if (!name) continue;
    if (ENV_CLASSIFICATION[name] === "runtime") continue;
    found.add(name);
  }
  return [...found].sort();
};

/**
 * Best-effort, non-fatal. A skill sandbox must not fail to build because the
 * LiteLLM config is missing, unreadable or malformed — on any such outcome we
 * log once and fall back to the static inventory alone.
 */
export const readLiteLLMOsEnvironNames = (
  configPath: string = resolveLiteLLMConfigPath(),
): string[] => {
  try {
    if (!existsSync(configPath)) return [];
    return parseOsEnvironNames(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.warn(
      `[SKILLS] Could not read LiteLLM config at ${configPath} to collect os.environ/ credential names; the skill environment falls back to the static secret inventory.`,
      err,
    );
    return [];
  }
};
