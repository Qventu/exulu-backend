import type { ExuluAgentToolConfig } from "@EXULU_TYPES/models/exulu-agent-tool-config";
import type { PrepareStepFn } from "./context-guard";

/**
 * Platform default step budget per agent turn. Raised from 5 after a production
 * report: multi-tool tasks (e.g. docx → pandoc → python analysis) exhausted 5
 * steps on tool calls alone, leaving no room for the final text answer.
 */
export const DEFAULT_MAX_STEPS = 10;

/**
 * Read the `max_steps` option from the agentic retrieval tool's saved config.
 *
 * Since 2026-07-08 this bounds ONLY agentic-retrieval CALLS per message —
 * enforced by retrievalBudgetGuard, which removes the retrieval tool from
 * activeTools once the budget is spent. It no longer feeds the turn-wide step
 * budget (that is resolveTurnStepBudget / agents.max_tool_steps).
 *
 * Returns a positive integer, or undefined when unset/0/invalid.
 */
export function resolveRetrievalCallBudget(
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
 * The per-turn step budget for ALL tools (bash, files, retrieval,
 * integrations). Precedence: explicit maxStepCount argument →
 * agents.max_tool_steps column (positive number; strings tolerated for pg
 * driver configs that return numerics as text) → DEFAULT_MAX_STEPS.
 */
export function resolveTurnStepBudget(
  maxStepCount: number | undefined,
  agent: { max_tool_steps?: number | string | null } | undefined,
): number {
  if (typeof maxStepCount === "number" && Number.isFinite(maxStepCount) && maxStepCount > 0) {
    return Math.floor(maxStepCount);
  }
  const raw = agent?.max_tool_steps;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  if (Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_MAX_STEPS;
}

/** Render one structured message part as plain text for the final-answer step. */
function flattenPart(part: unknown): string {
  const p = part as { type?: string; text?: string; toolName?: string; input?: unknown; output?: { value?: unknown } };
  if (p?.type === "text") return p.text ?? "";
  if (p?.type === "tool-call") {
    return `Earlier, the assistant ran the "${p.toolName}" tool with input: ${JSON.stringify(p.input ?? {}).slice(0, 300)}`;
  }
  if (p?.type === "tool-result") {
    const out = p.output?.value ?? p.output;
    return `The "${p.toolName}" tool returned: ${typeof out === "string" ? out : JSON.stringify(out ?? "")}`;
  }
  return "";
}

/**
 * Convert tool-call/tool-result history into plain text. Structured function parts
 * in the conversation invite models (observed: Gemini via LiteLLM) to MIMIC another
 * tool call even when the request declares no tools and tool_choice is "none" —
 * flattening removes the pattern, making a text answer the only possible output.
 * The flattened text is deliberately prose (not copyable tool-call syntax) so it
 * cannot serve as a mimicry template.
 */
export function flattenToolHistory(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role === "tool") {
      const text = (Array.isArray(msg.content) ? msg.content : [])
        .map(flattenPart)
        .filter(Boolean)
        .join("\n");
      return { role: "user", content: text || "(tool results)" };
    }
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const text = msg.content.map(flattenPart).filter(Boolean).join("\n");
      return { role: "assistant", content: text || "(searching)" };
    }
    return m;
  });
}

const FINAL_ANSWER_INSTRUCTION =
  "This is your last step for this turn. Answer the user's original question now, in plain text, using only the information gathered above. " +
  "If you could not finish the task, tell the user you reached the maximum number of tool steps, summarize what you found and did so far, and say what remains — they can ask you to continue. " +
  "Do not attempt any further tool calls. Write your answer as normal prose for the user: do not output tool-call syntax, JSON commands, or bracketed lines such as \"[called tool ...]\" — describe anything you did or still plan to do in plain language.";

/**
 * prepareStep guard: on the LAST budgeted step, force a text answer. Three layers,
 * each earned by a production failure of the previous one:
 *  1. toolChoice "none"  — advisory only in some provider chains (Gemini ignored it).
 *  2. activeTools []     — strips tool declarations SDK-side, but models still MIMIC
 *                          tool calls from the structured history parts.
 *  3. flattenToolHistory — rewrites the step's messages so no structured tool parts
 *                          remain, plus an explicit answer-now instruction. Verified
 *                          against vertex-gemini via LiteLLM: finishReason "stop"
 *                          with a real text answer.
 */
export function finalAnswerGuard(maxSteps: number) {
  return ({ stepNumber, messages }: { stepNumber: number; messages?: unknown[] }) =>
    stepNumber >= maxSteps - 1
      ? {
          toolChoice: "none" as const,
          activeTools: [] as string[],
          ...(Array.isArray(messages)
            ? {
                messages: [
                  ...flattenToolHistory(messages),
                  { role: "user", content: FINAL_ANSWER_INSTRUCTION },
                ] as never,
              }
            : {}),
        }
      : undefined;
}

/**
 * Bound agentic-retrieval CALLS per turn (spec 2026-07-08). Counts prior
 * steps' tool calls against the retrieval tool's REGISTERED key (the
 * sanitized tool name — resolve it at wiring time) and, once the budget is
 * spent, removes only that tool from activeTools. activeTools applies
 * per-step, so the exhausted state is re-asserted on every later step;
 * finalAnswerGuard runs later in the composition and its activeTools: []
 * still wins the final step.
 */
export function retrievalBudgetGuard(
  limit: number | undefined,
  agenticToolKey: string | undefined,
  allToolKeys: string[],
): PrepareStepFn {
  if (limit == null || limit <= 0 || !agenticToolKey || !allToolKeys.includes(agenticToolKey)) {
    return () => undefined;
  }
  const remainingTools = allToolKeys.filter((k) => k !== agenticToolKey);
  return ({ steps }) => {
    const calls = (steps ?? [])
      .flatMap((s) => s?.toolCalls ?? [])
      .filter((c) => c?.toolName === agenticToolKey).length;
    if (calls < limit) return undefined;
    return { activeTools: remainingTools };
  };
}
