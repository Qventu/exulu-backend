/**
 * POST /transcription-jobs/:id/chunks — one audio chunk of a live recording.
 *
 * Mirrors /transcribe's handler order (gate → auth → validation → LiteLLM
 * readiness → transcribe → error mapping) and adds ownership + the
 * compare-and-swap append. Built from injected deps so the HTTP contract is
 * unit-testable (chunk-route.test.ts); routes.ts wires the real ones.
 *
 * Design doc: docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md §3.4
 */
import type { Express, Request, RequestHandler, Response } from "express";

import { TranscriptionError } from "../transcribe";
import { TranscriptionJobAccessError, type TranscriptionJobUser } from "./authorize";
import { LIVE_RECORDING_DISABLED_MESSAGE, type AppendChunkInput, type AppendChunkResult } from "./live-recording";
import type { RawSegment } from "./transcript-text";

export const CHUNK_ROUTE_PATH = "/transcription-jobs/:id/chunks";

/**
 * Whether the previous chunk's tail is sent to the model as a continuity
 * hint. Flip to false if the Task 0 verify-first spike showed Gemini
 * repeating or truncating around the hint.
 */
export const LIVE_PRIOR_TEXT_ENABLED = true;

const PRIOR_TEXT_MAX_CHARS = 300;
const LITELLM_READY_TIMEOUT_MS = 5_000;

type AuthUser = TranscriptionJobUser & {
  email?: string | null;
  firstname?: string | null;
  type?: string | null;
};

export type ChunkRouteDeps = {
  /** multer().single("file") wrapper — shared with /transcribe (maps LIMIT_FILE_SIZE → 413). */
  upload: RequestHandler;
  enabled: () => boolean;
  authenticate: (req: Request) => Promise<{ user?: AuthUser | null; code?: number; message?: string }>;
  getDb: () => Promise<any>;
  assertOwns: (db: any, user: AuthUser, id: string) => Promise<void>;
  waitForLiteLLMReady: () => Promise<unknown>;
  /**
   * Timeout (ms) for waitForLiteLLMReady before responding 503. Defaults to
   * LITELLM_READY_TIMEOUT_MS (5s) in production; tests override it to keep
   * the "not ready" case fast without touching global/fake timers (a live
   * supertest request shares Node's http internals with jest fake timers,
   * which can hang the socket).
   */
  readyTimeoutMs?: number;
  buildTags: (input: { user_id?: number | string; user_name?: string; project_id?: string }) => string[];
  transcribe: (args: {
    file: { buffer: Buffer; originalname: string; mimetype: string };
    priorText?: string;
    tags?: string[];
  }) => Promise<{ text: string }>;
  service: { appendChunk: (input: AppendChunkInput) => Promise<AppendChunkResult> };
};

const parseSegments = (raw: unknown): RawSegment[] => {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as RawSegment[];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? (raw as RawSegment[]) : [];
};

/** Tail of the most recent non-empty segment, clipped for the prompt. */
export function priorTextFrom(raw: unknown): string | undefined {
  const segments = parseSegments(raw);
  for (let i = segments.length - 1; i >= 0; i--) {
    const text = (segments[i]?.text ?? "").trim();
    if (text) return text.length > PRIOR_TEXT_MAX_CHARS ? text.slice(-PRIOR_TEXT_MAX_CHARS) : text;
  }
  return undefined;
}

const intField = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return Number(value);
};

export function registerLiveRecordingChunkRoute(app: Express, deps: ChunkRouteDeps): void {
  app.post(CHUNK_ROUTE_PATH, deps.upload, async (req: Request, res: Response) => {
    if (!deps.enabled()) {
      res.status(503).json({ detail: LIVE_RECORDING_DISABLED_MESSAGE });
      return;
    }

    const auth = await deps.authenticate(req);
    if (!auth.user?.id) {
      res.status(auth.code || 401).json({ detail: auth.message ?? "Authentication required" });
      return;
    }
    const user = auth.user;
    // noUncheckedIndexedAccess widens ParamsDictionary access to
    // `string | undefined`; the route pattern guarantees :id is present at
    // runtime. Matches the `req.params.id ?? ""` convention used elsewhere
    // in routes.ts.
    const jobId = req.params.id ?? "";

    const db = await deps.getDb();
    try {
      await deps.assertOwns(db, user, jobId);
    } catch (err) {
      if (err instanceof TranscriptionJobAccessError) {
        res.status(err.code).json({ detail: err.message });
        return;
      }
      throw err;
    }

    const row = await db
      .from("transcription_jobs")
      .select(["status", "raw_segments", "project_id"])
      .where({ id: jobId })
      .first();
    if (!row) {
      res.status(404).json({ detail: `transcription_job ${jobId} not found` });
      return;
    }
    if (row.status !== "recording") {
      res.status(409).json({ detail: `Recording is not active (status '${row.status}').`, kind: "not_recording" });
      return;
    }

    const seq = intField(req.body?.seq);
    const offsetMs = intField(req.body?.offset_ms);
    const durationMs = intField(req.body?.duration_ms);
    if (seq == null || offsetMs == null || durationMs == null || durationMs <= 0) {
      res.status(400).json({ detail: "seq, offset_ms (≥ 0) and duration_ms (> 0) are required integers." });
      return;
    }
    const skipped = req.body?.skipped === "true";

    let text = "";
    if (!skipped) {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({ detail: "No audio file provided in 'file' field." });
        return;
      }
      if (!file.mimetype.startsWith("audio/")) {
        res.status(400).json({ detail: `Unsupported mimetype: ${file.mimetype}. Expected audio/*.` });
        return;
      }

      // The timer is cleared in `finally` regardless of which side of the
      // race settles first — an uncleared setTimeout here is a real open
      // Node timer handle that keeps a test's event loop (and jest) alive
      // for the full readyTimeoutMs even after the request has responded.
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          deps.waitForLiteLLMReady(),
          new Promise((_, reject) => {
            readyTimer = setTimeout(() => reject(new Error("LiteLLM not ready")), deps.readyTimeoutMs ?? LITELLM_READY_TIMEOUT_MS);
          }),
        ]);
      } catch {
        res.status(503).json({ detail: "Transcription service is not ready. Try again shortly." });
        return;
      } finally {
        clearTimeout(readyTimer);
      }

      const tags = deps.buildTags({
        user_id: user.id,
        user_name: user.type === "api" ? (user.firstname ?? user.email ?? undefined) : (user.email ?? undefined),
        project_id: row.project_id ?? undefined,
      });

      try {
        ({ text } = await deps.transcribe({
          file,
          priorText: LIVE_PRIOR_TEXT_ENABLED ? priorTextFrom(row.raw_segments) : undefined,
          tags,
        }));
      } catch (err) {
        if (err instanceof TranscriptionError) {
          const code = err.upstreamStatus >= 500 ? 502 : err.upstreamStatus;
          res.status(code).json({ detail: err.message });
          return;
        }
        console.error(`[EXULU] ${CHUNK_ROUTE_PATH} transcription failed`, err);
        res.status(500).json({ detail: err instanceof Error ? err.message : "Transcription failed." });
        return;
      }
    }

    const result = await deps.service.appendChunk({ id: jobId, seq, text, offsetMs, durationMs });
    switch (result.kind) {
      case "appended":
        res.status(200).json({ seq, text, chunk_count: result.chunkCount });
        return;
      case "duplicate":
        res.status(200).json({ seq, text: result.text, chunk_count: result.chunkCount, duplicate: true });
        return;
      case "out_of_order":
        res.status(409).json({
          detail: `Chunk ${seq} is ahead of the next expected chunk ${result.chunkCount}.`,
          kind: "out_of_order",
          chunk_count: result.chunkCount,
        });
        return;
      case "not_recording":
        res.status(409).json({ detail: `Recording is not active (status '${result.status}').`, kind: "not_recording" });
        return;
    }
  });
}
