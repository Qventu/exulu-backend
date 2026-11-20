import type { ChannelTransport } from "./chat-instance";
import type { Decision, InboundMessage } from "./decide";
import type { ChannelMessageJob } from "./run";
import { replyText } from "./texts";
import type { WhatsAppChannelConfig } from "./types";

export const CHANNEL_JOB_NAME = "channel_message";
export const CHANNEL_JOB_TIMEOUT_SECONDS = 600;
/** Finished jobs are kept this long, so a redelivered message id stays a no-op for a day. */
const KEEP_FINISHED_SECONDS = 24 * 60 * 60;

/**
 * One attempt only: a retry after a failed post would run the agent again or post the
 * failure notice twice. A job-level removeOn* overrides the worker's count-based default.
 */
export const channelJobOptions = (messageId: string) => ({
  jobId: `wa:${messageId}`,
  attempts: 1,
  removeOnComplete: { age: KEEP_FINISHED_SECONDS },
  removeOnFail: { age: KEEP_FINISHED_SECONDS },
});

export const enqueueChannelMessage = async (
  queue: { add(name: string, data: unknown, opts: ReturnType<typeof channelJobOptions>): Promise<unknown> },
  job: ChannelMessageJob,
): Promise<void> => {
  await queue.add(
    CHANNEL_JOB_NAME,
    {
      label: "WhatsApp message",
      type: CHANNEL_JOB_NAME,
      trigger: "api",
      timeoutInSeconds: CHANNEL_JOB_TIMEOUT_SECONDS,
      inputs: job,
    },
    channelJobOptions(job.messageId),
  );
};

/** Turns a decision into its effects. Never logs message text or the sender. */
export const actOnDecision = async (
  msg: InboundMessage,
  decision: Decision,
  deps: {
    config: WhatsAppChannelConfig;
    transport: ChannelTransport;
    enqueue(job: ChannelMessageJob): Promise<void>;
  },
): Promise<void> => {
  if (decision.kind === "silent") return;

  if (decision.kind === "reply") {
    await deps.transport.post(msg.threadId, replyText(decision.key, deps.config, decision.vars));
    return;
  }

  await deps.enqueue({
    channelId: msg.channelId,
    threadId: msg.threadId,
    identity: msg.identity,
    userId: decision.userId,
    messageId: msg.messageId,
    text: msg.text,
    newSession: decision.newSession,
  });

  // Cosmetic: the job is queued either way.
  const cosmetic = async (what: string, effect: () => Promise<void>) => {
    try {
      await effect();
    } catch (error) {
      console.warn(`[EXULU-CHANNEL] ${what} failed on channel ${msg.channelId}`, error instanceof Error ? error.name : "");
    }
  };
  await cosmetic("mark read", () => deps.transport.markRead(msg.threadId, msg.messageId));
  await cosmetic("typing indicator", () => deps.transport.typing(msg.threadId));
};
