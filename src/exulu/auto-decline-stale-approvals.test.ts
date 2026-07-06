import { autoDeclineStaleApprovals, AUTO_DECLINE_REASON } from "./auto-decline-stale-approvals";

const pendingPart = (overrides: Record<string, unknown> = {}) => ({
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "call_1",
  state: "approval-requested",
  input: { command: "ls" },
  approval: { id: "approval_1" },
  ...overrides,
});

const assistantMessage = (id: string, parts: unknown[]) =>
  ({ id, role: "assistant", parts }) as any;

const userMessage = (id: string, text: string) =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as any;

describe("autoDeclineStaleApprovals", () => {
  it("rewrites a dangling approval-requested part on a prior assistant message to output-denied", () => {
    const stale = assistantMessage("a1", [pendingPart()]);
    const { messages, declined } = autoDeclineStaleApprovals([
      userMessage("u1", "run ls"),
      stale,
      userMessage("u2", "actually, never mind"),
    ]);

    const rewritten = messages[1].parts[0];
    expect(rewritten.state).toBe("output-denied");
    expect(rewritten.approval).toEqual({
      id: "approval_1",
      approved: false,
      reason: AUTO_DECLINE_REASON,
    });
    expect(rewritten.input).toEqual({ command: "ls" });
    expect(declined).toEqual([messages[1]]);
    // the original message is not mutated
    expect(stale.parts[0].state).toBe("approval-requested");
  });

  it("never touches the last message (the incoming one)", () => {
    const incoming = assistantMessage("a1", [pendingPart()]);
    const { messages, declined } = autoDeclineStaleApprovals([userMessage("u1", "hi"), incoming]);
    expect(messages[1].parts[0].state).toBe("approval-requested");
    expect(declined).toEqual([]);
  });

  it("also rewrites static tool-* parts", () => {
    const { messages } = autoDeclineStaleApprovals([
      assistantMessage("a1", [pendingPart({ type: "tool-bash" })]),
      userMessage("u2", "next"),
    ]);
    expect(messages[0].parts[0].state).toBe("output-denied");
  });

  it("leaves resolved and non-tool parts untouched", () => {
    const parts = [
      { type: "text", text: "let me check" },
      pendingPart({ toolCallId: "call_a", approval: { id: "ap_a" } }),
      pendingPart({
        toolCallId: "call_b",
        state: "approval-responded",
        approval: { id: "ap_b", approved: true },
      }),
      pendingPart({ toolCallId: "call_c", state: "output-available", approval: undefined, output: "ok" }),
    ];
    const { messages, declined } = autoDeclineStaleApprovals([
      assistantMessage("a1", parts),
      userMessage("u2", "next"),
    ]);
    expect(messages[0].parts[0]).toEqual(parts[0]);
    expect(messages[0].parts[1].state).toBe("output-denied");
    expect(messages[0].parts[2]).toEqual(parts[2]);
    expect(messages[0].parts[3]).toEqual(parts[3]);
    expect(declined).toHaveLength(1);
  });

  it("declines multiple pending parts across multiple messages", () => {
    const { messages, declined } = autoDeclineStaleApprovals([
      assistantMessage("a1", [pendingPart({ toolCallId: "c1", approval: { id: "ap1" } })]),
      userMessage("u1", "and this"),
      assistantMessage("a2", [
        pendingPart({ toolCallId: "c2", approval: { id: "ap2" } }),
        pendingPart({ toolCallId: "c3", approval: { id: "ap3" } }),
      ]),
      userMessage("u2", "new question"),
    ]);
    expect(messages[0].parts[0].state).toBe("output-denied");
    expect(messages[2].parts[0].state).toBe("output-denied");
    expect(messages[2].parts[1].state).toBe("output-denied");
    expect(declined).toHaveLength(2);
  });

  it("returns everything unchanged when there is nothing to decline", () => {
    const input = [userMessage("u1", "hi"), assistantMessage("a1", [{ type: "text", text: "hello" }])];
    const { messages, declined } = autoDeclineStaleApprovals(input);
    expect(messages).toEqual(input);
    expect(declined).toEqual([]);
  });

  it("handles an empty message list", () => {
    expect(autoDeclineStaleApprovals([])).toEqual({ messages: [], declined: [] });
  });
});
