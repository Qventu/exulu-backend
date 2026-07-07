import { deriveContextBudget, estimateTokens } from "./context-budget";

export type PrepareStepFn = (opts: {
  stepNumber: number;
  messages?: unknown[];
}) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

const KEEP_RECENT_TOOL_MESSAGES = 2;
const COLLAPSE_KEEP_CHARS = 400;
const COLLAPSE_MARKER = " …[older tool output collapsed mid-response to fit the context window — the full output is in the session file named in the notice above, if one was saved]";

/**
 * In-flight microcompaction (spec §2, mid-response overflow): when a step's
 * accumulated messages approach the usable window, collapse tool results in
 * all but the most recent tool messages. Restorable — guarded outputs from
 * Task 4 lead with their session-file pointer, which survives the first
 * COLLAPSE_KEEP_CHARS characters.
 */
export function contextGuard(contextWindow?: number): PrepareStepFn {
  const budget = deriveContextBudget(contextWindow);
  return async ({ messages }) => {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    const tokens = estimateTokens(JSON.stringify(messages));
    if (tokens < budget.usableWindow) return undefined;

    const toolIndices = messages
      .map((m, i) => ((m as { role?: string })?.role === "tool" ? i : -1))
      .filter((i) => i !== -1);
    const collapsible = new Set(toolIndices.slice(0, Math.max(0, toolIndices.length - KEEP_RECENT_TOOL_MESSAGES)));
    if (collapsible.size === 0) return undefined;

    let changed = false;
    const next = messages.map((m, i) => {
      if (!collapsible.has(i)) return m;
      const msg = m as { content?: unknown };
      if (!Array.isArray(msg.content)) return m;
      const content = msg.content.map((part) => {
        const p = part as { type?: string; output?: { value?: unknown } };
        if (p?.type !== "tool-result") return part;
        const out = p.output?.value ?? p.output;
        const asText = typeof out === "string" ? out : JSON.stringify(out ?? "");
        if (asText.length <= COLLAPSE_KEEP_CHARS + COLLAPSE_MARKER.length) return part;
        changed = true;
        return { ...(part as object), output: { type: "text", value: asText.slice(0, COLLAPSE_KEEP_CHARS) + COLLAPSE_MARKER } };
      });
      return { ...(m as object), content };
    });
    return changed ? { messages: next as never } : undefined;
  };
}

/**
 * Compose prepareStep guards: each runs in order, sees the previous guard's
 * rewritten messages, and later overrides win on shallow-merged keys.
 */
export function composePrepareSteps(...guards: PrepareStepFn[]): PrepareStepFn {
  return async (opts) => {
    let merged: Record<string, unknown> | undefined;
    let messages = opts.messages;
    for (const guard of guards) {
      const result = await guard({ ...opts, messages });
      if (!result) continue;
      merged = { ...(merged ?? {}), ...result };
      if (Array.isArray((result as { messages?: unknown[] }).messages)) {
        messages = (result as { messages: unknown[] }).messages;
      }
    }
    if (merged && messages && !("messages" in merged)) {
      // preserve threading even if only an earlier guard rewrote messages
      merged.messages = messages;
    }
    return merged;
  };
}
