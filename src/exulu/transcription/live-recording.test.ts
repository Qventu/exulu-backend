/**
 * liveRecordingService — row insert shape, the compare-and-swap chunk append,
 * and the stop transition. Same module-mock + chainable db-fake pattern as
 * src/exulu/recall/service.test.ts, plus `db.raw` (the append uses jsonb ||).
 */
const runPostProcessingSpy = jest.fn(async () => []);
jest.mock("@SRC/exulu/recall/service", () => ({
  recallService: { runPostProcessing: (...args: any[]) => runPostProcessingSpy(...args) },
}));

const isLiteLLMEnabledSpy = jest.fn(() => true);
jest.mock("@SRC/exulu/litellm/supervisor", () => ({
  isLiteLLMEnabled: () => isLiteLLMEnabledSpy(),
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
  for (const m of ["where", "select", "whereIn", "whereNotIn", "orderBy"]) {
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
db.raw = (sql: string, bindings?: unknown[]) => ({ __raw: sql, bindings });
jest.mock("@SRC/postgres/client", () => ({
  postgresClient: jest.fn(async () => ({ db })),
}));

import {
  liveRecordingEnabled,
  liveRecordingService,
  LIVE_RECORDING_DISABLED_MESSAGE,
} from "./live-recording";

const JOBS = "transcription_jobs";

beforeEach(() => {
  for (const store of [calls, firstResults, updateResults]) {
    for (const key of Object.keys(store)) delete store[key];
  }
  jest.clearAllMocks();
  isLiteLLMEnabledSpy.mockReturnValue(true);
  process.env.TRANSCRIPTION_MODEL = "gemini-transcribe";
});

describe("liveRecordingEnabled", () => {
  it("requires LiteLLM and TRANSCRIPTION_MODEL", () => {
    expect(liveRecordingEnabled()).toBe(true);
    delete process.env.TRANSCRIPTION_MODEL;
    expect(liveRecordingEnabled()).toBe(false);
    process.env.TRANSCRIPTION_MODEL = "x";
    isLiteLLMEnabledSpy.mockReturnValue(false);
    expect(liveRecordingEnabled()).toBe(false);
    expect(LIVE_RECORDING_DISABLED_MESSAGE).toMatch(/TRANSCRIPTION_MODEL/);
  });
});

describe("start", () => {
  it("inserts a live/recording row with chunk_count 0 and an empty segments array", async () => {
    const row = await liveRecordingService.start({
      userId: 7,
      title: "Standup",
      language: null,
      project_id: "p1",
      target_rights_mode: "users",
      target_rbac_users: [{ id: 3, rights: "read" }],
      target_rbac_roles: null,
      post_processing_prompts: [{ prompt_id: "pr1", agent_id: "ag1" }],
    });

    const [values] = calls[`${JOBS}.insert`][0];
    expect(values).toMatchObject({
      source: "live",
      status: "recording",
      chunk_count: 0,
      raw_segments: "[]",
      title: "Standup",
      project_id: "p1",
      target_rights_mode: "users",
      target_rbac_users: JSON.stringify([{ id: 3, rights: "read" }]),
      target_rbac_roles: null,
      post_processing_prompts: JSON.stringify([{ prompt_id: "pr1", agent_id: "ag1" }]),
      rights_mode: "private",
      created_by: 7,
    });
    expect(row.id).toBe("jr-1");
    expect(row.status).toBe("recording");
  });

  it("normalises an empty prompt list to NULL and defaults rights to private", async () => {
    await liveRecordingService.start({ userId: 1, post_processing_prompts: [] });
    const [values] = calls[`${JOBS}.insert`][0];
    expect(values.post_processing_prompts).toBeNull();
    expect(values.target_rights_mode).toBe("private");
    expect(values.title).toBeNull();
  });
});

describe("appendChunk", () => {
  const input = { id: "jr-1", seq: 2, text: "hello there", offsetMs: 40_000, durationMs: 30_000 };

  it("appends with a compare-and-swap on chunk_count and returns the new count", async () => {
    updateResults[JOBS] = [1];

    const result = await liveRecordingService.appendChunk(input);

    expect(result).toEqual({ kind: "appended", chunkCount: 3 });
    expect(calls[`${JOBS}.where`][0][0]).toEqual({ id: "jr-1", status: "recording", chunk_count: 2 });
    const [values] = calls[`${JOBS}.update`][0];
    expect(values.chunk_count).toBe(3);
    expect(values.last_chunk_at).toBeInstanceOf(Date);
    // jsonb append of exactly one segment, seconds from the recording origin.
    expect(values.raw_segments.__raw).toMatch(/COALESCE\(raw_segments, '\[\]'::jsonb\) \|\| \?::jsonb/);
    expect(JSON.parse(values.raw_segments.bindings[0])).toEqual([
      { start: 40, end: 70, text: "hello there", speaker: "unknown" },
    ]);
    expect(values.duration_seconds.__raw).toMatch(/GREATEST/);
    expect(values.duration_seconds.bindings).toEqual([70]);
    // No re-read needed on the happy path.
    expect(calls[`${JOBS}.select`]).toBeUndefined();
  });

  it("stores a silent chunk with empty text so raw_segments[seq] always exists", async () => {
    updateResults[JOBS] = [1];
    await liveRecordingService.appendChunk({ ...input, text: "" });
    const [values] = calls[`${JOBS}.update`][0];
    expect(JSON.parse(values.raw_segments.bindings[0])[0].text).toBe("");
  });

  it("returns the stored text for a duplicate seq instead of appending twice", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [
      {
        status: "recording",
        chunk_count: 3,
        raw_segments: [
          { start: 0, end: 20, text: "one", speaker: "unknown" },
          { start: 20, end: 40, text: "two", speaker: "unknown" },
          { start: 40, end: 70, text: "three", speaker: "unknown" },
        ],
      },
    ];

    const result = await liveRecordingService.appendChunk({ ...input, seq: 1 });

    expect(result).toEqual({ kind: "duplicate", text: "two", chunkCount: 3 });
  });

  it("tolerates raw_segments arriving as a JSON string on the duplicate path", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [
      { status: "recording", chunk_count: 1, raw_segments: JSON.stringify([{ start: 0, end: 20, text: "one", speaker: "unknown" }]) },
    ];
    const result = await liveRecordingService.appendChunk({ ...input, seq: 0 });
    expect(result).toEqual({ kind: "duplicate", text: "one", chunkCount: 1 });
  });

  it("reports out_of_order when seq is ahead of chunk_count", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [{ status: "recording", chunk_count: 1, raw_segments: [] }];
    const result = await liveRecordingService.appendChunk({ ...input, seq: 3 });
    expect(result).toEqual({ kind: "out_of_order", chunkCount: 1 });
  });

  it("refuses to append once the row has left 'recording'", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [{ status: "awaiting_review", chunk_count: 5, raw_segments: [] }];
    const result = await liveRecordingService.appendChunk(input);
    expect(result).toEqual({ kind: "not_recording", status: "awaiting_review" });
  });

  it("throws when the row is gone", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [undefined];
    await expect(liveRecordingService.appendChunk(input)).rejects.toThrow(/not found/);
  });
});

describe("stop", () => {
  it("moves a recording row to awaiting_review, stores the audio key + client duration, and kicks off post-processing", async () => {
    updateResults[JOBS] = [1];

    const row = await liveRecordingService.stop("jr-1", { audio_s3key: "bucket/user_7/x.webm", duration_seconds: 3601.5 });

    expect(calls[`${JOBS}.where`][0][0]).toEqual({ id: "jr-1", status: "recording" });
    const [values] = calls[`${JOBS}.update`][0];
    expect(values).toMatchObject({ status: "awaiting_review", audio_s3key: "bucket/user_7/x.webm", duration_seconds: 3601.5 });
    expect(row.status).toBe("awaiting_review");
    await Promise.resolve(); // let the fire-and-forget call schedule
    expect(runPostProcessingSpy).toHaveBeenCalledWith("jr-1");
  });

  it("keeps the server-side duration and audio when the client sends nulls (Finish on an abandoned row)", async () => {
    updateResults[JOBS] = [1];
    await liveRecordingService.stop("jr-1", { audio_s3key: null, duration_seconds: null });
    const [values] = calls[`${JOBS}.update`][0];
    expect(values).not.toHaveProperty("audio_s3key");
    expect(values).not.toHaveProperty("duration_seconds");
    expect(values.status).toBe("awaiting_review");
  });

  it("refuses to stop a row that is not recording and does not run post-processing", async () => {
    updateResults[JOBS] = [0];
    firstResults[JOBS] = [{ id: "jr-1", status: "saved" }];
    await expect(liveRecordingService.stop("jr-1", {})).rejects.toThrow(/status 'saved'/);
    expect(runPostProcessingSpy).not.toHaveBeenCalled();
  });

  it("does not fail the stop when post-processing rejects", async () => {
    updateResults[JOBS] = [1];
    runPostProcessingSpy.mockRejectedValueOnce(new Error("llm down"));
    await expect(liveRecordingService.stop("jr-1", {})).resolves.toMatchObject({ status: "awaiting_review" });
  });
});
