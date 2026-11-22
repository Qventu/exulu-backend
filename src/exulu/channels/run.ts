import { maskIdentity } from "./config";
import { safeError } from "./log";
import { replyText } from "./texts";
import type { AgentChannelRow, WhatsAppChannelConfig } from "./types";

export interface ChannelMessageJob {
  channelId: string;
  threadId: string;
  identity: string;
  userId: number;
  messageId: string;
  text: string;
  newSession: boolean;
}

export interface RunDeps {
  now: () => Date;
  loadChannel(id: string): Promise<{ row: AgentChannelRow; config: WhatsAppChannelConfig } | null>;
  /**
   * Re-checks at run time what decide checked at enqueue time: the link is still valid
   * and belongs to job.userId, and that user may still use the channel's current agent.
   */
  stillAllowed(job: ChannelMessageJob, row: AgentChannelRow): Promise<boolean>;
  /**
   * `acquire` returns an owner token, or null when the lock is held. `release` must be a
   * compare-and-delete on that token, so a job that outlived the TTL cannot remove a newer job's lock.
   * `extend` renews the TTL only while the token still matches (compare-and-expire); true if it did.
   */
  lock: {
    acquire(key: string, ttlSeconds: number): Promise<string | null>;
    release(key: string, token: string): Promise<void>;
    extend(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  };
  /**
   * Marks this message id as answered (SET NX, 24 h); true if this call set it. Called right
   * before the answer or the runFailed notice of a run that executed, so a second execution of
   * the same message (a stalled job picked up again) posts nothing.
   */
  markAnswered(job: ChannelMessageJob): Promise<boolean>;
  sessions: {
    findRecent(p: { agentId: string; userId: number; channelId: string; idleHours: number; now: Date }): Promise<string | null>;
    create(p: {
      agentId: string;
      userId: number;
      title: string;
      channel: { type: "whatsapp"; id: string; identity: string };
    }): Promise<string>;
  };
  runAgentTurn(p: { agentId: string; userId: number; sessionId: string; text: string }): Promise<string>;
  transport: { post(threadId: string, markdown: string): Promise<void>; typing(threadId: string): Promise<void> };
}

/**
 * Short, and renewed every RUN_LOCK_RENEW_MS while the run is pending: a run cut by a crash or a
 * deploy blocks its sender for at most this long. BullMQ only re-queues a stalled job after its
 * own lock (lockDuration 300 s in ee/workers.ts) has lapsed, by which time this one has too.
 */
export const RUN_LOCK_TTL_SECONDS = 90;
/** The typing indicator lapses after about 25 s; the lock is renewed on the same timer. */
export const RUN_LOCK_RENEW_MS = 20_000;

/**
 * Channel ids are uuids (fixed shape, no ":"), so the first ":" after the prefix
 * always ends the channel id; the identity may contain ":" freely. Two different
 * (channelId, identity) pairs therefore never produce the same key.
 */
export const runLockKey = (channelId: string, identity: string): string => `channel-run:${channelId}:${identity}`;

export const handleChannelMessage = async (
  job: ChannelMessageJob,
  deps: RunDeps,
): Promise<{ sessionId: string | null; posted: "answer" | "runFailed" | "skipped" }> => {
  const who = `${job.channelId} ${maskIdentity(job.identity)}`;

  const loaded = await deps.loadChannel(job.channelId);
  if (!loaded || !loaded.row.enabled) return { sessionId: null, posted: "skipped" };
  const { row, config } = loaded;

  // Before the lock: a job that may no longer run must not block or answer anything.
  let allowed = false;
  try {
    allowed = await deps.stillAllowed(job, row);
  } catch (error) {
    console.error(`[EXULU-CHANNEL] run-time access check failed on channel ${job.channelId}`, safeError(error));
  }
  if (!allowed) {
    console.warn(`[EXULU-CHANNEL] message on channel ${job.channelId} skipped: link or access no longer valid`);
    return { sessionId: null, posted: "skipped" };
  }

  const key = runLockKey(job.channelId, job.identity);
  const token = await deps.lock.acquire(key, RUN_LOCK_TTL_SECONDS);
  if (token === null) {
    // Another message of this sender is being answered (both passed decide before it started).
    await deps.transport.post(job.threadId, replyText("stillWorking", config)).catch((e) =>
      console.error(`[EXULU-CHANNEL] could not post stillWorking for ${who}`, safeError(e)),
    );
    return { sessionId: null, posted: "skipped" };
  }

  try {
    let sessionId: string;
    try {
      const recent = job.newSession
        ? null
        : await deps.sessions.findRecent({
            agentId: row.agent,
            userId: job.userId,
            channelId: job.channelId,
            idleHours: config.sessionIdleHours,
            now: deps.now(),
          });
      sessionId =
        recent ??
        (await deps.sessions.create({
          agentId: row.agent,
          userId: job.userId,
          title: job.text.slice(0, 50),
          channel: { type: "whatsapp", id: job.channelId, identity: job.identity },
        }));
    } catch (error) {
      console.error(`[EXULU-CHANNEL] session lookup/creation failed for ${who}`, safeError(error));
      // The job failed, but the user should still be told.
      await deps.transport.post(job.threadId, replyText("runFailed", config)).catch((e) =>
        console.error(`[EXULU-CHANNEL] could not post failure notice for ${who}`, safeError(e)),
      );
      throw error;
    }

    const typing = () => {
      // Typing is cosmetic: never let it fail the job or leave an unhandled rejection.
      void (async () => deps.transport.typing(job.threadId))().catch((e) =>
        console.warn(`[EXULU-CHANNEL] typing indicator failed for ${who}`, safeError(e)),
      );
    };
    const extendLock = () => {
      // keeps the lock while the run is alive; a failure is logged and the run goes on
      void (async () => deps.lock.extend(key, token, RUN_LOCK_TTL_SECONDS))().then(
        (extended) => {
          if (!extended) console.warn(`[EXULU-CHANNEL] run lock could not be extended on channel ${job.channelId}`);
        },
        (e) => console.error(`[EXULU-CHANNEL] run lock extension failed on channel ${job.channelId}`, safeError(e)),
      );
    };
    typing();
    const timer = setInterval(() => {
      typing();
      extendLock();
    }, RUN_LOCK_RENEW_MS);

    let answer: string | null = null;
    try {
      answer = await deps.runAgentTurn({
        agentId: row.agent,
        userId: job.userId,
        sessionId,
        text: job.text,
      });
    } catch (error) {
      console.error(`[EXULU-CHANNEL] agent run failed for ${who}`, safeError(error));
    } finally {
      clearInterval(timer);
    }

    const ok = typeof answer === "string" && answer.trim() !== "";
    // Another execution of this same message may already have answered it.
    let first = true;
    try {
      first = await deps.markAnswered(job);
    } catch (error) {
      // a missing answer is worse than a rare duplicate: post anyway
      console.error(`[EXULU-CHANNEL] could not mark the message answered on channel ${job.channelId}`, safeError(error));
    }
    if (!first) {
      console.warn(`[EXULU-CHANNEL] message on channel ${job.channelId} already answered; nothing posted`);
      return { sessionId, posted: "skipped" };
    }
    try {
      await deps.transport.post(job.threadId, ok ? (answer as string) : replyText("runFailed", config));
    } catch (error) {
      console.error(`[EXULU-CHANNEL] posting to WhatsApp failed for ${who}`, safeError(error));
      throw error;
    }
    return { sessionId, posted: ok ? "answer" : "runFailed" };
  } finally {
    await deps.lock.release(key, token).catch((e) => console.error(`[EXULU-CHANNEL] lock release failed for ${who}`, safeError(e)));
  }
};
