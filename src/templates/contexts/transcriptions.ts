import { ExuluContext } from "@SRC/exulu/context";

/**
 * Built-in ExuluContext for storing diarized audio transcripts produced by
 * the transcription feature. Registered in ExuluApp.create() ahead of any
 * user-defined contexts, so it's always available even when consumers of
 * @exulu/backend don't declare a transcriptions context themselves.
 *
 * Design doc: docs/superpowers/specs/2026-05-28-transcription-feature-design.md
 */
export const transcriptionsContext = new ExuluContext({
  id: "transcriptions",
  name: "Transcriptions",
  description: "Diarized audio transcripts",
  fields: [
    { name: "transcript_text", type: "longText", editable: true },
    { name: "audio", type: "file" },
    { name: "language", type: "text" },
    { name: "duration_seconds", type: "number" },
    { name: "speakers", type: "json" },
    { name: "raw_segments", type: "json", editable: false },
    { name: "corrected_segments", type: "json", editable: false },
    // Post-processing results carried from the transcription job at finalize:
    // [{ prompt_id, agent_id, prompt_name, output, ran_at }]. Recall meeting
    // transcripts only for now.
    { name: "post_processing", type: "json", editable: false },
    // Link back to the Recall recording so the mixed video stays reachable
    // (resolve a fresh URL via ExuluRecall.getRecordingVideoUrl — it expires
    // after six hours). Null for Whisper uploads.
    { name: "recall_recording_id", type: "text" },
    // Permanent local copy of the mixed video, present only when
    // RECALL_STORE_VIDEO_LOCALLY=true was set at recording time.
    { name: "video", type: "file" },
    // Denormalised for the Transcripts home list (spec 2026-09-29 §2.1): the
    // list renders thousands of rows and must not parse raw_segments or join
    // projects per row. NOT named `source` —
    // convertContextToTableDefinition already injects a `source` column
    // (the ingestion source) on every context.
    { name: "recording_source", type: "text", index: true },
    // Back-link to the transcription_jobs row (audio, video, re-review).
    { name: "job_id", type: "uuid" },
    // When the recording happened, not when the item was last touched —
    // the home groups This week / Earlier on this.
    { name: "recorded_at", type: "date", index: true },
    { name: "speaker_count", type: "number" },
    // Read-side copy; projects.project_items stays the source of truth.
    { name: "project_id", type: "uuid", index: true },
  ],
  sources: [],
  active: true,
  configuration: {
    calculateVectors: "onInsert",
    defaultRightsMode: "private",
  },
});
