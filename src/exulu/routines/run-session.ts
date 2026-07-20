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
