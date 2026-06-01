/**
 * TranscriptionService — orchestrates the lifecycle of a transcription job.
 *
 * - startJob:    upload-time entry point. Inserts a transcription_jobs row,
 *                presigns an S3 download URL for the audio, submits to the
 *                whisper server, marks the row as transcribing.
 * - pollOnce:    interval-driven progress reconciliation. Maps whisper
 *                statuses onto our broader row-lifecycle (transcribing →
 *                awaiting_review / failed / cancelled).
 * - cancelJob:   user-initiated cancellation. Talks to the whisper server,
 *                then updates the row.
 * - finalize:    user clicks Save in the review panel. Renders the speaker-
 *                labeled transcript, creates an ExuluContext item, attaches
 *                RBAC + project, marks the row saved.
 *
 * Design doc: docs/superpowers/specs/2026-05-28-transcription-feature-design.md
 */

import { exuluApp } from "@SRC/exulu/app/singleton";
import { postgresClient } from "@SRC/postgres/client";
import { getPresignedUrl } from "@SRC/uppy";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import type { Item } from "@EXULU_TYPES/models/item";
import { handleRBACUpdate } from "@EE/rbac-update.ts";
import {
  transcriptionClient,
  TranscriptionServerUnavailable,
  type WhisperJob,
} from "./client";
import { renderTranscript, type RawSegment, type SpeakerMap } from "./transcript-text";

const TABLE = "transcription_jobs";

export type JobStatus =
  | "queued"
  | "transcribing"
  | "awaiting_review"
  | "saved"
  | "failed"
  | "cancelled";

export type StartJobInput = {
  userId: number;
  s3Key: string;
  filename: string;
  title?: string;
  language?: string | null;
  num_speakers?: number | null;
  hotwords?: string[];
  project_id?: string | null;
  target_rights_mode?: ExuluRightsMode | null;
  target_rbac_users?: { id: number; rights: "read" | "write" }[];
  target_rbac_roles?: { id: string; rights: "read" | "write" }[];
};

export type FinalizeInput = {
  title?: string;
  speakers: SpeakerMap;
  project_id?: string | null;
  target_rights_mode?: ExuluRightsMode | null;
  target_rbac_users?: { id: number; rights: "read" | "write" }[];
  target_rbac_roles?: { id: string; rights: "read" | "write" }[];
};

type JobRow = {
  id: string;
  audio_s3key: string;
  title: string | null;
  status: JobStatus;
  whisper_job_id: string | null;
  raw_segments: RawSegment[] | null;
  speakers: SpeakerMap | null;
  language: string | null;
  duration_seconds: number | null;
  project_id: string | null;
  target_rights_mode: ExuluRightsMode | null;
  target_rbac_users: { id: number; rights: "read" | "write" }[] | null;
  target_rbac_roles: { id: string; rights: "read" | "write" }[] | null;
  saved_item_id: string | null;
  error: string | null;
  rights_mode: ExuluRightsMode;
  created_by: number;
  createdAt: string;
  updatedAt: string;
};

const log = (msg: string) => console.log(`[EXULU-TRANSCRIPTION] ${msg}`);

const parseJsonField = <T>(v: unknown): T | null => {
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

const presignAudio = async (s3Key: string): Promise<string> => {
  const app = exuluApp.get();
  const config = (app as any)._config ?? (app as any).config;
  const configuredBucket: string | undefined = config?.fileUploads?.s3Bucket;
  if (!configuredBucket) {
    throw new Error("File uploads are not configured (s3Bucket missing).");
  }
  // Uppy stores keys with the bucket prefixed as the first path segment
  // (e.g. "exulu/user_1/uuid-_EXULU_file.m4a"). Mirror the /s3/download
  // endpoint's split so we don't double-prefix the bucket when signing.
  const firstSlash = s3Key.indexOf("/");
  const bucket = firstSlash > 0 ? s3Key.slice(0, firstSlash) : configuredBucket;
  const objectKey = firstSlash > 0 ? s3Key.slice(firstSlash + 1) : s3Key;
  return getPresignedUrl(bucket, objectKey, config);
};

export const transcriptionService = {
  /**
   * Create a transcription job row and dispatch it to the whisper server.
   * Throws TranscriptionServerUnavailable if the feature is off.
   */
  async startJob(input: StartJobInput): Promise<JobRow> {
    if (!transcriptionClient.isConfigured()) {
      throw new TranscriptionServerUnavailable(
        "TRANSCRIPTION_SERVER is not set. Start a whisper server with " +
          "`npx @exulu/backend exulu-start-whisper` and point TRANSCRIPTION_SERVER at it.",
      );
    }
    const { db } = await postgresClient();

    const now = new Date();
    const [inserted] = await db(TABLE)
      .insert({
        audio_s3key: input.s3Key,
        title: input.title ?? input.filename,
        status: "queued" as JobStatus,
        project_id: input.project_id ?? null,
        target_rights_mode: input.target_rights_mode ?? "private",
        target_rbac_users: input.target_rbac_users ? JSON.stringify(input.target_rbac_users) : null,
        target_rbac_roles: input.target_rbac_roles ? JSON.stringify(input.target_rbac_roles) : null,
        rights_mode: "private",
        created_by: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning("*");

    const row: JobRow = this._rowFromDb(inserted);

    try {
      const audioUrl = await presignAudio(input.s3Key);
      const submitted = await transcriptionClient.submitJob({
        audio_url: audioUrl,
        language: input.language ?? undefined,
        num_speakers: input.num_speakers ?? undefined,
        hotwords: input.hotwords,
      });
      const [updated] = await db(TABLE)
        .where({ id: row.id })
        .update({
          whisper_job_id: submitted.job_id,
          status: "transcribing" as JobStatus,
          updatedAt: new Date(),
        })
        .returning("*");
      return this._rowFromDb(updated);
    } catch (err) {
      const [failed] = await db(TABLE)
        .where({ id: row.id })
        .update({
          status: "failed" as JobStatus,
          error: (err as Error).message,
          updatedAt: new Date(),
        })
        .returning("*");
      log(`Failed to dispatch job ${row.id}: ${(err as Error).message}`);
      return this._rowFromDb(failed);
    }
  },

  /**
   * Reconcile every transcribing row against the whisper server. Called from
   * the polling loop on a fixed interval. Caps how many rows we touch per
   * tick so a backlog can't starve the event loop.
   */
  async pollOnce(maxPerTick = 50): Promise<void> {
    if (!transcriptionClient.isConfigured()) return;

    const { db } = await postgresClient();
    const rows: any[] = await db(TABLE)
      .where({ status: "transcribing" })
      .whereNotNull("whisper_job_id")
      .limit(maxPerTick);

    for (const dbRow of rows) {
      const row = this._rowFromDb(dbRow);
      if (!row.whisper_job_id) continue;
      try {
        const job = await transcriptionClient.getJob(row.whisper_job_id);
        await this._applyJobUpdate(row, job);
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === "JOB_NOT_FOUND") {
          await db(TABLE)
            .where({ id: row.id })
            .update({
              status: "failed" as JobStatus,
              error: "lost on server restart",
              updatedAt: new Date(),
            });
        } else if (err instanceof TranscriptionServerUnavailable) {
          // Transient — leave the row in transcribing and retry next tick.
          log(`Whisper server unreachable while polling ${row.id}; will retry`);
        } else {
          log(`Error polling job ${row.id}: ${(err as Error).message}`);
        }
      }
    }
  },

  async _applyJobUpdate(row: JobRow, job: WhisperJob): Promise<void> {
    const { db } = await postgresClient();

    // Whisper server populates duration_seconds as soon as the audio file is
    // loaded — i.e. while status is still "running". Persist it now so the
    // frontend can display "N audio / M elapsed" instead of just elapsed.
    if (
      (job.status === "queued" || job.status === "running") &&
      job.duration_seconds != null &&
      row.duration_seconds !== job.duration_seconds
    ) {
      await db(TABLE)
        .where({ id: row.id })
        .update({
          duration_seconds: job.duration_seconds,
          updatedAt: new Date(),
        });
    }

    if (job.status === "running" || job.status === "queued") return;

    if (job.status === "completed") {
      await db(TABLE)
        .where({ id: row.id })
        .update({
          status: "awaiting_review" as JobStatus,
          raw_segments: JSON.stringify(job.segments ?? []),
          language: job.language ?? null,
          duration_seconds: job.duration_seconds ?? null,
          updatedAt: new Date(),
        });
      return;
    }

    if (job.status === "failed") {
      await db(TABLE)
        .where({ id: row.id })
        .update({
          status: "failed" as JobStatus,
          error: job.error ?? "transcription failed",
          updatedAt: new Date(),
        });
      return;
    }

    if (job.status === "cancelled") {
      await db(TABLE)
        .where({ id: row.id })
        .update({
          status: "cancelled" as JobStatus,
          updatedAt: new Date(),
        });
    }
  },

  async cancelJob(id: string): Promise<JobRow> {
    const { db } = await postgresClient();
    const dbRow = await db(TABLE).where({ id }).first();
    if (!dbRow) throw new Error(`transcription_job ${id} not found`);
    const row = this._rowFromDb(dbRow);

    if (row.whisper_job_id && transcriptionClient.isConfigured()) {
      try {
        await transcriptionClient.cancelJob(row.whisper_job_id);
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code !== "JOB_NOT_FOUND") {
          log(`Best-effort cancel of whisper job failed: ${(err as Error).message}`);
        }
      }
    }

    const [updated] = await db(TABLE)
      .where({ id })
      .update({ status: "cancelled" as JobStatus, updatedAt: new Date() })
      .returning("*");
    return this._rowFromDb(updated);
  },

  /**
   * User clicked Save in the review panel.
   *
   * - From 'awaiting_review': render the speaker-labeled transcript, create a
   *   new ExuluContext item, apply RBAC + optional project linkage, mark the
   *   job saved.
   * - From 'saved': re-render the transcript with the (possibly updated)
   *   speaker map and upsert the existing context item by id. Used by the
   *   Completed-section re-edit flow.
   */
  async finalize(id: string, input: FinalizeInput): Promise<{ item: Item; row: JobRow }> {
    const { db } = await postgresClient();
    const dbRow = await db(TABLE).where({ id }).first();
    if (!dbRow) throw new Error(`transcription_job ${id} not found`);
    const row = this._rowFromDb(dbRow);

    if (row.status !== "awaiting_review" && row.status !== "saved") {
      throw new Error(
        `transcription_job ${id} is in status '${row.status}'; can only finalize from 'awaiting_review' or 'saved'`,
      );
    }
    if (!row.raw_segments) {
      throw new Error(`transcription_job ${id} has no raw_segments to finalize`);
    }

    const app = exuluApp.get();
    const context = app.context("transcriptions");
    if (!context) {
      throw new Error("Built-in transcriptions context not registered");
    }
    const config = (app as any)._config ?? (app as any).config;

    const transcriptText = renderTranscript(row.raw_segments, input.speakers);
    const rightsMode: ExuluRightsMode =
      input.target_rights_mode ?? row.target_rights_mode ?? "private";

    const isReSave = row.status === "saved" && !!row.saved_item_id;

    const itemInput: Item = {
      // Carrying the id on re-save makes context.createItem upsert in place.
      ...(isReSave && row.saved_item_id ? { id: row.saved_item_id } : {}),
      name: input.title ?? row.title ?? "Transcript",
      transcript_text: transcriptText,
      audio_s3key: row.audio_s3key,
      language: row.language ?? undefined,
      duration_seconds: row.duration_seconds ?? undefined,
      speakers: input.speakers,
      raw_segments: row.raw_segments,
      rights_mode: rightsMode,
      created_by: row.created_by,
    };

    let item: Item;
    try {
      const result = await context.createItem(
        itemInput,
        config,
        row.created_by,
        undefined,
        isReSave, // upsert when re-saving
      );
      item = result.item;
    } catch (err) {
      // Keep the job in its current status with the error recorded so the
      // user can retry Save without losing the transcript or the rename map.
      await db(TABLE)
        .where({ id })
        .update({
          speakers: JSON.stringify(input.speakers),
          error: `Failed to save: ${(err as Error).message}`,
          updatedAt: new Date(),
        });
      throw err;
    }

    // context.createItem returns `{ id }` on upsert; fall back to the
    // existing saved_item_id so we don't accidentally clear it.
    const itemId = (item.id as string) ?? row.saved_item_id ?? "";

    // Apply per-user / per-role RBAC if the user specified any.
    const users = input.target_rbac_users ?? row.target_rbac_users ?? [];
    const roles = input.target_rbac_roles ?? row.target_rbac_roles ?? [];
    if ((users.length || roles.length) && rightsMode !== "private") {
      try {
        await handleRBACUpdate(
          db,
          "transcriptions",
          itemId,
          { users, roles },
          [],
        );
      } catch (err) {
        log(`RBAC update failed for item ${itemId}: ${(err as Error).message}`);
      }
    }

    // Optionally attach to a project (only meaningful on first save; on
    // re-save the dev can re-attach via /data if they want a different one).
    const projectId = input.project_id ?? row.project_id ?? null;
    let projectWarning: string | null = null;
    if (projectId && !isReSave) {
      try {
        const project = await db("projects").where({ id: projectId }).first();
        if (!project) {
          projectWarning = `project ${projectId} not found`;
        } else {
          const existing: string[] = parseJsonField<string[]>(project.project_items) ?? [];
          const globalId = `transcriptions/${itemId}`;
          if (!existing.includes(globalId)) {
            existing.push(globalId);
            await db("projects")
              .where({ id: projectId })
              .update({
                project_items: JSON.stringify(existing),
                updatedAt: new Date(),
              });
          }
        }
      } catch (err) {
        projectWarning = (err as Error).message;
      }
    }

    const [updated] = await db(TABLE)
      .where({ id })
      .update({
        status: "saved" as JobStatus,
        saved_item_id: itemId,
        title: input.title ?? row.title ?? null,
        speakers: JSON.stringify(input.speakers),
        error: projectWarning ? `Saved, but could not attach to project: ${projectWarning}` : null,
        updatedAt: new Date(),
      })
      .returning("*");

    return { item, row: this._rowFromDb(updated) };
  },

  _rowFromDb(dbRow: any): JobRow {
    return {
      ...dbRow,
      raw_segments: parseJsonField<RawSegment[]>(dbRow.raw_segments),
      speakers: parseJsonField<SpeakerMap>(dbRow.speakers),
      target_rbac_users: parseJsonField<{ id: number; rights: "read" | "write" }[]>(
        dbRow.target_rbac_users,
      ),
      target_rbac_roles: parseJsonField<{ id: string; rights: "read" | "write" }[]>(
        dbRow.target_rbac_roles,
      ),
    } as JobRow;
  },
};
