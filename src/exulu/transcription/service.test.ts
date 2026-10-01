/**
 * transcriptionService — the upload pipeline's post-processing hook.
 *
 * shouldRunUploadPostProcessing is a pure predicate extracted from
 * _applyJobUpdate (the poll loop's per-tick decision point for every
 * transcribing row) specifically so it can be tested directly without
 * driving the whole poll tick. Same chainable db-fake pattern as
 * src/exulu/transcription/live-recording.test.ts.
 */
const runPostProcessingSpy = jest.fn(async () => []);
jest.mock("@SRC/exulu/recall/service", () => ({
  recallService: { runPostProcessing: (...args: any[]) => runPostProcessingSpy(...args) },
}));

const submitJobSpy = jest.fn(async () => ({ job_id: "wj-1" }));
jest.mock("./client", () => ({
  transcriptionClient: {
    isConfigured: () => true,
    submitJob: (...args: any[]) => submitJobSpy(...args),
  },
  TranscriptionServerUnavailable: class extends Error {},
}));

jest.mock("@SRC/exulu/app/singleton", () => ({
  exuluApp: { get: () => ({ _config: { fileUploads: { s3Bucket: "exulu" } } }) },
}));

jest.mock("@SRC/uppy", () => ({
  getPresignedUrl: jest.fn(async () => "https://signed.example/audio.m4a"),
}));

const calls: Record<string, any[][]> = {};
const firstResults: Record<string, any[]> = {};
const updateResults: Record<string, number[]> = {};

const record = (table: string, name: string, builder: any) =>
  (...args: any[]) => {
    (calls[`${table}.${name}`] ||= []).push(args);
    return builder;
  };

const builderFor = (table: string) => {
  const builder: any = {};
  for (const m of ["where", "select", "whereIn", "whereNotIn", "whereNotNull", "orderBy", "limit"]) {
    builder[m] = record(table, m, builder);
  }
  builder.first = jest.fn(async () => (firstResults[table] ||= []).shift());
  // update(): `await` → affected count; `.returning("*")` → [] when count is 0.
  builder.update = (values: any) => {
    (calls[`${table}.update`] ||= []).push([values]);
    const count = (updateResults[table] ||= []).shift() ?? 1;
    const thenable: any = Promise.resolve(count);
    thenable.returning = jest.fn(async () => (count === 0 ? [] : [{ id: "jr-1", ...values }]));
    return thenable;
  };
  builder.insert = (values: any) => {
    (calls[`${table}.insert`] ||= []).push([values]);
    return { returning: jest.fn(async () => [{ id: "jr-1", ...values }]) };
  };
  return builder;
};

const db: any = jest.fn((table: string) => builderFor(table));
db.from = (table: string) => builderFor(table);
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db })),
}));

import { transcriptionService, shouldRunUploadPostProcessing } from "./service";

const JOBS = "transcription_jobs";

beforeEach(() => {
  for (const store of [calls, firstResults, updateResults]) {
    for (const key of Object.keys(store)) delete store[key];
  }
  jest.clearAllMocks();
  submitJobSpy.mockResolvedValue({ job_id: "wj-1" } as any);
});

describe("shouldRunUploadPostProcessing", () => {
  const prompts = [{ prompt_id: "p", agent_id: "a" }];

  it("runs when a job with prompts completes", () => {
    expect(shouldRunUploadPostProcessing("completed", prompts, null)).toBe(true);
  });

  it("does NOT run while the job is still running", () => {
    expect(shouldRunUploadPostProcessing("running", prompts, null)).toBe(false);
  });

  it("does NOT run on a queued job", () => {
    expect(shouldRunUploadPostProcessing("queued", prompts, null)).toBe(false);
  });

  it("does NOT run on failure", () => {
    expect(shouldRunUploadPostProcessing("failed", prompts, null)).toBe(false);
  });

  it("does NOT run on cancellation", () => {
    expect(shouldRunUploadPostProcessing("cancelled", prompts, null)).toBe(false);
  });

  it("does NOT run when the job has no prompts", () => {
    expect(shouldRunUploadPostProcessing("completed", [], null)).toBe(false);
    expect(shouldRunUploadPostProcessing("completed", null, null)).toBe(false);
  });

  it("does NOT run again when outputs already exist", () => {
    // The poll loop re-reads rows; a completed job whose run already happened
    // must not pay for a second one.
    expect(
      shouldRunUploadPostProcessing("completed", prompts, [
        { prompt_id: "p", agent_id: "a", prompt_name: null, status: "done", output: "x", error: null, ran_at: "t" },
      ]),
    ).toBe(false);
  });
});

describe("startJob", () => {
  it("persists post_processing_prompts on the insert, JSON-encoded like target_rbac_users", async () => {
    const prompts = [{ prompt_id: "p1", agent_id: "a1" }];
    await transcriptionService.startJob({
      userId: 1,
      s3Key: "exulu/user_1/file.m4a",
      filename: "file.m4a",
      post_processing_prompts: prompts,
    });

    const [values] = calls[`${JOBS}.insert`][0];
    expect(values.post_processing_prompts).toBe(JSON.stringify(prompts));
  });

  it("stores NULL when no prompts are given", async () => {
    await transcriptionService.startJob({
      userId: 1,
      s3Key: "exulu/user_1/file.m4a",
      filename: "file.m4a",
    });

    const [values] = calls[`${JOBS}.insert`][0];
    expect(values.post_processing_prompts).toBeNull();
  });
});

describe("_applyJobUpdate — upload post-processing hook", () => {
  const completedJob = { status: "completed", segments: [], language: null, duration_seconds: 42 } as any;

  it("fires runPostProcessing once a completed upload has prompts", async () => {
    const row = {
      id: "job-1",
      post_processing_prompts: [{ prompt_id: "p", agent_id: "a" }],
      post_processing_outputs: null,
    } as any;

    await transcriptionService._applyJobUpdate(row, completedJob);

    expect(runPostProcessingSpy).toHaveBeenCalledTimes(1);
    expect(runPostProcessingSpy).toHaveBeenCalledWith("job-1");
    // The row still reaches awaiting_review regardless of post-processing.
    const [values] = calls[`${JOBS}.update`][0];
    expect(values.status).toBe("awaiting_review");
  });

  it("does NOT fire again when outputs already exist", async () => {
    const row = {
      id: "job-2",
      post_processing_prompts: [{ prompt_id: "p", agent_id: "a" }],
      post_processing_outputs: [
        { prompt_id: "p", agent_id: "a", prompt_name: null, status: "done", output: "x", error: null, ran_at: "t" },
      ],
    } as any;

    await transcriptionService._applyJobUpdate(row, completedJob);

    expect(runPostProcessingSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire when the upload has no prompts", async () => {
    const row = { id: "job-3", post_processing_prompts: null, post_processing_outputs: null } as any;

    await transcriptionService._applyJobUpdate(row, completedJob);

    expect(runPostProcessingSpy).not.toHaveBeenCalled();
  });

  it("still reaches awaiting_review when post-processing rejects (fire-and-forget)", async () => {
    runPostProcessingSpy.mockRejectedValueOnce(new Error("boom"));
    const row = {
      id: "job-4",
      post_processing_prompts: [{ prompt_id: "p", agent_id: "a" }],
      post_processing_outputs: null,
    } as any;

    await expect(transcriptionService._applyJobUpdate(row, completedJob)).resolves.toBeUndefined();

    const [values] = calls[`${JOBS}.update`][0];
    expect(values.status).toBe("awaiting_review");
  });
});
