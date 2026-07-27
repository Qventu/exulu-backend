// Extracted resolver helpers for unit-testability (spec §3.1, §8).
// The resolver in src/graphql/schemas/index.ts delegates to these so they
// can be tested in isolation without wiring up the full GraphQL layer.

import { generateTriggerAddress } from "./trigger-config";

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
