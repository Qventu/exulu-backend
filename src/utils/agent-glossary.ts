/**
 * The vocabulary glossary configured on an agent's `agentic_context_search` tool was only
 * ever fed into that tool's internal query-augmentation call (ee/agentic-retrieval/pipeline/
 * memory.ts) — so it only reached the model indirectly, and only on turns where the model
 * happened to invoke the retrieval tool at all. A direct question like "what does AZK mean?"
 * that the model answers without searching never saw it, even though the glossary is
 * configured specifically so the agent understands the organization's own terminology.
 *
 * This makes the glossary part of the agent's always-on instructions instead, at a fixed
 * position, so it's available on every turn and a prompt cache can reuse it turn over turn
 * regardless of what gets appended afterwards (custom instructions, etc.).
 */

export type GlossaryEntry = { term: string; meaning: string };

interface AgentToolConfigEntry {
  name?: string;
  type?: string;
  variable?: unknown;
}
interface AgentToolConfig {
  id?: string;
  config?: AgentToolConfigEntry[];
}

/**
 * Pulls the vocabulary glossary out of an agent's `agentic_context_search` tool config
 * (the `agents.tools` jsonb column). Mirrors the "json" branch of `hydrateVariables` in
 * convert-exulu-tools-to-ai-sdk-tools.ts (parse `.variable` if it's a string, use it as-is
 * if it's already an object) — the glossary never needs that function's `variables` table
 * lookup, so we don't pay for the async DB round-trip just to read it.
 */
export function extractGlossaryFromAgentTools(tools: unknown): GlossaryEntry[] {
  if (!Array.isArray(tools)) return [];

  // Only one agentic_context_search tool is expected per agent.
  const searchTool = (tools as AgentToolConfig[]).find((t) => t?.id === "agentic_context_search");
  const entry = searchTool?.config?.find((c) => c?.name === "vocabulary");
  if (entry === undefined || entry.variable === undefined || entry.variable === null || entry.variable === "") {
    return [];
  }

  try {
    const parsed = typeof entry.variable === "string" ? JSON.parse(entry.variable) : entry.variable;
    const glossary = (parsed as { glossary?: unknown })?.glossary;
    if (!Array.isArray(glossary)) return [];
    return glossary.filter(
      (g): g is GlossaryEntry =>
        !!g && typeof g.term === "string" && typeof g.meaning === "string" && g.term.trim().length > 0,
    );
  } catch (err) {
    console.warn(
      "[EXULU] Failed to parse the agentic_context_search vocabulary config while building agent instructions.",
      err,
    );
    return [];
  }
}

/** Renders the glossary as an instruction block, or "" if there's nothing to add. */
export function formatGlossaryBlock(glossary: GlossaryEntry[]): string {
  if (!glossary.length) return "";
  const lines = glossary.map((g) => `${g.term} : ${g.meaning}`).join("\n");
  return `The organization's documents and internal terminology use the following abbreviations/terms:\n${lines}`;
}

/**
 * Prepends the agent's glossary to its instructions at a fixed position, before the agent's
 * own instructions/custom instructions. Returns `baseInstructions` unchanged when there's no
 * glossary configured.
 */
export function withGlossary(baseInstructions: string | undefined | null, tools: unknown): string {
  const instructions = baseInstructions ?? "";
  const block = formatGlossaryBlock(extractGlossaryFromAgentTools(tools));
  if (!block) return instructions;
  return instructions ? `${block}\n\n${instructions}` : block;
}
