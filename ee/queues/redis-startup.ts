import { redisServer } from "./server";

/**
 * Loud, bounded Redis startup helpers.
 *
 * Without these, a Redis-down boot hangs SILENTLY: the BullMQ queue/worker connections retry
 * forever with no error listener and no timeout, so `exulu()` never returns and nothing is logged
 * (you just see repeated `connect ETIMEDOUT 127.0.0.1:6379` from the socket layer, if anything).
 *
 * These helpers make a Redis-dependent startup step:
 *   1. announce the target host:port it is connecting to,
 *   2. surface the (otherwise swallowed) connection errors with address + code,
 *   3. warn every few seconds while it is still blocked, and
 *   4. FAIL FAST with a clear error after REDIS_STARTUP_TIMEOUT_MS instead of hanging forever.
 */

/** Hard ceiling on a single Redis-dependent startup step before we abort instead of hanging. */
export const REDIS_STARTUP_TIMEOUT_MS = 60_000;
/** How often, while still blocked, to remind the operator that startup is stuck on Redis. */
const WATCHDOG_INTERVAL_MS = 10_000;
/** Throttle for the permanent per-connection error logger so a retry storm can't flood the log. */
const ERROR_LOG_THROTTLE_MS = 30_000;

const log = (line: string): void => console.log(`[EXULU-REDIS] ${line}`);
const warn = (line: string): void => console.warn(`[EXULU-REDIS] ${line}`);
const errorLog = (line: string): void => console.error(`[EXULU-REDIS] ${line}`);

/** The configured Redis target as `host:port` (with `(unset)` placeholders) for log/error messages. */
export const redisAddress = (): string =>
  `${redisServer.host || "(unset)"}:${redisServer.port || "(unset)"}`;

/** One-line, human-readable description of a Redis/socket error (code first, message head, no stack). */
const describeError = (e: unknown): string => {
  const any = e as any;
  const head = any?.message ? String(any.message).split("\n")[0] : undefined;
  if (any?.code) return head && head !== any.code ? `${any.code} (${head})` : `${any.code}`;
  return head ?? String(e);
};

/** Minimal structural shape shared by ioredis, node-redis clients, and BullMQ Queue/Worker. */
type RedisErrorSource = {
  on(event: "error", cb: (err: unknown) => void): unknown;
  off?(event: "error", cb: (err: unknown) => void): unknown;
};

/**
 * Attach a PERMANENT `error` listener that logs connection errors with the target address (the first
 * immediately, then at most once per throttle window). Also prevents node-redis/ioredis from treating
 * an `error` event as unhandled. Safe to call once per long-lived connection.
 */
export function logRedisErrors(source: RedisErrorSource, label: string): void {
  let count = 0;
  let lastLoggedAt = 0;
  source.on("error", (err) => {
    count += 1;
    const now = Date.now();
    if (count === 1 || now - lastLoggedAt >= ERROR_LOG_THROTTLE_MS) {
      errorLog(`${label} connection error (${redisAddress()}): ${describeError(err)}${count > 1 ? ` (x${count})` : ""}`);
      lastLoggedAt = now;
    }
  });
}

/**
 * Run a Redis-dependent startup step with loud logging + a hard timeout. Transparent on success
 * (returns `run()`'s value). While `run()` is pending it warns every WATCHDOG_INTERVAL_MS that startup
 * is blocked; if it does not settle within REDIS_STARTUP_TIMEOUT_MS it REJECTS with a clear error
 * (citing the address + last surfaced connection error) so the caller can fail the boot instead of
 * hanging forever. `source`, if given, is observed only to capture the latest error for that message.
 */
export async function guardRedisStartup<T>(
  label: string,
  run: () => Promise<T>,
  source?: RedisErrorSource,
): Promise<T> {
  const addr = redisAddress();
  log(`Connecting to Redis (${addr}) for ${label}…`);
  const startedAt = Date.now();

  let lastError: unknown;
  const onError = (err: unknown): void => { lastError = err; };
  source?.on("error", onError);

  const watchdog = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    warn(
      `⚠ Still waiting for Redis at ${addr} after ${secs}s — ${label} startup is blocked. ` +
        `Is Redis running? (aborting at ${REDIS_STARTUP_TIMEOUT_MS / 1000}s)`,
    );
  }, WATCHDOG_INTERVAL_MS);
  // Don't let the watchdog timer keep the event loop alive on its own; the timeout below holds it.
  (watchdog as { unref?: () => void }).unref?.();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `[EXULU-REDIS] Redis unreachable at ${addr} after ${REDIS_STARTUP_TIMEOUT_MS / 1000}s — aborting ${label} startup. ` +
            `Last error: ${lastError ? describeError(lastError) : "none surfaced"}. ` +
            `Check REDIS_HOST/REDIS_PORT and that a Redis server is reachable at ${addr}.`,
        ),
      );
    }, REDIS_STARTUP_TIMEOUT_MS);
  });

  // Mark the work promise handled so a rejection that lands AFTER the timeout already won the race
  // does not surface as an unhandledRejection.
  const runPromise = Promise.resolve().then(run);
  runPromise.catch(() => { /* handled via the race below or intentionally ignored post-timeout */ });

  try {
    const result = await Promise.race([runPromise, timeout]);
    log(`Redis ready; ${label} initialized (${addr}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s).`);
    return result as T;
  } finally {
    clearInterval(watchdog);
    if (timer) clearTimeout(timer);
    source?.off?.("error", onError);
  }
}
