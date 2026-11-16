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

describe("work status in the runs query", () => {
  const recorder = () => {
    const calls: { name: string; args: any[] }[] = [];
    const builder: any = {};
    for (const name of ["where", "whereIn", "whereNull", "orWhereNotIn", "whereRaw", "leftJoin"]) {
      builder[name] = (...args: any[]) => {
        calls.push({ name, args });
        // A where(fn) group: run the callback against the same recorder.
        if (name === "where" && typeof args[0] === "function") args[0](builder);
        return builder;
      };
    }
    return { builder, calls };
  };

  it("filters by explicit work statuses", () => {
    const { builder, calls } = recorder();
    applyRoutineRunFilters(builder, { workStatuses: ["neu", "rueckfrage"] }, ["wf-1"]);
    expect(calls).toContainEqual({ name: "whereIn", args: ["job_results.work_status", ["neu", "rueckfrage"]] });
  });

  it("open = no status or a status that is not done", () => {
    const { builder, calls } = recorder();
    applyRoutineRunFilters(builder, { workStatusOpen: true }, ["wf-1"], ["erledigt", "storniert"]);
    expect(calls).toContainEqual({ name: "whereNull", args: ["job_results.work_status"] });
    expect(calls).toContainEqual({ name: "orWhereNotIn", args: ["job_results.work_status", ["erledigt", "storniert"]] });
  });

  it("done = a status flagged done", () => {
    const { builder, calls } = recorder();
    applyRoutineRunFilters(builder, { workStatusOpen: false }, ["wf-1"], ["erledigt"]);
    expect(calls).toContainEqual({ name: "whereIn", args: ["job_results.work_status", ["erledigt"]] });
    expect(calls.some((c) => c.name === "whereNull")).toBe(false);
  });

  it("with no done status configured, open matches everything and done matches nothing", () => {
    const open = recorder();
    applyRoutineRunFilters(open.builder, { workStatusOpen: true }, ["wf-1"], []);
    expect(open.calls.some((c) => c.name === "whereNull" || c.name === "orWhereNotIn")).toBe(false);
    const done = recorder();
    applyRoutineRunFilters(done.builder, { workStatusOpen: false }, ["wf-1"], []);
    expect(done.calls).toContainEqual({ name: "whereRaw", args: ["1 = 0"] });
  });

  it("ignores workStatusOpen when the done keys are unknown (cross-routine list)", () => {
    const { builder, calls } = recorder();
    applyRoutineRunFilters(builder, { workStatusOpen: true }, ["wf-1", "wf-2"]);
    expect(calls.map((c) => c.name)).toEqual(["where", "whereIn"]);
  });

  it("maps the work status columns, parsing updated_by from a string, and nulls when absent", () => {
    const routineById = new Map([["wf-1", { id: "wf-1", name: "R", agent: "a" }]]);
    const at = new Date("2026-11-16T09:12:00Z");
    const run = mapRoutineRunRow(
      { id: "jr-1", state: "completed", workflow: "wf-1", work_status: "alt_geloescht", work_status_updated_at: at, work_status_updated_by: '{"kind":"user","id":14}' },
      routineById,
    );
    expect(run.work_status).toBe("alt_geloescht");
    expect(run.work_status_updated_at).toBe(at);
    expect(run.work_status_updated_by).toEqual({ kind: "user", id: 14 });
    const bare = mapRoutineRunRow({ id: "jr-2", state: "completed", workflow: "wf-1" }, routineById);
    expect(bare.work_status).toBeNull();
    expect(bare.work_status_updated_at).toBeNull();
    expect(bare.work_status_updated_by).toBeNull();
  });
});
