import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";
import { applyRoutineRunFilters, mapRoutineRunRow } from "./runs-query";

const makeRecorder = () => {
  const calls: { name: string; args: any[] }[] = [];
  const record = (name: string) =>
    (...args: any[]) => {
      calls.push({ name, args });
      return builder;
    };
  const builder: any = {
    where: record("where"),
    whereIn: record("whereIn"),
    leftJoin: record("leftJoin"),
  };
  return { builder, calls };
};

describe("applyRoutineRunFilters", () => {
  it("always scopes to workflow-type rows within the allowed routine ids", () => {
    const { builder, calls } = makeRecorder();
    applyRoutineRunFilters(builder, {}, ["wf-1", "wf-2"]);
    expect(calls[0]).toEqual({ name: "where", args: ["job_results.type", "workflow"] });
    expect(calls[1]).toEqual({ name: "whereIn", args: ["job_results.workflow", ["wf-1", "wf-2"]] });
  });

  it("applies states, triggers, needsAttention, and date filters", () => {
    const { builder, calls } = makeRecorder();
    const from = new Date("2026-07-01T00:00:00Z");
    const to = new Date("2026-07-15T00:00:00Z");
    applyRoutineRunFilters(
      builder,
      { states: ["failed"], triggers: ["email"], needsAttention: true, from, to },
      ["wf-1"],
    );
    expect(calls).toContainEqual({ name: "whereIn", args: ["job_results.state", ["failed"]] });
    expect(calls).toContainEqual({ name: "whereIn", args: ["job_results.trigger", ["email"]] });
    expect(calls).toContainEqual({
      name: "where",
      args: ["job_results.state", JOB_STATUS_ENUM.waiting_approval],
    });
    expect(calls).toContainEqual({ name: "where", args: ["job_results.createdAt", ">=", from] });
    expect(calls).toContainEqual({ name: "where", args: ["job_results.createdAt", "<=", to] });
  });

  it("search joins agent_sessions and ILIKEs the title", () => {
    const { builder, calls } = makeRecorder();
    applyRoutineRunFilters(builder, { search: "spare" }, ["wf-1"]);
    expect(calls).toContainEqual({
      name: "leftJoin",
      args: ["agent_sessions", "job_results.session", "agent_sessions.id"],
    });
    expect(calls).toContainEqual({
      name: "where",
      args: ["agent_sessions.title", "ilike", "%spare%"],
    });
  });

  it("skips optional filters when absent", () => {
    const { builder, calls } = makeRecorder();
    applyRoutineRunFilters(builder, { states: [], triggers: [] }, ["wf-1"]);
    expect(calls).toHaveLength(2); // type + workflow scope only
  });
});

describe("mapRoutineRunRow", () => {
  const routineById = new Map([["wf-1", { id: "wf-1", name: "Spare parts", agent: "agent-9" }]]);

  it("maps columns, parses json strings, and joins routine name + agent", () => {
    const run = mapRoutineRunRow(
      {
        id: "jr-1",
        job_id: "bull-1",
        state: "waiting_approval",
        trigger: "email",
        trigger_metadata: JSON.stringify({ from: "a@b.com", subject: "Hi" }),
        session: "sess-1",
        workflow: "wf-1",
        error: null,
        tries: 2,
        createdAt: "2026-07-15T09:00:00Z",
        updatedAt: "2026-07-15T09:05:00Z",
      },
      routineById,
    );
    expect(run).toMatchObject({
      id: "jr-1",
      job_id: "bull-1",
      state: "waiting_approval",
      trigger: "email",
      session: "sess-1",
      workflow: "wf-1",
      workflowName: "Spare parts",
      agent: "agent-9",
      tries: 2,
    });
    expect(run.trigger_metadata).toEqual({ from: "a@b.com", subject: "Hi" });
  });

  it("handles jsonb objects, unknown routines, and pre-migration null trigger", () => {
    const run = mapRoutineRunRow(
      {
        id: "jr-2",
        job_id: null,
        state: "completed",
        trigger: null,
        trigger_metadata: { cron: "0 3 * * *" },
        session: null,
        workflow: "wf-gone",
        error: { message: "boom" },
        tries: 1,
        createdAt: "2026-07-14T09:00:00Z",
        updatedAt: "2026-07-14T09:00:00Z",
      },
      routineById,
    );
    expect(run.workflowName).toBeNull();
    expect(run.agent).toBeNull();
    expect(run.trigger).toBeNull();
    expect(run.trigger_metadata).toEqual({ cron: "0 3 * * *" });
    expect(run.error).toEqual({ message: "boom" });
  });

  it("maps token totals and cost from metadata.tokens (jsonb or string)", () => {
    const fromObject = mapRoutineRunRow(
      {
        id: "jr-3",
        state: "completed",
        workflow: "wf-1",
        createdAt: "2026-07-29T09:00:00Z",
        updatedAt: "2026-07-29T09:01:00Z",
        metadata: { tokens: { inputTokens: 12340, outputTokens: 4512, costUsd: 0.021 } },
      },
      routineById,
    );
    expect(fromObject).toMatchObject({
      inputTokens: 12340,
      outputTokens: 4512,
      costUsd: 0.021,
    });

    const fromString = mapRoutineRunRow(
      {
        id: "jr-4",
        state: "completed",
        workflow: "wf-1",
        createdAt: "2026-07-29T09:00:00Z",
        updatedAt: "2026-07-29T09:01:00Z",
        metadata: JSON.stringify({ tokens: { inputTokens: 5, outputTokens: 6 } }),
      },
      routineById,
    );
    // costUsd absent → null; tokens still mapped
    expect(fromString).toMatchObject({ inputTokens: 5, outputTokens: 6, costUsd: null });

    const noMetadata = mapRoutineRunRow(
      { id: "jr-5", state: "filtered", workflow: "wf-1", metadata: null },
      routineById,
    );
    expect(noMetadata).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
});
