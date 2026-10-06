/**
 * In-process fixed-window per-user limiter for authenticated external users.
 * (Two windows: per-minute and per-hour, so a burst-then-trickle can't
 * exhaust the hourly budget in one minute.)
 * Not distributed — acceptable for the single-process backend; revisit
 * if the backend is ever horizontally scaled.
 */
import type { User } from "@EXULU_TYPES/models/user";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const perMinuteLimit = () =>
  parseInt(process.env.EXULU_EXTERNAL_RATE_PER_MINUTE || "30", 10);
const perHourLimit = () =>
  parseInt(process.env.EXULU_EXTERNAL_RATE_PER_HOUR || "300", 10);

interface WindowState {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
  lastSeen: number;
}

let windows = new Map<string, WindowState>();

export const resetExternalRateLimit = (): void => {
  windows = new Map();
};

export const externalRateLimitExceeded = (
  userId: string,
  now: number = Date.now(),
): boolean => {
  const state = windows.get(userId) ?? {
    minuteStart: now,
    minuteCount: 0,
    hourStart: now,
    hourCount: 0,
    lastSeen: now,
  };
  if (now - state.minuteStart >= MINUTE_MS) {
    state.minuteStart = now;
    state.minuteCount = 0;
  }
  if (now - state.hourStart >= HOUR_MS) {
    state.hourStart = now;
    state.hourCount = 0;
  }
  state.minuteCount += 1;
  state.hourCount += 1;
  state.lastSeen = now;
  windows.set(userId, state);
  // Bound memory: drop stale users opportunistically once the map grows.
  // Deleting from a Map during for...of iteration is safe in V8/Node.
  if (windows.size > 10_000) {
    for (const [key, value] of windows) {
      if (now - value.lastSeen >= HOUR_MS) windows.delete(key);
    }
    // Hard cap: if still over 10_000 after stale-prune (e.g. under attack),
    // evict the oldest entries by lastSeen until at or under the cap.
    if (windows.size > 10_000) {
      const sorted = [...windows.entries()].sort(
        (a, b) => a[1].lastSeen - b[1].lastSeen,
      );
      for (const [key] of sorted) {
        if (windows.size <= 10_000) break;
        windows.delete(key);
      }
    }
  }
  const minuteLimitExceeded = state.minuteCount > perMinuteLimit();
  const hourLimitExceeded = state.hourCount > perHourLimit();
  const limitExceeded = minuteLimitExceeded || hourLimitExceeded;

  if (limitExceeded) {
    const limits = {
      perMinute: perMinuteLimit(),
      perHour: perHourLimit(),
    };
    const current = {
      minute: state.minuteCount,
      hour: state.hourCount,
    };
    console.warn(
      `[EXULU] Rate limit exceeded for user ${userId}${minuteLimitExceeded ? ` per-minute (${current.minute}/${limits.perMinute})` : ""}${minuteLimitExceeded && hourLimitExceeded ? " and" : ""}${hourLimitExceeded ? ` per-hour (${current.hour}/${limits.perHour})` : ""}`,
    );
  }

  return limitExceeded;
};

/**
 * Check if a user has the 'external' role and should be subject to rate limiting.
 * A type guard so callers get `user` narrowed to non-null after a truthy check.
 */
export const isExternalUser = (
  user: User | null | undefined,
): user is User => {
  return user?.role?.name === "external";
};

/** Returns the current number of tracked user IDs. Exposed for testing. */
export const externalRateLimitMapSize = (): number => windows.size;
