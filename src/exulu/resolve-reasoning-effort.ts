/**
 * Per-agent thinking budget for the answer model.
 *
 * Reasoning models (Gemini 3+, o-series, Claude with extended thinking) spend
 * most of their output tokens on hidden thinking: a Newton smoke run produced
 * 5,016 reasoning tokens for a 1,776-token answer, i.e. roughly two thirds of
 * the answer latency. The agents.reasoning_effort column lets an operator trade
 * that thinking for speed per agent. The value is forwarded verbatim as
 * LiteLLM's `reasoning_effort`, which maps it to the provider's own knob
 * (Gemini thinkingBudget / thinkingLevel, OpenAI reasoning.effort, Anthropic
 * thinking budget). Unset = provider default, i.e. today's behaviour.
 */
export const REASONING_EFFORTS = ["none", "disable", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

type AgentReasoningRow = { reasoning_effort?: string | null } | undefined;

/** The agent's effort when it is a value LiteLLM understands; otherwise undefined. */
export function resolveReasoningEffort(agent: AgentReasoningRow): ReasoningEffort | undefined {
  const raw = agent?.reasoning_effort;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : undefined;
}

/** providerOptions for the chat streamText call: OpenAI summary + optional LiteLLM effort. */
export function resolveProviderOptions(
  agent: AgentReasoningRow,
): Record<string, Record<string, string>> {
  const effort = resolveReasoningEffort(agent);
  return {
    openai: { reasoningSummary: "auto" },
    ...(effort ? { litellm: { reasoningEffort: effort } } : {}),
  };
}
