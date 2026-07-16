import { JOB_STATUS_ENUM } from "@EXULU_TYPES/enums/jobs";

jest.mock("@EE/queues/queues", () => ({
  queues: { list: new Map() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { queues: queuesMock } = require("@EE/queues/queues") as {
  queues: { list: Map<string, { use: () => Promise<any> }> };
};

import {
  casJobResultState,
  parseRunMetadata,
  resumeRoutineRunIfWaiting,
  upsertWorkflowRunStart,
} from "./run-state";

type Calls = { name: string; args: any[] }[];

const makeJobResultsDb = (opts: { row?: any; update?: jest.Mock; insertId?: string }) => {
  const calls: Calls = [];
  const update = opts.update ?? jest.fn().mockResolvedValue(1);
  const builder: any = {
    where: (...args: any[]) => {
      calls.push({ name: "where", args });
      return builder;
    },
    whereIn: (...args: any[]) => {
      calls.push({ name: "whereIn", args });
      return builder;
    },
    orderBy: (...args: any[]) => {
      calls.push({ name: "orderBy", args });
      return builder;
    },
    first: async () => opts.row,
    update: (...args: any[]) => {
      calls.push({ name: "update", args });
      return update(...args);
    },
    insert: (...args: any[]) => {
      calls.push({ name: "insert", args });
      return { returning: async () => [{ id: opts.insertId ?? "jr-new" }] };
    },
  };
  const db: any = { from: jest.fn(() => builder) };
  return { db, calls, update };
};

afterEach(() => {
  queuesMock.list.clear();
  jest.clearAllMocks();
});

describe("parseRunMetadata", () => {
  it("parses JSON strings, passes objects through, and defaults to {}", () => {
    expect(parseRunMetadata('{"a":1}')).toEqual({ a: 1 });
    expect(parseRunMetadata({ a: 1 })).toEqual({ a: 1 });
    expect(parseRunMetadata(null)).toEqual({});
    expect(parseRunMetadata("boom{")).toEqual({});
  });
});

describe("casJobResultState", () => {
  it("returns true when a row transitioned and records the CAS clauses", async () => {
    const { db, calls } = makeJobResultsDb({});
    const moved = await casJobResultState(db, "jr-1", ["waiting", "active"], "cancelled");
    expect(moved).toBe(true);
    expect(calls.find((c) => c.name === "where")?.args).toEqual([{ id: "jr-1" }]);
    expect(calls.find((c) => c.name === "whereIn")?.args).toEqual(["state", ["waiting", "active"]]);
    expect(calls.find((c) => c.name === "update")?.args).toEqual([{ state: "cancelled" }]);
  });

  it("returns false when no row matched (CAS lost)", async () => {
    const { db } = makeJobResultsDb({ update: jest.fn().mockResolvedValue(0) });
    expect(await casJobResultState(db, "jr-1", ["failed"], "waiting")).toBe(false);
  });
});

describe("upsertWorkflowRunStart", () => {
  const bookkeeping = {
    run_as: { user: 7, role: "role-1" },
    inputs: { email_body: "" },
    queue_name: "workflow-queue",
  };
  const baseOpts = {
    jobId: "bull-1",
    label: "workflow-run-wf-1",
    state: "active",
    workflow: "wf-1",
    session: null,
    trigger: "email",
    triggerMetadata: { message_id: "<x@y>" },
    bookkeeping,
    resumeFromIndex: 0,
  };

  it("updates in place when jobResultId is provided (continuation/retry/email intake)", async () => {
    const { db, calls } = makeJobResultsDb({});
    const result = await upsertWorkflowRunStart(db, {
      ...baseOpts,
      jobResultId: "jr-9",
      session: "sess-9",
      resumeFromIndex: 3,
    });
    expect(result).toEqual({ jobResultId: "jr-9", session: "sess-9", resumeFromIndex: 3 });
    expect(calls.find((c) => c.name === "where")?.args).toEqual([{ id: "jr-9" }]);
    const updateArgs = calls.find((c) => c.name === "update")!.args[0];
    expect(updateArgs.job_id).toBe("bull-1");
    expect(updateArgs.workflow).toBe("wf-1");
    expect(updateArgs.trigger).toBe("email");
    expect(updateArgs.session).toBe("sess-9");
    expect(JSON.parse(updateArgs.metadata)).toEqual({ ...bookkeeping, current_step_index: 3 });
  });

  it("merges prior metadata on the jobResultId path — pre-pause tokens/messages survive (spec §5.7)", async () => {
    const existing = {
      id: "jr-9",
      metadata: JSON.stringify({
        tokens: {
          totalTokens: 500,
          reasoningTokens: 10,
          inputTokens: 300,
          outputTokens: 200,
          cachedInputTokens: 0,
        },
        messages: [{ id: "m-old" }],
        ...bookkeeping,
        current_step_index: 1,
      }),
    };
    const { db, calls } = makeJobResultsDb({ row: existing });
    await upsertWorkflowRunStart(db, {
      ...baseOpts,
      jobResultId: "jr-9",
      session: "sess-9",
      resumeFromIndex: 2,
    });
    const merged = JSON.parse(calls.find((c) => c.name === "update")!.args[0].metadata);
    expect(merged.tokens.totalTokens).toBe(500);
    expect(merged.messages).toEqual([{ id: "m-old" }]);
    expect(merged.queue_name).toBe("workflow-queue");
    expect(merged.current_step_index).toBe(2);
  });

  it("reuses an existing row by job_id on BullMQ attempt retries (session + progress survive)", async () => {
    const existing = {
      id: "jr-5",
      session: "sess-5",
      tries: 1,
      metadata: JSON.stringify({ ...bookkeeping, current_step_index: 2 }),
    };
    const { db, calls } = makeJobResultsDb({ row: existing });
    const result = await upsertWorkflowRunStart(db, baseOpts);
    expect(result).toEqual({ jobResultId: "jr-5", session: "sess-5", resumeFromIndex: 2 });
    const updateArgs = calls.find((c) => c.name === "update")!.args[0];
    expect(updateArgs.tries).toBe(2);
    expect(JSON.parse(updateArgs.metadata).current_step_index).toBe(2);
  });

  it("inserts a fresh row (type workflow, trigger stamped) otherwise", async () => {
    const { db, calls } = makeJobResultsDb({ row: undefined, insertId: "jr-new" });
    const result = await upsertWorkflowRunStart(db, baseOpts);
    expect(result).toEqual({ jobResultId: "jr-new", session: null, resumeFromIndex: 0 });
    const insertArgs = calls.find((c) => c.name === "insert")!.args[0];
    expect(insertArgs).toMatchObject({
      job_id: "bull-1",
      label: "workflow-run-wf-1",
      state: "active",
      tries: 1,
      type: "workflow",
      workflow: "wf-1",
      trigger: "email",
    });
    expect(JSON.parse(insertArgs.trigger_metadata)).toEqual({ message_id: "<x@y>" });
    expect(JSON.parse(insertArgs.metadata)).toEqual({ ...bookkeeping, current_step_index: 0 });
  });
});

describe("resumeRoutineRunIfWaiting", () => {
  const waitingRow = {
    id: "jr-1",
    state: JOB_STATUS_ENUM.waiting_approval,
    workflow: "wf-1",
    session: "sess-1",
    trigger: "email",
    trigger_metadata: { message_id: "<x@y>" },
    metadata: JSON.stringify({
      run_as: { user: 7, role: "role-1" },
      inputs: { email_body: "hello" },
      queue_name: "workflow-queue",
      current_step_index: 1,
    }),
  };

  const registerQueue = () => {
    const add = jest.fn().mockResolvedValue({ id: "bull-2" });
    queuesMock.list.set("workflow-queue", {
      use: async () => ({ queue: { add }, timeoutInSeconds: 180, retries: undefined, backoff: undefined }),
    });
    return add;
  };

  it("returns false when there is no run row or it is not waiting_approval", async () => {
    expect(await resumeRoutineRunIfWaiting(makeJobResultsDb({ row: undefined }).db, "sess-1")).toBe(false);
    expect(
      await resumeRoutineRunIfWaiting(
        makeJobResultsDb({ row: { ...waitingRow, state: "active" } }).db,
        "sess-1",
      ),
    ).toBe(false);
  });

  it("CAS-wins → enqueues the continuation with resumeFromIndex = current_step_index + 1", async () => {
    const add = registerQueue();
    const { db } = makeJobResultsDb({ row: waitingRow });
    const resumed = await resumeRoutineRunIfWaiting(db, "sess-1");
    expect(resumed).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    const [jobName, jobData] = add.mock.calls[0];
    expect(jobName).toBe("workflow_run");
    expect(jobData).toMatchObject({
      type: "workflow",
      workflow: "wf-1",
      session: "sess-1",
      jobResultId: "jr-1",
      resumeFromIndex: 2,
      user: 7,
      role: "role-1",
      triggerSource: "email",
    });
    expect(jobData.inputs).toEqual({ email_body: "hello" });
  });

  it("CAS-loses → does not enqueue (double-approval safe)", async () => {
    const add = registerQueue();
    const { db } = makeJobResultsDb({ row: waitingRow, update: jest.fn().mockResolvedValue(0) });
    expect(await resumeRoutineRunIfWaiting(db, "sess-1")).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it("reverts the CAS and rethrows when the queue is missing", async () => {
    const update = jest.fn().mockResolvedValue(1);
    const { db } = makeJobResultsDb({ row: waitingRow, update });
    await expect(resumeRoutineRunIfWaiting(db, "sess-1")).rejects.toThrow(
      "not registered",
    );
    // First update: waiting_approval -> active. Second: revert active -> waiting_approval.
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1][0]).toEqual({ state: JOB_STATUS_ENUM.waiting_approval });
  });
});
