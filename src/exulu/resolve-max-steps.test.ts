import { resolveMaxStepsFromToolConfigs, finalAnswerGuard } from "./resolve-max-steps";

const cfg = (entries: { name: string; variable: any; type: string }[]) =>
  [{ id: "agentic_context_search", type: "context", name: "Context Search", config: entries }] as any;

describe("resolveMaxStepsFromToolConfigs", () => {
  it("returns the configured positive integer (string-stored, platform convention)", () => {
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "4", type: "number" }]))).toBe(4);
  });

  it("accepts numeric values and floors them", () => {
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: 6.7, type: "number" }]))).toBe(6);
  });

  it("returns undefined for unset, zero, negative, or garbage values", () => {
    expect(resolveMaxStepsFromToolConfigs(undefined)).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs([] as any)).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([]))).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "0", type: "number" }]))).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "-3", type: "number" }]))).toBeUndefined();
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "banana", type: "number" }]))).toBeUndefined();
  });

  it("ignores other tools' configs", () => {
    const configs = [{ id: "other_tool", type: "function", name: "x", config: [{ name: "max_steps", variable: "9", type: "number" }] }] as any;
    expect(resolveMaxStepsFromToolConfigs(configs)).toBeUndefined();
  });

  it("prefers hydrated value over raw variable when present", () => {
    expect(resolveMaxStepsFromToolConfigs(cfg([{ name: "max_steps", variable: "2", value: 8, type: "number" } as any]))).toBe(8);
  });
});

import { flattenToolHistory } from "./resolve-max-steps";

describe("finalAnswerGuard", () => {
  it("does nothing before the last budgeted step", () => {
    const guard = finalAnswerGuard(4);
    expect(guard({ stepNumber: 0 })).toBeUndefined();
    expect(guard({ stepNumber: 2 })).toBeUndefined();
  });

  it("on the final step strips tools and flattens history with an answer-now instruction", () => {
    const guard = finalAnswerGuard(3);
    const messages = [
      { role: "user", content: "Frage?" },
      { role: "assistant", content: [{ type: "tool-call", toolName: "search", input: { q: "x" } }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "search", output: { value: "RESULT TEXT" } }] },
    ];
    const r = guard({ stepNumber: 2, messages }) as any;
    expect(r.toolChoice).toBe("none");
    expect(r.activeTools).toEqual([]);
    const msgs = r.messages as any[];
    // No structured tool parts survive
    expect(JSON.stringify(msgs)).not.toContain("tool-call");
    expect(JSON.stringify(msgs)).not.toContain("tool-result");
    expect(msgs.find((m) => m.role === "tool")).toBeUndefined();
    // Tool results became readable text, original user turn intact
    expect(msgs[2]).toEqual({ role: "user", content: expect.stringContaining("RESULT TEXT") });
    expect(msgs[0]).toEqual({ role: "user", content: "Frage?" });
    // Trailing answer-now instruction
    expect(msgs[msgs.length - 1].content).toContain("Do not attempt any further tool calls");
  });

  it("omits the messages override when none are provided (sync callers)", () => {
    const guard = finalAnswerGuard(3);
    expect(guard({ stepNumber: 5 })).toEqual({ toolChoice: "none", activeTools: [] });
  });
});

describe("flattenToolHistory", () => {
  it("passes plain user/system messages through untouched", () => {
    const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u" }];
    expect(flattenToolHistory(msgs)).toEqual(msgs);
  });

  it("falls back to placeholders for empty structured content", () => {
    const r = flattenToolHistory([
      { role: "assistant", content: [] },
      { role: "tool", content: [] },
    ]) as any[];
    expect(r[0].content).toBe("(searching)");
    expect(r[1]).toEqual({ role: "user", content: "(tool results)" });
  });
});
