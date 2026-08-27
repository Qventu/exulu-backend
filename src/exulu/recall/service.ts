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
const DEFAULT_BOT_NAME = "Company Notetaker";

// Reconciliation sweep tuning. The webhook route ACKs with 2xx before
// processing, and Recall never redelivers an ACKed event — so a crash,
// restart, or unhandled error mid-processing would otherwise strand the job
// forever. The sweep re-drives stuck rows from Recall's own state.
const RECONCILE_STALE_MS = 10 * 60 * 1000;
// A queued bot with no terminal bot_status may just be a long quiet meeting;
// probe it via the API at most once per quiet period.
const RECONCILE_PROBE_QUIET_MS = 60 * 60 * 1000;
// Hard cap: a meeting whose transcript never materializes fails visibly
// instead of sitting in "Processing" forever.
const RECONCILE_GIVE_UP_MS = 24 * 60 * 60 * 1000;
// Re-run post-processing whose fire-and-forget run was lost (process restart
// mid-LLM-call). Long enough that a live run is almost certainly finished.
const POST_PROCESSING_REDO_STALE_MS = 30 * 60 * 1000;
// Hard bound per prompt LLM call; without it a hung provider connection pends
// the whole post-processing chain forever.
const POST_PROCESSING_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/** bot_status values that mean the meeting itself is over. */
const BOT_ENDED_STATUSES = ["done", "call_ended"];

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
        // Normalized to NULL when empty so the reconcile sweep's redo select
        // ("prompts configured but never ran") can never match a no-prompt row.
        post_processing_prompts: input.post_processing_prompts?.length
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
      .whereNotIn("status", [
        "transcribing",
        "awaiting_review",
        "saved",
        "failed",
        "cancelled",
      ])
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
   * Fresh signed URL for a recording's mixed MP4, or null when there is no
   * usable video (still processing, no video artifact, recording expired or
   * deleted).
   *
   * Never cache the result: the URL carries X-Amz-Expires=21600, so it dies
   * after six hours. Resolve at point of use.
   */
  async getRecordingVideoUrl(recordingId: string): Promise<string | null> {
    try {
      const recording = await recallClient.retrieveRecording(recordingId);
      const video = recording?.media_shortcuts?.video_mixed;
      if (!video) return null;
      // Absent status means the artifact predates status reporting; treat as ready.
      if (video.status?.code && video.status.code !== "done") return null;
      return video.data?.download_url ?? null;
    } catch (err) {
      log(
        `could not resolve video url for recording ${recordingId}: ${(err as Error).message}`,
      );
      return null;
    }
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

    // Claim the run atomically ("[]" = in flight). A fresh row claims via the
    // NULL branch; a run that died mid-flight leaves "[]" behind and becomes
    // re-claimable once stale — so concurrent callers (webhook vs reconcile
    // sweep, or two app instances) can never double-spend the LLM calls.
    const claimed = await db(TABLE)
      .where({ id: jobId })
      .whereRaw(
        `(post_processing_outputs IS NULL OR ` +
          `(post_processing_outputs::text = '[]' AND "updatedAt" < ?))`,
        [new Date(Date.now() - POST_PROCESSING_REDO_STALE_MS)],
      )
      .update({ post_processing_outputs: "[]", updatedAt: new Date() });
    if (!claimed) {
      log(`post-processing for job ${jobId} already in flight; skipping.`);
      return [];
    }

    const outputs: PostProcessingOutput[] = [];
    for (const p of prompts) {
      outputs.push(await this._runOnePrompt(job, p.prompt_id, p.agent_id));
      // Heartbeat: keep the "[]" claim fresh so a long multi-prompt batch is
      // never stale-stolen by the sweep while it is legitimately running.
      await this._update(jobId, {});
    }
    return this._mergeOutputs(jobId, outputs);
  },

  /**
   * Upsert entries into post_processing_outputs without clobbering concurrent
   * writers: optimistic-concurrency loop — read, merge by {prompt_id,
   * agent_id}, write only while the column still matches the snapshot.
   */
  async _mergeOutputs(
    jobId: string,
    entries: PostProcessingOutput[],
  ): Promise<PostProcessingOutput[]> {
    const { db } = await postgresClient();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const row = await db(TABLE).where({ id: jobId }).first();
      if (!row) return entries;
      const raw = row.post_processing_outputs ?? null;
      const snapshot =
        raw == null ? null : typeof raw === "string" ? raw : JSON.stringify(raw);
      const current = parseJson<PostProcessingOutput[]>(raw) ?? [];
      const merged = [
        ...current.filter(
          (o) =>
            !entries.some(
              (e) => e.prompt_id === o.prompt_id && e.agent_id === o.agent_id,
            ),
        ),
        ...entries,
      ];
      const updated = await db(TABLE)
        .where({ id: jobId })
        .whereRaw(
          "post_processing_outputs::jsonb IS NOT DISTINCT FROM ?::jsonb",
          [snapshot],
        )
        .update({
          post_processing_outputs: JSON.stringify(merged),
          updatedAt: new Date(),
        });
      if (updated) return merged;
    }
    log(
      `post-processing outputs for job ${jobId} kept changing under the merge; ` +
        `leaving the concurrent writer's data in place.`,
    );
    return entries;
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

    // Refuse while the batch's "[]" claim is fresh: the auto-run is still
    // executing (it heartbeats updatedAt per prompt) and a manual run now
    // would double-spend. A stale claim means the run died — take over.
    const claimInFlight =
      dbRow.post_processing_outputs != null &&
      (job.post_processing_outputs?.length ?? 0) === 0 &&
      Date.now() - new Date(job.updatedAt).getTime() <
        POST_PROCESSING_REDO_STALE_MS;
    if (claimInFlight) {
      throw new Error(
        "POST_PROCESSING_IN_FLIGHT: the automatic post-processing run is " +
          "still in progress; its results will appear shortly.",
      );
    }

    const result = await this._runOnePrompt(job, promptId, agentId);
    await this._mergeOutputs(jobId, [result]);
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
        abortSignal: AbortSignal.timeout(POST_PROCESSING_PROMPT_TIMEOUT_MS),
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

  /**
   * Reconciliation sweep: re-drive recall jobs whose webhook event was lost
   * (ACK-first delivery + crash/restart = no redelivery). Called periodically
   * from the reconcile loop. Returns the number of jobs it acted on.
   *
   * Idempotent by construction: every recovery path funnels into the same
   * guarded transitions the webhook handlers use (_onRecordingDone's atomic
   * claim, _onTranscriptDone's already-processed check, runPostProcessing's
   * skip-if-outputs-exist), so a webhook racing the sweep is harmless.
   */
  async reconcileOnce(limit = 10): Promise<number> {
    if (!recallEnabled()) return 0;
    const { db } = await postgresClient();
    const now = Date.now();

    const stuck = await db(TABLE)
      .where({ source: "recall" })
      .whereIn("status", ["queued", "transcribing"])
      // A meeting that hasn't started (or barely started) can't be stuck, and
      // probing it would only burn API calls and sweep-window slots.
      .whereRaw(`("join_at" IS NULL OR "join_at" < ?)`, [
        new Date(now - RECONCILE_STALE_MS),
      ])
      .where("updatedAt", "<", new Date(now - RECONCILE_STALE_MS))
      .orderBy("updatedAt", "asc")
      .limit(limit);

    // awaiting_review rows whose configured prompts never produced outputs:
    // the fire-and-forget runPostProcessing died mid-run (or never started).
    // Rows runPostProcessing would only skip (no prompts, no transcript) are
    // excluded here — otherwise they'd re-match every tick and starve the
    // sweep window.
    const redo = await db(TABLE)
      .where({ source: "recall", status: "awaiting_review" })
      .whereNotNull("post_processing_prompts")
      .whereRaw("post_processing_prompts::text <> '[]'")
      .whereRaw("(raw_segments IS NOT NULL AND raw_segments::text <> '[]')")
      .whereRaw(
        "(post_processing_outputs IS NULL OR post_processing_outputs::text = '[]')",
      )
      .where("updatedAt", "<", new Date(now - POST_PROCESSING_REDO_STALE_MS))
      .orderBy("updatedAt", "asc")
      .limit(limit);

    let acted = 0;
    for (const dbRow of stuck) {
      const job = this._row(dbRow);
      try {
        if (await this._reconcileStuckJob(job)) acted++;
      } catch (err) {
        if (await this._reconcileError(job, err)) acted++;
      }
    }
    for (const dbRow of redo) {
      try {
        log(`reconcile: re-running lost post-processing for job ${dbRow.id}`);
        const outputs = await this.runPostProcessing(dbRow.id);
        if (outputs.length > 0) acted++;
      } catch (err) {
        log(
          `post-processing redo failed for job ${dbRow.id}: ${(err as Error).message}`,
        );
      }
    }
    return acted;
  },

  async _reconcileStuckJob(job: JobRow): Promise<boolean> {
    if (!job.recall_bot_id) {
      // Crash between the row insert and the recall_bot_id write: no webhook
      // can ever match this row, so it can never progress.
      await this._fail(job.id, "bot was never launched (lost during creation)");
      return true;
    }
    if (job.status === "queued") return this._reconcileQueued(job);
    if (job.status === "transcribing") return this._reconcileTranscribing(job);
    return false;
  },

  /**
   * A recovery step threw. 404 means the Recall object is gone — terminal.
   * Otherwise apply the 24h give-up (API errors must not defer it forever),
   * and touch the row so it rotates to the back of the sweep window.
   */
  async _reconcileError(job: JobRow, err: unknown): Promise<boolean> {
    const message = (err as Error).message ?? String(err);
    if ((err as { status?: number }).status === 404) {
      await this._fail(
        job.id,
        `Recall no longer knows this recording: ${message}`,
      );
      return true;
    }
    if (this._pastGiveUp(job)) {
      await this._fail(
        job.id,
        `still stuck 24 hours after the meeting start (last error: ${message})`,
      );
      return true;
    }
    log(`reconcile failed for job ${job.id}: ${message}`);
    await this._update(job.id, {});
    return false;
  },

  /** A queued row: the recording.done event (or the whole bot lifecycle) was lost. */
  async _reconcileQueued(job: JobRow): Promise<boolean> {
    // While the meeting looks alive, only probe after a long quiet period so
    // the sweep doesn't hammer the Recall API for every in-progress meeting.
    const ended = !!job.bot_status && BOT_ENDED_STATUSES.includes(job.bot_status);
    const quietMs = Date.now() - new Date(job.updatedAt).getTime();
    if (!ended && quietMs < RECONCILE_PROBE_QUIET_MS) return false;

    const bot = await recallClient.retrieveBot(job.recall_bot_id as string);
    const code = bot?.status_changes?.at(-1)?.code ?? null;

    if (code === "fatal") {
      await this._fail(job.id, "bot fatal (recovered by reconciliation)");
      return true;
    }

    const recording = bot?.recordings?.[0] ?? null;
    if (recording?.id) {
      // Only a COMPLETED recording may be driven to transcription: a long
      // live meeting has an in-progress recording here, and transcribing it
      // now would permanently fail the job.
      const readiness = await this._recordingReadiness(recording);
      if (readiness === "failed") {
        await this._fail(job.id, "recording failed (found by reconciliation)");
        return true;
      }
      if (readiness === "done") {
        log(`reconcile: driving lost recording.done for job ${job.id}`);
        await this._onRecordingDone(job.id, recording.id);
        return true;
      }
      // Still processing: fall through to the touch/wait branch.
    } else if (code === "done") {
      // Terminal bot state, nothing recorded: e.g. nobody admitted the bot.
      await this._fail(job.id, "bot finished without a recording");
      return true;
    }
    if (this._pastGiveUp(job)) {
      await this._fail(
        job.id,
        "no recording within 24 hours of the meeting start",
      );
      return true;
    }
    // Meeting still running (or Recall still uploading): sync the bot status
    // and bump updatedAt so the next probe waits another quiet period.
    await this._update(
      job.id,
      code && code !== job.bot_status ? { bot_status: code } : {},
    );
    return false;
  },

  /** Whether a recording is safe to transcribe, checking the full recording
   *  object when the bot payload carries no status. */
  async _recordingReadiness(recording: {
    id: string;
    status?: { code?: string | null } | null;
    completed_at?: string | null;
  }): Promise<"done" | "failed" | "processing"> {
    const codeOf = (c: string | null | undefined) =>
      c === "done" ? "done" : c === "failed" ? "failed" : c ? "processing" : null;
    const fromBot = codeOf(recording.status?.code);
    if (fromBot) return fromBot;
    if (recording.completed_at) return "done";
    const full = await recallClient.retrieveRecording(recording.id);
    const fromFull = codeOf(full?.status?.code);
    if (fromFull) return fromFull;
    return full?.completed_at || recordingDurationSeconds(full) != null
      ? "done"
      : "processing";
  },

  /**
   * A transcribing row: transcript.done was lost, or the original
   * recording.done handling crashed between the status claim and
   * createAsyncTranscript (in which case Recall was never asked to
   * transcribe and no transcript.* event will ever arrive).
   */
  async _reconcileTranscribing(job: JobRow): Promise<boolean> {
    // Recover the recording id if its write was lost mid-flight. Not
    // persisted here — it rides along on the reissue claim below, so the
    // row's updatedAt stays stale until the claim itself.
    let recordingId = job.recall_recording_id;
    if (!recordingId && !job.recall_transcript_id) {
      const bot = await recallClient.retrieveBot(job.recall_bot_id as string);
      recordingId = bot?.recordings?.[0]?.id ?? null;
    }

    // Recover the transcript id: from the recording's media shortcuts when
    // createAsyncTranscript succeeded but its id write was lost, or by issuing
    // the createAsyncTranscript a crash skipped.
    let transcriptId = job.recall_transcript_id;
    if (!transcriptId) {
      if (!recordingId) return this._transcribingNotReady(job);
      const rec = await recallClient.retrieveRecording(recordingId);
      const shortcut = rec?.media_shortcuts?.transcript;
      if (shortcut?.id) {
        transcriptId = shortcut.id;
        await this._update(job.id, {
          recall_recording_id: recordingId,
          recall_transcript_id: transcriptId,
        });
      } else {
        // Claim the reissue atomically: another app instance sweeping the
        // same row bumps updatedAt first, so only one createAsyncTranscript
        // (a paid operation) is ever sent.
        const { db } = await postgresClient();
        const claimed = await db(TABLE)
          .where({ id: job.id, status: "transcribing" })
          .whereNull("recall_transcript_id")
          .where("updatedAt", "<", new Date(Date.now() - RECONCILE_STALE_MS))
          .update({ recall_recording_id: recordingId, updatedAt: new Date() });
        if (!claimed) return false;
        log(
          `reconcile: re-requesting transcript for job ${job.id} ` +
            `(lost before createAsyncTranscript)`,
        );
        const transcript = await recallClient.createAsyncTranscript(
          recordingId,
          job.language || "auto",
        );
        await this._update(job.id, {
          recall_transcript_id: transcript.id ?? null,
        });
        return true;
      }
    }

    // Transcript known: complete the lost transcript.done once it's ready,
    // or fail fast when Recall reports the transcript itself failed.
    const transcript = await recallClient.retrieveTranscript(transcriptId);
    const transcriptCode = transcript?.status?.code ?? null;
    if (transcriptCode === "error" || transcriptCode === "failed") {
      await this._fail(
        job.id,
        `transcript failed at Recall: ${transcript?.status?.sub_code || transcriptCode}`,
      );
      return true;
    }
    if (transcript?.data?.download_url) {
      log(`reconcile: driving lost transcript.done for job ${job.id}`);
      await this._onTranscriptDone(job.id, transcriptId, recordingId);
      return true;
    }
    return this._transcribingNotReady(job);
  },

  /** Transcript not ready yet: wait (touch) or give up after the hard cap. */
  async _transcribingNotReady(job: JobRow): Promise<boolean> {
    if (this._pastGiveUp(job)) {
      await this._fail(
        job.id,
        "transcript was not ready within 24 hours of the meeting start",
      );
      return true;
    }
    await this._update(job.id, {});
    return false;
  },

  _pastGiveUp(job: JobRow): boolean {
    const startedAt = new Date(job.join_at ?? job.createdAt).getTime();
    return (
      Number.isFinite(startedAt) && Date.now() - startedAt > RECONCILE_GIVE_UP_MS
    );
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
  language: string | null;
  raw_segments: RawSegment[] | null;
  speakers: SpeakerMap | null;
  post_processing_prompts: PostProcessingPrompt[] | null;
  post_processing_outputs: PostProcessingOutput[] | null;
  created_by: number;
  join_at: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
