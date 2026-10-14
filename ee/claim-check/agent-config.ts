// ee/claim-check/agent-config.ts
//
// One place to read a claim-check caller's agent configuration. Both the HTTP
// handler and the second-chance retrieval need the same two steps — flatten the
// agentic_context_search tool's config entries, then parse them with the
// retrieval pipeline's own schema — so neither owns a private copy.
import { parsePipelineConfig, type PipelineConfig } from "@EE/agentic-retrieval/pipeline/config";

/** The agent's agentic_context_search tool config as a plain record. */
export function toolConfigOf(agent: unknown): Record<string, unknown> {
  const tools = (agent as { tools?: { id?: string; config?: { name?: string; variable?: unknown }[] }[] } | undefined)?.tools ?? [];
  const tool = tools.find((t) => t?.id === "agentic_context_search");
  const out: Record<string, unknown> = {};
  for (const entry of tool?.config ?? []) if (entry?.name) out[entry.name] = entry.variable;
  return out;
}

/** True when the agent has no agentic_context_search tool configured at all. */
export function hasNoToolConfig(raw: Record<string, unknown>): boolean {
  return Object.keys(raw).length === 0;
}

/** The parsed pipeline config for an agent; defaults throughout, never throws. */
export function pipelineConfigFor(agent: unknown): PipelineConfig {
  return parsePipelineConfig(toolConfigOf(agent));
}
