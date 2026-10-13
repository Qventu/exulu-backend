export type StageUsage = { calls: number; inputTokens: number; outputTokens: number };

export const EMPTY_USAGE: StageUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

export function addUsage(a: StageUsage, b: StageUsage): StageUsage {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
