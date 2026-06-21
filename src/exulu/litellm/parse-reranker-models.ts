import { existsSync, readFileSync } from "node:fs";
import { resolveLiteLLMConfigPath } from "./parse-embedding-models";

/**
 * Discover reranker models declared in config.litellm.yaml — without pulling in
 * a full YAML parser dependency. Mirrors the approach in
 * parse-embedding-models.ts (same comment-aware, line-based scan of LiteLLM's
 * documented `model_list:` schema).
 *
 * A model is treated as a reranker iff its `model_info.type` is `reranker`.
 * That is the only required `model_info` key; everything else is optional:
 *   - `top_n`        → optional. Default page size hint forwarded to the proxy.
 *   - `description`  → optional. Admin-facing label text for the reranker
 *                      dropdown (falls back to the model_name).
 *
 * Example entry:
 *   - model_name: rerank-v4.0-pro
 *     litellm_params:
 *       model: cohere/rerank-v4.0-pro
 *       api_key: os.environ/COHERE_API_KEY
 *     model_info:
 *       type: reranker
 *       top_n: 20
 *       description: "Cohere rerank v4 (pro)"
 *
 * Comment-aware: lines whose first non-whitespace character is `#`, and the
 * trailing `# ...` portion of any other line, are stripped. Commented-out
 * model blocks are therefore skipped naturally.
 */

export type RerankerModelInfo = {
  model_name: string;
  topN?: number;
  description?: string;
};

type RawEntry = {
  model_name?: string;
  type?: string;
  top_n?: number;
  description?: string;
  indent: number;
};

const stripComment = (line: string): string => {
  const idx = line.indexOf("#");
  return idx >= 0 ? line.slice(0, idx) : line;
};

const parseInt10 = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return Number.isInteger(n) ? n : undefined;
};

const unquote = (raw: string): string =>
  raw.trim().replace(/^["']/, "").replace(/["']$/, "");

/**
 * Parse every reranker model entry (those carrying `model_info.type: reranker`)
 * from config.litellm.yaml.
 */
export const parseRerankerModels = (configPath: string): RerankerModelInfo[] => {
  if (!existsSync(configPath)) return [];
  const text = readFileSync(configPath, "utf8");
  const lines = text.split("\n");

  const entries: RawEntry[] = [];
  let current: RawEntry | undefined;

  for (const rawLine of lines) {
    const noComment = stripComment(rawLine);
    if (!noComment.trim()) continue;

    const indent = (rawLine.match(/^\s*/)?.[0] ?? "").length;

    // Start of a new model entry ("- model_name: ...").
    const modelNameMatch = noComment.match(
      /^\s*-\s*model_name\s*:\s*["']?([^"'\s#]+)["']?\s*$/,
    );
    if (modelNameMatch) {
      if (current) entries.push(current);
      current = { model_name: modelNameMatch[1], indent };
      continue;
    }

    if (!current) continue;

    // Once we encounter a line at or shallower than the current entry's `- `
    // marker (and that isn't a comment / blank), the entry's block is over.
    if (indent <= current.indent && !/^\s*-\s/.test(rawLine)) {
      entries.push(current);
      current = undefined;
      continue;
    }

    const kvMatch = noComment.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (!kvMatch) continue;
    const key = kvMatch[1] ?? "";
    const rawValue = kvMatch[2] ?? "";

    switch (key) {
      case "type": {
        current.type = unquote(rawValue);
        break;
      }
      case "top_n": {
        current.top_n = parseInt10(rawValue);
        break;
      }
      case "description": {
        current.description = unquote(rawValue);
        break;
      }
    }
  }
  if (current) entries.push(current);

  return entries
    .filter((e) => e.type === "reranker")
    .map((e) => ({
      model_name: e.model_name!,
      topN: typeof e.top_n === "number" && e.top_n > 0 ? e.top_n : undefined,
      description: e.description,
    }));
};

/**
 * Look up a single reranker model's info by its LiteLLM `model_name` (the
 * string an agentic-retrieval tool stores in `toolVariablesConfig.reranker`).
 * Throws a fail-fast, actionable error if the model isn't declared in
 * config.litellm.yaml or isn't a reranker — same philosophy as
 * parse-embedding-models.ts.
 */
export const getRerankerModelInfo = (
  modelName: string,
  configPath: string = resolveLiteLLMConfigPath(),
): RerankerModelInfo => {
  const models = parseRerankerModels(configPath);
  const found = models.find((m) => m.model_name === modelName);
  if (!found) {
    throw new Error(
      `[EXULU] Reranker model "${modelName}" was not found in ${configPath}, or its ` +
        `entry is missing \`model_info.type: reranker\`. Add it, e.g.:\n` +
        `  - model_name: ${modelName}\n` +
        `    litellm_params:\n` +
        `      model: <provider>/${modelName}\n` +
        `    model_info:\n` +
        `      type: reranker      # required\n` +
        `      top_n: 20           # optional\n` +
        `      description: "..."  # optional`,
    );
  }
  return found;
};
