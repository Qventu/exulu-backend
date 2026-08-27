/**
 * HTTP client for the Recall.ai API.
 *
 * Every request goes through fetch_with_retry, which honors the retry contract
 * from RECALL-AI.AGENT.md §"Handling retryable status codes":
 *   - 429 → wait Retry-After seconds
 *   - 503 → wait ~10s
 *   - 507 → wait ~30s
 * all with added jitter and a capped number of attempts.
 *
 * Auth uses the raw API key in the Authorization header, exactly as the Recall
 * docs show (`Authorization: RECALL_API_KEY`).
 *
 * Design doc: docs/superpowers/specs/2026-06-19-recall-meeting-recording-design.md
 */

import {
  recallApiBaseUrl,
  recallApiKey,
  assertRecallConfigured,
} from "./env";

export class RecallApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
    this.name = "RecallApiError";
  }
}

const jitterMs = () => 1000 * Math.ceil(Math.random() * 5);

// Per-attempt fetch budgets: a hung connection must not strand the recall
// state machine (a stalled transcript download used to freeze a job in
// "transcribing" forever). API JSON calls are small; the transcript download
// from S3 can be many MB.
export const API_TIMEOUT_MS = 60_000;
export const DOWNLOAD_TIMEOUT_MS = 300_000;

/**
 * fetch with retry on Recall's transient status codes. Mirrors the reference
 * implementation in RECALL-AI.AGENT.md. Transport-level failures (network
 * errors, per-attempt timeouts) retry ONLY when the caller opts in: a
 * timed-out non-idempotent POST may have been processed server-side, and
 * re-sending it would create a duplicate bot / duplicate paid transcript.
 */
export async function fetch_with_retry(args: {
  url: string;
  options: RequestInit;
  max_attempts?: number;
  /** Per-attempt timeout; every attempt gets a fresh abort budget. */
  timeout_ms?: number;
  /** Retry rejected fetches too — safe for idempotent requests only. */
  retry_on_reject?: boolean;
}): Promise<Response> {
  const { url, options, max_attempts = 6, timeout_ms, retry_on_reject } = args;
  for (let attempt = 1; attempt <= max_attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(
        url,
        timeout_ms
          ? { ...options, signal: AbortSignal.timeout(timeout_ms) }
          : options,
      );
    } catch (err) {
      if (!retry_on_reject || attempt === max_attempts) throw err;
      console.log(
        `[EXULU-RECALL] fetch error from ${url} (${(err as Error).message}); ` +
          `retrying in ~5s (attempt ${attempt}/${max_attempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000 + jitterMs()));
      continue;
    }
    let wait_for: number | null = null;
    switch (response.status) {
      case 429:
        wait_for = parseInt(response.headers.get("Retry-After") || "0", 10);
        break;
      case 503:
        wait_for = 10;
        break;
      case 507:
        wait_for = 30;
        break;
    }
    if (wait_for) {
      console.log(
        `[EXULU-RECALL] retryable ${response.status} from ${url}; retrying in ~${wait_for}s (attempt ${attempt}/${max_attempts})`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * wait_for + jitterMs()),
      );
      continue;
    }
    return response;
  }
  throw new Error(
    `[EXULU-RECALL] Max attempts (${max_attempts}) reached while fetching ${url}.`,
  );
}

/** Authenticated JSON request against the region-scoped Recall API. */
const request = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  assertRecallConfigured();
  const url = `${recallApiBaseUrl()}${path}`;
  const response = await fetch_with_retry({
    url,
    options: {
      ...init,
      headers: {
        Authorization: recallApiKey() as string,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    },
    timeout_ms: API_TIMEOUT_MS,
    retry_on_reject: (init.method ?? "GET").toUpperCase() === "GET",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new RecallApiError(
      `Recall API ${response.status} for ${path}: ${body}`,
      response.status,
      body,
    );
  }
  // DELETE / 204 responses may have no JSON body.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
};

export type CreateBotInput = {
  meeting_url: string;
  /** ISO8601. Always passed (= now for "join immediately"). */
  join_at: string;
  bot_name?: string;
  /** Optional "this meeting is being recorded" chat notice. */
  notifyChat?: { message: string };
};

/** Mixed video artifact. `data.download_url` is a signed S3 URL valid ~6h. */
export type RecallVideoMixed = {
  id?: string;
  format?: string | null;
  status?: { code?: string | null } | null;
  data?: { download_url?: string };
};

export type RecallBot = {
  id: string;
  status_changes?: { code: string }[];
  recordings?: {
    id: string;
    /** Recording lifecycle: "processing" | "done" | "failed". */
    status?: { code?: string | null } | null;
    completed_at?: string | null;
    media_shortcuts?: {
      transcript?: { id: string; data?: { download_url?: string } };
      video_mixed?: RecallVideoMixed;
    };
  }[];
};

export type RecallTranscript = {
  id: string;
  /** Transcript lifecycle: "processing" | "done" | "error". */
  status?: { code?: string | null; sub_code?: string | null } | null;
  data?: { download_url?: string };
  metadata?: Record<string, unknown>;
};

export type RecallRecording = {
  id: string;
  /** Recording lifecycle: "processing" | "done" | "failed". */
  status?: { code?: string | null } | null;
  /** ISO8601 timestamps bounding the recording (authoritative duration source). */
  started_at?: string | null;
  completed_at?: string | null;
  /** Some payloads expose a numeric duration (seconds) directly. */
  duration?: number | null;
  media_shortcuts?: {
    transcript?: { id: string; data?: { download_url?: string } };
    video_mixed?: RecallVideoMixed;
  };
};

/**
 * Authoritative recording length in seconds from a Recall recording object:
 * a numeric `duration` if present, else completed_at − started_at. Returns null
 * when neither is available (caller falls back to the transcript span).
 */
export const recordingDurationSeconds = (
  rec: RecallRecording | null | undefined,
): number | null => {
  if (!rec) return null;
  if (typeof rec.duration === "number" && rec.duration > 0) return rec.duration;
  if (rec.started_at && rec.completed_at) {
    const start = Date.parse(rec.started_at);
    const end = Date.parse(rec.completed_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return (end - start) / 1000;
    }
  }
  return null;
};

export const recallClient = {
  isConfigured: (): boolean =>
    !!recallApiKey() && !!process.env.RECALL_REGION,

  /** POST /bot — schedule/launch a bot for a meeting. */
  createBot: (input: CreateBotInput): Promise<RecallBot> =>
    request<RecallBot>("/bot/", {
      method: "POST",
      body: JSON.stringify({
        meeting_url: input.meeting_url,
        join_at: input.join_at,
        ...(input.bot_name ? { bot_name: input.bot_name } : {}),
        ...(input.notifyChat
          ? {
              chat: {
                on_bot_join: {
                  send_to: "everyone",
                  message: input.notifyChat.message,
                  pin: true,
                },
              },
            }
          : {}),
      }),
    }),

  /**
   * POST /recording/{id}/create_transcript — start a post-meeting (async)
   * transcript with Recall.ai Transcription, auto language + separate-stream
   * diarization.
   */
  createAsyncTranscript: (
    recordingId: string,
    languageCode: string = "auto",
  ): Promise<RecallTranscript> =>
    request<RecallTranscript>(
      `/recording/${recordingId}/create_transcript/`,
      {
        method: "POST",
        body: JSON.stringify({
          provider: {
            recallai_async: { language_code: languageCode || "auto" },
          },
          diarization: { use_separate_streams_when_available: true },
        }),
      },
    ),

  retrieveTranscript: (transcriptId: string): Promise<RecallTranscript> =>
    request<RecallTranscript>(`/transcript/${transcriptId}/`),

  retrieveRecording: (recordingId: string): Promise<RecallRecording> =>
    request<RecallRecording>(`/recording/${recordingId}/`),

  retrieveBot: (botId: string): Promise<RecallBot> =>
    request<RecallBot>(`/bot/${botId}/`),

  /**
   * Download the transcript JSON from a signed S3 URL. This is not a Recall API
   * endpoint (no auth header), but we still retry transient failures.
   */
  downloadTranscript: async (downloadUrl: string): Promise<unknown> => {
    const response = await fetch_with_retry({
      url: downloadUrl,
      options: { method: "GET" },
      timeout_ms: DOWNLOAD_TIMEOUT_MS,
      retry_on_reject: true,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new RecallApiError(
        `Failed to download transcript (${response.status}): ${body}`,
        response.status,
        body,
      );
    }
    return response.json();
  },
};
