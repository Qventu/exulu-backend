// Save-time validation for admin-supplied trigger config (spec §8): 200-char
// regex length cap + safe-regex ReDoS check, allowlist shape check, strictly
// positive rate limits, non-negative retention (0 = keep no filtered rows).
// Plus server-side address generation (spec §3.1).
import { randomBytes } from "node:crypto";
import safeRegex from "safe-regex";
import type { EmailTriggerConfig, EmailTriggerFilterRule } from "./types";

export const MAX_FILTER_PATTERN_LENGTH = 200;

const FILTER_FIELDS: EmailTriggerFilterRule["field"][] = [
  "from",
  "subject",
  "body",
  "attachment_name",
];

const assertPositiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
};

// filtered_run_retention accepts 0: "keep no filtered rows at all".
const assertNonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
};

export function validateEmailTriggerConfig(raw: unknown): EmailTriggerConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Trigger config must be a JSON object.");
  }
  const input = raw as Record<string, unknown>;
  const config: EmailTriggerConfig = {};

  if (input.allowed_senders !== undefined) {
    if (!Array.isArray(input.allowed_senders)) {
      throw new Error("allowed_senders must be an array of email addresses or *@domain globs.");
    }
    config.allowed_senders = input.allowed_senders.map((entry) => {
      if (typeof entry !== "string" || !entry.includes("@") || entry.trim().length < 3) {
        throw new Error(
          `Invalid allowed_senders entry: ${JSON.stringify(entry)}. Use an email address or *@domain.`,
        );
      }
      return entry.trim().toLowerCase();
    });
  }

  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters)) {
      throw new Error("filters must be an array of { field, pattern } rules.");
    }
    config.filters = input.filters.map((rule) => {
      const candidate = rule as { field?: unknown; pattern?: unknown };
      if (!FILTER_FIELDS.includes(candidate.field as EmailTriggerFilterRule["field"])) {
        throw new Error(
          `Invalid filter field: ${JSON.stringify(candidate.field)}. Use one of ${FILTER_FIELDS.join(", ")}.`,
        );
      }
      if (typeof candidate.pattern !== "string" || candidate.pattern.length === 0) {
        throw new Error("Each filter needs a non-empty regex pattern.");
      }
      if (candidate.pattern.length > MAX_FILTER_PATTERN_LENGTH) {
        throw new Error(
          `Filter patterns are capped at ${MAX_FILTER_PATTERN_LENGTH} characters.`,
        );
      }
      try {
        // Compile check only — evaluation happens in guards.ts.
        void new RegExp(candidate.pattern);
      } catch {
        throw new Error(`Invalid regex pattern: ${candidate.pattern}`);
      }
      if (!safeRegex(candidate.pattern)) {
        throw new Error(`Unsafe regex pattern (potential ReDoS): ${candidate.pattern}`);
      }
      return {
        field: candidate.field as EmailTriggerFilterRule["field"],
        pattern: candidate.pattern,
      };
    });
  }

  if (input.filtered_run_retention !== undefined) {
    config.filtered_run_retention = assertNonNegativeInteger(
      input.filtered_run_retention,
      "filtered_run_retention",
    );
  }
  if (input.rate_limit_per_hour !== undefined) {
    config.rate_limit_per_hour = assertPositiveInteger(
      input.rate_limit_per_hour,
      "rate_limit_per_hour",
    );
  }
  if (input.sender_rate_limit_per_hour !== undefined) {
    config.sender_rate_limit_per_hour = assertPositiveInteger(
      input.sender_rate_limit_per_hour,
      "sender_rate_limit_per_hour",
    );
  }

  return config;
}

/** Capability-URL secret for /webhooks/routine/:secret (~192 bits). */
export function generateTriggerSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Plaintext HMAC shared secret (encrypt before storing). */
export function generateSigningSecret(): string {
  return randomBytes(32).toString("base64url");
}
