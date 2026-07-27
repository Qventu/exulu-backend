// Email-triggered routines: shared types for the inbound-email pipeline.
// Everything downstream of normalize.ts consumes InboundEmail only — a
// future SES adapter produces the same shape without touching the pipeline.
// Design doc: docs/superpowers/specs/2026-07-15-email-triggered-routines-design.md §4.3

export interface InboundEmail {
  messageId: string;
  from: { address: string; name?: string };
  /** The per-routine address the email was sent to. */
  recipient: string;
  /** '' if absent. */
  subject: string;
  /** Plain-text body; derived from HTML if only HTML present; '' if neither. */
  text: string;
  /** Kept for future use; v1 uses text only. */
  html?: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  /** Header names lowercased. */
  headers: Map<string, string>;
}

export interface EmailTriggerFilterRule {
  field: "from" | "subject" | "body" | "attachment_name";
  pattern: string;
}

export interface EmailTriggerConfig {
  /** Optional; empty = allow all. Entries: exact address or "*@domain". */
  allowed_senders?: string[];
  /** Optional; ALL must match; empty = always fire. */
  filters?: EmailTriggerFilterRule[];
  /** Keep last X filtered rows for this trigger (default 200). */
  filtered_run_retention?: number;
  /** Per-trigger ceiling (default 60). */
  rate_limit_per_hour?: number;
  /** Per-sender-per-trigger ceiling (default 10). */
  sender_rate_limit_per_hour?: number;
}

export interface WorkflowTriggerRow {
  id: string;
  workflow: string;
  type: string;
  enabled: boolean;
  /** base64url secret; the /webhooks/routine/:secret routing + auth key. */
  secret: string;
  /** AES-encrypted HMAC shared secret, or null when signing is off. */
  signing_secret: string | null;
  last_fired_at: string | Date | null;
  /** jsonb — pg returns an object, but tolerate strings defensively. */
  config: EmailTriggerConfig | string;
  run_as_user: number | null;
  run_as_role: string | null;
  created_by?: number | string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

export const parseTriggerConfig = (
  config: EmailTriggerConfig | string | null | undefined,
): EmailTriggerConfig => {
  if (!config) return {};
  if (typeof config === "string") {
    try {
      return JSON.parse(config) as EmailTriggerConfig;
    } catch {
      return {};
    }
  }
  return config;
};
