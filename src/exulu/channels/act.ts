import { createHash } from "crypto";
import type { ChannelTransport } from "./chat-instance";
import type { Decision, InboundMessage } from "./decide";
import { safeError } from "./log";
import type { ChannelMessageJob } from "./run";
import { replyText } from "./texts";
import type { WhatsAppChannelConfig } from "./types";

export const CHANNEL_JOB_NAME = "channel_message";
export const CHANNEL_JOB_TIMEOUT_SECONDS = 600;
/** How long a message id counts as handled, so a redelivery stays a no-op. */
export const SEEN_TTL_SECONDS = 24 * 60 * 60;

/** A wamid encodes the sender's number, so it is only ever used hashed. */
const hashMessageId = (messageId: string): string => createHash("sha256").update(messageId).digest("hex");

export const seenKey = (channelId: string, messageId: string): string =>
  `channel-seen:${channelId}:${hashMessageId(messageId)}`;

/**
 * One attempt only: a retry after a failed post would run the agent again or post the
 * failure notice twice. De-duplication lives in the seen key, so finished jobs (message
 * text, sender) are removed at once rather than kept in Redis.
 */
export const channelJobOptions = (messageId: string) => ({
  jobId: `wa:${hashMessageId(messageId).slice(0, 32)}`,
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
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

/** The slice of the key-value store the seen key needs. */
export interface SeenStore {
  set(key: string, value: string, opts: { EX: number; NX?: true }): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** Turns a decision into its effects. Never logs message text or the sender. */
export const actOnDecision = async (
  msg: InboundMessage,
  decision: Decision,
  deps: {
    config: WhatsAppChannelConfig;
    transport: ChannelTransport;
    enqueue(job: ChannelMessageJob): Promise<void>;
    store: SeenStore;
  },
): Promise<void> => {
  if (decision.kind === "silent") return;

  if (decision.kind === "reply") {
    await deps.transport.post(msg.threadId, replyText(decision.key, deps.config, decision.vars));
    return;
  }

  const seen = seenKey(msg.channelId, msg.messageId);
  if ((await deps.store.set(seen, "1", { EX: SEEN_TTL_SECONDS, NX: true })) === null) {
    // already handled: a redelivery
    return;
  }

  try {
    await deps.enqueue({
      channelId: msg.channelId,
      threadId: msg.threadId,
      identity: msg.identity,
      userId: decision.userId,
      messageId: msg.messageId,
      text: msg.text,
      newSession: decision.newSession,
    });
  } catch (error) {
    console.error(`[EXULU-CHANNEL] enqueue failed on channel ${msg.channelId}`, safeError(error));
    // let a redelivery be processed, and tell the sender now
    await deps.store
      .del(seen)
      .catch((e) => console.error(`[EXULU-CHANNEL] could not free the seen key on channel ${msg.channelId}`, safeError(e)));
    await deps.transport
      .post(msg.threadId, replyText("runFailed", deps.config))
      .catch((e) => console.error(`[EXULU-CHANNEL] could not post runFailed on channel ${msg.channelId}`, safeError(e)));
    return;
  }

  // Cosmetic: the job is queued either way.
  const cosmetic = async (what: string, effect: () => Promise<void>) => {
    try {
      await effect();
    } catch (error) {
      console.warn(`[EXULU-CHANNEL] ${what} failed on channel ${msg.channelId}`, safeError(error));
    }
  };
  await cosmetic("mark read", () => deps.transport.markRead(msg.threadId, msg.messageId));
  await cosmetic("typing indicator", () => deps.transport.typing(msg.threadId));
};
