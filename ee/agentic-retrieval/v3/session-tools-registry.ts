import type { Tool as AITool } from "ai";

// Persists dynamic tools (get_more_content_from_X, get_X_page_N_content) created
// during an agentic retrieval run, keyed by session ID. This lets the outer chat
// agent call them directly on follow-up questions without re-running retrieval.
const registry = new Map<string, Map<string, AITool>>();

export function registerSessionTools(sessionId: string, tools: Record<string, AITool>): void {
  const existing = registry.get(sessionId) ?? new Map();
  for (const [name, toolDef] of Object.entries(tools)) {
    existing.set(name, toolDef);
  }
  registry.set(sessionId, existing);
}

export function getSessionTools(sessionId: string): Record<string, AITool> {
  const toolMap = registry.get(sessionId);
  if (!toolMap || toolMap.size === 0) return {};
  return Object.fromEntries(toolMap.entries());
}
