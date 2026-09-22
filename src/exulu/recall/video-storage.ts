/**
 * Permanent local copy of a Recall meeting's mixed video — the "Option 1"
 * half of the configurable video-retention feature (recallStoreVideoLocally
 * in ./env). Downloads the signed URL Recall hands back and re-uploads the
 * bytes into this deployment's own S3, so the video outlives Recall's own
 * retention window (RECALL_RECORDING_RETENTION_HOURS) instead of expiring
 * with it.
 */
import { uploadFile } from "@SRC/uppy";
import type { ExuluConfig } from "@SRC/exulu/app";
import type { RecallRecording } from "./client";

/**
 * Download the recording's mixed MP4 (if Recall has one ready) and store it
 * under this deployment's own S3, returning the resulting key. Returns null
 * when there is no usable video artifact yet (no video_mixed shortcut, or
 * still processing) — mirrors the readiness check in
 * RecallService.getRecordingVideoUrl. Throws if the download itself fails,
 * so the caller's existing retry/fail handling applies.
 */
export async function downloadAndStoreRecordingVideo(
  recording: RecallRecording,
  jobId: string,
  config: ExuluConfig,
): Promise<string | null> {
  const video = recording.media_shortcuts?.video_mixed;
  const url = video?.data?.download_url;
  if (!url) return null;
  // Absent status means the artifact predates status reporting; treat as ready.
  if (video.status?.code && video.status.code !== "done") return null;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`video download failed for job ${jobId}: HTTP ${res.status}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());

  return uploadFile(
    bytes,
    `recall-videos/${jobId}.mp4`,
    config,
    { contentType: "video/mp4" },
    undefined,
    undefined,
    true, // global: this is a system-stored artifact, not scoped to an uploading user.
  );
}
