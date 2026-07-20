/**
 * In-process fixed-window per-IP limiter for anonymous guest chat
 * (spec §3.5). Modeled on the email-webhook limiter; two windows so a
 * burst-then-trickle can't exhaust the hourly budget in one minute.
 * Not distributed — acceptable for the single-process backend; revisit
 * if the backend is ever horizontally scaled.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const perMinuteLimit = () =>
  parseInt(process.env.EXULU_GUEST_RATE_PER_MINUTE || "10", 10);
const perHourLimit = () =>
  parseInt(process.env.EXULU_GUEST_RATE_PER_HOUR || "60", 10);
const maxMessageChars = () =>
  parseInt(process.env.EXULU_GUEST_MAX_MESSAGE_CHARS || "8000", 10);

interface WindowState {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
}

let windows = new Map<string, WindowState>();

export const resetGuestRateLimit = (): void => {
  windows = new Map();
};

export const guestRateLimitExceeded = (
  ip: string,
  now: number = Date.now(),
): boolean => {
  const state = windows.get(ip) ?? {
    minuteStart: now,
    minuteCount: 0,
    hourStart: now,
    hourCount: 0,
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
  windows.set(ip, state);
  // Bound memory: drop stale IPs opportunistically once the map grows.
  if (windows.size > 10_000) {
    for (const [key, value] of windows) {
      if (now - value.hourStart >= HOUR_MS) windows.delete(key);
    }
  }
  return state.minuteCount > perMinuteLimit() || state.hourCount > perHourLimit();
};

const partsTooLong = (parts: unknown): boolean =>
  Array.isArray(parts) &&
  parts.some(
    (p: any) =>
      typeof p?.text === "string" && p.text.length > maxMessageChars(),
  );

/** True when any text part in body.message or body.messages exceeds the cap. */
export const guestMessageTooLong = (body: unknown): boolean => {
  const b = body as any;
  if (!b) return false;
  if (b.message && partsTooLong(b.message.parts)) return true;
  if (Array.isArray(b.messages)) {
    return b.messages.some((m: any) => partsTooLong(m?.parts));
  }
  return false;
};

export const extractClientIp = (req: {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
};
