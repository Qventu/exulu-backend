/**
 * Session-backed routine runs (spec 2026-07-15 §3.4): every run gets a real
 * agent_sessions row so admins can preview the transcript and jump into the
 * chat to answer tool approvals.
 *
 * RBAC is copied from the routine as a POINT-IN-TIME snapshot because
 * agent_sessions access control binds even super admins (applyAccessControl
 * special-cases the table). Later changes to the routine's RBAC do not
 * retroactively update existing run sessions. rbac rows use the SINGULAR
 * entity name "agent_session" — that is what applyAccessControl /
 * RBACResolver / handleRBACUpdate match on (table.name.singular).
 */

import type { User } from "@EXULU_TYPES/models/user";
import { checkRecordAccess } from "@SRC/utils/check-record-access";

export async function createRunSession(opts: {
  db: any;
  workflow: { id: string; name: string; agent: string; rights_mode?: string };
  userId: number;
  title: string;
  trigger: "email" | "schedule" | "manual" | "api";
  jobResultId?: string;
}): Promise<string> {
  const { db, workflow, userId, title, trigger, jobResultId } = opts;

  const inserted = await db
    .from("agent_sessions")
    .insert({
      agent: workflow.agent,
      user: userId,
      created_by: userId,
      title,
      rights_mode: workflow.rights_mode ?? "private",
      // The routine/workflow this session is a run of; null for user chats.
      // Chat history filters run = null so run sessions do not appear there.
      run: workflow.id,
      // Session ⇄ run cross-link; the agent-run route uses job_result_id to
      // resume a paused run after an approval turn (spec §5.5).
      metadata: {
        routine_id: workflow.id,
        job_result_id: jobResultId ?? null,
        trigger,
      },
    })
    .returning("id");

  const sessionId: string = inserted[0].id;

  const routineRbacRows: {
    access_type: string;
    user_id: number | null;
    role_id: string | null;
    team_id: string | null;
    rights: string;
  }[] = await db
    .from("rbac")
    .where({ entity: "workflow_template", target_resource_id: workflow.id })
    .select("*");

  if (routineRbacRows.length > 0) {
    const now = new Date();
    await db.from("rbac").insert(
      routineRbacRows.map((row) => ({
        entity: "agent_session",
        access_type: row.access_type,
        target_resource_id: sessionId,
        user_id: row.user_id ?? null,
        role_id: row.role_id ?? null,
        team_id: row.team_id ?? null,
        rights: row.rights,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  return sessionId;
}

/**
 * True when an agent_sessions row belongs to a routine run (its metadata
 * carries job_result_id). Accepts the raw column value: object (pg jsonb)
 * or JSON string.
 */
export const isRunSessionMetadata = (metadata: unknown): boolean => {
  if (metadata == null) {
    return false;
  }
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return false;
    }
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !!(parsed as { job_result_id?: unknown }).job_result_id
  );
};

const parseMetadata = (metadata: unknown): Record<string, unknown> | null => {
  if (metadata == null) return null;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof metadata === "object" ? (metadata as Record<string, unknown>) : null;
};

/**
 * Throws unless `sessionId` is a run session of routine `workflowId`. The worker
 * takes the session from the job payload, so without this a crafted job could
 * make a run write its transcript into any session. Run sessions carry the
 * routine in `run` and `metadata.routine_id` (createRunSession); every marker
 * present must name this routine. A session with neither marker (older rows)
 * falls back to write access of the run user.
 */
export async function verifyRunSessionOwnership(
  db: any,
  opts: { sessionId: string; workflowId: string; runUser?: User },
): Promise<void> {
  const { sessionId, workflowId, runUser } = opts;
  const session = await db.from("agent_sessions").where({ id: sessionId }).first();
  if (!session) {
    throw new Error(`Run session ${sessionId} not found; refusing to run routine ${workflowId}.`);
  }
  const markers = [session.run, parseMetadata(session.metadata)?.routine_id].filter(
    (m) => m != null && m !== "",
  );
  const belongs =
    markers.length > 0
      ? markers.every((m) => String(m) === String(workflowId))
      : await checkRecordAccess(session, "write", runUser);
  if (!belongs) {
    throw new Error(`Session ${sessionId} does not belong to routine ${workflowId}; refusing to run.`);
  }
}
