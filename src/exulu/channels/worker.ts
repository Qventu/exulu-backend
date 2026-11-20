import type { Knex } from "knex";
import type { RedisClientType } from "redis";
import { postgresClient } from "@SRC/postgres/client";
import { redisClient } from "@SRC/redis/client";
import type { ExuluConfig } from "../app";
import { exuluApp } from "../app/singleton";
import type { ExuluContext } from "../context";
import type { ExuluTool } from "../tool";
import { channelAccessAllowed, type GuestAgent } from "./access";
import { runChannelAgentTurn } from "./agent-turn";
import { getTransport as defaultGetTransport, type TransportDeps } from "./chat-instance";
import { parseChannelConfig } from "./config";
import { createLinkStore, linkState } from "./links";
import { ChannelSetupError, sanitizedError } from "./log";
import { getChannelPgPool } from "./pg-pool";
import { handleChannelMessage, type ChannelMessageJob, type RunDeps } from "./run";
import { createRunLock } from "./run-lock";
import { channelStoreFromRedis } from "./wiring";
import type { AgentChannelRow } from "./types";

const LOG_PREFIX = "[EXULU-CHANNEL]";

export interface ChannelWorkerEnv {
  getDb(): Promise<Knex>;
  getRedis(): Promise<RedisClientType | null>;
  loadAgent(id: string): Promise<GuestAgent | undefined>;
  runAgentTurn: RunDeps["runAgentTurn"];
  now?(): Date;
  /** test seam */
  getTransport?: typeof defaultGetTransport;
}

/** The job data comes back from Redis; check its shape. Errors never quote the payload. */
export const parseChannelMessageJob = (inputs: unknown): ChannelMessageJob => {
  const bad = (field: string) => new Error(`Invalid channel_message job: ${field}`);
  if (inputs === null || typeof inputs !== "object") throw bad("inputs");
  const j = inputs as Record<string, unknown>;
  for (const field of ["channelId", "threadId", "identity", "messageId", "text"] as const) {
    if (typeof j[field] !== "string" || (field !== "text" && j[field] === "")) throw bad(field);
  }
  if (typeof j.userId !== "number" || !Number.isInteger(j.userId)) throw bad("userId");
  if (typeof j.newSession !== "boolean") throw bad("newSession");
  return {
    channelId: j.channelId as string,
    threadId: j.threadId as string,
    identity: j.identity as string,
    userId: j.userId,
    messageId: j.messageId as string,
    text: j.text as string,
    newSession: j.newSession,
  };
};

const LAST_ACTIVITY = 'COALESCE(last_answer_at, "createdAt")';

/**
 * The newest WhatsApp session of this user and agent on this channel whose last activity
 * (the last answer, else its creation) is within the idle window. Routine-run sessions
 * (run not null) never match.
 */
export const findRecentSessionQuery = (
  db: Knex,
  p: { agentId: string; userId: number; channelId: string; idleHours: number; now: Date },
) =>
  db("agent_sessions")
    .where({ agent: p.agentId, user: p.userId })
    .whereNull("run")
    .whereRaw("metadata -> 'channel' ->> 'id' = ?", [p.channelId])
    .whereRaw(`${LAST_ACTIVITY} >= ?`, [new Date(p.now.getTime() - p.idleHours * 3600 * 1000)])
    .orderByRaw(`${LAST_ACTIVITY} DESC`)
    .first("id");

/** Sessions are created like the web chat's (agent_sessionsCreateOne): private, owned by the user. */
export const createChannelSessions = (db: Knex): RunDeps["sessions"] => ({
  async findRecent(p) {
    const found = await findRecentSessionQuery(db, p);
    return found?.id ?? null;
  },
  async create(p) {
    const [inserted] = await db("agent_sessions")
      .insert({
        agent: p.agentId,
        user: p.userId,
        created_by: p.userId,
        title: p.title,
        rights_mode: "private",
        metadata: { channel: p.channel },
      })
      .returning("id");
    return typeof inserted === "object" ? inserted.id : inserted;
  },
});

/** RunDeps for one job. The transport follows the row that loadChannel returned. */
export const createRunDeps = async (env: ChannelWorkerEnv): Promise<RunDeps> => {
  const db = await env.getDb();
  const client = await env.getRedis();
  if (!client) throw new ChannelSetupError("redis unavailable");
  const store = channelStoreFromRedis(client);

  let loadedRow: AgentChannelRow | null = null;
  // no onMessage: the worker's instance only posts; inbound messages are the server's
  const transportDeps: TransportDeps = { pgPool: getChannelPgPool() };
  const now = env.now ?? (() => new Date());
  const transport = async () => {
    if (!loadedRow) throw new ChannelSetupError("no channel loaded for this job");
    const t = await (env.getTransport ?? defaultGetTransport)(loadedRow, transportDeps);
    if (!t) throw new ChannelSetupError(`channel ${loadedRow.id} has no usable credentials`);
    return t;
  };

  return {
    now,
    async loadChannel(id) {
      const row: AgentChannelRow | undefined = await db("agent_channels").where({ id }).first();
      if (!row) return null;
      try {
        const config = parseChannelConfig(row.config);
        loadedRow = row;
        return { row, config };
      } catch {
        console.error(`${LOG_PREFIX} channel ${id} has an invalid config; message skipped`);
        return null;
      }
    },
    async stillAllowed(job, row) {
      const state = linkState(await createLinkStore(db).find(job.channelId, job.identity), now());
      if (state.state !== "valid" || state.link.user !== job.userId) return false;
      // the channel's agent now, which may differ from the one decide checked
      return channelAccessAllowed({
        db,
        loadAgent: env.loadAgent,
        agentId: row.agent,
        channelId: row.id,
        userId: job.userId,
      });
    },
    lock: createRunLock(store),
    sessions: createChannelSessions(db),
    runAgentTurn: env.runAgentTurn,
    transport: {
      post: async (threadId, markdown) => (await transport()).post(threadId, markdown),
      typing: async (threadId) => (await transport()).typing(threadId),
    },
  };
};

/**
 * The worker's `channel_message` branch. handleChannelMessage has already logged the
 * cause with the channel id and masked sender; the rethrown error is reduced to its class
 * so job storage and the worker's failure log carry no recipient or message text.
 */
export const runChannelMessageJob = async (
  inputs: unknown,
  env: ChannelWorkerEnv,
): Promise<{ sessionId: string | null; posted: "answer" | "runFailed" | "skipped" }> => {
  const job = parseChannelMessageJob(inputs);
  try {
    return await handleChannelMessage(job, await createRunDeps(env));
  } catch (error) {
    throw sanitizedError(`channel_message job failed on channel ${job.channelId}`, error);
  }
};

/** The production environment for the worker branch in ee/workers.ts. */
export const createChannelWorkerEnv = (ctx: {
  tools: ExuluTool[];
  contexts: ExuluContext[];
  config: ExuluConfig;
}): ChannelWorkerEnv => {
  const getDb = async () => (await postgresClient()).db;
  const loadAgent = (id: string) => exuluApp.get().agent(id);
  return {
    getDb,
    getRedis: async () => (await redisClient()).client,
    loadAgent,
    runAgentTurn: (p) => runChannelAgentTurn(p, { ...ctx, getDb, loadAgent }),
  };
};
