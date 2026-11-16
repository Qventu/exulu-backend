/**
 * The workflow worker trusts `data.session` from the job payload. Before a run
 * writes into an existing session, the session must be one of THIS routine's run
 * sessions (finding 5 of the storage/sandbox hotfix).
 */
import { verifyRunSessionOwnership, withRunSession } from "./run-session";

const dbWith = (rows: Record<string, any>) => ({
  from(table: string) {
    if (table !== "agent_sessions") throw new Error("unexpected table " + table);
    return {
      where(criteria: { id: string }) {
        return { first: async () => rows[criteria.id] };
      },
    };
  },
});

const runUser = { id: 7, type: "user", super_admin: false } as any;

describe("verifyRunSessionOwnership", () => {
  it("accepts the routine's own run session (run column and metadata.routine_id)", async () => {
    const db = dbWith({ s1: { id: "s1", run: "wf-1", metadata: { routine_id: "wf-1", job_result_id: "jr" }, created_by: 99 } });
    await expect(verifyRunSessionOwnership(db, { sessionId: "s1", workflowId: "wf-1", runUser })).resolves.toBeUndefined();
  });

  it("accepts metadata stored as a JSON string", async () => {
    const db = dbWith({ s1: { id: "s1", run: null, metadata: JSON.stringify({ routine_id: "wf-1" }), created_by: 99 } });
    await expect(verifyRunSessionOwnership(db, { sessionId: "s1", workflowId: "wf-1", runUser })).resolves.toBeUndefined();
  });

  it("a session without run markers falls back to write access of the run user", async () => {
    const db = dbWith({ chat: { id: "chat", run: null, metadata: null, created_by: 7, rights_mode: "private" } });
    // No run marker, falls back to RBAC: run user 7 created it, so this one passes...
    await expect(verifyRunSessionOwnership(db, { sessionId: "chat", workflowId: "wf-1", runUser })).resolves.toBeUndefined();
    // ...but someone else's private chat does not.
    // (distinct id: checkRecordAccess caches per record id + user for a minute)
    const db2 = dbWith({ other: { id: "other", run: null, metadata: null, created_by: 12, rights_mode: "private" } });
    await expect(verifyRunSessionOwnership(db2, { sessionId: "other", workflowId: "wf-1", runUser })).rejects.toThrow(
      /does not belong to routine wf-1/,
    );
  });

  it("refuses another routine's run session regardless of RBAC", async () => {
    const db = dbWith({ s2: { id: "s2", run: "wf-2", metadata: { routine_id: "wf-2" }, created_by: 7, rights_mode: "public" } });
    await expect(verifyRunSessionOwnership(db, { sessionId: "s2", workflowId: "wf-1", runUser })).rejects.toThrow(
      /does not belong to routine wf-1/,
    );
  });

  it("refuses a session whose markers disagree", async () => {
    const db = dbWith({ s3: { id: "s3", run: "wf-1", metadata: { routine_id: "wf-2" }, created_by: 7 } });
    await expect(verifyRunSessionOwnership(db, { sessionId: "s3", workflowId: "wf-1", runUser })).rejects.toThrow();
  });

  it("refuses a missing session", async () => {
    await expect(verifyRunSessionOwnership(dbWith({}), { sessionId: "nope", workflowId: "wf-1", runUser })).rejects.toThrow(
      /not found/,
    );
  });
});

/** agent_sessions rows + a job_results table that records updates. */
const runDb = (sessions: Record<string, any>) => {
  const jobUpdates: Array<{ where: any; values: any }> = [];
  const inserted: any[] = [];
  const db = {
    from(table: string) {
      if (table === "agent_sessions") {
        return {
          where: (criteria: { id: string }) => ({ first: async () => sessions[criteria.id] }),
          insert: (row: any) => {
            inserted.push(row);
            return { returning: async () => [{ id: "new-session" }] };
          },
        };
      }
      if (table === "rbac") {
        return { where: () => ({ select: async () => [] }) };
      }
      if (table === "job_results") {
        return { where: (where: any) => ({ update: async (values: any) => jobUpdates.push({ where, values }) }) };
      }
      throw new Error("unexpected table " + table);
    },
  };
  return { db, jobUpdates, inserted };
};

describe("withRunSession — the worker's session step", () => {
  const workflow = { id: "wf-1", name: "Spare parts", agent: "agent-1", rights_mode: "private" };
  const base = { jobResultId: "jr-1", workflow, runUser, trigger: "api" as const };

  it("a foreign session in the job data: throws, unlinks the job_results row, never generates", async () => {
    const { db, jobUpdates } = runDb({ foreign: { id: "foreign", run: "wf-2", metadata: { routine_id: "wf-2" }, created_by: 7 } });
    const generate = jest.fn(async () => "done");
    await expect(withRunSession(db, { ...base, existingSession: "foreign" }, generate)).rejects.toThrow(
      /does not belong to routine wf-1/,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(jobUpdates).toEqual([{ where: { id: "jr-1", session: "foreign" }, values: { session: null } }]);
  });

  it("the routine's own run session: generates with it and touches nothing else", async () => {
    const { db, jobUpdates, inserted } = runDb({ own: { id: "own", run: "wf-1", metadata: { routine_id: "wf-1" } } });
    const generate = jest.fn(async (sessionId: string) => `ran in ${sessionId}`);
    await expect(withRunSession(db, { ...base, existingSession: "own" }, generate)).resolves.toBe("ran in own");
    expect(generate).toHaveBeenCalledWith("own");
    expect(jobUpdates).toEqual([]);
    expect(inserted).toEqual([]);
  });

  it("no session: creates a run session, links it, then generates", async () => {
    const { db, jobUpdates, inserted } = runDb({});
    const generate = jest.fn(async (sessionId: string) => sessionId);
    await expect(withRunSession(db, { ...base, existingSession: null }, generate)).resolves.toBe("new-session");
    expect(inserted[0]).toMatchObject({ run: "wf-1", metadata: { routine_id: "wf-1", job_result_id: "jr-1" } });
    expect(jobUpdates).toEqual([{ where: { id: "jr-1" }, values: { session: "new-session" } }]);
  });
});
