import { answeredApprovalToolCallIds, needsApprovalForCall } from "./approval-revalidation";

const request = (approvalId: string, toolCallId: string) => ({
  role: "assistant" as const,
  content: [
    { type: "tool-call", toolCallId, toolName: "x", input: {} },
    { type: "tool-approval-request", approvalId, toolCallId },
  ],
});
const response = (approvalId: string, approved = true) => ({
  role: "tool" as const,
  content: [{ type: "tool-approval-response", approvalId, approved }],
});

describe("answeredApprovalToolCallIds", () => {
  it("maps an approval response back to its tool call through the request", () => {
    const ids = answeredApprovalToolCallIds([request("a1", "call-1"), response("a1")] as any);
    expect([...ids]).toEqual(["call-1"]);
  });

  it("ignores requests without a response, string contents and unrelated parts", () => {
    const ids = answeredApprovalToolCallIds([
      request("a1", "call-1"),
      { role: "user", content: "hallo" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-9", toolName: "x", output: { type: "text", value: "" } }] },
    ] as any);
    expect(ids.size).toBe(0);
  });
});

describe("needsApprovalForCall", () => {
  it("never asks for an approval-free tool", () => {
    expect(needsApprovalForCall({ toolCallId: "c", messages: [], approvedForSession: false, requiresApproval: false })).toBe(false);
  });

  it("asks when the tool was not allowed for this chat", () => {
    expect(needsApprovalForCall({ toolCallId: "c", messages: [], approvedForSession: false, requiresApproval: true })).toBe(true);
  });

  it("does not ask for a NEW call of a tool allowed for this chat", () => {
    expect(needsApprovalForCall({ toolCallId: "call-2", messages: [request("a1", "call-1"), response("a1")], approvedForSession: true, requiresApproval: true })).toBe(false);
  });

  // The regression seen at M&V (2026-11-12): the user approved call-1, the
  // frontend resent with approvedTools containing the tool, we answered
  // `false`, and ai ≥ 6.0.x turned the approval into a denial.
  it("keeps needing approval for the call whose approval was just answered — even when the tool is allowed for this chat", () => {
    expect(needsApprovalForCall({ toolCallId: "call-1", messages: [request("a1", "call-1"), response("a1")], approvedForSession: true, requiresApproval: true })).toBe(true);
  });

  it("treats a declined answer the same way (the SDK decides what a denial does)", () => {
    expect(needsApprovalForCall({ toolCallId: "call-1", messages: [request("a1", "call-1"), response("a1", false)], approvedForSession: true, requiresApproval: true })).toBe(true);
  });
});
