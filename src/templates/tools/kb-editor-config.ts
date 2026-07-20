import { z } from "zod";
import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";

// The agents.tools entry that holds per-context write permissions. It is a
// config-only entry: never itself exposed to the model, but expanded into
// per-context create/update tools in convertExuluToolsToAiSdkTools.
export const KB_EDITOR_TOOL_ID = "knowledge_base_editor";

export type KbWritePermissions = { create: boolean; update: boolean };

export type KbEditorConfig = {
  /** True when the agent has the knowledge_base_editor tool entry at all. */
  enabled: boolean;
  /** Explicit opt-in: contexts absent here have NO write access. */
  knowledgeBases: Record<string, KbWritePermissions>;
  skipApproval: boolean;
};

const permissionsSchema = z.object({
  create: z.boolean().catch(false).default(false),
  update: z.boolean().catch(false).default(false),
});

const EMPTY: KbEditorConfig = { enabled: false, knowledgeBases: {}, skipApproval: false };

// Never throws. Malformed input degrades to "no writable contexts" — write
// access must never appear by accident (inverse of the retrieval pipeline's
// default-enabled semantics, on purpose).
export const parseKbEditorConfig = (
  tools: ExuluAgentToolConfig[] | string | null | undefined,
): KbEditorConfig => {
  let entries: unknown = tools;
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch {
      return { ...EMPTY };
    }
  }
  if (!Array.isArray(entries)) {
    return { ...EMPTY };
  }

  const entry = (entries as ExuluAgentToolConfig[]).find((t) => t?.id === KB_EDITOR_TOOL_ID);
  if (!entry) {
    return { ...EMPTY };
  }

  const rawValue = (name: string): unknown => {
    const row = Array.isArray(entry.config)
      ? entry.config.find((c) => c?.name === name)
      : undefined;
    return row?.value ?? row?.variable ?? row?.default;
  };

  let kbsRaw: unknown = rawValue("knowledge_bases");
  if (typeof kbsRaw === "string" && kbsRaw) {
    try {
      kbsRaw = JSON.parse(kbsRaw);
    } catch {
      kbsRaw = {};
    }
  }

  const knowledgeBases: Record<string, KbWritePermissions> = {};
  if (kbsRaw && typeof kbsRaw === "object" && !Array.isArray(kbsRaw)) {
    for (const [contextId, value] of Object.entries(kbsRaw as Record<string, unknown>)) {
      const parsed = permissionsSchema.safeParse(value);
      if (parsed.success && (parsed.data.create || parsed.data.update)) {
        knowledgeBases[contextId] = parsed.data;
      }
    }
  }

  const skipRaw = rawValue("skip_approval");
  const skipApproval = skipRaw === true || skipRaw === "true" || skipRaw === 1;

  return { enabled: true, knowledgeBases, skipApproval };
};
