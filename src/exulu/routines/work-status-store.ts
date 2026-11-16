import {
  decideWorkStatusWrite,
  parseWorkStatusConfig,
  type WorkStatusActor,
  type WorkStatusConfig,
  type WorkStatusDecision,
  type WorkStatusOrigin,
} from "./work-status";

/** Database side of routine work statuses; the rules are in work-status.ts. */

export type RunWorkStatusRow = {
  id: string;
  workflow: string;
  work_status: string | null;
  work_status_updated_at: unknown;
  work_status_updated_by: WorkStatusActor | null;
};

const parseActor = (raw: unknown): WorkStatusActor | null => {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && typeof (value as any).kind === "string"
    ? (value as WorkStatusActor)
    : null;
};

const mapRow = (row: any): RunWorkStatusRow | undefined =>
  row
    ? {
        id: row.id,
        workflow: row.workflow,
        work_status: row.work_status ?? null,
        work_status_updated_at: row.work_status_updated_at ?? null,
        work_status_updated_by: parseActor(row.work_status_updated_by),
      }
    : undefined;

export async function loadRunWorkStatus(db: any, jobResultId: string): Promise<RunWorkStatusRow | undefined> {
  return mapRow(await db("job_results").where({ id: jobResultId }).first());
}

export async function loadRoutineWorkStatusConfig(
  db: any,
  workflowId: string,
): Promise<{ id: string; name: string; config: WorkStatusConfig } | undefined> {
  const row = await db("workflow_templates").where({ id: workflowId }).select("id", "name", "work_statuses").first();
  if (!row) return undefined;
  return { id: row.id, name: row.name, config: parseWorkStatusConfig(row.work_statuses) };
}

/** Applies decideWorkStatusWrite; throws Error(message) on reject; returns the decision otherwise. */
export async function setRunWorkStatus(
  db: any,
  args: { jobResultId: string; status: string | null; actor: WorkStatusActor; origin: WorkStatusOrigin },
): Promise<WorkStatusDecision> {
  const run = await loadRunWorkStatus(db, args.jobResultId);
  if (!run) throw new Error(`Run ${args.jobResultId} not found`);
  const routine = await loadRoutineWorkStatusConfig(db, run.workflow);
  if (!routine) throw new Error(`The routine of run ${args.jobResultId} was not found`);
  const decision = decideWorkStatusWrite({
    config: routine.config,
    routineName: routine.name,
    current: { status: run.work_status, updatedBy: run.work_status_updated_by },
    next: args.status,
    origin: args.origin,
  });
  if (decision.action === "reject") throw new Error(decision.message);
  if (decision.action === "write") {
    let query = db("job_results").where({ id: args.jobResultId });
    // The decision above was taken on a row read a moment ago. For the
    // worker's run the rule "a person's status wins" is repeated inside the
    // UPDATE, so a click that lands between the read and the write is kept.
    if (args.origin === "worker") {
      query = query.whereRaw("(work_status_updated_by::jsonb)->>'kind' IS DISTINCT FROM 'user'");
    }
    const written = await query.update({
      work_status: decision.status,
      work_status_updated_at: new Date(),
      work_status_updated_by: JSON.stringify(args.actor),
    });
    if (args.origin === "worker" && written === 0) {
      console.log(`[EXULU] work status of run ${args.jobResultId} left unchanged: a person set it.`);
      return { action: "skip", reason: "human_set" };
    }
  } else if (decision.reason === "human_set") {
    console.log(`[EXULU] work status of run ${args.jobResultId} left unchanged: a person set it.`);
  }
  return decision;
}

/**
 * Columns that give a run the routine's default work status; {} when the
 * routine has no statuses or no default. Never throws: a run must start even
 * when this lookup fails.
 */
export async function defaultWorkStatusColumns(
  db: any,
  workflowId: string,
): Promise<{ work_status?: string; work_status_updated_at?: Date; work_status_updated_by?: string }> {
  try {
    const routine = await loadRoutineWorkStatusConfig(db, workflowId);
    if (!routine?.config.default) return {};
    return {
      work_status: routine.config.default,
      work_status_updated_at: new Date(),
      work_status_updated_by: JSON.stringify({ kind: "default" } satisfies WorkStatusActor),
    };
  } catch (error) {
    console.warn(`[EXULU] could not resolve the default work status of routine ${workflowId}:`, error);
    return {};
  }
}

/**
 * The manual path from the runs list. Whoever may read a routine's runs may
 * set a run's work status (spec decision 1) — the caller passes the routine
 * ids the user can read. A run outside that set is reported as not found, so
 * the answer does not reveal that it exists.
 */
export async function setRunWorkStatusManually(
  db: any,
  args: { id: string; status: string | null; userId: number; readableRoutineIds: string[] },
): Promise<void> {
  const row = await db("job_results").where({ id: args.id }).first();
  if (!row || row.type !== "workflow" || !row.workflow || !args.readableRoutineIds.includes(row.workflow)) {
    throw new Error("Routine run not found.");
  }
  await setRunWorkStatus(db, {
    jobResultId: args.id,
    status: args.status,
    actor: { kind: "user", id: args.userId },
    origin: "manual",
  });
}
