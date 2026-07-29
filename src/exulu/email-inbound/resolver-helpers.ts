// Extracted resolver helpers for unit-testability (spec §3.1, §8).
// The resolver in src/graphql/schemas/index.ts delegates to these so they
// can be tested in isolation without wiring up the full GraphQL layer.

import { generateTriggerSecret } from "./trigger-config";
import type { WorkflowTriggerRow } from "./types";

export interface WorkflowTriggerPayload {
  id: string;
  workflow: string;
  type: string;
  enabled: boolean;
  webhook_url: string | null;   // writers only
  has_webhook: boolean;
  has_signing_secret: boolean;
  last_fired_at: string | null;
  config: unknown;
  run_as_user: number | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
  signing_secret_once: string | null; // returned once on generation
}

export function toWorkflowTriggerPayload(
  row: WorkflowTriggerRow,
  opts: { canWrite: boolean; signingSecretOnce?: string | null },
): WorkflowTriggerPayload {
  const webhookUrl = `${process.env.BACKEND}/webhooks/routine/${row.secret}`;
  return {
    id: row.id,
    workflow: row.workflow,
    type: row.type,
    enabled: row.enabled,
    webhook_url: opts.canWrite ? webhookUrl : null,
    has_webhook: Boolean(row.secret),
    has_signing_secret: Boolean(row.signing_secret),
    last_fired_at: row.last_fired_at ? new Date(row.last_fired_at).toISOString() : null,
    config: typeof row.config === "string" ? JSON.parse(row.config) : row.config,
    run_as_user: row.run_as_user,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    signing_secret_once: opts.signingSecretOnce ?? null,
  };
}

export interface InsertTriggerRow {
  workflow: string;
  type: string;
  enabled: boolean;
  secret: string;
  config: string;
  run_as_user: string;
  run_as_role: string | null;
  created_by: string;
}

/** Insert with a fresh secret, regenerating on a 23505 unique collision. */
export async function insertTriggerWithSecretRetry(
  insertFn: (row: InsertTriggerRow) => Promise<any>,
  baseRow: Omit<InsertTriggerRow, "secret">,
): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await insertFn({ ...baseRow, secret: generateTriggerSecret() });
    } catch (err: any) {
      if (err?.code === "23505") continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique trigger secret.");
}
