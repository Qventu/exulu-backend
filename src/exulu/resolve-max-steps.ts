import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";

/**
 * Read the `max_steps` option from the agentic retrieval tool's saved config.
 *
 * The agentic pipeline can trigger several reasoning/tool rounds in the CALLING
 * agent (retry-with-rephrasing loops). `max_steps` lets an admin bound that step
 * budget per agent from the retrieval tool's configuration UI instead of the
 * hardcoded platform default (5, or 10 when skills are enabled).
 *
 * Returns a positive integer, or undefined when unset/0/invalid — callers fall
 * back to the platform default. An explicit `maxStepCount` argument to
 * generateSync/generateStream always takes precedence over this config value.
 */
export function resolveMaxStepsFromToolConfigs(
  toolConfigs: ExuluAgentToolConfig[] | undefined,
): number | undefined {
  const agentic = toolConfigs?.find((t) => t.id === "agentic_context_search");
  if (!agentic?.config) return undefined;
  const entry = agentic.config.find((c) => c.name === "max_steps");
  if (!entry) return undefined;
  const raw = (entry as { value?: unknown }).value ?? entry.variable;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * prepareStep guard: on the LAST budgeted step, force `toolChoice: "none"` so the
 * model must answer in text from the material gathered so far. Without this, a
 * model that spends every step on tool calls hits the stepCountIs cap mid-loop and
 * the turn ends with a dangling tool call and NO answer (observed with the agentic
 * retrieval tool: three searches, zero answer text).
 */
export function finalAnswerGuard(maxSteps: number) {
  return ({ stepNumber }: { stepNumber: number }) =>
    stepNumber >= maxSteps - 1
      ? // activeTools: [] strips the tool definitions BEFORE they reach the provider —
        // toolChoice "none" alone is advisory in some provider chains (observed in
        // production: Gemini via LiteLLM still emitted a tool call on the guarded
        // step). With no tools declared, a tool call is impossible and the model
        // must answer in text.
        { toolChoice: "none" as const, activeTools: [] as string[] }
      : undefined;
}
