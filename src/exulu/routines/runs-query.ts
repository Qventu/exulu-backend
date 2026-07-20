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
};

export const applyRoutineRunFilters = (
  query: any,
  args: RoutineRunsFilterArgs,
  allowedWorkflowIds: string[],
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
} => {
  const routine = row.workflow ? routineById.get(row.workflow) : undefined;
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
  };
};

export { parseRunMetadata };
