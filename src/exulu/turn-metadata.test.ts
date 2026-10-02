import { finishTurnMetadata } from "./turn-metadata";

describe("finishTurnMetadata — what the assistant message records when a turn finishes", () => {
  const totalUsage = { totalTokens: 1200, reasoningTokens: 0, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 50 };

  it("keeps the token counters and adds the wall-clock duration of the turn", () => {
    const meta = finishTurnMetadata({ totalUsage, startedAt: 1_000, now: 43_500 });
    expect(meta).toEqual({ ...totalUsage, durationMs: 42_500 });
  });

  it("never reports a negative duration", () => {
    expect(finishTurnMetadata({ totalUsage, startedAt: 5_000, now: 4_000 }).durationMs).toBe(0);
  });
});
