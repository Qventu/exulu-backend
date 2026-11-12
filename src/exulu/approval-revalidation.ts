import type { ModelMessage } from "ai";

/**
 * Why this file exists: the AI SDK re-validates approved tool calls before it
 * executes them (`validateApprovedToolApprovals`, present from ai 6.0.x after
 * 6.0.49 — the version our lockfile pinned, which is why no test here ever saw
 * it). For every call the user approved it calls `needsApproval` AGAIN, and if
 * the answer is now `false` it turns the approval into a denial ("Tool X does
 * not require approval"). Our "allow for this chat" resend does exactly that:
 * the frontend sends `approvedTools` containing the tool, and we answered
 * `needsApproval: false` for the whole tool — including the call that was just
 * approved. Result at M&V on 2026-11-12: every approval showed "Denied", and the
 * stored part (`output-denied` with `approved: true`) made the session
 * unloadable.
 *
 * The rule that survives both SDK generations: a call whose approval request
 * has already been ANSWERED keeps needing approval (so the SDK honours the
 * answer); a NEW call of a tool the user allowed for this chat does not.
 */

type Part = { type?: unknown; approvalId?: unknown; toolCallId?: unknown };

/** Tool-call ids whose approval request has an approval response in `messages`. */
export function answeredApprovalToolCallIds(messages: ReadonlyArray<ModelMessage> | undefined): Set<string> {
  const toolCallByApproval = new Map<string, string>();
  for (const message of messages ?? []) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content as ReadonlyArray<Part>) {
      if (part?.type === "tool-approval-request" && typeof part.approvalId === "string" && typeof part.toolCallId === "string") {
        toolCallByApproval.set(part.approvalId, part.toolCallId);
      }
    }
  }
  const answered = new Set<string>();
  for (const message of messages ?? []) {
    if (message.role !== "tool" || typeof message.content === "string") continue;
    for (const part of message.content as ReadonlyArray<Part>) {
      if (part?.type !== "tool-approval-response" || typeof part.approvalId !== "string") continue;
      const toolCallId = toolCallByApproval.get(part.approvalId);
      if (toolCallId) answered.add(toolCallId);
    }
  }
  return answered;
}

/**
 * The `needsApproval` answer for one tool call.
 *
 * - `requiresApproval` false → never (the tool is approval-free by definition).
 * - the call's approval has been answered → true, whatever `approvedForSession`
 *   says — this is the line that keeps an approval from being re-read as a denial.
 * - otherwise → true unless the user allowed the tool for this chat.
 */
export function needsApprovalForCall(args: {
  toolCallId: string;
  messages: unknown[] | undefined;
  approvedForSession: boolean;
  requiresApproval: boolean;
}): boolean {
  if (!args.requiresApproval) return false;
  if (answeredApprovalToolCallIds(args.messages as ReadonlyArray<ModelMessage> | undefined).has(args.toolCallId)) return true;
  return !args.approvedForSession;
}
