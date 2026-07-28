/**
 * job_results state machine for session-backed routine runs (spec §5).
 * ALL transitions are conditional updates (CAS) so pause / cancel / complete
 * can never clobber each other, and only the CAS winner may enqueue a
 * continuation job (double-approval safe).
 */
import { v4 as uuidv4 } from "uuid";
import { queues as ExuluQueues } from "@EE/queues/queues";
import type { BullMqJobData } from "@EE/queues/decorator";
import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { clearStreamActive } from "@SRC/exulu/active-streams.ts";

/** job_results.metadata / trigger_metadata arrive as jsonb objects or strings. */
export const parseRunMetadata = (value: unknown): Record<string, any> => {
  if (value == null) {
    return {};
  }
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, any>) : {};
};

/** UPDATE … WHERE id = ? AND state IN (from) → true iff a row transitioned. */
export async function casJobResultState(
  db: any,
  jobResultId: string,
  from: string[],
  to: string,
): Promise<boolean> {
  const updated: number = await db
    .from("job_results")
    .where({ id: jobResultId })
    .whereIn("state", from)
    .update({ state: to });
  return updated > 0;
}

/**
 * Worker-pickup upsert for workflow runs (Task 7 calls this at handler start).
 *
 * Three paths:
 * 1. data.jobResultId set (continuation / retry / email-intake-created row):
 *    UPDATE that row in place, MERGING its existing metadata so pre-pause
 *    tokens/messages survive the resume (spec §5.7) — same run identity
 *    across pauses.
 * 2. A row already exists for this BullMQ job id (attempt-level retry after
 *    the in-handler retry loop exhausted): reuse it, including its session
 *    and persisted current_step_index, and bump tries.
 * 3. Fresh run: INSERT with type/workflow/trigger stamped.
 *
 * metadata always carries the run bookkeeping { run_as, inputs, queue_name,
 * current_step_index } so cancel/retry/resume never need the Redis payload.
 */
export async function upsertWorkflowRunStart(
  db: any,
  opts: {
    jobId: string;
    jobResultId?: string;
    label: string;
    state: string;
    workflow: string;
    session: string | null;
    trigger: string | null;
    triggerMetadata: Record<string, unknown> | null;
    bookkeeping: {
      run_as: { user?: number; role?: string };
      inputs: Record<string, unknown>;
      queue_name: string;
    };
    resumeFromIndex: number;
  },
): Promise<{ jobResultId: string; session: string | null; resumeFromIndex: number }> {
  const triggerMetadataJson = opts.triggerMetadata ? JSON.stringify(opts.triggerMetadata) : null;
  const metadataJson = (currentStepIndex: number) =>
    JSON.stringify({ ...opts.bookkeeping, current_step_index: currentStepIndex });

  if (opts.jobResultId) {
    // Spec §5.7: a continuation must not lose the pre-pause metadata written
    // at pause time (tokens, messages) — MERGE the existing row's metadata,
    // then apply the bookkeeping + step pointer on top.
    const currentRow = await db.from("job_results").where({ id: opts.jobResultId }).first();
    const priorMetadata = parseRunMetadata(currentRow?.metadata);
    await db
      .from("job_results")
      .where({ id: opts.jobResultId })
      .update({
        job_id: opts.jobId,
        state: opts.state,
        workflow: opts.workflow,
        trigger: opts.trigger,
        trigger_metadata: triggerMetadataJson,
        ...(opts.session ? { session: opts.session } : {}),
        metadata: JSON.stringify({
          ...priorMetadata,
          ...opts.bookkeeping,
          current_step_index: opts.resumeFromIndex,
        }),
      });
    return {
      jobResultId: opts.jobResultId,
      session: opts.session,
      resumeFromIndex: opts.resumeFromIndex,
    };
  }

  const existing = await db.from("job_results").where({ job_id: opts.jobId }).first();
  if (existing) {
    const existingMetadata = parseRunMetadata(existing.metadata);
    const resumeFromIndex =
      typeof existingMetadata.current_step_index === "number"
        ? existingMetadata.current_step_index
        : opts.resumeFromIndex;
    await db
      .from("job_results")
      .where({ id: existing.id })
      .update({
        state: opts.state,
        workflow: opts.workflow,
        trigger: opts.trigger,
        trigger_metadata: triggerMetadataJson,
        metadata: metadataJson(resumeFromIndex),
        tries: (existing.tries ?? 0) + 1,
      });
    return {
      jobResultId: existing.id,
      session: existing.session ?? opts.session,
      resumeFromIndex,
    };
  }

  const inserted = await db
    .from("job_results")
    .insert({
      job_id: opts.jobId,
      label: opts.label,
      state: opts.state,
      result: null,
      metadata: metadataJson(opts.resumeFromIndex),
      tries: 1,
      type: "workflow",
      workflow: opts.workflow,
      session: opts.session,
      trigger: opts.trigger,
      trigger_metadata: triggerMetadataJson,
    })
    .returning("id");
  return {
    jobResultId: inserted[0].id,
    session: opts.session,
    resumeFromIndex: opts.resumeFromIndex,
  };
}

/**
 * Called by the agent-run route's onFinish (spec §5.5): when a chat turn on a
 * run session completes and the run is waiting_approval, CAS it to active and
 * enqueue the continuation (new BullMQ job id, SAME job_results row) starting
 * at current_step_index + 1. Only the CAS winner enqueues. On enqueue failure
 * the CAS is reverted so a later approval turn can try again.
 */
export async function resumeRoutineRunIfWaiting(db: any, sessionId: string): Promise<boolean> {
  // The state predicate matches the partial index job_results_session_waiting_idx
  // (session) WHERE state = 'waiting_approval' — a session has at most one linked
  // run row, so filtering here is semantics-equivalent to checking the newest row.
  const row = await db
    .from("job_results")
    .where({ session: sessionId, state: JOB_STATUS_ENUM.waiting_approval })
    .orderBy("createdAt", "desc")
    .first();

  if (!row || row.state !== JOB_STATUS_ENUM.waiting_approval) {
    return false;
  }

  const metadata = parseRunMetadata(row.metadata);
  const queueName = typeof metadata.queue_name === "string" ? metadata.queue_name : undefined;

  const won = await casJobResultState(
    db,
    row.id,
    [JOB_STATUS_ENUM.waiting_approval],
    JOB_STATUS_ENUM.active,
  );
  if (!won) {
    return false;
  }

  try {
    const entry = queueName ? ExuluQueues.list.get(queueName) : undefined;
    if (!entry) {
      throw new Error(
        `Queue ${queueName ?? "<unknown>"} is not registered; cannot resume routine run ${row.id}.`,
      );
    }
    const queue = await entry.use();

    const currentStepIndex =
      typeof metadata.current_step_index === "number" ? metadata.current_step_index : 0;
    const runAs = (metadata.run_as ?? {}) as { user?: number; role?: string };

    const jobData: BullMqJobData = {
      label: `Workflow Run ${row.workflow}`,
      trigger: "api",
      timeoutInSeconds: queue.timeoutInSeconds || 180,
      type: "workflow",
      workflow: row.workflow,
      inputs: (metadata.inputs as Record<string, unknown>) ?? {},
      user: runAs.user,
      role: runAs.role,
      session: sessionId,
      jobResultId: row.id,
      resumeFromIndex: currentStepIndex + 1,
      triggerSource: (row.trigger as BullMqJobData["triggerSource"]) ?? undefined,
      triggerMetadata: row.trigger_metadata ? parseRunMetadata(row.trigger_metadata) : undefined,
    };

    await queue.queue.add("workflow_run", jobData, {
      jobId: uuidv4(),
      attempts: queue.retries || 3,
      removeOnComplete: 5000,
      removeOnFail: 10000,
      backoff: queue.backoff || { type: "exponential", delay: 2000 },
    });
    return true;
  } catch (error) {
    // Give a later approval turn another chance to resume.
    await casJobResultState(db, row.id, [JOB_STATUS_ENUM.active], JOB_STATUS_ENUM.waiting_approval);
    throw error;
  }
}

/**
 * Shared cancel path (spec §5.6): CAS the run to cancelled, best-effort
 * remove its pending BullMQ job, and release the session's stream-active
 * flag. Used by BOTH the cancelRoutineRun resolver and session deletion
 * (postprocessDeletion) so the two paths behave identically. A lost CAS
 * (row already terminal) is a silent no-op — callers that need to report
 * "not cancellable" check the row state before calling.
 */
export async function cancelRoutineRunRow(
  db: any,
  row: { id: string; job_id?: string | null; session?: string | null; metadata?: unknown },
  queues: { list: Map<string, { use: () => Promise<any> }> },
): Promise<void> {
  const cancelled = await casJobResultState(
    db,
    row.id,
    [JOB_STATUS_ENUM.waiting, JOB_STATUS_ENUM.active, JOB_STATUS_ENUM.waiting_approval],
    JOB_STATUS_ENUM.cancelled,
  );
  if (!cancelled) {
    return;
  }

  // Best-effort: remove the pending BullMQ job (an actively-processing job
  // cannot be removed — the CAS'd state makes its completion a no-op).
  const runMetadata = parseRunMetadata(row.metadata);
  if (row.job_id && typeof runMetadata.queue_name === "string") {
    try {
      const entry = queues.list.get(runMetadata.queue_name);
      if (entry) {
        const queueConfig = await entry.use();
        const job = await queueConfig.queue.getJob(row.job_id);
        if (job) {
          await job.remove();
        }
      }
    } catch (removeError) {
      console.warn(
        `[EXULU] could not remove BullMQ job ${row.job_id} for cancelled run ${row.id}.`,
        removeError instanceof Error ? removeError.message : String(removeError),
      );
    }
  }
  if (row.session) {
    clearStreamActive(row.session);
  }
}

/**
 * Side-effects of removing an agent_session (does NOT delete the session row):
 * its messages, cancelling any still-live runs for it (so an in-flight worker
 * becomes a no-op), and its point-in-time rbac snapshot. Shared by the generic
 * agent_sessions delete (postprocessDeletion) and deleteRoutineRunRow.
 */
export async function deleteAgentSessionData(
  db: any,
  sessionId: string,
  queues: { list: Map<string, { use: () => Promise<any> }> },
): Promise<void> {
  await db.from("agent_messages").where({ session: sessionId }).delete();
  const liveRuns = await db
    .from("job_results")
    .where({ session: sessionId })
    .whereIn("state", [
      JOB_STATUS_ENUM.waiting,
      JOB_STATUS_ENUM.active,
      JOB_STATUS_ENUM.waiting_approval,
    ])
    .select("*");
  for (const run of liveRuns) {
    await cancelRoutineRunRow(db, run, queues);
  }
  await db
    .from("rbac")
    .where({ entity: "agent_session", target_resource_id: sessionId })
    .del();
}
