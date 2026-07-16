// Public Mailgun raw-MIME webhook handler (spec §4.2). Durability ordering:
// verify → persist raw MIME to S3 → enqueue intake job → ACK 200. Any
// failure before the ACK returns 4xx/5xx and Mailgun retries for ~8h, so no
// verified email is silently lost. Deps are injected so the handler is unit
// testable; routes.ts wires the real S3/queue/db/redis.
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { bumpLastWebhookAt, getEmailInboundConfig, type EmailInboundConfig } from "./config";
import { isReplay, verifyMailgunSignature } from "./verify-mailgun";

export const EMAIL_INBOUND_S3_PREFIX = "email-inbound/";

// Cheap in-process fixed-window limiter for the public endpoint (spec §8).
// Mailgun retries on 429, so an over-limit burst degrades to delayed intake.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 300;
let rateWindowStart = 0;
let rateWindowCount = 0;
export const emailWebhookRateLimitExceeded = (now: number = Date.now()): boolean => {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount > RATE_MAX_REQUESTS;
};

export interface EmailWebhookDeps {
  licensedForQueues: () => boolean;
  getDb: () => Promise<any>;
  getRedis: () => Promise<any>;
  /** Persists the raw MIME; returns the storage key for the intake job. */
  putRawEmail: (key: string, body: Buffer) => Promise<string>;
  enqueueIntake: (payload: { s3Key: string; recipient?: string }) => Promise<void>;
  /** Injectable for tests; defaults to the module-level fixed window. */
  rateLimitExceeded?: () => boolean;
  /**
   * Optional injectable config loader — used by routes.ts to supply the
   * 30-second module-level cache. Tests that don't inject this fall back to
   * calling getEmailInboundConfig(db) directly (no cache, handler stays pure).
   */
  getEmailConfig?: (db: any) => Promise<EmailInboundConfig>;
}

export const createEmailWebhookHandler =
  (deps: EmailWebhookDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const rateLimitExceeded = deps.rateLimitExceeded ?? emailWebhookRateLimitExceeded;
    if (rateLimitExceeded()) {
      res.status(429).json({ detail: "Too many requests." });
      return;
    }
    if (!deps.licensedForQueues()) {
      res.status(503).json({ detail: "Email triggers require the queues entitlement." });
      return;
    }

    const db = await deps.getDb();
    const loadConfig = deps.getEmailConfig ?? getEmailInboundConfig;
    const config = await loadConfig(db);
    if (!config.enabled || !config.signing_key) {
      res.status(503).json({ detail: "Inbound email is not configured on this instance." });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
    const token = typeof body.token === "string" ? body.token : "";
    const signature = typeof body.signature === "string" ? body.signature : "";

    if (!verifyMailgunSignature({ timestamp, token, signature }, config.signing_key)) {
      console.warn("[EXULU-EMAIL] webhook rejected (invalid signature).");
      res.status(401).json({ detail: "invalid signature" });
      return;
    }

    const redis = await deps.getRedis();
    if (await isReplay(redis, token, timestamp)) {
      console.warn("[EXULU-EMAIL] webhook rejected (replay).");
      res.status(401).json({ detail: "replay rejected" });
      return;
    }

    // Setup debugging aid (spec §3.5): stamped on every VERIFIED webhook,
    // best-effort — a stats write must not fail the intake.
    void bumpLastWebhookAt(db).catch((err: unknown) => {
      console.error("[EXULU-EMAIL] failed to bump last_webhook_at", err);
    });

    const bodyMime = typeof body["body-mime"] === "string" ? body["body-mime"] : "";
    if (!bodyMime) {
      res.status(400).json({
        detail:
          "body-mime field is required. Configure the Mailgun route action as forward(...)/mime to this endpoint.",
      });
      return;
    }

    // Persist BEFORE ACK (spec §4.2.2).
    // latin1 encoding is intentional for byte fidelity: the multipart parser
    // (busboy with defCharset:"latin1") preserves every raw octet as its
    // latin1 code-point, so Buffer.from(str, "latin1") reconstructs the
    // exact original bytes. Using "utf8" here would corrupt 8-bit sequences
    // (e.g. 0xE9 → EF BF BD U+FFFD) because Node re-encodes the JS string
    // as UTF-8 rather than treating each char as a raw byte.
    try {
      const s3Key = await deps.putRawEmail(
        `${EMAIL_INBOUND_S3_PREFIX}${randomUUID()}.eml`,
        Buffer.from(bodyMime, "latin1"),
      );
      const recipient = typeof body.recipient === "string" ? body.recipient : undefined;
      await deps.enqueueIntake({ s3Key, ...(recipient ? { recipient } : {}) });
    } catch (error) {
      console.error("[EXULU-EMAIL] webhook persist/enqueue failed", error);
      res.status(500).json({ detail: "temporary failure, please retry" });
      return;
    }

    res.status(200).json({ ok: true });
  };
