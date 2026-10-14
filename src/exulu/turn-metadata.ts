import type { UIMessage } from "ai";
import type { RecalledMemory } from "./memory/recall-collector";
import type { ClaimCheckTrigger } from "./claim-check/finish-metadata";

/**
 * Metadata written onto the assistant message when a turn finishes.
 *
 * Besides the token counters this records the wall-clock duration of the turn, so
 * latency can be analysed from the messages table (there is no tracing on most
 * deployments, and the tracking table only holds aggregated counters).
 */
export type TurnUsage = {
  totalTokens?: number;
  reasoningTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
};

/**
 * Everything the chat stream may merge onto an assistant message's metadata,
 * in one place, so `pipeUIMessageStreamToResponse<ChatUIMessage>` can type-check
 * the `messageMetadata` callback's return.
 *
 * Without the generic the callback's return type is inferred and checked
 * against nothing, so a fragment whose SHAPE changed — `claimCheck` losing a
 * field, carrying a wrong type, or a counter turning into a string — reached
 * the client unchecked. With it, that is a TS2322 on the `messageMetadata`
 * property. What it does NOT catch is a misspelled key: the returned literal
 * is built from spreads, which costs it object-literal freshness, so excess
 * properties are not flagged. The fragment builders' own tests are what pin
 * the key names (see claim-check/finish-metadata.test.ts).
 *
 * Every key is optional because the callback answers different parts with
 * different subsets (`finish-step` returns the two per-step counters,
 * `finish` returns the rest).
 */
export type ChatMessageMetadata = Partial<ReturnType<typeof finishTurnMetadata>> & {
  lastStepInputTokens?: number;
  lastStepOutputTokens?: number;
  recalledMemories?: RecalledMemory[];
  claimCheck?: ClaimCheckTrigger;
};

/** The chat's UIMessage, carrying the metadata type above. */
export type ChatUIMessage = UIMessage<ChatMessageMetadata>;

export function finishTurnMetadata(opts: { totalUsage: TurnUsage; startedAt: number; now?: number }) {
  const now = opts.now ?? Date.now();
  return {
    totalTokens: opts.totalUsage.totalTokens,
    reasoningTokens: opts.totalUsage.reasoningTokens,
    inputTokens: opts.totalUsage.inputTokens,
    outputTokens: opts.totalUsage.outputTokens,
    cachedInputTokens: opts.totalUsage.cachedInputTokens,
    durationMs: Math.max(0, now - opts.startedAt),
  };
}
