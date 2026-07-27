// Generic per-trigger webhook signature verification (spec §4.4). HMAC-SHA256
// over the raw request body (optionally prefixed with a timestamp for replay
// defense) using the trigger's decrypted signing_secret. Replaces the former
// Mailgun timestamp+token scheme.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_REPLAY_WINDOW_SECONDS = 300;
const REPLAY_TTL_SECONDS = 900;

/**
 * Verify `X-Exulu-Signature: sha256=<hex>` over the raw body. When a timestamp
 * header is supplied the signed message is `timestamp + "." + rawBody`.
 */
export function verifyPayloadSignature(
  rawBody: Buffer,
  signatureHeader: string,
  timestampHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const message = timestampHeader
    ? Buffer.concat([Buffer.from(`${timestampHeader}.`), rawBody])
    : rawBody;
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided.toLowerCase(), "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * True when the request must be rejected as a replay: timestamp outside the
 * window, unparseable, or a signature already seen (Redis SETNX, TTL 900 s).
 * Degrades to the timestamp window only when Redis is unavailable.
 */
export async function isReplay(redis: any, signature: string, timestamp: string): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return true;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SIGNATURE_REPLAY_WINDOW_SECONDS) return true;
  if (!redis) return false;
  try {
    const result = await redis.set(`routine_webhook:replay:${signature}`, "1", {
      NX: true,
      EX: REPLAY_TTL_SECONDS,
    });
    return result === null;
  } catch (err) {
    console.error(
      "[EXULU] routine-webhook replay guard: redis unavailable, degrading to window-only",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}
