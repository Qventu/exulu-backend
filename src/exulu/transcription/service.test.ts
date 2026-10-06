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

// Mutable so individual tests (markReviewed / finalize) can observe or stub
// context.createItem without a second mocking harness. Name prefixed
// "mock" per jest's out-of-scope-variable rule for jest.mock factories.
let mockCreateItem: (...args: any[]) => any = jest.fn();
jest.mock("@SRC/exulu/app/singleton", () => ({
  exuluApp: {
    get: () => ({
      _config: { fileUploads: { s3Bucket: "exulu" } },
      context: (_name: string) => ({
        createItem: (...args: any[]) => mockCreateItem(...args),
      }),
    }),
  },
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
  mockCreateItem = jest.fn();
});

/**
 * Minimal, fully-populated transcription_jobs row for markReviewed/finalize
 * tests. _rowFromDb's parseJsonField passes non-string values through
 * untouched, so feeding already-"parsed" values here (plain arrays/objects,
 * not JSON strings) stands in for what db(JOBS).first() would hand back.
 */
const jobRow = (overrides: Record<string, unknown> = {}): any => ({
  id: "job-1",
  audio_s3key: "exulu/user_1/file.m4a",
  title: "Standup",
  status: "awaiting_review",
  whisper_job_id: null,
  raw_segments: [{ start: 0, end: 1, speaker: "SPEAKER_00", text: "Hello." }],
  speakers: null,
  language: null,
  duration_seconds: null,
  project_id: null,
  target_rights_mode: "private",
  target_rbac_users: null,
  target_rbac_roles: null,
  saved_item_id: null,
  reviewed_at: null,
  error: null,
  rights_mode: "private",
  created_by: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  post_processing_prompts: null,
  post_processing_outputs: null,
  recall_recording_id: null,
  source: "whisper",
  chunk_count: null,
  last_chunk_at: null,
  corrected_segments: null,
  ...overrides,
});

/** Points the `exuluApp.get().context(...)` mock's createItem at a given fn. */
const mockContext = ({ createItem }: { createItem: (...args: any[]) => any }) => {
  mockCreateItem = createItem;
};

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

describe("markReviewed", () => {
  it("signs the job off without creating a knowledge-base item", async () => {
    const row = jobRow({ status: "awaiting_review", reviewed_at: null });
    firstResults[JOBS] = [row];
    const createItem = jest.fn();
    mockContext({ createItem });

    const result = await transcriptionService.markReviewed(row.id, {
      speakers: { SPEAKER_00: "Lena Brandt" },
    });

    expect(createItem).not.toHaveBeenCalled();
    expect(result.status).toBe("reviewed");
    expect(result.reviewed_at).toBeTruthy();
    // The update values markReviewed writes never touch saved_item_id, so the
    // fake's update().returning() (which merges only {id, ...values}) won't
    // carry the column forward — falsy covers both that and a real DB's
    // untouched-column null.
    expect(result.saved_item_id).toBeFalsy();
  });

  it("persists the corrections, which is what an export will read", async () => {
    // Nothing renders text here: the export builders work from
    // raw_segments + corrected_segments + speakers, all of which the job
    // already carries. Rendering a second copy onto the job would be a
    // duplicate that can drift from the corrections.
    const row = jobRow({ status: "awaiting_review" });
    firstResults[JOBS] = [row];
    const corrected = [{ start: 0, end: 2, speaker: "SPEAKER_00", text: "Also." }];

    await transcriptionService.markReviewed(row.id, {
      speakers: { SPEAKER_00: "Lena Brandt" },
      corrected_segments: corrected,
    });

    const written = calls[`${JOBS}.update`].at(-1)?.[0];
    expect(JSON.parse(written.corrected_segments)).toEqual(corrected);
    expect(JSON.parse(written.speakers)).toEqual({ SPEAKER_00: "Lena Brandt" });
  });

  it("refuses a job that is already published", async () => {
    firstResults[JOBS] = [jobRow({ status: "saved", saved_item_id: "item-1" })];

    await expect(
      transcriptionService.markReviewed("job-1", { speakers: {} }),
    ).rejects.toThrow(/saved/);
  });
});

describe("finalize from reviewed", () => {
  it("publishes a reviewed job and keeps its original reviewed_at", async () => {
    const reviewedAt = "2026-10-01T09:00:00.000Z";
    firstResults[JOBS] = [jobRow({ status: "reviewed", reviewed_at: reviewedAt })];
    const createItem = jest.fn().mockResolvedValue({ item: { id: "item-9" } });
    mockContext({ createItem });

    const { row } = await transcriptionService.finalize("job-1", { speakers: {} });

    expect(createItem).toHaveBeenCalled();
    expect(row.status).toBe("saved");
    expect(row.reviewed_at).toBe(reviewedAt);
  });

  it("stamps reviewed_at when publishing straight from awaiting_review", async () => {
    firstResults[JOBS] = [jobRow({ status: "awaiting_review", reviewed_at: null })];
    mockContext({ createItem: jest.fn().mockResolvedValue({ item: { id: "item-9" } }) });

    const { row } = await transcriptionService.finalize("job-1", { speakers: {} });

    expect(row.reviewed_at).toBeTruthy();
  });

  it("can still be cancelled after review", async () => {
    firstResults[JOBS] = [jobRow({ status: "reviewed" })];

    const row = await transcriptionService.cancelJob("job-1");

    expect(row.status).toBe("cancelled");
  });
});
