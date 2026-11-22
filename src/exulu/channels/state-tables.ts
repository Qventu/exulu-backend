import { Pool } from "pg";
import { channelsLicensed } from "./licence";
import { safeError } from "./log";

type StateModule = {
  createPostgresState: (options: {
    client: Pool;
    keyPrefix: string;
    autoCreateSchema: boolean;
  }) => { connect(): Promise<void>; disconnect(): Promise<void> };
};

/** The state adapter's key prefix for every channel (chat-instance.ts uses the same). */
export const CHAT_STATE_KEY_PREFIX = "exulu-channel";

// The chat SDK packages are ESM only and jest runs our sources as CommonJS, so
// they are only ever imported dynamically, and the loader is injectable.
const loadStateModule = (): Promise<StateModule> =>
  import("@chat-adapter/state-pg") as unknown as Promise<StateModule>;

/**
 * Creates the chat SDK's `chat_state_*` tables with the adapter's own DDL
 * (autoCreateSchema), so nothing is copied here and a later SDK version brings
 * its own schema. Only meant to run from `utils:initdb`.
 */
export async function ensureChatStateTables(
  pool: Pool,
  load: () => Promise<StateModule> = loadStateModule,
): Promise<void> {
  const { createPostgresState } = await load();
  const state = createPostgresState({
    client: pool,
    keyPrefix: CHAT_STATE_KEY_PREFIX,
    autoCreateSchema: true,
  });
  try {
    await state.connect();
  } finally {
    await state.disconnect();
  }
}

/**
 * The adapter's tables that carry an `expires_at` column (@chat-adapter/state-pg 4.45.0 DDL).
 * The adapter skips expired rows on read but never deletes them (only `get` deletes the one
 * expired cache row it was asked for). chat_state_subscriptions has no expiry.
 */
const EXPIRING_TABLES = ["chat_state_locks", "chat_state_cache", "chat_state_lists", "chat_state_queues"] as const;

/**
 * Deletes the expired rows under our key prefix: the per-message `dedupe:` rows and the
 * inbound `msg-history:` lists (message text, sender id, profile name) once their TTL has
 * passed. Rows without an expiry (the adapter's identity aliases and routes) are kept.
 * No-op without the licence or when a table does not exist; never throws.
 */
export async function purgeExpiredChatState(pool: Pool): Promise<void> {
  if (!channelsLicensed()) return;
  try {
    const present = await pool.query<{ name: string }>(
      `SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass(name) IS NOT NULL`,
      [[...EXPIRING_TABLES]],
    );
    const existing = new Set(present.rows.map((r) => r.name));
    for (const table of EXPIRING_TABLES) {
      if (!existing.has(table)) continue;
      // table names come from the constant above, never from input
      await pool.query(
        `DELETE FROM ${table} WHERE key_prefix = $1 AND expires_at IS NOT NULL AND expires_at <= now()`,
        [CHAT_STATE_KEY_PREFIX],
      );
    }
  } catch (error) {
    console.error("[EXULU-CHANNEL] purging expired chat state failed", safeError(error));
  }
}

/**
 * The pool for the initdb step: short-lived, built from the same connection settings as
 * postgresClient() (the adapter wants a pg.Pool, not knex).
 */
const initdbPool = (): Pool =>
  new Pool({
    host: process.env.POSTGRES_DB_HOST,
    port: parseInt(process.env.POSTGRES_DB_PORT || "5432"),
    user: process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME || "exulu",
    password: process.env.POSTGRES_DB_PASSWORD,
    ssl: process.env.POSTGRES_DB_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 2,
  });

/**
 * The `utils:initdb` step for the chat SDK's tables: pool, dynamic import, the adapter's DDL,
 * then purgeExpiredChatState. utils:initdb runs on every server and worker boot and a failing
 * step is fatal there, so this never throws: any failure is one log line and boot continues
 * (channels then fail per webhook until a later initdb succeeds). The pool is always ended.
 */
export async function initChatStateTables(
  opts: { createPool?: () => Pool; load?: () => Promise<StateModule> } = {},
): Promise<void> {
  let pool: Pool | undefined;
  try {
    pool = (opts.createPool ?? initdbPool)();
    await ensureChatStateTables(pool, opts.load ?? loadStateModule);
    await purgeExpiredChatState(pool);
  } catch (error) {
    console.error(
      "[EXULU-CHANNEL] chat state tables not created; WhatsApp channels will not work until this succeeds",
      safeError(error),
    );
  } finally {
    // ending a short-lived pool cannot fail the boot either
    await pool?.end().catch(() => undefined);
  }
}

export const CHAT_STATE_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** When this process last started a purge from the webhook path (ms since epoch). */
let lastPurgeStartedAt: number | null = null;

/** test seam */
export const resetChatStatePurgeThrottle = (): void => {
  lastPurgeStartedAt = null;
};

/**
 * Starts purgeExpiredChatState at most once per CHAT_STATE_PURGE_INTERVAL_MS per process and
 * does not wait for it. Returns whether a purge was started. Never throws, never rejects.
 */
export const purgeChatStateThrottled = (
  pool: Pool,
  now: number = Date.now(),
  purge: (pool: Pool) => Promise<void> = purgeExpiredChatState,
): boolean => {
  if (lastPurgeStartedAt !== null && now - lastPurgeStartedAt < CHAT_STATE_PURGE_INTERVAL_MS) return false;
  lastPurgeStartedAt = now;
  // started synchronously; a synchronous throw becomes a rejection of the async wrapper
  void (async () => purge(pool))().catch((error) => console.error("[EXULU-CHANNEL] purging expired chat state failed", safeError(error)));
  return true;
};
