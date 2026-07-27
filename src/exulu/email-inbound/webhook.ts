// Public generic routine webhook (spec §4). Durability ordering: resolve
// trigger by secret → (optional) verify HMAC → detect format → persist raw
// payload to S3 → enqueue intake → ACK 200. Any failure before ACK returns
// 4xx/5xx so a retrying forwarder is safe (DB message_id dedup downstream).
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import type { WorkflowTriggerRow } from "./types";
import { detectPayloadFormat, extractMultipartMimePart } from "./adapters";
import { isReplay, verifyPayloadSignature } from "./verify-signature";

export const EMAIL_INBOUND_S3_PREFIX = "inbound-webhook/";

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 300;
let rateWindowStart = 0;
let rateWindowCount = 0;
export const routineWebhookRateLimitExceeded = (now: number = Date.now()): boolean => {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount > RATE_MAX_REQUESTS;
};

export interface RoutineWebhookDeps {
  licensedForQueues: () => boolean;
  getDb: () => Promise<any>;
  getRedis: () => Promise<any>;
  resolveTrigger: (db: any, secret: string) => Promise<WorkflowTriggerRow | undefined>;
  decryptSigningSecret: (encrypted: string) => string;
  /** Persists the raw payload; returns the storage key for the intake job. */
  putRawPayload: (key: string, body: Buffer) => Promise<string>;
  enqueueIntake: (payload: { s3Key: string; triggerId: string; format: "eml" | "json" }) => Promise<void>;
  stampLastFiredAt: (db: any, triggerId: string) => Promise<void>;
  rateLimitExceeded?: () => boolean;
}

export const createRoutineWebhookHandler =
  (deps: RoutineWebhookDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const rateLimitExceeded = deps.rateLimitExceeded ?? routineWebhookRateLimitExceeded;
    if (rateLimitExceeded()) {
      res.status(429).json({ detail: "Too many requests." });
      return;
    }
    if (!deps.licensedForQueues()) {
      res.status(503).json({ detail: "Routine webhooks require the queues entitlement." });
      return;
    }

    const secret = String((req.params as any).secret ?? "");
    const db = await deps.getDb();
    const trigger = secret.length > 0 ? await deps.resolveTrigger(db, secret) : undefined;
    // 404 (not 401/403) on unknown/disabled: no enumeration oracle.
    if (!trigger || trigger.type !== "email" || !trigger.enabled) {
      console.warn("[EXULU-WEBHOOK] rejected (unknown/disabled secret).");
      res.status(404).json({ detail: "not found" });
      return;
    }

    const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const contentType = String(req.headers["content-type"] ?? "");

    // Optional per-trigger HMAC (spec §4.4).
    if (trigger.signing_secret) {
      const signature = String(req.headers["x-exulu-signature"] ?? "");
      const timestamp = req.headers["x-exulu-timestamp"] ? String(req.headers["x-exulu-timestamp"]) : undefined;
      const secretPlain = deps.decryptSigningSecret(trigger.signing_secret);
      if (!verifyPayloadSignature(rawBody, signature, timestamp, secretPlain)) {
        console.warn("[EXULU-WEBHOOK] rejected (invalid signature).");
        res.status(401).json({ detail: "invalid signature" });
        return;
      }
      if (timestamp) {
        const redis = await deps.getRedis();
        if (await isReplay(redis, signature, timestamp)) {
          res.status(401).json({ detail: "replay rejected" });
          return;
        }
      }
    }

    // Detect format and reduce to raw bytes to persist (spec §4.2).
    const kind = detectPayloadFormat(contentType);
    let payloadBytes: Buffer;
    let format: "eml" | "json";
    try {
      if (kind === "multipart") {
        payloadBytes = await extractMultipartMimePart(rawBody, contentType);
        format = "eml";
      } else if (kind === "json") {
        if (!rawBody.length) throw new Error("Empty JSON body.");
        payloadBytes = rawBody;
        format = "json";
      } else {
        if (!rawBody.length) throw new Error("Empty payload.");
        payloadBytes = rawBody;
        format = "eml";
      }
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : "bad payload" });
      return;
    }

    void deps.stampLastFiredAt(db, trigger.id).catch((e: unknown) =>
      console.error("[EXULU-WEBHOOK] failed to stamp last_fired_at", e),
    );

    try {
      const ext = format === "json" ? "json" : "eml";
      const s3Key = await deps.putRawPayload(`${EMAIL_INBOUND_S3_PREFIX}${randomUUID()}.${ext}`, payloadBytes);
      await deps.enqueueIntake({ s3Key, triggerId: trigger.id, format });
    } catch (error) {
      console.error("[EXULU-WEBHOOK] persist/enqueue failed", error);
      res.status(500).json({ detail: "temporary failure, please retry" });
      return;
    }

    res.status(200).json({ ok: true });
  };
