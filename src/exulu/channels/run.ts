import { maskIdentity } from "./config";
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
  lock: { acquire(key: string, ttlSeconds: number): Promise<boolean>; release(key: string): Promise<void> };
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

export const RUN_LOCK_TTL_SECONDS = 900;
const TYPING_REFRESH_MS = 20_000;

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

  const key = runLockKey(job.channelId, job.identity);
  if (!(await deps.lock.acquire(key, RUN_LOCK_TTL_SECONDS))) {
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
      console.error(`[EXULU-CHANNEL] session lookup/creation failed for ${who}`, error);
      // The job failed, but the user should still be told.
      await deps.transport.post(job.threadId, replyText("runFailed", config)).catch((e) =>
        console.error(`[EXULU-CHANNEL] could not post failure notice for ${who}`, e),
      );
      throw error;
    }

    const typing = () => {
      // Typing is cosmetic: never let it fail the job or leave an unhandled rejection.
      void (async () => deps.transport.typing(job.threadId))().catch((e) =>
        console.warn(`[EXULU-CHANNEL] typing indicator failed for ${who}`, e),
      );
    };
    typing();
    const timer = setInterval(typing, TYPING_REFRESH_MS);

    let answer: string | null = null;
    try {
      answer = await deps.runAgentTurn({
        agentId: row.agent,
        userId: job.userId,
        sessionId,
        text: job.text,
      });
    } catch (error) {
      console.error(`[EXULU-CHANNEL] agent run failed for ${who}`, error);
    } finally {
      clearInterval(timer);
    }

    const ok = typeof answer === "string" && answer.trim() !== "";
    try {
      await deps.transport.post(job.threadId, ok ? (answer as string) : replyText("runFailed", config));
    } catch (error) {
      console.error(`[EXULU-CHANNEL] posting to WhatsApp failed for ${who}`, error);
      throw error;
    }
    return { sessionId, posted: ok ? "answer" : "runFailed" };
  } finally {
    await deps.lock.release(key).catch((e) => console.error(`[EXULU-CHANNEL] lock release failed for ${who}`, e));
  }
};
