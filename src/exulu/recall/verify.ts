/**
 * Verify that an incoming webhook/callback request actually came from Recall.ai
 * before processing it (RECALL-AI.AGENT.md §"Verifying requests from Recall.ai").
 *
 * Recall uses the Svix "Standard Webhooks" signature scheme. We verify the
 * signature against RECALL_WORKSPACE_VERIFICATION_SECRET using the EXACT raw
 * request body bytes — not the parsed/re-serialized JSON.
 *
 * Verification must succeed before any payload is stored, enqueued, or
 * processed. Unverified requests are rejected and logged.
 *
 * Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { recallVerificationSecret } from "./env";

/** Standard Webhooks allows a 5-minute clock skew to mitigate replay. */
const TOLERANCE_SECONDS = 5 * 60;

type HeaderBag = Record<string, string | string[] | undefined>;

const header = (headers: HeaderBag, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value == null) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
};

/**
 * Decode a Svix signing secret. Secrets are conventionally prefixed with
 * `whsec_` and the remainder is base64. If no prefix is present we treat the
 * whole string as the base64 secret.
 */
const secretKey = (secret: string): Buffer => {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(raw, "base64");
};

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a Recall webhook request.
 *
 * @param headers  the incoming request headers
 * @param rawBody  the exact raw request body (string or Buffer)
 * @param secret   override secret (defaults to RECALL_WORKSPACE_VERIFICATION_SECRET)
 */
export const verifyRecallRequest = (
  headers: HeaderBag,
  rawBody: string | Buffer,
  secret: string | undefined = recallVerificationSecret(),
): VerifyResult => {
  if (!secret) {
    return { ok: false, reason: "verification secret not configured" };
  }

  const id = header(headers, "svix-id", "webhook-id");
  const timestamp = header(headers, "svix-timestamp", "webhook-timestamp");
  const signatureHeader = header(headers, "svix-signature", "webhook-signature");

  if (!id || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing signature headers" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: "invalid timestamp" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const body =
    typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${id}.${timestamp}.${body}`;

  const expected = createHmac("sha256", secretKey(secret))
    .update(signedContent)
    .digest("base64");

  // The header is a space-delimited list of `version,signature` pairs. After a
  // secret rotation Recall may send several valid signatures for up to 24h, so
  // a match on ANY entry is sufficient.
  const passed = signatureHeader.split(" ").some((entry) => {
    const [, sig] = entry.split(",");
    return !!sig && safeEqual(sig, expected);
  });

  return passed ? { ok: true } : { ok: false, reason: "signature mismatch" };
};
