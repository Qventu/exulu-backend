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
/**
 * Import runs (server-side bulk import) get their own, smaller, per-context
 * cap instead of sharing the generic MAX_TERMINAL rolling window below -- a
 * tenant running frequent imports in one context should not crowd out every
 * other context's or job type's terminal rows, and 200 per context is plenty
 * to review (older ones are still available in the context's own audit trail
 * via the item rows they created/updated).
 */
const MAX_IMPORT_PER_CONTEXT = 200;

let sinceLastPrune = 0;
let pruning = false;

export async function maybePruneJobResults(db: any): Promise<void> {
  sinceLastPrune += 1;
  if (sinceLastPrune < PRUNE_EVERY || pruning) return;
  sinceLastPrune = 0;
  pruning = true;
  try {
    await pruneGenericJobResults(db);
    await pruneImportJobResults(db);
  } finally {
    pruning = false;
  }
}

/**
 * The (MAX_TERMINAL+1)-th newest terminal row marks the boundary; delete it
 * and everything older. Dialect-agnostic (knex offset/limit) so it works on
 * both Postgres and MySQL. Import rows are excluded here (`whereNot({ type:
 * "import" })` on both the boundary query and the delete) -- they get their
 * own, smaller, per-context cap in pruneImportJobResults instead.
 */
async function pruneGenericJobResults(db: any): Promise<void> {
  try {
    const boundary = await db("job_results")
      .whereIn("state", TERMINAL_JOB_STATES)
      .whereNot({ type: "import" })
      .orderBy("createdAt", "desc")
      .offset(MAX_TERMINAL)
      .limit(1)
      .first();

    if (boundary?.createdAt) {
      const deleted = await db("job_results")
        .whereIn("state", TERMINAL_JOB_STATES)
        .whereNot({ type: "import" })
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
  }
}

/**
 * Per-context cap for import job_results rows: keeps only the newest
 * MAX_IMPORT_PER_CONTEXT terminal rows per context, independent of the
 * generic MAX_TERMINAL window above. Needs a Postgres window function
 * (row_number() over (partition by context ...)), so this step is skipped
 * entirely on any other knex dialect -- the generic cap above still bounds
 * the table's overall size regardless, and this codebase only ever connects
 * with the "pg" client (src/postgres/client.ts), so the guard is defensive
 * rather than a real supported-dialect split.
 */
async function pruneImportJobResults(db: any): Promise<void> {
  if (db.client?.config?.client !== "pg") return;
  try {
    const statePlaceholders = TERMINAL_JOB_STATES.map(() => "?").join(", ");
    const deleted = await db("job_results")
      .where({ type: "import" })
      .whereRaw(
        `id in (
          select id from (
            select id, row_number() over (partition by context order by "createdAt" desc) as rn
            from job_results
            where type = 'import' and state in (${statePlaceholders})
          ) ranked
          where rn > ?
        )`,
        [...TERMINAL_JOB_STATES, MAX_IMPORT_PER_CONTEXT],
      )
      .del();
    if (deleted) {
      console.log(
        `[EXULU] pruned ${deleted} terminal import job_results rows (cap ${MAX_IMPORT_PER_CONTEXT}/context).`,
      );
    }
  } catch (err) {
    console.error("[EXULU] import job_results prune failed", err);
  }
}
