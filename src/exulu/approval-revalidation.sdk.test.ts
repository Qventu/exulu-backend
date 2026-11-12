/**
 * Drives the real `generateText` approval flow with a mock model: the user has
 * ANSWERED the approval for call-1 and the resend carries approvedTools for the
 * tool. The tool must execute.
 *
 * Under the lockfile's ai 6.0.49 this passes for the old boolean too (no
 * re-validation there). Under ai ≥ 6.0.x with `validateApprovedToolApprovals`
 * (verified 2026-11-12 against 6.0.330) the old `needsApproval: false` is
 * turned into `execution-denied` and only `needsApprovalForCall` executes —
 * which is why this test exists: it keeps the contract when the lockfile moves.
 */
import { generateText, tool, type ModelMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { needsApprovalForCall } from "./approval-revalidation";

const model = () =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "fertig" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  } as any);

const answeredApproval: ModelMessage[] = [
  { role: "user", content: "Pitch-Matrix fortsetzen" },
  {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call-1", toolName: "lesen", input: { pitch: "26W0099" } },
      { type: "tool-approval-request", approvalId: "a-1", toolCallId: "call-1" } as any,
    ],
  },
  { role: "tool", content: [{ type: "tool-approval-response", approvalId: "a-1", approved: true } as any] },
];

describe("an answered approval survives the SDK's re-validation", () => {
  it("executes the approved call although the tool is allowed for this chat", async () => {
    const approvedTools = ["tool-lesen"];
    let executed = 0;
    const lesen = tool({
      description: "liest",
      inputSchema: z.object({ pitch: z.string() }),
      needsApproval: (_input, opts) =>
        needsApprovalForCall({
          toolCallId: opts.toolCallId,
          messages: opts.messages as unknown[],
          approvedForSession: approvedTools.includes("tool-lesen"),
          requiresApproval: true,
        }),
      execute: async () => {
        executed += 1;
        return { ok: true };
      },
    });
    const result = await generateText({ model: model(), messages: answeredApproval, tools: { lesen } });
    const toolMessage = result.response.messages.find((m) => m.role === "tool");
    const outputs = ((toolMessage?.content ?? []) as any[])
      .filter((p) => p.type === "tool-result")
      .map((p) => p.output?.type);
    expect(executed).toBe(1);
    expect(outputs).not.toContain("execution-denied");
  });
});
