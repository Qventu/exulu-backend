import type { UIMessage } from "ai";

/**
 * Single source of truth for context-window budget math (spec:
 * docs/superpowers/specs/2026-07-07-context-window-management-design.md).
 * The frontend mirrors these formulas in
 * exulu/frontend/app/(application)/chat/lib/context-budget.ts — keep in sync.
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export type ContextBudget = {
  contextWindow: number;
  outputReserve: number;
  usableWindow: number;
  warnThreshold: number;
  blockThreshold: number;
  toolOutputCapTokens: number;
  compactionTailTokens: number;
  summaryBudgetTokens: number;
};

export const deriveContextBudget = (contextWindowInput?: number | null): ContextBudget => {
  const contextWindow =
    contextWindowInput != null && contextWindowInput > 0 ? contextWindowInput : DEFAULT_CONTEXT_WINDOW;
  const outputReserve = Math.min(32_000, Math.floor(contextWindow * 0.2));
  const usableWindow = contextWindow - outputReserve;
  return {
    contextWindow,
    outputReserve,
    usableWindow,
    warnThreshold: Math.floor(usableWindow * 0.8),
    blockThreshold: Math.floor(usableWindow * 0.95),
    toolOutputCapTokens: Math.min(25_000, Math.max(4_000, Math.floor(contextWindow * 0.1))),
    compactionTailTokens: Math.floor(usableWindow * 0.1),
    summaryBudgetTokens: Math.min(8_000, Math.floor(usableWindow * 0.05)),
  };
};

/**
 * chars/4 heuristic — deterministic, sync, no network. Real per-turn usage
 * metadata anchors occupancy every turn, so estimator drift never accumulates.
 */
export const estimateTokens = (text: string): number => (text ? Math.ceil(text.length / 4) : 0);

export const estimateMessageTokens = (message: UIMessage): number =>
  estimateTokens(JSON.stringify(message));

export type CompactionMetadata = {
  coversUpTo: string;
  originalTokens: number;
  summaryTokens: number;
  occupancyEstimate: number;
  steer?: string;
};

export const getCompaction = (message: UIMessage): CompactionMetadata | undefined =>
  (message.metadata as { compaction?: CompactionMetadata } | undefined)?.compaction;

/**
 * Model-view assembly. Input MUST be in chronological (createdAt) order.
 * The newest checkpoint replaces everything up to and including its
 * `coversUpTo` message; messages created after that point (the verbatim tail
 * plus anything newer) follow the summary.
 */
export const sliceHistoryAtCheckpoint = (messages: UIMessage[]): UIMessage[] => {
  let checkpointIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (getCompaction(messages[i]!)) {
      checkpointIdx = i;
      break;
    }
  }
  if (checkpointIdx === -1) return messages;
  const checkpoint = messages[checkpointIdx]!;
  const coversUpTo = getCompaction(checkpoint)!.coversUpTo;
  const coversIdx = messages.findIndex((m) => m.id === coversUpTo);
  // coversUpTo missing (deleted row): degrade to "summary only + newer than
  // the checkpoint" rather than resending the whole history.
  const boundary = coversIdx === -1 ? checkpointIdx : coversIdx;
  const after = messages.filter((m, i) => i > boundary && i !== checkpointIdx);
  return [checkpoint, ...after];
};

/**
 * Occupancy = the newest REAL number we have, plus a chars/4 estimate of
 * everything after it. Input MUST be in chronological order. Anchors:
 *  - an assistant message with usage metadata (inputTokens reflects the whole
 *    prompt of that turn, outputTokens its response), or
 *  - a compaction checkpoint (occupancyEstimate = summary + verbatim tail).
 */
export const contextOccupancy = (messages: UIMessage[]): number => {
  let anchorIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const meta = m.metadata as { inputTokens?: number } | undefined;
    if (getCompaction(m) || (m.role === "assistant" && typeof meta?.inputTokens === "number")) {
      anchorIdx = i;
      break;
    }
  }
  let total = 0;
  let rest = messages;
  if (anchorIdx !== -1) {
    const anchor = messages[anchorIdx]!;
    const compaction = getCompaction(anchor);
    if (compaction) {
      total = compaction.occupancyEstimate;
    } else {
      const meta = anchor.metadata as { inputTokens?: number; outputTokens?: number };
      total = (meta.inputTokens ?? 0) + (meta.outputTokens ?? 0);
    }
    rest = messages.slice(anchorIdx + 1);
  }
  for (const m of rest) total += estimateMessageTokens(m);
  return total;
};

export const CONTEXT_COMPACTION_REQUIRED = "CONTEXT_COMPACTION_REQUIRED";
export const COMPACTION_INSUFFICIENT = "COMPACTION_INSUFFICIENT";

/**
 * Thrown by the pre-flight budget gate. The message IS a JSON string so it
 * survives every error channel (HTTP body, SSE error part) and the frontend
 * can `JSON.parse` it or match `.includes(CONTEXT_COMPACTION_REQUIRED)`.
 */
export class ContextCompactionRequiredError extends Error {
  constructor(
    public occupancy: number,
    public budget: ContextBudget,
  ) {
    super(
      JSON.stringify({
        code: CONTEXT_COMPACTION_REQUIRED,
        message:
          `This conversation no longer fits the model's context window ` +
          `(~${occupancy.toLocaleString("en-US")} of ${budget.usableWindow.toLocaleString("en-US")} usable tokens). ` +
          `Compact the conversation to continue.`,
        occupancy,
        usableWindow: budget.usableWindow,
        contextWindow: budget.contextWindow,
      }),
    );
    this.name = "ContextCompactionRequiredError";
  }
}

// Known provider phrasings for "your prompt does not fit". Sources: LiteLLM
// (ContextWindowExceededError), OpenAI ("maximum context length"), Anthropic
// ("prompt is too long"), Vertex/Gemini ("input token count exceeds"),
// generic gateways ("input is too long", "context window/length").
const PROVIDER_CONTEXT_ERROR_PATTERNS: RegExp[] = [
  /ContextWindowExceededError/i,
  /context.?window/i,
  /context.?length/i,
  /maximum context/i,
  /prompt is too long/i,
  /input is too long/i,
  /token count exceeds/i,
  /too many tokens/i,
];

export const isProviderContextLengthError = (message: string): boolean =>
  PROVIDER_CONTEXT_ERROR_PATTERNS.some((re) => re.test(message));

/** Map a raw stream-error message to the structured code when it is a context-length failure. */
export const mapStreamErrorMessage = (message: string): string =>
  isProviderContextLengthError(message)
    ? JSON.stringify({
        code: CONTEXT_COMPACTION_REQUIRED,
        message:
          "The model rejected the request because the conversation exceeds its context window. Compact the conversation to continue.",
        providerMessage: message.slice(0, 500),
      })
    : message;
