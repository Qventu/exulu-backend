import type { Knex } from "knex";
import type { RedisClientType } from "redis";
import { externalRateLimitExceeded } from "../external-rate-limit";
import { actOnDecision } from "./act";
import { createChannelAuditor } from "./audit";
import { getTransport as defaultGetTransport, type TransportDeps } from "./chat-instance";
import { linkPageUrl, parseChannelConfig } from "./config";
import { decideInbound, type DecideDeps, type InboundMessage } from "./decide";
import { channelAccessAllowed, type GuestAgent } from "./access";
import { codeAttemptsExceeded, consumeCode, linkPromptAllowed, type KeyValueStore } from "./link-codes";
import { createLinkStore } from "./links";
import { ChannelSetupError } from "./log";
import { getChannelPgPool } from "./pg-pool";
import { runLockKey, type ChannelMessageJob } from "./run";
import { createRunLock, type LockRedis } from "./run-lock";
import type { ChannelWebhookDeps } from "./webhook";
import type { AgentChannelRow, WhatsAppChannelConfig } from "./types";

/** Everything the channel code keeps in Redis goes through this one slice of node-redis v4. */
export type ChannelStore = KeyValueStore & LockRedis;

export const channelStoreFromRedis = (client: RedisClientType): ChannelStore => ({
  set: (key, value, opts) =>
    client.set(key, value, opts.NX ? { EX: opts.EX, NX: true } : { EX: opts.EX }) as Promise<string | null>,
  getDel: (key) => client.getDel(key),
  del: (key) => client.del(key),
  incr: (key) => client.incr(key),
  expire: (key, seconds) => client.expire(key, seconds),
  get: (key) => client.get(key),
  ttl: (key) => client.ttl(key),
  eval: (script, options) => client.eval(script, options),
  exists: (key) => client.exists(key),
});

export interface ChannelServerEnv {
  /** channels && queues */
  entitled(): boolean;
  /** global limit on the public route */
  rateLimitExceeded(): boolean;
  getDb(): Promise<Knex>;
  getRedis(): Promise<RedisClientType | null>;
  loadAgent(id: string): Promise<GuestAgent | undefined>;
  enqueue(job: ChannelMessageJob): Promise<void>;
  /** per linked user; defaults to the external-user limiter */
  userRateLimited?(userId: number): boolean;
  now?(): Date;
  /** test seams */
  getTransport?: typeof defaultGetTransport;
  storeFor?(client: RedisClientType): ChannelStore;
}

const newSessionKey = (channelId: string, identity: string) => `channel-new-session:${channelId}:${identity}`;

export const createDecideDeps = (p: {
  row: AgentChannelRow;
  config: WhatsAppChannelConfig;
  db: Knex;
  store: ChannelStore;
  env: ChannelServerEnv;
}): DecideDeps => {
  const { row, config, db, store, env } = p;
  const lock = createRunLock(store);
  const userRateLimited = env.userRateLimited ?? ((userId: number) => externalRateLimitExceeded(String(userId)));
  return {
    now: env.now ?? (() => new Date()),
    config,
    // lazily: a missing URL variable must only affect the link reply, never linked users
    linkUrl: () => linkPageUrl(row.agent),
    links: createLinkStore(db),
    consumeCode: (code) => consumeCode(store, code),
    codeAttemptsExceeded: (identity) => codeAttemptsExceeded(store, row.id, identity),
    linkPromptAllowed: (identity) => linkPromptAllowed(store, row.id, identity),
    accessAllowed: (userId) =>
      channelAccessAllowed({ db, loadAgent: env.loadAgent, agentId: row.agent, channelId: row.id, userId }),
    rateLimited: (userId) => userRateLimited(userId),
    runInFlight: (identity) => lock.held(runLockKey(row.id, identity)),
    // a marker older than the idle window is moot: the next run starts a new session anyway
    markNewSession: async (identity) => {
      await store.set(newSessionKey(row.id, identity), "1", { EX: config.sessionIdleHours * 3600 });
    },
    takeNewSession: async (identity) => (await store.getDel(newSessionKey(row.id, identity))) !== null,
    audit: createChannelAuditor({ channelId: row.id, agentId: row.agent, kv: store }),
  };
};

const readyClient = async (env: ChannelServerEnv): Promise<RedisClientType | null> => {
  const client = await env.getRedis();
  return client && client.isReady ? client : null;
};

/** The server side of an inbound message: decide, then act. Model work happens in the worker. */
const handleInbound = async (
  row: AgentChannelRow,
  msg: InboundMessage,
  env: ChannelServerEnv,
  transportDeps: TransportDeps,
): Promise<void> => {
  const client = await readyClient(env);
  if (!client) throw new ChannelSetupError("redis unavailable");
  const store = (env.storeFor ?? channelStoreFromRedis)(client);
  const config = parseChannelConfig(row.config);
  const db = await env.getDb();
  const decision = await decideInbound(msg, createDecideDeps({ row, config, db, store, env }));
  // the instance that is handling this message, from the transport cache
  const transport = await (env.getTransport ?? defaultGetTransport)(row, transportDeps);
  if (!transport) throw new ChannelSetupError("channel transport unavailable");
  await actOnDecision(msg, decision, { config, transport, enqueue: env.enqueue, store });
};

export const createChannelWebhookDeps = (env: ChannelServerEnv): ChannelWebhookDeps => ({
  entitled: () => env.entitled(),
  rateLimitExceeded: () => env.rateLimitExceeded(),
  redisAvailable: async () => (await readyClient(env)) !== null,
  loadChannel: async (id) => (await env.getDb())("agent_channels").where({ id }).first(),
  transportFor: (row) => {
    const transportDeps: TransportDeps = {
      pgPool: getChannelPgPool(),
      onMessage: (msg) => handleInbound(row, msg, env, transportDeps),
    };
    return (env.getTransport ?? defaultGetTransport)(row, transportDeps);
  },
});
