// Extracted resolver helpers for unit-testability (spec §3.1, §8).
// The resolver in src/graphql/schemas/index.ts delegates to these so they
// can be tested in isolation without wiring up the full GraphQL layer.

import { generateTriggerAddress } from "./trigger-config";

export interface EmailInboundConfigShape {
  provider: string | null;
  inbound_domain: string | null;
  enabled: boolean;
  last_webhook_at: string | null;
  signing_key: string | null;
}

export interface EmailInboundConfigPayload {
  provider: string | null;
  inbound_domain: string | null;
  enabled: boolean;
  last_webhook_at: string | null;
  webhook_url: string | null;
  has_signing_key: boolean;
}

/** Maps the internal config (which carries the decrypted signing key) to the
 *  API payload shape.  The signing_key itself is NEVER included (spec §8). */
export function toEmailInboundConfigPayload(
  inbound: EmailInboundConfigShape,
): EmailInboundConfigPayload {
  return {
    provider: inbound.provider,
    inbound_domain: inbound.inbound_domain,
    enabled: inbound.enabled,
    last_webhook_at: inbound.last_webhook_at,
    webhook_url: process.env.BACKEND
      ? process.env.BACKEND.replace(/\/+$/, "") + "/webhooks/email/mime"
      : null,
    // The signing key itself is write-only and NEVER returned (spec §8).
    has_signing_key: !!inbound.signing_key,
  };
}

export interface InsertTriggerRow {
  workflow: string;
  type: string;
  enabled: boolean;
  address: string;
  config: string;
  run_as_user: string;
  run_as_role: string | null;
  created_by: string;
}

/** Attempts up to 5 INSERT tries, regenerating the address on a 23505 unique
 *  violation (concurrent race-safe — the INSERT itself is inside the loop). */
export async function insertTriggerWithRetry(
  insertFn: (row: InsertTriggerRow) => Promise<any>,
  baseRow: Omit<InsertTriggerRow, "address">,
  routineName: string,
  inboundDomain: string,
): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const address = generateTriggerAddress(routineName, inboundDomain);
    try {
      return await insertFn({ ...baseRow, address });
    } catch (err: any) {
      if (err?.code === "23505") {
        // Unique violation — try a fresh address.
        continue;
      }
      // Any other error is not retriable.
      throw err;
    }
  }
  throw new Error("Could not generate a unique trigger address after 5 attempts.");
}
