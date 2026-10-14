// ee/claim-check/rate-limit.ts
//
// One request can cost ~18 provider calls on arbitrary input, so this applies
// to EVERY role, not just external users (spec §4): a per-user fixed window
// plus a global in-flight cap, so a burst cannot drain the provider quota the
// chat itself needs.

const DEFAULTS = { perMinute: 30, perHour: 300, maxInFlight: 20 };

type Window = { minute: number; minuteStart: number; hour: number; hourStart: number };

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
      const current = windows.get(userId) ?? { minute: 0, minuteStart: now, hour: 0, hourStart: now };
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
  };
}

export type ClaimCheckRateLimiter = ReturnType<typeof claimCheckRateLimiter>;
