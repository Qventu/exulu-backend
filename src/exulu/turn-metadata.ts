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
