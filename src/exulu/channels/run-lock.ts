import { randomBytes } from "crypto";

/** The slice of node-redis v4 the run lock needs; the real client is passed in. */
export interface LockRedis {
  set(key: string, value: string, opts: { NX: true; EX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  exists(key: string): Promise<number>;
}

/** Deletes the key only while it still holds the caller's token, atomically. */
export const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * The per-identity run lock (RunDeps.lock) and its read side (DecideDeps.runInFlight).
 * `acquire` returns an owner token or null when the lock is held; `release` is a
 * compare-and-delete, so a job that outlived the TTL cannot remove a newer job's lock.
 */
export const createRunLock = (redis: LockRedis) => ({
  async acquire(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomBytes(16).toString("hex");
    const result = await redis.set(key, token, { NX: true, EX: ttlSeconds });
    return result === null ? null : token;
  },
  async release(key: string, token: string): Promise<void> {
    await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
  },
  async held(key: string): Promise<boolean> {
    return (await redis.exists(key)) > 0;
  },
});
