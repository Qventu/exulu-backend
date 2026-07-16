import { createRunSession, isRunSessionMetadata } from "./run-session";

const createFakeDb = (routineRbacRows: any[]) => {
  const inserted: { agent_sessions: any[]; rbac: any[] } = { agent_sessions: [], rbac: [] };
  const rbacWhereCalls: any[] = [];
  const db = {
    from(table: string) {
      if (table === "agent_sessions") {
        return {
          insert(row: any) {
            inserted.agent_sessions.push(row);
            return { returning: async () => [{ id: "session-uuid-1" }] };
          },
        };
      }
      if (table === "rbac") {
        return {
          where(criteria: any) {
            rbacWhereCalls.push(criteria);
            return { select: async () => routineRbacRows };
          },
          insert: async (rows: any[]) => {
            inserted.rbac.push(...rows);
            return rows.length;
          },
        };
      }
      throw new Error("unexpected table " + table);
    },
  };
  return { db, inserted, rbacWhereCalls };
};

const workflow = { id: "wf-1", name: "Spare parts", agent: "agent-1", rights_mode: "roles" };

describe("createRunSession", () => {
  it("creates the session with agent/user/title/rights_mode and run metadata", async () => {
    const { db, inserted } = createFakeDb([]);
    const sessionId = await createRunSession({
      db,
      workflow,
      userId: 7,
      title: "Spare parts — 2026-07-15",
      trigger: "manual",
      jobResultId: "jr-1",
    });

    expect(sessionId).toBe("session-uuid-1");
    const row = inserted.agent_sessions[0];
    expect(row.agent).toBe("agent-1");
    expect(row.user).toBe(7);
    expect(row.created_by).toBe(7);
    expect(row.title).toBe("Spare parts — 2026-07-15");
    expect(row.rights_mode).toBe("roles");
    expect(row.metadata).toEqual({ routine_id: "wf-1", job_result_id: "jr-1", trigger: "manual" });
  });

  it("defaults rights_mode to private and job_result_id to null", async () => {
    const { db, inserted } = createFakeDb([]);
    await createRunSession({
      db,
      workflow: { id: "wf-1", name: "R", agent: "agent-1" },
      userId: 7,
      title: "t",
      trigger: "schedule",
    });
    expect(inserted.agent_sessions[0].rights_mode).toBe("private");
    expect(inserted.agent_sessions[0].metadata.job_result_id).toBeNull();
  });

  it("duplicates the routine's rbac rows onto the session (entity agent_session)", async () => {
    const routineRows = [
      { entity: "workflow_template", access_type: "User", target_resource_id: "wf-1", user_id: 9, role_id: null, team_id: null, rights: "write" },
      { entity: "workflow_template", access_type: "Role", target_resource_id: "wf-1", user_id: null, role_id: "role-1", team_id: null, rights: "read" },
      { entity: "workflow_template", access_type: "Team", target_resource_id: "wf-1", user_id: null, role_id: null, team_id: "team-1", rights: "read" },
    ];
    const { db, inserted, rbacWhereCalls } = createFakeDb(routineRows);
    await createRunSession({ db, workflow, userId: 7, title: "t", trigger: "email" });

    expect(rbacWhereCalls[0]).toEqual({ entity: "workflow_template", target_resource_id: "wf-1" });
    expect(inserted.rbac).toHaveLength(3);
    for (const row of inserted.rbac) {
      expect(row.entity).toBe("agent_session");
      expect(row.target_resource_id).toBe("session-uuid-1");
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.updatedAt).toBeInstanceOf(Date);
    }
    expect(inserted.rbac[0]).toMatchObject({ access_type: "User", user_id: 9, rights: "write" });
    expect(inserted.rbac[1]).toMatchObject({ access_type: "Role", role_id: "role-1", rights: "read" });
    expect(inserted.rbac[2]).toMatchObject({ access_type: "Team", team_id: "team-1", rights: "read" });
  });

  it("skips the rbac insert when the routine has no rbac rows", async () => {
    const { db, inserted } = createFakeDb([]);
    await createRunSession({ db, workflow, userId: 7, title: "t", trigger: "api" });
    expect(inserted.rbac).toHaveLength(0);
  });
});

describe("isRunSessionMetadata", () => {
  it("is true for objects and JSON strings with job_result_id", () => {
    expect(isRunSessionMetadata({ job_result_id: "jr-1" })).toBe(true);
    expect(isRunSessionMetadata(JSON.stringify({ job_result_id: "jr-1" }))).toBe(true);
  });
  it("is false for null, plain sessions, and malformed strings", () => {
    expect(isRunSessionMetadata(null)).toBe(false);
    expect(isRunSessionMetadata(undefined)).toBe(false);
    expect(isRunSessionMetadata({})).toBe(false);
    expect(isRunSessionMetadata({ job_result_id: null })).toBe(false);
    expect(isRunSessionMetadata("not-json")).toBe(false);
  });
});
