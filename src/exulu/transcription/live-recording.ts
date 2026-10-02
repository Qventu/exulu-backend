/**
 * liveRecordingService — the browser-microphone ("Record on this device")
 * pipeline for transcription_jobs rows with source='live'.
 *
 * - start:       insert the row in status 'recording' (chunk_count 0).
 * - appendChunk: one compare-and-swap UPDATE that appends a RawSegment to
 *                raw_segments (jsonb ||) iff status='recording' AND
 *                chunk_count = seq. Retries/duplicates are idempotent; the
 *                sequence can never have holes.
 * - stop:        'recording' → 'awaiting_review' (+ audio key, duration), then
 *                fire-and-forget post-processing exactly like Recall does.
 *
 * Everything after 'awaiting_review' (review sheet, finalize, saved item) is
 * the shared transcription pipeline and untouched.
 *
 * Design doc: docs/superpowers/specs/2026-09-23-live-recording-transcription-design.md
 */
import { postgresClient } from "@SRC/postgres/client";
import { isLiteLLMEnabled } from "@SRC/exulu/litellm/supervisor";
import { recallService } from "@SRC/exulu/recall/service";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { RawSegment } from "./transcript-text";

const TABLE = "transcription_jobs";
const log = (msg: string) => console.log(`[EXULU-LIVE-RECORDING] ${msg}`);

export const LIVE_RECORDING_DISABLED_MESSAGE =
  "Speech-to-text is not enabled on this deployment. " +
  "Set EXULU_USE_LITELLM=true and TRANSCRIPTION_MODEL in the environment.";

/** Same gate as the composer mic (/transcribe): LiteLLM on + a transcription model. */
export function liveRecordingEnabled(): boolean {
  return isLiteLLMEnabled() && Boolean(process.env.TRANSCRIPTION_MODEL);
}

export type LiveRecordingStartInput = {
  userId: number;
  title?: string | null;
  language?: string | null;
  project_id?: string | null;
  target_rights_mode?: ExuluRightsMode | null;
  target_rbac_users?: { id: number; rights: "read" | "write" }[] | null;
  target_rbac_roles?: { id: string; rights: "read" | "write" }[] | null;
  post_processing_prompts?: { prompt_id: string; agent_id: string }[] | null;
};

export type AppendChunkInput = {
  id: string;
  /** 0-based chunk index; must equal the row's chunk_count to be accepted. */
  seq: number;
  text: string;
  offsetMs: number;
  durationMs: number;
};

export type AppendChunkResult =
  | { kind: "appended"; chunkCount: number }
  | { kind: "duplicate"; text: string; chunkCount: number }
  | { kind: "out_of_order"; chunkCount: number }
  | { kind: "not_recording"; status: string };

export type LiveRecordingStopInput = {
  audio_s3key?: string | null;
  /** Client-side authoritative total; null/0 keeps the server-side value. */
  duration_seconds?: number | null;
};

/** The db row with JSON columns parsed (jsonb comes back as objects, but tolerate strings). */
export type LiveJobRow = {
  id: string;
  status: string;
  source: string;
  chunk_count: number;
  raw_segments: RawSegment[] | null;
  [key: string]: unknown;
};

const parseJson = <T>(v: unknown): T | null => {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
};

const rowFromDb = (dbRow: any): LiveJobRow => ({
  ...dbRow,
  chunk_count: Number(dbRow.chunk_count ?? 0),
  raw_segments: parseJson<RawSegment[]>(dbRow.raw_segments),
});

export const liveRecordingService = {
  async start(input: LiveRecordingStartInput): Promise<LiveJobRow> {
    const { db } = await postgresClient();
    const now = new Date();
    const [inserted] = await db(TABLE)
      .insert({
        source: "live",
        status: "recording",
        chunk_count: 0,
        raw_segments: "[]",
        title: input.title?.trim() ? input.title.trim() : null,
        language: input.language && input.language !== "auto" ? input.language : null,
        project_id: input.project_id ?? null,
        target_rights_mode: input.target_rights_mode ?? "private",
        target_rbac_users: input.target_rbac_users ? JSON.stringify(input.target_rbac_users) : null,
        target_rbac_roles: input.target_rbac_roles ? JSON.stringify(input.target_rbac_roles) : null,
        // NULL when empty — mirrors recallService.createMeetingBot so
        // runPostProcessing's "no prompts" short-circuit works unchanged.
        post_processing_prompts: input.post_processing_prompts?.length
          ? JSON.stringify(input.post_processing_prompts)
          : null,
        rights_mode: "private",
        created_by: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning("*");
    log(`started live recording ${inserted.id} for user ${input.userId}`);
    return rowFromDb(inserted);
  },

  async appendChunk(input: AppendChunkInput): Promise<AppendChunkResult> {
    const { db } = await postgresClient();
    const segment: RawSegment = {
      start: input.offsetMs / 1000,
      end: (input.offsetMs + input.durationMs) / 1000,
      text: input.text,
      speaker: "unknown",
    };
    const affected: number = await db(TABLE)
      .where({ id: input.id, status: "recording", chunk_count: input.seq })
      .update({
        raw_segments: db.raw("COALESCE(raw_segments, '[]'::jsonb) || ?::jsonb", [
          JSON.stringify([segment]),
        ]),
        chunk_count: input.seq + 1,
        duration_seconds: db.raw("GREATEST(COALESCE(duration_seconds, 0), ?)", [segment.end]),
        last_chunk_at: new Date(),
        updatedAt: new Date(),
      });
    if (affected === 1) return { kind: "appended", chunkCount: input.seq + 1 };

    // CAS refused: find out why without ever appending.
    const row = await db(TABLE)
      .select(["status", "chunk_count", "raw_segments"])
      .where({ id: input.id })
      .first();
    if (!row) throw new Error(`transcription_job ${input.id} not found`);
    if (row.status !== "recording") return { kind: "not_recording", status: row.status };
    const chunkCount = Number(row.chunk_count ?? 0);
    if (chunkCount > input.seq) {
      const segments = parseJson<RawSegment[]>(row.raw_segments) ?? [];
      return { kind: "duplicate", text: segments[input.seq]?.text ?? "", chunkCount };
    }
    return { kind: "out_of_order", chunkCount };
  },

  async stop(id: string, input: LiveRecordingStopInput): Promise<LiveJobRow> {
    const { db } = await postgresClient();
    const patch: Record<string, unknown> = { status: "awaiting_review", updatedAt: new Date() };
    if (input.audio_s3key) patch.audio_s3key = input.audio_s3key;
    if (typeof input.duration_seconds === "number" && input.duration_seconds > 0) {
      patch.duration_seconds = input.duration_seconds;
    }
    const [updated] = await db(TABLE).where({ id, status: "recording" }).update(patch).returning("*");
    if (!updated) {
      const row = await db(TABLE).where({ id }).first();
      if (!row) throw new Error(`transcription_job ${id} not found`);
      throw new Error(
        `transcription_job ${id} is in status '${row.status}'; can only stop from 'recording'`,
      );
    }
    log(`live recording ${id} stopped → awaiting_review`);
    // Same fire-and-forget shape as recallService._onTranscriptDone: a crashed
    // run leaves never-ran prompts, which the review sheet shows as Run cards.
    void recallService.runPostProcessing(id).catch((err: unknown) => {
      log(`post-processing for job ${id} failed: ${(err as Error).message}`);
    });
    return rowFromDb(updated);
  },
};
