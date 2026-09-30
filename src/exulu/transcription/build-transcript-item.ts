import type { Item } from "@EXULU_TYPES/models/item";
import type { ExuluRightsMode } from "@EXULU_TYPES/rbac-rights-modes";

/**
 * Shapes a finalized transcription job into the knowledge item that gets
 * written to the transcriptions context.
 *
 * Pure on purpose: finalize needs a live db and the app singleton, so this is
 * the only part of the save path a unit test can reach.
 */
export const buildTranscriptItemInput = ({
  row,
  title,
  speakers,
  transcriptText,
  rightsMode,
  isReSave,
}: {
  row: any;
  title?: string;
  speakers: unknown;
  transcriptText: string;
  rightsMode: ExuluRightsMode;
  isReSave: boolean;
}): Item => ({
  // Carrying the id on re-save makes context.createItem upsert in place.
  ...(isReSave && row.saved_item_id ? { id: row.saved_item_id } : {}),
  name: title ?? row.title ?? "Transcript",
  transcript_text: transcriptText,
  audio_s3key: row.audio_s3key,
  language: row.language ?? undefined,
  duration_seconds: row.duration_seconds ?? undefined,
  speakers,
  raw_segments: row.raw_segments,
  corrected_segments: row.corrected_segments ?? undefined,
  // Recall meeting-bot post-processing results (null for Whisper jobs).
  post_processing: row.post_processing_outputs ?? undefined,
  // Handle for the meeting video; null for Whisper uploads.
  recall_recording_id: row.recall_recording_id ?? undefined,
  // Permanent local copy of the video, only present when
  // RECALL_STORE_VIDEO_LOCALLY was on at recording time.
  video_s3key: row.video_s3key ?? undefined,
  rights_mode: rightsMode,
  created_by: row.created_by,
  // Denormalised list columns (spec §2.1).
  recording_source: row.source ?? "whisper",
  job_id: row.id,
  recorded_at: row.join_at ?? row.createdAt,
  speaker_count: new Set(
    (row.raw_segments ?? []).map((segment: { speaker: string }) => segment.speaker),
  ).size,
  project_id: row.project_id ?? undefined,
});
