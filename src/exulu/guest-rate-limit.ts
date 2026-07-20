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
const maxTotalChars = () =>
  parseInt(process.env.EXULU_GUEST_MAX_TOTAL_CHARS || "32000", 10);
const MAX_PART_COUNT = 100;

interface WindowState {
  minuteStart: number;
  minuteCount: number;
  hourStart: number;
  hourCount: number;
  lastSeen: number;
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
  windows.set(ip, state);
  // Bound memory: drop stale IPs opportunistically once the map grows.
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
  return state.minuteCount > perMinuteLimit() || state.hourCount > perHourLimit();
};

const partsTooLong = (parts: unknown): boolean =>
  Array.isArray(parts) &&
  parts.some(
    (p: any) =>
      typeof p?.text === "string" && p.text.length > maxMessageChars(),
  );

/** Collect all text parts from a body's message / messages fields. */
const collectTextParts = (b: any): string[] => {
  const parts: string[] = [];
  const addFromParts = (ps: unknown) => {
    if (!Array.isArray(ps)) return;
    for (const p of ps) {
      if (typeof p?.text === "string") parts.push(p.text);
    }
  };
  if (b.message) addFromParts(b.message.parts);
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) addFromParts(m?.parts);
  }
  return parts;
};

/**
 * True when the request body exceeds any of the guest message caps:
 * - any single text part exceeds EXULU_GUEST_MAX_MESSAGE_CHARS (default 8000)
 * - total text across all parts exceeds EXULU_GUEST_MAX_TOTAL_CHARS (default 32000)
 * - total number of text parts across the payload exceeds 100
 */
export const guestMessageTooLong = (body: unknown): boolean => {
  const b = body as any;
  if (!b) return false;
  // Per-part cap check.
  if (b.message && partsTooLong(b.message.parts)) return true;
  if (Array.isArray(b.messages)) {
    if (b.messages.some((m: any) => partsTooLong(m?.parts))) return true;
  }
  // Cumulative caps.
  const allParts = collectTextParts(b);
  if (allParts.length > MAX_PART_COUNT) return true;
  const totalChars = allParts.reduce((sum, t) => sum + t.length, 0);
  if (totalChars > maxTotalChars()) return true;
  return false;
};

/**
 * Extract the real client IP.
 * - When EXULU_TRUST_PROXY=true (i.e. the backend sits behind a trusted
 *   reverse-proxy that appends the real client IP to x-forwarded-for), we
 *   use the LAST entry of the header — the hop our own proxy appended.
 * - Otherwise x-forwarded-for is ignored (it is trivially spoofable by the
 *   client) and we fall back to the raw socket address.
 */
export const extractClientIp = (req: {
  headers: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (process.env.EXULU_TRUST_PROXY === "true") {
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const parts = forwarded.split(",");
      return parts[parts.length - 1]!.trim();
    }
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
};

/** Returns the current number of tracked IPs. Exposed for testing. */
export const guestRateLimitMapSize = (): number => windows.size;
