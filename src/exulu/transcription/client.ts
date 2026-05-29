/**
 * HTTP client for the standalone whisper server.
 *
 * Reads TRANSCRIPTION_SERVER from the environment. Throws a typed
 * TranscriptionServerUnavailable error when the env var is unset or the
 * server is unreachable, so callers can give the user an actionable message.
 */

import type { RawSegment } from "./transcript-text";

export class TranscriptionServerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionServerUnavailable";
  }
}

const getBaseUrl = (): string => {
  const url = process.env.TRANSCRIPTION_SERVER;
  if (!url) {
    throw new TranscriptionServerUnavailable(
      "TRANSCRIPTION_SERVER env var is not set. Start a whisper server with " +
        "`npx @exulu/backend exulu-start-whisper` and point TRANSCRIPTION_SERVER at it.",
    );
  }
  return url.replace(/\/$/, "");
};

type WhisperStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WhisperJob = {
  job_id: string;
  status: WhisperStatus;
  started_at: number | null;
  finished_at: number | null;
  segments: RawSegment[] | null;
  language: string | null;
  duration_seconds: number | null;
  error: string | null;
};

export type SubmitJobOptions = {
  audio_url: string;
  language?: string;
  num_speakers?: number;
  hotwords?: string[];
};

export type HealthResponse = {
  ok: boolean;
  device: string;
  model: string;
  gpu: {
    available: boolean;
    kind: "cuda" | "mps" | "cpu";
    name: string | null;
    vram_gb: number | null;
  };
  diarization: boolean;
};

const request = async <T>(
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  const url = `${getBaseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new TranscriptionServerUnavailable(
      `Unable to reach whisper server at ${url}: ${(err as Error).message}`,
    );
  }
  if (res.status === 404) {
    // Surface as a specific error so the polling loop can map it to
    // "job lost on server restart" without confusing it with a network outage.
    const err = new Error(`whisper server returned 404 for ${path}`);
    (err as Error & { code: string }).code = "JOB_NOT_FOUND";
    throw err;
  }
  if (!res.ok) {
    throw new Error(
      `whisper server returned ${res.status} for ${path}: ${await res.text()}`,
    );
  }
  return (await res.json()) as T;
};

export const transcriptionClient = {
  submitJob: (opts: SubmitJobOptions) =>
    request<{ job_id: string; status: WhisperStatus }>("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    }),

  getJob: (jobId: string) => request<WhisperJob>(`/jobs/${jobId}`),

  cancelJob: (jobId: string) =>
    request<{ job_id: string; status: WhisperStatus }>(`/jobs/${jobId}`, {
      method: "DELETE",
    }),

  health: () => request<HealthResponse>("/healthz"),

  isConfigured: (): boolean => Boolean(process.env.TRANSCRIPTION_SERVER),
};
