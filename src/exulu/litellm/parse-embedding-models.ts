import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Discover embedding models declared in config.litellm.yaml and extract the
 * `model_info` fields Exulu needs to wire a context to a LiteLLM embedding
 * model — without pulling in a full YAML parser dependency. Mirrors the
 * approach in parse-image-models.ts (same comment-aware, line-based scan of
 * LiteLLM's documented `model_list:` schema).
 *
 * For an embedding model the relevant `model_info` keys are:
 *   - `dimensionality`  → REQUIRED. Used to create the chunks table's
 *                          `vector(N)` column. Must match the model's real
 *                          output size.
 *   - `max_chunk_size`  → optional. Target chunk size (chars) for the built-in
 *                          default chunker. Defaults to DEFAULT_MAX_CHUNK_SIZE.
 *   - `max_batch_size`  → optional. Max inputs per /v1/embeddings call.
 *                          Defaults to DEFAULT_MAX_BATCH_SIZE.
 *
 * Example entry:
 *   - model_name: gemini-embedding-001
 *     litellm_params:
 *       model: gemini/gemini-embedding-001
 *     model_info:
 *       dimensionality: 1024
 *       max_chunk_size: 1024
 *       max_batch_size: 250
 *
 * Comment-aware: lines whose first non-whitespace character is `#`, and the
 * trailing `# ...` portion of any other line, are stripped. Commented-out
 * model blocks are therefore skipped naturally.
 */

export type EmbeddingModelInfo = {
  model_name: string;
  dimensionality: number;
  maxChunkSize: number;
  maxBatchSize: number;
};

export const DEFAULT_MAX_CHUNK_SIZE = 1024;
export const DEFAULT_MAX_BATCH_SIZE = 100;

type RawEntry = {
  model_name?: string;
  dimensionality?: number;
  max_chunk_size?: number;
  max_batch_size?: number;
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

/**
 * Resolve the path to config.litellm.yaml the same way every other Exulu
 * consumer does (supervisor, app bootstrap, image-model parser).
 */
export const resolveLiteLLMConfigPath = (): string =>
  process.env.LITELLM_CONFIG_PATH ?? resolve(process.cwd(), "./config.litellm.yaml");

/**
 * Parse every embedding model entry (those carrying a numeric
 * `model_info.dimensionality`) from config.litellm.yaml.
 */
export const parseEmbeddingModels = (configPath: string): EmbeddingModelInfo[] => {
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
      case "dimensionality": {
        current.dimensionality = parseInt10(rawValue);
        break;
      }
      case "max_chunk_size": {
        current.max_chunk_size = parseInt10(rawValue);
        break;
      }
      case "max_batch_size": {
        current.max_batch_size = parseInt10(rawValue);
        break;
      }
    }
  }
  if (current) entries.push(current);

  return entries
    .filter((e) => typeof e.dimensionality === "number" && e.dimensionality! > 0)
    .map((e) => ({
      model_name: e.model_name!,
      dimensionality: e.dimensionality!,
      maxChunkSize:
        typeof e.max_chunk_size === "number" && e.max_chunk_size > 0
          ? e.max_chunk_size
          : DEFAULT_MAX_CHUNK_SIZE,
      maxBatchSize:
        typeof e.max_batch_size === "number" && e.max_batch_size > 0
          ? e.max_batch_size
          : DEFAULT_MAX_BATCH_SIZE,
    }));
};

/**
 * Look up a single embedding model's info by its LiteLLM `model_name` (the
 * string a context puts in `embedder.model`). Throws a fail-fast, actionable
 * error if the model isn't declared in config.litellm.yaml or is missing the
 * required `dimensionality` — same philosophy as parse-image-models.ts.
 */
export const getEmbeddingModelInfo = (
  modelName: string,
  configPath: string = resolveLiteLLMConfigPath(),
): EmbeddingModelInfo => {
  const models = parseEmbeddingModels(configPath);
  const found = models.find((m) => m.model_name === modelName);
  if (!found) {
    throw new Error(
      `[EXULU] Embedding model "${modelName}" was not found in ${configPath}, or its ` +
        `entry is missing a numeric \`model_info.dimensionality\`. Add it, e.g.:\n` +
        `  - model_name: ${modelName}\n` +
        `    litellm_params:\n` +
        `      model: <provider>/${modelName}\n` +
        `    model_info:\n` +
        `      dimensionality: 1024   # required (matches the model's output size)\n` +
        `      max_chunk_size: 1024   # optional\n` +
        `      max_batch_size: 100    # optional`,
    );
  }
  return found;
};
