/**
 * The workflow worker trusts `data.session` from the job payload. Before a run
 * writes into an existing session, the session must be one of THIS routine's run
 * sessions (finding 5 of the storage/sandbox hotfix).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyRunSessionOwnership } from "./run-session";

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

describe("worker wiring", () => {
  const source = readFileSync(join(__dirname, "../../../ee/workers.ts"), "utf8");
  it("verifies an existing session before the run generates anything", () => {
    const branch = source.slice(source.indexOf('if (data.type === "workflow")'));
    const verify = branch.indexOf("verifyRunSessionOwnership(");
    const generate = branch.indexOf("await processUiMessagesFlow(");
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(generate);
    // Guarded by the existing-session case, against the routine of this job.
    expect(branch.slice(0, verify)).toMatch(/if \(started\.session\)/);
    expect(branch.slice(verify, verify + 200)).toMatch(/workflowId:\s*workflow\.id/);
  });
});
