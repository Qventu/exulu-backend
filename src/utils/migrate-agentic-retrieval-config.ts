export type SavedToolConfigEntry = { name: string; variable: any; type: string };
export type SavedTool = { id: string; type?: string; name?: string; description?: string; config: SavedToolConfigEntry[] };

/**
 * Migrates a saved tool config from v3 agentic-retrieval format (flat ${ctx}_|_* keys)
 * to the new pipeline format (json options with knowledge_bases structure).
 * Returns the migrated tool, or null when the tool is already in the new format or not the retrieval tool.
 */
export function migrateAgenticToolConfig(tool: SavedTool): SavedTool | null {
  // Detection: old-format iff id === "agentic_context_search" AND (some config name contains "_|_" OR some name is reasoning_model/search_model)
  if (tool.id !== "agentic_context_search") return null;

  const hasOldFormat = tool.config.some(c =>
    c.name.includes("_|_") || c.name === "reasoning_model" || c.name === "search_model"
  );

  if (!hasOldFormat) return null;

  // Check if already migrated (has knowledge_bases)
  if (tool.config.some(c => c.name === "knowledge_bases")) return null;

  // Process the config
  const kept: SavedToolConfigEntry[] = [];
  const contextMap: Record<string, any> = {};

  // Keep these fields verbatim
  const keepFields = new Set(["instructions", "reranker", "managed_context", "require_preselected_contexts", "logging"]);

  // Drop these fields
  const dropFields = new Set(["reasoning_model", "search_model"]);

  for (const entry of tool.config) {
    // Keep verbatim fields
    if (keepFields.has(entry.name)) {
      kept.push(entry);
      continue;
    }

    // Drop dead fields
    if (dropFields.has(entry.name)) {
      continue;
    }

    // Process context keys
    if (entry.name.includes("_|_")) {
      // Split on FIRST occurrence of "_|_"
      const splitIndex = entry.name.indexOf("_|_");
      const ctx = entry.name.substring(0, splitIndex);
      const key = entry.name.substring(splitIndex + 3); // "_|_" is 3 chars

      if (!contextMap[ctx]) {
        contextMap[ctx] = { overrides: {} };
      }

      if (key === "enabled") {
        // Coerce string "true"/"false" to boolean
        let value = entry.variable;
        if (typeof value === "string") {
          value = value.toLowerCase() === "true";
        }
        contextMap[ctx].enabled = value;
      } else if (key === "instructions") {
        contextMap[ctx].instructions = entry.variable;
      } else if (key === "max_results") {
        const val = Number(entry.variable);
        if (val > 0) {
          contextMap[ctx].overrides.limit = val;
        }
      } else if (key === "expand_chunks") {
        const val = Number(entry.variable);
        if (val > 0) {
          contextMap[ctx].overrides.expand = val;
        }
      }
      // Drop priority and max_steps by doing nothing with them
    }
  }

  // Filter out default entries from contextMap
  // Default is: enabled=true with nothing else
  const filteredContextMap: Record<string, any> = {};
  for (const [ctx, value] of Object.entries(contextMap)) {
    // Check if this is a default entry
    // A default entry is: enabled=true (or undefined) and no other non-default values
    const isDefault =
      (value.enabled === true || value.enabled === undefined) &&
      value.instructions === undefined &&
      Object.keys(value.overrides).length === 0;

    if (!isDefault) {
      // Clean up empty overrides
      if (Object.keys(value.overrides).length === 0) {
        delete value.overrides;
      }
      filteredContextMap[ctx] = value;
    }
  }

  // Add the new entries
  kept.push({
    name: "knowledge_bases",
    variable: JSON.stringify(filteredContextMap),
    type: "json"
  });

  kept.push({
    name: "routing",
    variable: "",
    type: "json"
  });

  kept.push({
    name: "vocabulary",
    variable: "",
    type: "json"
  });

  kept.push({
    name: "memory",
    variable: "",
    type: "json"
  });

  kept.push({
    name: "tuning",
    variable: "",
    type: "json"
  });

  return {
    ...tool,
    config: kept
  };
}
