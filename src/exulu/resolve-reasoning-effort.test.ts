import { resolveReasoningEffort, resolveProviderOptions } from "./resolve-reasoning-effort";

describe("resolveReasoningEffort — the per-agent thinking budget for the answer model", () => {
  it("returns the configured effort when it is one LiteLLM understands", () => {
    expect(resolveReasoningEffort({ reasoning_effort: "none" })).toBe("none");
    expect(resolveReasoningEffort({ reasoning_effort: "low" })).toBe("low");
    expect(resolveReasoningEffort({ reasoning_effort: "high" })).toBe("high");
  });

  it("tolerates surrounding whitespace and upper case from hand-edited rows", () => {
    expect(resolveReasoningEffort({ reasoning_effort: " Low " })).toBe("low");
  });

  it("ignores unset, empty or unknown values so a typo can never break chats", () => {
    expect(resolveReasoningEffort(undefined)).toBeUndefined();
    expect(resolveReasoningEffort({})).toBeUndefined();
    expect(resolveReasoningEffort({ reasoning_effort: null })).toBeUndefined();
    expect(resolveReasoningEffort({ reasoning_effort: "" })).toBeUndefined();
    expect(resolveReasoningEffort({ reasoning_effort: "maximum" })).toBeUndefined();
  });
});

describe("resolveProviderOptions — what streamText sends to the LiteLLM provider", () => {
  it("keeps the OpenAI reasoning summary and adds nothing when the agent has no effort set", () => {
    expect(resolveProviderOptions({})).toEqual({ openai: { reasoningSummary: "auto" } });
  });

  it("passes the agent's effort through as LiteLLM's reasoning_effort", () => {
    expect(resolveProviderOptions({ reasoning_effort: "none" })).toEqual({
      openai: { reasoningSummary: "auto" },
      litellm: { reasoningEffort: "none" },
    });
  });
});
