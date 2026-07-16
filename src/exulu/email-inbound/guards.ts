// Guard chain (spec §4.4, order fixed): auto-reply → allowlist → rate
// limits → DB dedup → regex filters. Each miss records a `filtered` row with
// its reason (done by the intake job, not here).
import type { InboundEmail, WorkflowTriggerRow } from "./types";
import { parseTriggerConfig } from "./types";

export type FilteredReason =
  | "sender_not_allowed"
  | "filter"
  | "rate_limited"
  | "duplicate"
  | "auto_reply";

export const DEFAULT_TRIGGER_RATE_LIMIT_PER_HOUR = 60;
export const DEFAULT_SENDER_RATE_LIMIT_PER_HOUR = 10;
export const DEFAULT_FILTERED_RUN_RETENTION = 200;

/** Regex evaluation is capped on input length (spec §8, ReDoS mitigation). */
const FILTER_BODY_BYTE_CAP = 10 * 1024;

const AUTO_REPLY_PRECEDENCE = new Set(["bulk", "junk", "list"]);
const HOUR_MS = 60 * 60 * 1000;

/**
 * Auto-reply/loop guard (spec §4.4.2, all comparisons case-insensitive):
 * Auto-Submitted present with value ≠ "no", Precedence ∈ bulk|junk|list,
 * X-Autoreply/X-Autorespond present, or the sender is this instance's own
 * SMTP_FROM (guard skipped if SMTP_FROM unset).
 */
export const isAutoReply = (email: InboundEmail): boolean => {
  const autoSubmitted = email.headers.get("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") {
    return true;
  }
  const precedence = email.headers.get("precedence");
  if (precedence !== undefined && AUTO_REPLY_PRECEDENCE.has(precedence.trim().toLowerCase())) {
    return true;
  }
  if (email.headers.has("x-autoreply") || email.headers.has("x-autorespond")) {
    return true;
  }
  const smtpFrom = process.env.SMTP_FROM?.trim().toLowerCase();
  if (smtpFrom && email.from.address.toLowerCase() === smtpFrom) {
    return true;
  }
  return false;
};

/** Exact match (case-insensitive) or "*@domain" glob; empty list allows all. */
export const senderAllowed = (
  address: string,
  allowedSenders: string[] | undefined,
): boolean => {
  if (allowedSenders === undefined || allowedSenders.length === 0) return true;
  const candidate = address.toLowerCase();
  return allowedSenders.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith("*@")) return candidate.endsWith(rule.slice(1));
    return candidate === rule;
  });
};

/**
 * Sliding-window counter over the current + previous hour buckets. Counters
 * are best-effort (a Redis flush resets windows, spec §4.4.4); without Redis
 * the limit is skipped entirely. On Redis operation error (incr/get/expire),
 * logs and degrades to best-effort allow (matching the null-client path).
 */
export const checkRateLimit = async (
  redis: any,
  key: string,
  limitPerHour: number,
  now: number = Date.now(),
): Promise<boolean> => {
  if (!redis) return true;
  try {
    const currentBucket = Math.floor(now / HOUR_MS);
    const currentKey = `${key}:${currentBucket}`;
    const previousKey = `${key}:${currentBucket - 1}`;
    const count = await redis.incr(currentKey);
    if (count === 1) {
      await redis.expire(currentKey, 2 * 60 * 60);
    }
    const previousRaw = await redis.get(previousKey);
    const previous = previousRaw ? Number(previousRaw) : 0;
    const elapsedFraction = (now % HOUR_MS) / HOUR_MS;
    const weighted = count + previous * (1 - elapsedFraction);
    return weighted <= limitPerHour;
  } catch (err) {
    console.error(
      "[EXULU] email-inbound rate limit: redis unavailable, allowing (best-effort)",
      err instanceof Error ? err.message : String(err),
    );
    return true;
  }
};

/** Each {field, pattern} rule must match; body is capped at 10KB. */
export const matchesFilters = (
  email: InboundEmail,
  filters: { field: string; pattern: string }[] | undefined,
): { ok: true } | { ok: false; failedRule: string } => {
  if (!filters?.length) return { ok: true };
  const body = email.text.slice(0, FILTER_BODY_BYTE_CAP);
  for (const rule of filters) {
    const failedRule = `${rule.field}:${rule.pattern}`;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern, "i");
    } catch {
      return { ok: false, failedRule };
    }
    let matched = false;
    if (rule.field === "from") matched = regex.test(email.from.address);
    else if (rule.field === "subject") matched = regex.test(email.subject);
    else if (rule.field === "body") matched = regex.test(body);
    else if (rule.field === "attachment_name") {
      matched = email.attachments.some((attachment) => regex.test(attachment.filename));
    }
    if (!matched) return { ok: false, failedRule };
  }
  return { ok: true };
};

/**
 * DB-backed Message-ID dedup (spec §4.4.5) — survives webhook retries,
 * intake-job retries, and Redis restarts. Backed by the
 * job_results_email_dedup_idx expression index.
 */
export const findDuplicateRun = async (
  db: any,
  workflowId: string,
  messageId: string,
): Promise<any | undefined> => {
  return db
    .from("job_results")
    .where({ workflow: workflowId, trigger: "email" })
    .whereRaw("trigger_metadata->>'message_id' = ?", [messageId])
    .first();
};

export async function runGuardChain(opts: {
  email: InboundEmail;
  trigger: WorkflowTriggerRow;
  db: any;
  redis: any;
}): Promise<{ ok: true } | { ok: false; reason: FilteredReason; failedRule?: string }> {
  const { email, trigger, db, redis } = opts;
  const config = parseTriggerConfig(trigger.config);

  if (isAutoReply(email)) {
    return { ok: false, reason: "auto_reply" };
  }

  if (!senderAllowed(email.from.address, config.allowed_senders)) {
    return { ok: false, reason: "sender_not_allowed" };
  }

  const triggerLimit = config.rate_limit_per_hour ?? DEFAULT_TRIGGER_RATE_LIMIT_PER_HOUR;
  if (!(await checkRateLimit(redis, `email_inbound:rate:${trigger.id}`, triggerLimit))) {
    return { ok: false, reason: "rate_limited" };
  }
  const senderLimit =
    config.sender_rate_limit_per_hour ?? DEFAULT_SENDER_RATE_LIMIT_PER_HOUR;
  const senderKey = `email_inbound:rate:${trigger.id}:${email.from.address.toLowerCase()}`;
  if (!(await checkRateLimit(redis, senderKey, senderLimit))) {
    return { ok: false, reason: "rate_limited" };
  }

  if (await findDuplicateRun(db, trigger.workflow, email.messageId)) {
    return { ok: false, reason: "duplicate" };
  }

  const filterResult = matchesFilters(email, config.filters);
  if (!filterResult.ok) {
    return { ok: false, reason: "filter", failedRule: filterResult.failedRule };
  }

  return { ok: true };
}
