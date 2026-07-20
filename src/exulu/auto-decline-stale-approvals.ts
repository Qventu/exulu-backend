import type { UIMessage } from "ai";

export const AUTO_DECLINE_REASON =
  "Automatically declined because the user sent a new message instead of responding to the approval request.";

type PendingApprovalPart = {
  type: string;
  state: string;
  approval: { id: string };
};

export const isPendingApprovalToolPart = (part: unknown): part is PendingApprovalPart => {
  const candidate = part as PendingApprovalPart | undefined;
  return (
    (candidate?.type === "dynamic-tool" || (typeof candidate?.type === "string" && candidate.type.startsWith("tool-"))) &&
    candidate?.state === "approval-requested" &&
    typeof candidate?.approval?.id === "string"
  );
};

/**
 * Tool calls left in state "approval-requested" (the stream ended waiting for
 * the user to accept or decline) can no longer be answered once a newer
 * message exists after them. Left unresolved, the AI SDK throws
 * "Tool result is missing for tool call" as soon as a user message follows
 * the dangling call. This rewrites those parts to the terminal denied state
 * ("output-denied"), which convertToModelMessages turns into a proper
 * approval response plus a denied tool result.
 *
 * The last message is the incoming one and is never touched: when it is an
 * approval response resend, streamText still needs to process it.
 *
 * Returns the reconciled messages plus the rewritten ones so the caller can
 * persist them and the UI stops showing a stale Accept/Decline prompt.
 */
export const autoDeclineStaleApprovals = (
  messages: UIMessage[],
): { messages: UIMessage[]; declined: UIMessage[] } => {
  const declined: UIMessage[] = [];
  const reconciled = messages.map((message, index) => {
    if (index === messages.length - 1 || message.role !== "assistant") return message;
    if (!message.parts?.some(isPendingApprovalToolPart)) return message;
    const updated = {
      ...message,
      parts: message.parts.map((part) =>
        isPendingApprovalToolPart(part)
          ? {
            ...part,
            state: "output-denied",
            approval: { id: part.approval.id, approved: false, reason: AUTO_DECLINE_REASON },
          }
          : part,
      ),
    } as UIMessage;
    declined.push(updated);
    return updated;
  });
  return { messages: reconciled, declined };
};
