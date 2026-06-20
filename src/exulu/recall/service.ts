/**
 * RecallService — meeting-bot lifecycle for the Recall.ai integration.
 *
 * Recall is webhook-driven (polling is explicitly forbidden), so unlike the
 * Whisper polling flow this service is split into:
 *
 *   - createMeetingBot:    insert a transcription_jobs row (source='recall') and
 *                          launch the bot via the Recall API.
 *   - handleWebhookEvent:  the async, idempotent state machine driven by Recall
 *                          webhooks (bot.* / recording.done / transcript.done /
 *                          *.failed).
 *   - runPostProcessing:   run the per-meeting {prompt, agent} pairs against the
 *                          ready transcript and store results on the row.
 *
 * Saving into the `transcriptions` context reuses the existing
 * transcriptionService.finalize() path (the user clicks Save in review).
 *
 * Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
 */

import { generateText } from "ai";
import { exuluApp } from "@SRC/exulu/app/singleton";
import { postgresClient } from "@SRC/postgres/client";
import { resolveModel } from "@SRC/exulu/resolve-model";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";
import { renderTranscript, type RawSegment, type SpeakerMap } from "../transcription/transcript-text";
import { recallClient, recordingDurationSeconds } from "./client";
import {
  recallEnabled,
  RecallNotConfiguredError,
  recordingMonthlyLimitSeconds,
} from "./env";
import { mapRecallTranscript, durationFromSegments } from "./transcript-map";

const TABLE = "transcription_jobs";
const DEFAULT_BOT_NAME = "Exulu Notetaker";

const log = (msg: string) => console.log(`[EXULU-RECALL] ${msg}`);

export type PostProcessingPrompt = { prompt_id: string; agent_id: string };

export type PostProcessingOutput = {
  prompt_id: string;
  agent_id: string;
  prompt_name: string | null;
  status: "done" | "failed";
  output: string | null;
  error: string | null;
  ran_at: string;
};

export type CreateMeetingBotInput = {
  userId: number;
  meeting_url: string;
  /** ISO8601; defaults to now when omitted ("join immediately"). */
  join_at?: string | null;
  /** Transcription language code (e.g. "en", "de"); null/"auto" = auto-detect. */
  language?: string | null;
  title?: string | null;
  bot_name?: string | null;
  notify_chat?: boolean;
  project_id?: string | null;
  target_rights_mode?: ExuluRightsMode | null;
  target_rbac_users?: { id: number; rights: "read" | "write" }[];
  target_rbac_roles?: { id: string; rights: "read" | "write" }[];
  post_processing_prompts?: PostProcessingPrompt[];
};

type RecallEvent = {
  event?: string;
  data?: {
    data?: { code?: string; sub_code?: string | null } | null;
    bot?: { id?: string } | null;
    recording?: { id?: string } | null;
    transcript?: { id?: string } | null;
  } | null;
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

const eventIds = (e: RecallEvent) => ({
  botId: e?.data?.bot?.id ?? null,
  recordingId: e?.data?.recording?.id ?? null,
  transcriptId: e?.data?.transcript?.id ?? null,
  code: e?.data?.data?.code ?? null,
  subCode: e?.data?.data?.sub_code ?? null,
});

export type RecordingUsage = {
  /** Whether a monthly cap is configured. */
  enabled: boolean;
  /** Total recorded seconds this calendar month (UTC). */
  used_seconds: number;
  /** The cap in seconds, or null when no cap is set. */
  limit_seconds: number | null;
  /** 0–100 (null when no cap). */
  percent: number | null;
  /** True when usage has reached/exceeded the cap. */
  exceeded: boolean;
};

export const recallService = {
  /**
   * Total recorded meeting duration (seconds) for the current UTC month. Sums
   * duration_seconds across completed recall jobs created this month.
   */
  async monthlyUsedSeconds(): Promise<number> {
    const { db } = await postgresClient();
    const now = new Date();
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const [row] = await db(TABLE)
      .where({ source: "recall" })
      .andWhere("createdAt", ">=", startOfMonth)
      .whereNotNull("duration_seconds")
      .sum({ total: "duration_seconds" });
    return Number(row?.total ?? 0);
  },

  /** Current month's recording usage against the optional monthly cap. */
  async getUsage(): Promise<RecordingUsage> {
    const limit = recordingMonthlyLimitSeconds();
    const used = await this.monthlyUsedSeconds();
    return {
      enabled: limit != null,
      used_seconds: used,
      limit_seconds: limit,
      percent: limit != null ? Math.min(100, (used / limit) * 100) : null,
      exceeded: limit != null && used >= limit,
    };
  },

  /**
   * Insert a recall transcription_jobs row and launch the bot. join_at always
   * flows through (= now for "join immediately") to keep the scheduling path
   * consistent for a future calendar integration.
   */
  async createMeetingBot(input: CreateMeetingBotInput) {
    if (!recallEnabled()) throw new RecallNotConfiguredError();

    // Enforce the optional monthly recording cap before launching a bot.
    const limit = recordingMonthlyLimitSeconds();
    if (limit != null) {
      const used = await this.monthlyUsedSeconds();
      if (used >= limit) {
        throw new Error(
          `RECORDING_LIMIT_REACHED: Monthly meeting recording limit reached ` +
            `(${Math.round(used / 60)} / ${Math.round(limit / 60)} minutes used). ` +
            `New recordings are blocked until next month.`,
        );
      }
    }

    const { db } = await postgresClient();

    const now = new Date();
    const joinAt = input.join_at ? new Date(input.join_at) : now;

    const [inserted] = await db(TABLE)
      .insert({
        source: "recall",
        status: "queued",
        title: input.title ?? null,
        meeting_url: input.meeting_url,
        join_at: joinAt,
        // Requested transcription language ("auto"/empty → null = auto-detect).
        language:
          input.language && input.language !== "auto" ? input.language : null,
        project_id: input.project_id ?? null,
        target_rights_mode: input.target_rights_mode ?? "private",
        target_rbac_users: input.target_rbac_users
          ? JSON.stringify(input.target_rbac_users)
          : null,
        target_rbac_roles: input.target_rbac_roles
          ? JSON.stringify(input.target_rbac_roles)
          : null,
        post_processing_prompts: input.post_processing_prompts
          ? JSON.stringify(input.post_processing_prompts)
          : null,
        rights_mode: "private",
        created_by: input.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning("*");

    try {
      const bot = await recallClient.createBot({
        meeting_url: input.meeting_url,
        join_at: joinAt.toISOString(),
        bot_name: input.bot_name?.trim() || DEFAULT_BOT_NAME,
        notifyChat: input.notify_chat
          ? { message: "This meeting is being recorded and transcribed." }
          : undefined,
      });
      const [updated] = await db(TABLE)
        .where({ id: inserted.id })
        .update({ recall_bot_id: bot.id, updatedAt: new Date() })
        .returning("*");
      return this._row(updated);
    } catch (err) {
      const [failed] = await db(TABLE)
        .where({ id: inserted.id })
        .update({
          status: "failed",
          error: (err as Error).message,
          updatedAt: new Date(),
        })
        .returning("*");
      log(`createBot failed for job ${inserted.id}: ${(err as Error).message}`);
      return this._row(failed);
    }
  },

  /**
   * Process a verified Recall webhook event. Idempotent: every transition is
   * guarded so duplicate / out-of-order deliveries are safe. Must NOT be called
   * before signature verification.
   */
  async handleWebhookEvent(event: RecallEvent): Promise<void> {
    const ids = eventIds(event);
    const name = event?.event ?? "";

    const job = await this._findJob(ids.botId, ids.recordingId, ids.transcriptId);
    if (!job) {
      log(`No job for event ${name} (bot=${ids.botId}); ignoring.`);
      return;
    }

    if (name.startsWith("bot.")) {
      const botStatus = name.slice("bot.".length) || ids.code || null;
      await this._update(job.id, { bot_status: botStatus });
      if (name === "bot.fatal") {
        await this._fail(job.id, ids.subCode || ids.code || "bot fatal error");
      }
      return;
    }

    switch (name) {
      case "recording.done":
        await this._onRecordingDone(job.id, ids.recordingId);
        return;
      case "transcript.done":
        await this._onTranscriptDone(job.id, ids.transcriptId, ids.recordingId);
        return;
      case "recording.failed":
        await this._fail(job.id, ids.subCode || ids.code || "recording failed");
        return;
      case "transcript.failed":
        await this._fail(job.id, ids.subCode || ids.code || "transcript failed");
        return;
      default:
        log(`Unhandled event ${name} for job ${job.id}`);
    }
  },

  async _onRecordingDone(jobId: string, recordingId: string | null): Promise<void> {
    if (!recordingId) {
      log(`recording.done for job ${jobId} had no recording id`);
      return;
    }
    const { db } = await postgresClient();
    // Claim the transition atomically: only proceed from a pre-transcription
    // state. A duplicate recording.done finds status already advanced and bails,
    // so createAsyncTranscript runs at most once.
    const claimed = await db(TABLE)
      .where({ id: jobId })
      .whereNotIn("status", ["transcribing", "awaiting_review", "saved", "failed"])
      .update({
        recall_recording_id: recordingId,
        status: "transcribing",
        updatedAt: new Date(),
      });
    if (!claimed) {
      log(`recording.done for job ${jobId} already handled; skipping.`);
      return;
    }
    try {
      // Use the language chosen at bot creation (null = auto-detect).
      const row = await db(TABLE).where({ id: jobId }).first();
      const transcript = await recallClient.createAsyncTranscript(
        recordingId,
        row?.language || "auto",
      );
      await this._update(jobId, { recall_transcript_id: transcript.id ?? null });
    } catch (err) {
      await this._fail(jobId, `create transcript failed: ${(err as Error).message}`);
    }
  },

  async _onTranscriptDone(
    jobId: string,
    transcriptId: string | null,
    recordingId: string | null,
  ): Promise<void> {
    const { db } = await postgresClient();
    const dbRow = await db(TABLE).where({ id: jobId }).first();
    if (!dbRow) return;
    const job = this._row(dbRow);

    // Idempotent: a transcript already downloaded means this event was handled.
    if (
      (job.status === "awaiting_review" || job.status === "saved") &&
      job.raw_segments &&
      job.raw_segments.length > 0
    ) {
      log(`transcript.done for job ${jobId} already processed; skipping.`);
      return;
    }

    try {
      const url = await this._transcriptDownloadUrl(
        transcriptId ?? job.recall_transcript_id,
        recordingId ?? job.recall_recording_id,
      );
      if (!url) throw new Error("no transcript download_url available");

      const raw = await recallClient.downloadTranscript(url);
      const segments = mapRecallTranscript(raw);

      // Prefer Recall's authoritative recording duration; fall back to the
      // transcript span (last spoken word) when the recording object lacks it.
      let duration = durationFromSegments(segments);
      const recId = recordingId ?? job.recall_recording_id;
      if (recId) {
        try {
          const rec = await recallClient.retrieveRecording(recId);
          const recDuration = recordingDurationSeconds(rec);
          if (recDuration != null) duration = recDuration;
        } catch (err) {
          log(`could not fetch recording duration for job ${jobId}: ${(err as Error).message}`);
        }
      }

      await this._update(jobId, {
        recall_transcript_id: transcriptId ?? job.recall_transcript_id ?? null,
        raw_segments: JSON.stringify(segments),
        duration_seconds: duration,
        status: "awaiting_review",
      });
    } catch (err) {
      await this._fail(jobId, `transcript download failed: ${(err as Error).message}`);
      return;
    }

    // Auto-run post-processing now that the transcript is ready.
    await this.runPostProcessing(jobId);
  },

  async _transcriptDownloadUrl(
    transcriptId: string | null | undefined,
    recordingId: string | null | undefined,
  ): Promise<string | null> {
    if (transcriptId) {
      const t = await recallClient.retrieveTranscript(transcriptId);
      if (t?.data?.download_url) return t.data.download_url;
    }
    if (recordingId) {
      const r = await recallClient.retrieveRecording(recordingId);
      const url = r?.media_shortcuts?.transcript?.data?.download_url;
      if (url) return url;
    }
    return null;
  },

  /**
   * Run the selected {prompt, agent} pairs against the transcript and store the
   * results on the row. Idempotent (skips if outputs already exist). Each entry
   * is isolated so one failing prompt does not block the others.
   */
  async runPostProcessing(jobId: string): Promise<PostProcessingOutput[]> {
    const { db } = await postgresClient();
    const dbRow = await db(TABLE).where({ id: jobId }).first();
    if (!dbRow) return [];
    const job = this._row(dbRow);

    const prompts = job.post_processing_prompts ?? [];
    if (prompts.length === 0) return [];

    // Don't double-spend on a duplicate transcript.done.
    if (job.post_processing_outputs && job.post_processing_outputs.length > 0) {
      log(`post-processing for job ${jobId} already ran; skipping.`);
      return job.post_processing_outputs;
    }
    if (!job.raw_segments || job.raw_segments.length === 0) {
      log(`post-processing for job ${jobId} skipped: no transcript.`);
      return [];
    }

    const outputs: PostProcessingOutput[] = [];
    for (const p of prompts) {
      outputs.push(await this._runOnePrompt(job, p.prompt_id, p.agent_id));
    }
    await this._update(jobId, {
      post_processing_outputs: JSON.stringify(outputs),
    });
    return outputs;
  },

  /**
   * Manual single-prompt run (re-run from the review sheet). Upserts the matching
   * {prompt_id, agent_id} entry in post_processing_outputs.
   */
  async runOnePostProcessing(
    jobId: string,
    promptId: string,
    agentId: string,
  ): Promise<PostProcessingOutput> {
    const { db } = await postgresClient();
    const dbRow = await db(TABLE).where({ id: jobId }).first();
    if (!dbRow) throw new Error(`transcription_job ${jobId} not found`);
    const job = this._row(dbRow);

    const result = await this._runOnePrompt(job, promptId, agentId);

    const existing = job.post_processing_outputs ?? [];
    const next = existing.filter(
      (o) => !(o.prompt_id === promptId && o.agent_id === agentId),
    );
    next.push(result);
    await this._update(jobId, { post_processing_outputs: JSON.stringify(next) });
    return result;
  },

  async _runOnePrompt(
    job: JobRow,
    promptId: string,
    agentId: string,
  ): Promise<PostProcessingOutput> {
    const ranAt = new Date().toISOString();
    const { db } = await postgresClient();
    let promptName: string | null = null;
    try {
      const prompt = await db("prompt_library").where({ id: promptId }).first();
      if (!prompt) throw new Error(`prompt_library item ${promptId} not found`);
      promptName = prompt.name ?? null;

      const agent = await exuluApp.get().agent(agentId);
      if (!agent) throw new Error(`agent ${agentId} not found`);
      if (!agent.model) throw new Error(`agent ${agent.name} has no model configured`);

      const user = await db("users").where({ id: job.created_by }).first();

      const resolved = await resolveModel({
        modelId: agent.model,
        user,
        providers: exuluApp.get().providers,
        agent,
      });

      const transcriptText = renderTranscript(
        job.raw_segments ?? [],
        job.speakers ?? {},
      );

      const { text } = await generateText({
        model: resolved.languageModel,
        system: agent.instructions || undefined,
        prompt: `${prompt.content}\n\n---\nMeeting transcript:\n\n${transcriptText}`,
        maxRetries: 3,
      });

      return {
        prompt_id: promptId,
        agent_id: agentId,
        prompt_name: promptName,
        status: "done",
        output: text,
        error: null,
        ran_at: ranAt,
      };
    } catch (err) {
      log(`post-processing prompt ${promptId} failed for job ${job.id}: ${(err as Error).message}`);
      return {
        prompt_id: promptId,
        agent_id: agentId,
        prompt_name: promptName,
        status: "failed",
        output: null,
        error: (err as Error).message,
        ran_at: ranAt,
      };
    }
  },

  async _findJob(
    botId: string | null,
    recordingId: string | null,
    transcriptId: string | null,
  ): Promise<JobRow | null> {
    const { db } = await postgresClient();
    let dbRow: any | undefined;
    if (botId) dbRow = await db(TABLE).where({ recall_bot_id: botId }).first();
    if (!dbRow && recordingId)
      dbRow = await db(TABLE).where({ recall_recording_id: recordingId }).first();
    if (!dbRow && transcriptId)
      dbRow = await db(TABLE).where({ recall_transcript_id: transcriptId }).first();
    return dbRow ? this._row(dbRow) : null;
  },

  async _update(id: string, patch: Record<string, unknown>): Promise<void> {
    const { db } = await postgresClient();
    await db(TABLE).where({ id }).update({ ...patch, updatedAt: new Date() });
  },

  async _fail(id: string, error: string): Promise<void> {
    await this._update(id, { status: "failed", error });
  },

  _row(dbRow: any): JobRow {
    return {
      ...dbRow,
      raw_segments: parseJson<RawSegment[]>(dbRow.raw_segments),
      speakers: parseJson<SpeakerMap>(dbRow.speakers),
      post_processing_prompts: parseJson<PostProcessingPrompt[]>(
        dbRow.post_processing_prompts,
      ),
      post_processing_outputs: parseJson<PostProcessingOutput[]>(
        dbRow.post_processing_outputs,
      ),
    } as JobRow;
  },
};

type JobRow = {
  id: string;
  source: string;
  status: string;
  meeting_url: string | null;
  recall_bot_id: string | null;
  recall_recording_id: string | null;
  recall_transcript_id: string | null;
  bot_status: string | null;
  raw_segments: RawSegment[] | null;
  speakers: SpeakerMap | null;
  post_processing_prompts: PostProcessingPrompt[] | null;
  post_processing_outputs: PostProcessingOutput[] | null;
  created_by: number;
};
