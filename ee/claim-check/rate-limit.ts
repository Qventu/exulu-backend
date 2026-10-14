// ee/claim-check/rate-limit.ts
//
// One request can cost ~18 provider calls on arbitrary input, so this applies
// to EVERY role, not just external users (spec §4): a per-user fixed window
// plus a global in-flight cap, so a burst cannot drain the provider quota the
// chat itself needs.

const DEFAULTS = { perMinute: 30, perHour: 300, maxInFlight: 20 };

/** Bound the per-user map, as src/exulu/external-rate-limit.ts does: an
 *  unbounded one grows for the lifetime of the process. */
const MAX_TRACKED_USERS = 10_000;
const HOUR_MS = 3_600_000;

type Window = { minute: number; minuteStart: number; hour: number; hourStart: number; lastSeen: number };

/** Drop windows nobody has used for an hour; if still over the cap (under
 *  attack with fresh ids), evict the least recently seen until at the cap. */
function evict(windows: Map<string, Window>, now: number): void {
  if (windows.size <= MAX_TRACKED_USERS) return;
  for (const [key, value] of windows) {
    if (now - value.lastSeen >= HOUR_MS) windows.delete(key);
  }
  if (windows.size <= MAX_TRACKED_USERS) return;
  const sorted = [...windows.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  for (const [key] of sorted) {
    if (windows.size <= MAX_TRACKED_USERS) break;
    windows.delete(key);
  }
}

export function claimCheckRateLimiter(opts: Partial<typeof DEFAULTS> = {}) {
  const { perMinute, perHour, maxInFlight } = { ...DEFAULTS, ...opts };
  const windows = new Map<string, Window>();
  let inFlight = 0;

  return {
    take(userId: string): { ok: boolean; reason?: string } {
      if (inFlight >= maxInFlight) {
        return { ok: false, reason: `too many claim checks in flight (${maxInFlight})` };
      }
      const now = Date.now();
      const current = windows.get(userId) ?? { minute: 0, minuteStart: now, hour: 0, hourStart: now, lastSeen: now };
      current.lastSeen = now;
      if (now - current.minuteStart >= 60_000) {
        current.minute = 0;
        current.minuteStart = now;
      }
      if (now - current.hourStart >= 3_600_000) {
        current.hour = 0;
        current.hourStart = now;
      }
      if (current.minute >= perMinute) {
        windows.set(userId, current);
        return { ok: false, reason: `per-minute claim-check limit reached (${perMinute})` };
      }
      if (current.hour >= perHour) {
        windows.set(userId, current);
        return { ok: false, reason: `per-hour claim-check limit reached (${perHour})` };
      }
      current.minute += 1;
      current.hour += 1;
      windows.set(userId, current);
      evict(windows, now);
      inFlight += 1;
      return { ok: true };
    },
    release(): void {
      inFlight = Math.max(0, inFlight - 1);
    },
    reset(): void {
      windows.clear();
      inFlight = 0;
    },
    /** Number of tracked users. Exposed for the eviction test only. */
    trackedUsers(): number {
      return windows.size;
    },
  };
}

export type ClaimCheckRateLimiter = ReturnType<typeof claimCheckRateLimiter>;
