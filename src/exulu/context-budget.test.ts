import type { UIMessage } from "ai";
import {
  deriveContextBudget,
  estimateTokens,
  contextOccupancy,
  sliceHistoryAtCheckpoint,
  getCompaction,
  ContextCompactionRequiredError,
  isProviderContextLengthError,
  mapStreamErrorMessage,
  CONTEXT_COMPACTION_REQUIRED,
  DEFAULT_CONTEXT_WINDOW,
} from "./context-budget";

const text = (role: "user" | "assistant", body: string, metadata?: object): UIMessage =>
  ({ id: `m_${Math.random().toString(36).slice(2)}`, role, parts: [{ type: "text", text: body }], ...(metadata ? { metadata } : {}) }) as UIMessage;

describe("deriveContextBudget", () => {
  it("derives the spec formulas for a 200K window", () => {
    const b = deriveContextBudget(200_000);
    expect(b.outputReserve).toBe(32_000); // min(32000, 40000)
    expect(b.usableWindow).toBe(168_000);
    expect(b.warnThreshold).toBe(134_400); // 0.8 × usable
    expect(b.blockThreshold).toBe(159_600); // 0.95 × usable
    expect(b.toolOutputCapTokens).toBe(20_000); // min(25000, max(4000, 20000))
    expect(b.compactionTailTokens).toBe(16_800);
    expect(b.summaryBudgetTokens).toBe(8_000); // min(8000, 8400)
  });

  it("clamps the tool cap for tiny and huge windows", () => {
    expect(deriveContextBudget(32_000).toolOutputCapTokens).toBe(4_000); // floor
    expect(deriveContextBudget(1_000_000).toolOutputCapTokens).toBe(25_000); // ceiling
  });

  it("falls back to the default window for undefined/0/negative", () => {
    for (const input of [undefined, null, 0, -5]) {
      expect(deriveContextBudget(input as never).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  });
});

describe("estimateTokens", () => {
  it("is ceil(chars/4) and 0 for empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("contextOccupancy", () => {
  it("estimates the whole history when no anchor exists", () => {
    const messages = [text("user", "x".repeat(400)), text("assistant", "y".repeat(400))];
    const occ = contextOccupancy(messages);
    // Serialized JSON is larger than the raw text, so > 200 tokens; sanity band.
    expect(occ).toBeGreaterThan(200);
    expect(occ).toBeLessThan(500);
  });

  it("anchors on the last assistant message with usage metadata and adds the delta", () => {
    const messages = [
      text("user", "hello"),
      text("assistant", "hi", { inputTokens: 90_000, outputTokens: 1_000, totalTokens: 91_000 }),
      text("user", "z".repeat(4_000)), // ~1000+ tokens serialized
    ];
    const occ = contextOccupancy(messages);
    expect(occ).toBeGreaterThan(91_000);
    expect(occ).toBeLessThan(93_500);
  });

  it("prefers lastStepInputTokens over summed inputTokens when both are present (multi-step fix)", () => {
    const messages = [
      text("assistant", "reply", {
        // inputTokens = summed across steps (inflated), lastStep* = single-step actual
        inputTokens: 500_000,
        outputTokens: 2_000,
        lastStepInputTokens: 50_000,
        lastStepOutputTokens: 1_000,
      }),
    ];
    const occ = contextOccupancy(messages);
    // Must anchor on lastStep (51_000) not summed (502_000)
    expect(occ).toBeGreaterThanOrEqual(51_000);
    expect(occ).toBeLessThan(53_000);
  });

  it("prefers a compaction checkpoint that comes after the last usage anchor", () => {
    const messages = [
      text("assistant", "old", { inputTokens: 900_000, outputTokens: 2_000 }),
      text("user", "[Conversation summary]", {
        compaction: { coversUpTo: "m_x", originalTokens: 900_000, summaryTokens: 3_000, occupancyEstimate: 12_000 },
      }),
    ];
    expect(contextOccupancy(messages)).toBe(12_000);
  });
});

describe("sliceHistoryAtCheckpoint", () => {
  it("returns messages unchanged when no checkpoint exists", () => {
    const messages = [text("user", "a"), text("assistant", "b")];
    expect(sliceHistoryAtCheckpoint(messages)).toEqual(messages);
  });

  it("returns [checkpoint, ...messages after coversUpTo], dropping summarized head", () => {
    const head = text("user", "old question");
    const covered = text("assistant", "old answer");
    const tailUser = text("user", "recent question");
    const tailAssistant = text("assistant", "recent answer");
    const checkpoint = text("user", "[Conversation summary]", {
      compaction: { coversUpTo: covered.id, originalTokens: 100, summaryTokens: 10, occupancyEstimate: 50 },
    });
    // Chronological order: checkpoint row was inserted AFTER the tail existed.
    const result = sliceHistoryAtCheckpoint([head, covered, tailUser, tailAssistant, checkpoint]);
    expect(result.map((m) => m.id)).toEqual([checkpoint.id, tailUser.id, tailAssistant.id]);
  });

  it("uses only the NEWEST checkpoint when several exist", () => {
    const a = text("user", "a");
    const cp1 = text("user", "[summary 1]", { compaction: { coversUpTo: a.id, originalTokens: 1, summaryTokens: 1, occupancyEstimate: 1 } });
    const b = text("user", "b");
    const cp2 = text("user", "[summary 2]", { compaction: { coversUpTo: b.id, originalTokens: 1, summaryTokens: 1, occupancyEstimate: 1 } });
    const c = text("user", "c");
    const result = sliceHistoryAtCheckpoint([a, cp1, b, c, cp2]);
    expect(result.map((m) => m.id)).toEqual([cp2.id, c.id]);
    expect(getCompaction(result[0]!)).toBeDefined();
  });
});

describe("error helpers", () => {
  it("ContextCompactionRequiredError carries a JSON message with the code", () => {
    const err = new ContextCompactionRequiredError(150_000, deriveContextBudget(200_000));
    const parsed = JSON.parse(err.message);
    expect(parsed.code).toBe(CONTEXT_COMPACTION_REQUIRED);
    expect(parsed.occupancy).toBe(150_000);
    expect(parsed.usableWindow).toBe(168_000);
    expect(typeof parsed.message).toBe("string");
  });

  it("matches known provider context-length error shapes", () => {
    for (const msg of [
      "litellm.ContextWindowExceededError: ...",
      "This model's maximum context length is 128000 tokens",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "Input is too long for requested model.",
      "The input token count exceeds the maximum number of tokens allowed",
    ]) {
      expect(isProviderContextLengthError(msg)).toBe(true);
    }
    expect(isProviderContextLengthError("rate limit exceeded")).toBe(false);
    expect(isProviderContextLengthError("tool call validation failed")).toBe(false);
  });

  it("mapStreamErrorMessage wraps context errors as the structured JSON and passes others through", () => {
    const mapped = mapStreamErrorMessage("prompt is too long: 999");
    expect(JSON.parse(mapped).code).toBe(CONTEXT_COMPACTION_REQUIRED);
    expect(mapStreamErrorMessage("something else")).toBe("something else");
  });
});
