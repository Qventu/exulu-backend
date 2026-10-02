/**
 * POST /transcription-jobs/:id/chunks — the handler is built from injected
 * deps so the whole HTTP contract (status codes, JSON shapes, skip marker,
 * prior-text hint, tags) is testable with supertest and no LiteLLM/Postgres.
 */
import express from "express";
import multer from "multer";
import request from "supertest";

import { TranscriptionError } from "../transcribe";
import { TranscriptionJobAccessError } from "./authorize";
import { CHUNK_ROUTE_PATH, priorTextFrom, registerLiveRecordingChunkRoute, type ChunkRouteDeps } from "./chunk-route";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }).single("file");

type Row = { status: string; raw_segments: unknown; project_id: string | null } | undefined;

// `row` is a rest tuple rather than a plain default parameter so that
// `build({}, undefined)` (the "row is gone" test) actually produces
// `row === undefined` — a plain `row: Row = {...}` default applies whenever
// the caller passes `undefined` explicitly, not just when the argument is
// omitted, which would make that test unable to exercise the 404 path.
function build(overrides: Partial<ChunkRouteDeps> = {}, ...rowArg: [Row] | []) {
  const row: Row = rowArg.length > 0 ? rowArg[0] : { status: "recording", raw_segments: [], project_id: "p1" };
  const deps: ChunkRouteDeps = {
    upload,
    enabled: () => true,
    authenticate: async () => ({ user: { id: 7, email: "d@x.io" } }),
    getDb: async () => ({
      from: () => ({ select: () => ({ where: () => ({ first: async () => row }) }) }),
    }),
    assertOwns: async () => undefined,
    waitForLiteLLMReady: async () => undefined,
    buildTags: (input) => Object.entries(input).filter(([, v]) => v != null).map(([k, v]) => `${k}_${v}`),
    transcribe: jest.fn(async () => ({ text: "hello" })),
    service: { appendChunk: jest.fn(async () => ({ kind: "appended" as const, chunkCount: 2 })) },
    ...overrides,
  };
  const app = express();
  registerLiveRecordingChunkRoute(app, deps);
  return { app, deps };
}

const post = (app: express.Express, fields: Record<string, string> = {}, withFile = true) => {
  let req = request(app).post("/transcription-jobs/job-1/chunks");
  for (const [k, v] of Object.entries({ seq: "1", offset_ms: "20000", duration_ms: "30000", ...fields })) {
    req = req.field(k, v);
  }
  if (withFile) req = req.attach("file", Buffer.from("fake-audio"), { filename: "chunk.webm", contentType: "audio/webm" });
  return req;
};

describe("priorTextFrom", () => {
  it("returns the last non-empty segment text, clipped to 300 chars", () => {
    expect(priorTextFrom(null)).toBeUndefined();
    expect(priorTextFrom([{ start: 0, end: 1, text: "", speaker: "unknown" }])).toBeUndefined();
    expect(
      priorTextFrom([
        { start: 0, end: 1, text: "first", speaker: "unknown" },
        { start: 1, end: 2, text: "x".repeat(400), speaker: "unknown" },
        { start: 2, end: 3, text: "   ", speaker: "unknown" },
      ]),
    ).toBe("x".repeat(300));
    expect(priorTextFrom(JSON.stringify([{ start: 0, end: 1, text: "from json", speaker: "unknown" }]))).toBe("from json");
  });
});

describe(CHUNK_ROUTE_PATH, () => {
  it("503s when the feature is disabled, before auth", async () => {
    const authenticate = jest.fn();
    const { app } = build({ enabled: () => false, authenticate });
    const res = await post(app);
    expect(res.status).toBe(503);
    expect(res.body.detail).toMatch(/TRANSCRIPTION_MODEL/);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("401s without a user", async () => {
    const { app } = build({ authenticate: async () => ({ code: 401, message: "nope" }) });
    const res = await post(app);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ detail: "nope" });
  });

  it("maps ownership errors to their code", async () => {
    const { app } = build({
      assertOwns: async () => {
        throw new TranscriptionJobAccessError(403, "Not authorized to act on this transcription job");
      },
    });
    const res = await post(app);
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/Not authorized/);
  });

  it("409s (not_recording) when the row already left 'recording' — and never transcribes", async () => {
    const { app, deps } = build({}, { status: "awaiting_review", raw_segments: [], project_id: null });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ detail: expect.stringMatching(/awaiting_review/), kind: "not_recording" });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.service.appendChunk).not.toHaveBeenCalled();
  });

  it("404s when the row is gone", async () => {
    const { app } = build({}, undefined);
    expect((await post(app)).status).toBe(404);
  });

  it("400s on a missing/invalid seq, offset_ms or duration_ms", async () => {
    const { app } = build();
    expect((await post(app, { seq: "abc" })).status).toBe(400);
    expect((await post(app, { offset_ms: "-1" })).status).toBe(400);
    expect((await post(app, { duration_ms: "0" })).status).toBe(400);
  });

  it("400s without a file or with a non-audio mimetype", async () => {
    const { app } = build();
    expect((await post(app, {}, false)).status).toBe(400);
    const res = await request(app)
      .post("/transcription-jobs/job-1/chunks")
      .field("seq", "1").field("offset_ms", "0").field("duration_ms", "1000")
      .attach("file", Buffer.from("x"), { filename: "c.bin", contentType: "video/webm" });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/video\/webm/);
  });

  it("503s when LiteLLM is not ready", async () => {
    const { app } = build({ waitForLiteLLMReady: () => new Promise(() => undefined), readyTimeoutMs: 50 }); // never resolves
    const res = await post(app);
    expect(res.status).toBe(503);
  });

  it("transcribes with the prior-text tail and user/project tags, then appends", async () => {
    const { app, deps } = build(
      {},
      {
        status: "recording",
        raw_segments: [
          { start: 0, end: 20, text: "we talked about", speaker: "unknown" },
          { start: 20, end: 40, text: "", speaker: "unknown" },
        ],
        project_id: "p1",
      },
    );
    const res = await post(app, { seq: "2", offset_ms: "40000", duration_ms: "30000" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 2, text: "hello", chunk_count: 2 });
    const args = (deps.transcribe as jest.Mock).mock.calls[0][0];
    expect(args.file.mimetype).toBe("audio/webm");
    expect(args.priorText).toBe("we talked about");
    expect(args.tags).toEqual(expect.arrayContaining(["user_id_7", "user_name_d@x.io", "project_id_p1"]));
    expect(deps.service.appendChunk).toHaveBeenCalledWith({
      id: "job-1", seq: 2, text: "hello", offsetMs: 40000, durationMs: 30000,
    });
  });

  it("stores a silent chunk (empty transcript) under its seq", async () => {
    const { app, deps } = build({ transcribe: jest.fn(async () => ({ text: "" })) });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("");
    expect(deps.service.appendChunk).toHaveBeenCalledWith(expect.objectContaining({ text: "" }));
  });

  it("skipped=true appends an empty placeholder without a file and without transcribing", async () => {
    const { app, deps } = build();
    const res = await post(app, { skipped: "true" }, false);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 1, text: "", chunk_count: 2 });
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.service.appendChunk).toHaveBeenCalledWith(expect.objectContaining({ seq: 1, text: "" }));
  });

  it("returns the stored text for a duplicate seq", async () => {
    const { app } = build({
      service: { appendChunk: jest.fn(async () => ({ kind: "duplicate" as const, text: "earlier", chunkCount: 5 })) },
    });
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ seq: 1, text: "earlier", chunk_count: 5, duplicate: true });
  });

  it("409s (out_of_order) when the seq is ahead", async () => {
    const { app } = build({
      service: { appendChunk: jest.fn(async () => ({ kind: "out_of_order" as const, chunkCount: 0 })) },
    });
    const res = await post(app, { seq: "4" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ detail: expect.any(String), kind: "out_of_order", chunk_count: 0 });
  });

  it("409s (not_recording) when the append itself reports the row left 'recording'", async () => {
    const { app } = build({
      service: { appendChunk: jest.fn(async () => ({ kind: "not_recording" as const, status: "cancelled" })) },
    });
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(res.body.kind).toBe("not_recording");
  });

  it("surfaces upstream 4xx as-is and 5xx as 502 without appending", async () => {
    const { app: app429, deps } = build({
      transcribe: jest.fn(async () => { throw new TranscriptionError(429, "rate limited"); }),
    });
    const res = await post(app429);
    expect(res.status).toBe(429);
    expect(res.body.detail).toMatch(/rate limited/);
    expect(deps.service.appendChunk).not.toHaveBeenCalled();

    const { app: app500 } = build({
      transcribe: jest.fn(async () => { throw new TranscriptionError(500, "boom"); }),
    });
    expect((await post(app500)).status).toBe(502);
  });
});
