import { existsSync, readFileSync } from "node:fs";

/**
 * Discover image-generation models declared in config.litellm.yaml and
 * extract their capability declarations without pulling in a full YAML
 * parser dependency. The file follows LiteLLM's documented `model_list:`
 * schema — a flat list of objects each with `model_name`, `litellm_params`,
 * and `model_info`.
 *
 * For each entry whose `model_info.type` is `image_generation` we also
 * require `sizes`, `qualities`, `supports_edit`, and `max_n` to be present
 * and well-formed; missing/invalid keys throw a single descriptive error
 * listing every offending model. ExuluApp.create() calls this at boot, so
 * misconfiguration fails the boot fast with one actionable message.
 *
 * Comment-aware: lines whose first non-whitespace character is `#`, and the
 * trailing `# ...` portion of any other line, are stripped. Commented-out
 * model blocks (every line within the block is `#`-prefixed) are therefore
 * skipped naturally.
 */

export type ImageGenerationModel = {
  model_name: string;
  sizes: string[];      // non-empty
  qualities: string[];  // non-empty
  supports_edit: boolean;
  max_n: number;        // integer ≥ 1
};

type RawEntry = {
  model_name?: string;
  type?: string;
  sizes?: unknown;
  qualities?: unknown;
  supports_edit?: unknown;
  max_n?: unknown;
  indent: number;
};

const stripComment = (line: string): string => {
  const idx = line.indexOf("#");
  return idx >= 0 ? line.slice(0, idx) : line;
};

const parseInlineArray = (raw: string): string[] | undefined => {
  // Match `["a", "b"]` / `['a', 'b']` / `[a, b]`. YAML supports flow-style
  // inline arrays which is the form we expect operators to use here.
  const m = raw.trim().match(/^\[(.*)\]$/);
  if (!m) return undefined;
  const inner = m[1] ?? "";
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
};

const parseBool = (raw: string): boolean | undefined => {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return undefined;
};

const parseInt10 = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return Number.isInteger(n) ? n : undefined;
};

export const parseImageGenerationModels = (
  configPath: string,
): ImageGenerationModel[] => {
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
        current.type = rawValue.replace(/^["']|["']$/g, "").trim();
        break;
      }
      case "sizes": {
        current.sizes = parseInlineArray(rawValue);
        break;
      }
      case "qualities": {
        current.qualities = parseInlineArray(rawValue);
        break;
      }
      case "supports_edit": {
        current.supports_edit = parseBool(rawValue);
        break;
      }
      case "max_n": {
        current.max_n = parseInt10(rawValue);
        break;
      }
    }
  }
  if (current) entries.push(current);

  const imageEntries = entries.filter((e) => e.type === "image_generation");

  // Inline validation — collect every problem across every image entry so
  // the operator sees one error listing all misconfigured models, not a
  // whack-a-mole stream of single-key failures.
  const errors: string[] = [];
  const validated: ImageGenerationModel[] = [];
  for (const e of imageEntries) {
    const modelErrs: string[] = [];
    if (!Array.isArray(e.sizes) || e.sizes.length === 0) {
      modelErrs.push(
        "model_info.sizes must be a non-empty inline YAML array of strings, " +
          'e.g. `sizes: ["1024x1024", "1024x1536"]`',
      );
    }
    if (!Array.isArray(e.qualities) || e.qualities.length === 0) {
      modelErrs.push(
        "model_info.qualities must be a non-empty inline YAML array of strings, " +
          'e.g. `qualities: ["auto", "high"]`',
      );
    }
    if (typeof e.supports_edit !== "boolean") {
      modelErrs.push(
        "model_info.supports_edit must be a boolean (true/false)",
      );
    }
    if (typeof e.max_n !== "number" || !Number.isInteger(e.max_n) || e.max_n < 1) {
      modelErrs.push("model_info.max_n must be an integer ≥ 1");
    }
    if (modelErrs.length > 0) {
      errors.push(
        `  - "${e.model_name}":\n      - ${modelErrs.join("\n      - ")}`,
      );
      continue;
    }
    validated.push({
      model_name: e.model_name!,
      sizes: e.sizes as string[],
      qualities: e.qualities as string[],
      supports_edit: e.supports_edit as boolean,
      max_n: e.max_n as number,
    });
  }

  if (errors.length > 0) {
    throw new Error(
      `[EXULU] config.litellm.yaml has image-generation models with missing or ` +
        `invalid model_info keys. Fix and restart Exulu:\n${errors.join("\n")}\n` +
        `See docs/superpowers/specs/2026-05-31-in-chat-image-generation-design.md ` +
        `for the required schema.`,
    );
  }

  return validated;
};
