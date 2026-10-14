// src/exulu/claim-check/store.ts
//
// The `claim_checks` table's only two writers/readers (ee/claim-check/routes.ts
// wires these into the route handlers via postgresClient()). Pulled out of
// routes.ts — a 5,000+ line factory — because this is the one guarantee in
// Task B3 that must be independently verifiable: a knex double, not a mock
// callback, proves what the actual query filters on.
//
// Row uniqueness is (session, message_id, user) — not (session, message_id).
// A fix-round review caught that the original delete-then-insert upsert
// deleted by (session, message_id) alone, unscoped by user: a caller who
// names another user's session uuid and message id could destroy and
// replace that user's stored row. The fix is not "add user to the delete's
// where" — a destructive statement that must remember to carry a scope is a
// defect waiting to recur — it is to not delete at all. `onConflict(...).merge()`
// lets Postgres enforce the uniqueness via the composite unique index
// created in init-exulu-db.ts (see claimChecksSchema's docblock in
// ee/schemas.ts), so a row belonging to a different user is never touched,
// and two concurrent writes for the same (session, message_id, user)
// converge on one row instead of racing a delete against an insert.
import type { Knex } from "knex";
import type { ClaimCheckResult } from "@EE/claim-check/types";

export async function saveClaimCheck(
  db: Knex,
  args: { session: string; messageId: string; userId: number; result: ClaimCheckResult },
): Promise<void> {
  const { session, messageId, userId, result } = args;
  await db("claim_checks")
    .insert({
      session,
      message_id: messageId,
      payload: JSON.stringify(result),
      score_label: result.score.label,
      user: userId,
    })
    // Conflict columns match the unique index backing (session, message_id, user)
    // exactly — this is what makes the statement a true upsert rather than a
    // delete masquerading as one.
    .onConflict(["session", "message_id", "user"])
    .merge();
}

export async function listClaimChecks(
  db: Knex,
  args: { session: string; userId: number },
): Promise<Record<string, ClaimCheckResult>> {
  const { session, userId } = args;
  // Both conditions in the one query — never a fetch-by-session-then-filter
  // in application code. This is the only thing standing between one user
  // and another user's stored answers.
  const rows = await db("claim_checks")
    .where({ session, user: userId })
    .select("message_id", "payload");

  const out: Record<string, unknown> = {};
  for (const row of rows) {
    out[row.message_id] = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  }
  return out as Record<string, ClaimCheckResult>;
}
