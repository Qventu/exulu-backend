/**
 * recallService tests — webhook state machine guards, the reconciliation
 * sweep, and post-processing crash-safety.
 *
 * Uses the module-mock + chainable db-fake pattern from
 * src/exulu/email-inbound/intake.test.ts: every query-builder call is recorded
 * per table, `.first()` / awaited-select answers come from per-table FIFOs the
 * test seeds, and `.update()` resolves a seeded affected-row count.
 */

const generateTextSpy = jest.fn(async () => ({ text: "summary text" }));
jest.mock("ai", () => ({
  generateText: (...args: any[]) => generateTextSpy(...args),
}));

const agentSpy = jest.fn(async () => ({
  id: "agent-1",
  name: "Agent One",
  model: "gpt-test",
  instructions: "be helpful",
}));
jest.mock("@SRC/exulu/app/singleton", () => ({
  exuluApp: {
    get: () => ({
      agent: (...args: any[]) => agentSpy(...args),
      providers: [],
    }),
  },
}));

const resolveModelSpy = jest.fn(async () => ({ languageModel: { id: "lm" } }));
jest.mock("@SRC/exulu/resolve-model", () => ({
  resolveModel: (...args: any[]) => resolveModelSpy(...args),
}));

const recallEnabledSpy = jest.fn(() => true);
jest.mock("./env", () => ({
  recallEnabled: () => recallEnabledSpy(),
  RecallNotConfiguredError: class RecallNotConfiguredError extends Error {},
  recordingMonthlyLimitSeconds: () => null,
}));

const createBotSpy = jest.fn<Promise<any>, any[]>(async () => ({ id: "bot-1" }));
const retrieveBotSpy = jest.fn<Promise<any>, any[]>();
const retrieveTranscriptSpy = jest.fn<Promise<any>, any[]>();
const retrieveRecordingSpy = jest.fn<Promise<any>, any[]>();
const createAsyncTranscriptSpy = jest.fn<Promise<any>, any[]>();
const downloadTranscriptSpy = jest.fn<Promise<any>, any[]>();
jest.mock("./client", () => ({
  recallClient: {
    createBot: (...args: any[]) => createBotSpy(...args),
    retrieveBot: (...args: any[]) => retrieveBotSpy(...args),
    retrieveTranscript: (...args: any[]) => retrieveTranscriptSpy(...args),
    retrieveRecording: (...args: any[]) => retrieveRecordingSpy(...args),
    createAsyncTranscript: (...args: any[]) => createAsyncTranscriptSpy(...args),
    downloadTranscript: (...args: any[]) => downloadTranscriptSpy(...args),
  },
  recordingDurationSeconds: (rec: any) =>
    typeof rec?.duration === "number" ? rec.duration : null,
}));

// db fake: chainable builders recorded per table. Awaiting a builder resolves
// the next seeded select FIFO entry (an array of rows); .first() shifts from
// its own FIFO; .update() resolves the next seeded affected-count (default 1).
const calls: Record<string, any[][]> = {};
const firstResults: Record<string, any[]> = {};
const selectResults: Record<string, any[][]> = {};
const updateResults: Record<string, number[]> = {};

const record = (table: string, name: string, builder: any) =>
  (...args: any[]) => {
    (calls[`${table}.${name}`] ||= []).push(args);
    return builder;
  };

const builderFor = (table: string) => {
  const builder: any = {};
  for (const m of [
    "where",
    "whereIn",
    "whereNotIn",
    "whereNull",
    "whereNotNull",
    "whereRaw",
    "andWhere",
    "orWhere",
    "orderBy",
    "limit",
    "offset",
  ]) {
    builder[m] = record(table, m, builder);
  }
  builder.first = jest.fn(async () => (firstResults[table] ||= []).shift());
  // update() must support both `await ...update(v)` (affected count) and
  // `...update(v).returning("*")` (updated rows).
  builder.update = (values: any) => {
    (calls[`${table}.update`] ||= []).push([values]);
    const count = (updateResults[table] ||= []).shift() ?? 1;
    const thenable: any = Promise.resolve(count);
    thenable.returning = jest.fn(async () => [{ id: "jr-1", ...values }]);
    return thenable;
  };
  builder.insert = (values: any) => {
    (calls[`${table}.insert`] ||= []).push([values]);
    return { returning: jest.fn(async () => [{ id: "jr-1", ...values }]) };
  };
  builder.sum = jest.fn(async () => [{ total: 0 }]);
  // Awaiting the builder itself resolves a seeded multi-row select.
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve((selectResults[table] ||= []).shift() ?? []).then(
      resolve,
      reject,
    );
  return builder;
};

const db: any = jest.fn((table: string) => builderFor(table));
db.from = (table: string) => builderFor(table);
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db })),
}));

import { recallService } from "./service";

const JOBS = "transcription_jobs";

const resetAll = () => {
  for (const store of [calls, firstResults, selectResults, updateResults]) {
    for (const key of Object.keys(store)) delete store[key];
  }
  jest.clearAllMocks();
  recallEnabledSpy.mockReturnValue(true);
};

beforeEach(resetAll);

describe("_onRecordingDone claim guard", () => {
  test("does not resurrect a cancelled job: the atomic claim excludes 'cancelled'", async () => {
    // Simulate the DB refusing the claim (row is cancelled): update returns 0.
    updateResults[JOBS] = [0];

    await recallService._onRecordingDone("job-1", "rec-1");

    // The claim must exclude every already-advanced state INCLUDING cancelled,
    // so a late recording.done can never flip a cancelled job to transcribing.
    const notIn = (calls[`${JOBS}.whereNotIn`] ?? []).find(
      (args) => args[0] === "status",
    );
    expect(notIn).toBeDefined();
    expect(notIn![1]).toEqual(
      expect.arrayContaining([
        "transcribing",
        "awaiting_review",
        "saved",
        "failed",
        "cancelled",
      ]),
    );

    // Claim refused -> no transcript may be requested.
    expect(createAsyncTranscriptSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reconciliation sweep
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 60 * MIN;

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: "job-1",
  source: "recall",
  status: "queued",
  recall_bot_id: "bot-1",
  recall_recording_id: null,
  recall_transcript_id: null,
  bot_status: null,
  language: null,
  raw_segments: null,
  speakers: null,
  post_processing_prompts: null,
  post_processing_outputs: null,
  created_by: 7,
  join_at: new Date(Date.now() - 1 * HOUR),
  createdAt: new Date(Date.now() - 2 * HOUR),
  updatedAt: new Date(Date.now() - 20 * MIN),
  ...over,
});

const updatePayloads = () =>
  (calls[`${JOBS}.update`] ?? []).map((args) => args[0]);

const RAW_TRANSCRIPT = [
  {
    participant: { id: 1, name: "Alice" },
    words: [
      {
        text: "Hello world",
        start_timestamp: { relative: 0 },
        end_timestamp: { relative: 2 },
      },
    ],
  },
];

describe("reconcileOnce", () => {
  test("returns 0 and touches nothing when recall is not configured", async () => {
    recallEnabledSpy.mockReturnValue(false);

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    expect(db).not.toHaveBeenCalled();
  });

  test("recovers a lost recording.done: queued job with bot done and a COMPLETED recording drives the transcript request", async () => {
    selectResults[JOBS] = [
      [jobRow({ bot_status: "done" })],
      [], // post-processing redo select
    ];
    retrieveBotSpy.mockResolvedValue({
      id: "bot-1",
      status_changes: [{ code: "joining_call" }, { code: "done" }],
      recordings: [{ id: "rec-9", status: { code: "done" } }],
    });
    // _onRecordingDone re-reads the row for the language choice.
    firstResults[JOBS] = [jobRow({ bot_status: "done" })];
    createAsyncTranscriptSpy.mockResolvedValue({ id: "tr-5" });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(retrieveBotSpy).toHaveBeenCalledWith("bot-1");
    expect(createAsyncTranscriptSpy).toHaveBeenCalledWith("rec-9", "auto");
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "transcribing",
          recall_recording_id: "rec-9",
        }),
        expect.objectContaining({ recall_transcript_id: "tr-5" }),
      ]),
    );
  });

  test("does NOT transcribe an in-progress recording: a long live meeting only gets a touch", async () => {
    selectResults[JOBS] = [
      [jobRow({ bot_status: "in_call_recording", updatedAt: new Date(Date.now() - 2 * HOUR) })],
      [],
    ];
    retrieveBotSpy.mockResolvedValue({
      id: "bot-1",
      status_changes: [{ code: "in_call_recording" }],
      recordings: [{ id: "rec-9", status: { code: "processing" } }],
    });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    expect(createAsyncTranscriptSpy).not.toHaveBeenCalled();
    for (const payload of updatePayloads()) {
      expect(payload).not.toHaveProperty("status");
    }
  });

  test("verifies completion via retrieveRecording when the bot payload has no recording status", async () => {
    selectResults[JOBS] = [[jobRow({ bot_status: "done" })], []];
    retrieveBotSpy.mockResolvedValue({
      id: "bot-1",
      status_changes: [{ code: "done" }],
      recordings: [{ id: "rec-9" }],
    });
    retrieveRecordingSpy.mockResolvedValue({
      id: "rec-9",
      completed_at: new Date(Date.now() - 30 * MIN).toISOString(),
    });
    firstResults[JOBS] = [jobRow({ bot_status: "done" })];
    createAsyncTranscriptSpy.mockResolvedValue({ id: "tr-5" });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(createAsyncTranscriptSpy).toHaveBeenCalledWith("rec-9", "auto");
  });

  test("fails the job when the recovered recording itself failed", async () => {
    selectResults[JOBS] = [[jobRow({ bot_status: "done" })], []];
    retrieveBotSpy.mockResolvedValue({
      id: "bot-1",
      status_changes: [{ code: "done" }],
      recordings: [{ id: "rec-9", status: { code: "failed" } }],
    });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(createAsyncTranscriptSpy).not.toHaveBeenCalled();
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("recording"),
        }),
      ]),
    );
  });

  test("claims the transcript reissue atomically: a lost claim spends nothing", async () => {
    const row = jobRow({
      status: "transcribing",
      recall_recording_id: "rec-1",
      recall_transcript_id: null,
    });
    selectResults[JOBS] = [[row], []];
    retrieveRecordingSpy.mockResolvedValue({ id: "rec-1", media_shortcuts: {} });
    // Another instance already claimed (bumped updatedAt): claim affects 0 rows.
    updateResults[JOBS] = [0];

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    expect(createAsyncTranscriptSpy).not.toHaveBeenCalled();
  });

  test("fails immediately when Recall reports the transcript itself failed", async () => {
    const row = jobRow({
      status: "transcribing",
      recall_recording_id: "rec-1",
      recall_transcript_id: "tr-1",
    });
    selectResults[JOBS] = [[row], []];
    retrieveTranscriptSpy.mockResolvedValue({
      id: "tr-1",
      status: { code: "error" },
      data: {},
    });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("transcript"),
        }),
      ]),
    );
  });

  test("treats a Recall 404 during reconciliation as terminal", async () => {
    selectResults[JOBS] = [[jobRow({ bot_status: "done" })], []];
    const notFound = Object.assign(new Error("Recall API 404 for /bot/bot-1/"), {
      status: 404,
    });
    retrieveBotSpy.mockRejectedValue(notFound);

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed" }),
      ]),
    );
  });

  test("applies the 24h give-up even when the Recall API keeps erroring", async () => {
    selectResults[JOBS] = [
      [jobRow({ bot_status: "done", join_at: new Date(Date.now() - 25 * HOUR) })],
      [],
    ];
    retrieveBotSpy.mockRejectedValue(new Error("Recall API 500"));

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("24"),
        }),
      ]),
    );
  });

  test("touches the row on a transient Recall API error so the sweep backs off and rotates", async () => {
    selectResults[JOBS] = [[jobRow({ bot_status: "done" })], []];
    retrieveBotSpy.mockRejectedValue(new Error("Recall API 500"));

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    const payloads = updatePayloads();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty("status");
    }
  });

  test("fails a stale queued row that never got a bot id — no webhook can ever match it", async () => {
    selectResults[JOBS] = [[jobRow({ recall_bot_id: null })], []];

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(retrieveBotSpy).not.toHaveBeenCalled();
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("bot"),
        }),
      ]),
    );
  });

  test("stuck select excludes future/just-started meetings; redo select excludes empty prompts and empty transcripts", async () => {
    selectResults[JOBS] = [[], []];

    await recallService.reconcileOnce();

    const raws = (calls[`${JOBS}.whereRaw`] ?? []).map((args) => args[0]);
    expect(raws.some((sql) => sql.includes("join_at"))).toBe(true);
    expect(
      raws.some((sql) => sql.includes("post_processing_prompts::text <> '[]'")),
    ).toBe(true);
    expect(raws.some((sql) => sql.includes("raw_segments"))).toBe(true);
  });
});

describe("createMeetingBot input normalization", () => {
  test("stores NULL, not '[]', when no post-processing prompts are configured", async () => {
    firstResults[JOBS] = [];

    await recallService.createMeetingBot({
      userId: 7,
      meeting_url: "https://meet.example/abc",
      post_processing_prompts: [],
    });

    const inserts = (calls[`${JOBS}.insert`] ?? []).map((args) => args[0]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].post_processing_prompts).toBeNull();
  });
});

describe("reconcileOnce recovery paths and post-processing crash-safety", () => {
  test("fails a queued job whose bot finished without any recording", async () => {
    selectResults[JOBS] = [[jobRow({ bot_status: "done" })], []];
    retrieveBotSpy.mockResolvedValue({
      id: "bot-1",
      status_changes: [{ code: "done" }],
      recordings: [],
    });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("without a recording"),
        }),
      ]),
    );
  });

  test("completes a lost transcript.done: transcribing job with a ready transcript is downloaded and moved to awaiting_review", async () => {
    const row = jobRow({
      status: "transcribing",
      recall_recording_id: "rec-1",
      recall_transcript_id: "tr-1",
    });
    selectResults[JOBS] = [[row], []];
    retrieveTranscriptSpy.mockResolvedValue({
      id: "tr-1",
      data: { download_url: "https://s3.example/t.json" },
    });
    downloadTranscriptSpy.mockResolvedValue(RAW_TRANSCRIPT);
    retrieveRecordingSpy.mockResolvedValue({ id: "rec-1", duration: 1234 });
    // _onTranscriptDone re-reads the row, then runPostProcessing reads it again.
    firstResults[JOBS] = [{ ...row }, { ...row }];

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(downloadTranscriptSpy).toHaveBeenCalledWith(
      "https://s3.example/t.json",
    );
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "awaiting_review",
          raw_segments: expect.stringContaining("Hello world"),
          duration_seconds: 1234,
        }),
      ]),
    );
  });

  test("re-requests the transcript when the claim crashed before createAsyncTranscript", async () => {
    const row = jobRow({
      status: "transcribing",
      recall_recording_id: "rec-1",
      recall_transcript_id: null,
    });
    selectResults[JOBS] = [[row], []];
    // The recording exists but has no transcript attached -> the original
    // createAsyncTranscript never happened; the sweep must issue it now.
    retrieveRecordingSpy.mockResolvedValue({ id: "rec-1", media_shortcuts: {} });
    createAsyncTranscriptSpy.mockResolvedValue({ id: "tr-7" });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(createAsyncTranscriptSpy).toHaveBeenCalledWith("rec-1", "auto");
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recall_transcript_id: "tr-7" }),
      ]),
    );
  });

  test("leaves a transcribing job untouched (except a probe touch) while Recall is still transcribing", async () => {
    const row = jobRow({
      status: "transcribing",
      recall_recording_id: "rec-1",
      recall_transcript_id: "tr-1",
    });
    selectResults[JOBS] = [[row], []];
    retrieveTranscriptSpy.mockResolvedValue({ id: "tr-1", data: {} });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    for (const payload of updatePayloads()) {
      expect(payload).not.toHaveProperty("status");
    }
  });

  test("gives up on a transcribing job whose meeting started more than 24h ago and whose transcript never arrived", async () => {
    const row = jobRow({
      status: "transcribing",
      recall_recording_id: "rec-1",
      recall_transcript_id: "tr-1",
      join_at: new Date(Date.now() - 25 * HOUR),
    });
    selectResults[JOBS] = [[row], []];
    retrieveTranscriptSpy.mockResolvedValue({ id: "tr-1", data: {} });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("24"),
        }),
      ]),
    );
  });

  test("does not probe a quiet in-meeting bot before the probe-quiet threshold", async () => {
    selectResults[JOBS] = [
      [jobRow({ bot_status: "in_call_recording", updatedAt: new Date(Date.now() - 20 * MIN) })],
      [],
    ];

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    expect(retrieveBotSpy).not.toHaveBeenCalled();
    expect(updatePayloads()).toEqual([]);
  });

  test("probes a long-quiet queued bot and only touches it while the meeting is still running", async () => {
    selectResults[JOBS] = [
      [jobRow({ bot_status: "in_call_recording", updatedAt: new Date(Date.now() - 2 * HOUR) })],
      [],
    ];
    retrieveBotSpy.mockResolvedValue({
      id: "bot-1",
      status_changes: [{ code: "in_call_recording" }],
      recordings: [],
    });

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(0);
    expect(retrieveBotSpy).toHaveBeenCalledWith("bot-1");
    const payloads = updatePayloads();
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty("status");
    }
  });

  test("claim lost: a concurrent runPostProcessing call spends nothing and writes nothing", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: null,
    });
    firstResults[JOBS] = [row];
    // The atomic claim UPDATE affects 0 rows: another runner holds the run.
    updateResults[JOBS] = [0];

    const outputs = await recallService.runPostProcessing("job-1");

    expect(outputs).toEqual([]);
    expect(generateTextSpy).not.toHaveBeenCalled();
    // Nothing but the failed claim attempt may touch the row — in particular
    // no output write that would clobber the in-flight runner's results.
    const outputWrites = updatePayloads().filter(
      (p) =>
        typeof p.post_processing_outputs === "string" &&
        p.post_processing_outputs !== "[]",
    );
    expect(outputWrites).toEqual([]);
  });

  test("claim won: marks the run in-flight with a '[]' sentinel before spending, then writes the outputs", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: null,
    });
    // Initial read + the merge loop's re-read (claim sentinel in place).
    firstResults[JOBS] = [row, { ...row, post_processing_outputs: "[]" }];
    firstResults["prompt_library"] = [
      { id: "p1", name: "Summary", content: "Summarize this meeting." },
    ];
    firstResults["users"] = [{ id: 7, email: "u@example.com" }];

    const outputs = await recallService.runPostProcessing("job-1");

    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ status: "done", output: "summary text" });
    const payloads = updatePayloads();
    const sentinelIndex = payloads.findIndex(
      (p) => p.post_processing_outputs === "[]",
    );
    const resultIndex = payloads.findIndex(
      (p) =>
        typeof p.post_processing_outputs === "string" &&
        p.post_processing_outputs.includes("summary text"),
    );
    expect(sentinelIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(sentinelIndex);
  });

  test("bounds every prompt LLM call with an abort budget", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: null,
    });
    firstResults[JOBS] = [row];
    firstResults["prompt_library"] = [
      { id: "p1", name: "Summary", content: "Summarize this meeting." },
    ];
    firstResults["users"] = [{ id: 7, email: "u@example.com" }];

    await recallService.runPostProcessing("job-1");

    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    expect(generateTextSpy.mock.calls[0][0].abortSignal).toBeInstanceOf(
      AbortSignal,
    );
  });

  test("manual run refuses while the batch claim is fresh — no double-spend against a live auto-run", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: "[]",
      updatedAt: new Date(Date.now() - 5 * MIN),
    });
    firstResults[JOBS] = [row];

    await expect(
      recallService.runOnePostProcessing("job-1", "p1", "a1"),
    ).rejects.toThrow(/in progress|IN_FLIGHT/i);
    expect(generateTextSpy).not.toHaveBeenCalled();
  });

  test("manual run takes over a STALE batch claim (the run died)", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: "[]",
      updatedAt: new Date(Date.now() - 45 * MIN),
    });
    firstResults[JOBS] = [row, { ...row }];
    firstResults["prompt_library"] = [
      { id: "p1", name: "Summary", content: "Summarize this meeting." },
    ];
    firstResults["users"] = [{ id: 7, email: "u@example.com" }];

    const result = await recallService.runOnePostProcessing("job-1", "p1", "a1");

    expect(result.status).toBe("done");
    expect(generateTextSpy).toHaveBeenCalledTimes(1);
  });

  test("manual run merges instead of clobbering: a concurrent writer's outputs survive", async () => {
    const p2Output = {
      prompt_id: "p2",
      agent_id: "a2",
      prompt_name: "Actions",
      status: "done",
      output: "action items",
      error: null,
      ran_at: "2026-07-21T00:00:00.000Z",
    };
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
        { prompt_id: "p2", agent_id: "a2" },
      ]),
      post_processing_outputs: null,
    });
    // Reads: the initial row, merge attempt 1 (still null), merge attempt 2
    // (a concurrent writer landed p2's output in between).
    firstResults[JOBS] = [
      row,
      { ...row },
      { ...row, post_processing_outputs: JSON.stringify([p2Output]) },
    ];
    firstResults["prompt_library"] = [
      { id: "p1", name: "Summary", content: "Summarize this meeting." },
    ];
    firstResults["users"] = [{ id: 7, email: "u@example.com" }];
    // Merge attempt 1's conditional write loses the race; attempt 2 wins.
    updateResults[JOBS] = [0, 1];

    await recallService.runOnePostProcessing("job-1", "p1", "a1");

    const raws = (calls[`${JOBS}.whereRaw`] ?? []).map((args) => args[0]);
    expect(raws.some((sql) => sql.includes("post_processing_outputs"))).toBe(
      true,
    );
    const finalWrite = updatePayloads()
      .filter((p) => typeof p.post_processing_outputs === "string")
      .pop();
    expect(finalWrite!.post_processing_outputs).toContain("action items");
    expect(finalWrite!.post_processing_outputs).toContain("summary text");
  });

  test("batch run heartbeats the claim after each prompt so a live batch is never stale-stolen", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
        { prompt_id: "p2", agent_id: "a2" },
      ]),
      post_processing_outputs: null,
    });
    firstResults[JOBS] = [row, { ...row, post_processing_outputs: "[]" }];
    firstResults["prompt_library"] = [
      { id: "p1", name: "Summary", content: "Summarize this meeting." },
      { id: "p2", name: "Actions", content: "List action items." },
    ];
    firstResults["users"] = [
      { id: 7, email: "u@example.com" },
      { id: 7, email: "u@example.com" },
    ];

    await recallService.runPostProcessing("job-1");

    expect(generateTextSpy).toHaveBeenCalledTimes(2);
    const bareTouches = updatePayloads().filter(
      (p) => Object.keys(p).length === 1 && "updatedAt" in p,
    );
    expect(bareTouches.length).toBeGreaterThanOrEqual(1);
  });

  test("already ran: existing outputs are returned untouched (no claim, no spend)", async () => {
    const existing = [
      {
        prompt_id: "p1",
        agent_id: "a1",
        prompt_name: "Summary",
        status: "done",
        output: "earlier result",
        error: null,
        ran_at: "2026-07-20T00:00:00.000Z",
      },
    ];
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: JSON.stringify(existing),
    });
    firstResults[JOBS] = [row];

    const outputs = await recallService.runPostProcessing("job-1");

    expect(outputs).toEqual(existing);
    expect(generateTextSpy).not.toHaveBeenCalled();
    expect(updatePayloads()).toEqual([]);
  });

  test("re-runs post-processing for an awaiting_review job whose prompts never produced outputs", async () => {
    const row = jobRow({
      status: "awaiting_review",
      raw_segments: JSON.stringify([
        { start: 0, end: 2, text: "Hello world", speaker: "Alice" },
      ]),
      post_processing_prompts: JSON.stringify([
        { prompt_id: "p1", agent_id: "a1" },
      ]),
      post_processing_outputs: null,
      updatedAt: new Date(Date.now() - 45 * MIN),
    });
    selectResults[JOBS] = [[], [row]];
    firstResults[JOBS] = [{ ...row }, { ...row, post_processing_outputs: "[]" }];
    firstResults["prompt_library"] = [
      { id: "p1", name: "Summary", content: "Summarize this meeting." },
    ];
    firstResults["users"] = [{ id: 7, email: "u@example.com" }];

    const acted = await recallService.reconcileOnce();

    expect(acted).toBe(1);
    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    expect(updatePayloads()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          post_processing_outputs: expect.stringContaining("summary text"),
        }),
      ]),
    );
  });
});
