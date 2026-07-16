// Mailgun webhook authentication (spec §4.2.1): signature = HMAC-SHA256 over
// timestamp + token with the domain's HTTP webhook signing key (NOT the API
// key). The HMAC does not cover the body — payloads are authenticated-origin,
// not integrity-protected; authorization derives from the signature, never
// from `recipient` alone (spec §8).
import { createHmac, timingSafeEqual } from "node:crypto";

/** Reject webhooks whose timestamp is older than this (seconds). */
export const MAILGUN_REPLAY_WINDOW_SECONDS = 300;
/** Seen-token cache TTL — comfortably covers the skew window (spec §4.2.1). */
const REPLAY_TOKEN_TTL_SECONDS = 900;

export function verifyMailgunSignature(
  params: { timestamp: string; token: string; signature: string },
  signingKey: string,
): boolean {
  if (!params.timestamp || !params.token || !params.signature || !signingKey) {
    return false;
  }
  const expected = createHmac("sha256", signingKey)
    .update(params.timestamp + params.token)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(params.signature, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * True when the webhook must be rejected as a replay: timestamp outside the
 * 5-minute window, unparseable, or a token we have already accepted (Redis
 * SETNX, TTL 900s). Longer-horizon duplicates are handled by the DB-backed
 * Message-ID dedup in the guard chain. Without Redis this degrades to the
 * timestamp window only (best-effort, deterministic degradation on error).
 */
export async function isReplay(redis: any, token: string, timestamp: string): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return true;
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSeconds > MAILGUN_REPLAY_WINDOW_SECONDS) {
    return true;
  }
  if (!redis) {
    return false;
  }
  try {
    const result = await redis.set(`email_inbound:replay:${token}`, "1", {
      NX: true,
      EX: REPLAY_TOKEN_TTL_SECONDS,
    });
    return result === null;
  } catch (err) {
    console.error(
      "[EXULU] email-inbound replay guard: redis unavailable, degrading to timestamp-window-only",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
