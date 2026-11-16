/**
 * Query building + row mapping for the routineRuns GraphQL API (spec §6).
 * job_results has no RBAC of its own — the resolvers restrict `workflow` to
 * the access-filtered routine-id set and these helpers do the rest with one
 * indexed query (composite index (workflow, state, trigger, createdAt)).
 */
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { parseRunMetadata } from "./run-state";

export type RoutineRunsFilterArgs = {
  workflow?: string;
  states?: string[];
  triggers?: string[];
  from?: Date | string;
  to?: Date | string;
  search?: string;
  needsAttention?: boolean;
  /** Work-status keys to include (spec 2026-11-16-routine-work-status-design). */
  workStatuses?: string[];
  /** true = open (no status, or one not flagged done); false = done. Needs doneKeys. */
  workStatusOpen?: boolean | null;
};

export const applyRoutineRunFilters = (
  query: any,
  args: RoutineRunsFilterArgs,
  allowedWorkflowIds: string[],
  /**
   * Keys of the statuses flagged done, for the open/done split. "Done" is
   * defined per routine, so the resolver passes this only when the list is
   * scoped to one routine; without it workStatusOpen is ignored.
   */
  doneKeys?: string[],
): any => {
  let q = query
    .where("job_results.type", "workflow")
    .whereIn("job_results.workflow", allowedWorkflowIds);
  if (args.states?.length) {
    q = q.whereIn("job_results.state", args.states);
  }
  if (args.triggers?.length) {
    q = q.whereIn("job_results.trigger", args.triggers);
  }
  if (args.needsAttention) {
    q = q.where("job_results.state", JOB_STATUS_ENUM.waiting_approval);
  }
  if (args.from) {
    q = q.where("job_results.createdAt", ">=", args.from);
  }
  if (args.to) {
    q = q.where("job_results.createdAt", "<=", args.to);
  }
  if (args.workStatuses?.length) {
    q = q.whereIn("job_results.work_status", args.workStatuses);
  }
  if (typeof args.workStatusOpen === "boolean" && doneKeys) {
    if (args.workStatusOpen) {
      if (doneKeys.length > 0) {
        q = q.where((group: any) => {
          group.whereNull("job_results.work_status").orWhereNotIn("job_results.work_status", doneKeys);
        });
      }
    } else if (doneKeys.length > 0) {
      q = q.whereIn("job_results.work_status", doneKeys);
    } else {
      q = q.whereRaw("1 = 0");
    }
  }
  if (args.search) {
    // session ⇄ run is 1:1 — the join cannot fan out rows.
    q = q
      .leftJoin("agent_sessions", "job_results.session", "agent_sessions.id")
      .where("agent_sessions.title", "ilike", `%${args.search}%`);
  }
  return q;
};

/** json columns arrive as objects (pg jsonb) or strings — normalize either. */
const parseMaybeJson = (value: unknown): any => {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const mapRoutineRunRow = (
  row: any,
  routineById: Map<string, { id: string; name?: string; agent?: string }>,
): {
  id: string;
  job_id: string | null;
  state: string;
  trigger: string | null;
  trigger_metadata: any;
  session: string | null;
  workflow: string;
  workflowName: string | null;
  agent: string | null;
  error: any;
  tries: number | null;
  createdAt: unknown;
  updatedAt: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  work_status: string | null;
  work_status_updated_at: unknown;
  work_status_updated_by: any;
} => {
  const routine = row.workflow ? routineById.get(row.workflow) : undefined;
  const tokens = parseMaybeJson(row.metadata)?.tokens as
    | { inputTokens?: number; outputTokens?: number; costUsd?: number }
    | undefined;
  return {
    id: row.id,
    job_id: row.job_id ?? null,
    state: row.state,
    trigger: row.trigger ?? null,
    trigger_metadata: parseMaybeJson(row.trigger_metadata),
    session: row.session ?? null,
    workflow: row.workflow,
    workflowName: routine?.name ?? null,
    agent: routine?.agent ?? null,
    error: parseMaybeJson(row.error),
    tries: row.tries ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    inputTokens: tokens?.inputTokens ?? null,
    outputTokens: tokens?.outputTokens ?? null,
    costUsd: tokens?.costUsd ?? null,
    work_status: row.work_status ?? null,
    work_status_updated_at: row.work_status_updated_at ?? null,
    work_status_updated_by: parseMaybeJson(row.work_status_updated_by),
  };
};

export { parseRunMetadata };
