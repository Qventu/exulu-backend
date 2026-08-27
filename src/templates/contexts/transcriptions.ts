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
    // Post-processing results carried from the transcription job at finalize:
    // [{ prompt_id, agent_id, prompt_name, output, ran_at }]. Recall meeting
    // transcripts only for now.
    { name: "post_processing", type: "json", editable: false },
    // Link back to the Recall recording so the mixed video stays reachable
    // (resolve a fresh URL via ExuluRecall.getRecordingVideoUrl — it expires
    // after six hours). Null for Whisper uploads.
    { name: "recall_recording_id", type: "text" },
  ],
  sources: [],
  active: true,
  configuration: {
    calculateVectors: "onInsert",
    defaultRightsMode: "private",
  },
});
