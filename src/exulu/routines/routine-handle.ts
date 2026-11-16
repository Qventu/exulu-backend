import { isRunSessionMetadata } from "./run-session";
import type { WorkStatusActor, WorkStatusDecision, WorkStatusOrigin } from "./work-status";
import {
  loadRoutineWorkStatusConfig,
  loadRunWorkStatus,
  setRunWorkStatus,
} from "./work-status-store";

/**
 * The `routine` object a tool's execute receives when its turn is part of a
 * routine run (spec 2026-11-16-routine-work-status-design): during the
 * worker's run, and when a person continues that run's session in the chat.
 * `routine` itself is read-only; everything that writes hangs off
 * `routine.runs.current`.
 */
export type RoutineRunPatch = {
  /** Work status: a key from routine.statuses. */
  status?: string;
};

export type RoutineHandle = {
  id: string;
  name: string;
  /** The routine's configured work statuses; [] when none are configured. */
  statuses: { key: string; label: string; done?: boolean }[];
  runs: {
    current: {
      /** job_results id of this run. */
      id: string;
      /** Current work status of this run. */
      status: string | null;
      /** Updates the run. Only the fields of RoutineRunPatch are accepted. */
      update(patch: RoutineRunPatch): Promise<void>;
    };
  };
};

/** RoutineHandle plus the write outcome — for the built-in status tool only. */
export type RoutineHandleInternal = RoutineHandle & {
  runs: { current: RoutineHandle["runs"]["current"] & { updateWithResult(patch: RoutineRunPatch): Promise<WorkStatusDecision | undefined> } };
};

const runIdFromSessionMetadata = (metadata: unknown): string | undefined => {
  try {
    const parsed = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    const id = (parsed as { job_result_id?: unknown } | null)?.job_result_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
};

const PATCH_FIELDS = ["status"];

type HandleActor = { kind: "tool"; id: string } | { kind: "agent" };

/**
 * One per turn. Resolves the run from `jobResultId` (the worker's run) or
 * from the session (a chat turn on a run session). Returns undefined when the
 * turn is not part of a routine run or the run row is gone; never throws —
 * a tool must work the same with or without it.
 */
export async function resolveRoutineHandleFactory(
  db: any,
  args: { sessionId?: string; sessionMetadata?: unknown; jobResultId?: string; actingUser?: number },
): Promise<((actor: HandleActor) => RoutineHandleInternal) | undefined> {
  const origin: WorkStatusOrigin = args.jobResultId ? "worker" : "chat";
  try {
    // A run session's metadata carries its job_result_id (run-session.ts).
    const jobResultId =
      args.jobResultId ??
      (isRunSessionMetadata(args.sessionMetadata) ? runIdFromSessionMetadata(args.sessionMetadata) : undefined);
    if (!jobResultId) return undefined;
    const run = await loadRunWorkStatus(db, jobResultId);
    if (!run) return undefined;
    const routine = await loadRoutineWorkStatusConfig(db, run.workflow);
    if (!routine) return undefined;
    const runId = run.id;
    const statuses = routine.config.statuses.map(({ key, label, done }) => ({
      key,
      label,
      ...(done !== undefined ? { done } : {}),
    }));
    // Shared by every handle of the turn, so a status one tool set is what the next tool reads.
    const state = { status: run.work_status };

    return (actor) => {
      const fullActor: WorkStatusActor =
        origin === "chat" && args.actingUser !== undefined ? { ...actor, user: args.actingUser } : actor;
      const updateWithResult = async (patch: RoutineRunPatch): Promise<WorkStatusDecision | undefined> => {
        const unknown = Object.keys(patch ?? {}).filter((key) => !PATCH_FIELDS.includes(key));
        if (unknown.length > 0) {
          throw new Error(`Unknown routine run field(s): ${unknown.join(", ")}. Allowed: ${PATCH_FIELDS.join(", ")}`);
        }
        if (patch?.status === undefined) return undefined;
        const decision = await setRunWorkStatus(db, { jobResultId: runId, status: patch.status, actor: fullActor, origin });
        if (decision.action === "write") state.status = decision.status;
        return decision;
      };
      return {
        id: routine.id,
        name: routine.name,
        statuses,
        runs: {
          current: {
            id: runId,
            get status() {
              return state.status;
            },
            update: async (patch) => {
              await updateWithResult(patch);
            },
            updateWithResult,
          },
        },
      };
    };
  } catch (error) {
    console.warn("[EXULU] could not resolve the routine handle for this turn:", error);
    return undefined;
  }
}
