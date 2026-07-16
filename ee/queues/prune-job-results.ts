/**
 * Periodic job_results cap (knowledge V2 KB-7 follow-up).
 *
 * We now write a job_results row at enqueue time, so the table grows faster.
 * To bound it, every PRUNE_EVERY-th call we delete the oldest terminal rows
 * (states in TERMINAL_JOB_STATES) beyond the newest MAX_TERMINAL — keeping a rolling
 * window of recent finished jobs. Waiting/active/delayed rows are never
 * pruned (they're still live).
 *
 * The counter is per-process (the API process counts enqueues; the worker
 * process counts completions) — that's fine: the prune is idempotent, so it
 * doesn't matter which process triggers it. A `pruning` guard avoids
 * overlapping runs.
 */

import { TERMINAL_JOB_STATES } from "@EXULU_TYPES/enums/jobs";

const MAX_TERMINAL = 10_000;
const PRUNE_EVERY = 100;

let sinceLastPrune = 0;
let pruning = false;

export async function maybePruneJobResults(db: any): Promise<void> {
  sinceLastPrune += 1;
  if (sinceLastPrune < PRUNE_EVERY || pruning) return;
  sinceLastPrune = 0;
  pruning = true;
  try {
    // The (MAX_TERMINAL+1)-th newest terminal row marks the boundary; delete it
    // and everything older. Dialect-agnostic (knex offset/limit) so it works on
    // both Postgres and MySQL.
    const boundary = await db("job_results")
      .whereIn("state", TERMINAL_JOB_STATES)
      .orderBy("createdAt", "desc")
      .offset(MAX_TERMINAL)
      .limit(1)
      .first();

    if (boundary?.createdAt) {
      const deleted = await db("job_results")
        .whereIn("state", TERMINAL_JOB_STATES)
        .where("createdAt", "<=", boundary.createdAt)
        .del();
      if (deleted) {
        console.log(
          `[EXULU] pruned ${deleted} terminal job_results rows (cap ${MAX_TERMINAL}).`,
        );
      }
    }
  } catch (err) {
    console.error("[EXULU] job_results prune failed", err);
  } finally {
    pruning = false;
  }
}
