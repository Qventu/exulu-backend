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
  // Recall meeting-bot post-processing results (null for Whisper jobs).
  post_processing: row.post_processing_outputs ?? undefined,
  // Handle for the meeting video; null for Whisper uploads.
  recall_recording_id: row.recall_recording_id ?? undefined,
  rights_mode: rightsMode,
  created_by: row.created_by,
});
