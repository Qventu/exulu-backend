import { buildTranscriptItemInput } from "./build-transcript-item";

const row = (over: Partial<any> = {}): any => ({
  id: "job-1",
  audio_s3key: "bucket/audio.webm",
  title: "Stored title",
  status: "awaiting_review",
  raw_segments: [{ start: 0, end: 1, text: "hi", speaker: "SPEAKER_00" }],
  language: "de",
  duration_seconds: 1860,
  saved_item_id: null,
  created_by: 7,
  recall_recording_id: null,
  post_processing_outputs: null,
  ...over,
});

const args = (over: Partial<any> = {}) => ({
  row: row(),
  title: undefined,
  speakers: { SPEAKER_00: "Jörg" },
  transcriptText: "Jörg: hi",
  rightsMode: "private" as const,
  isReSave: false,
  ...over,
});

describe("buildTranscriptItemInput", () => {
  it("carries recall_recording_id through so the video stays reachable", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ recall_recording_id: "rec-9" }) }),
    );
    expect(item.recall_recording_id).toBe("rec-9");
  });

  it("omits recall_recording_id for a whisper upload", () => {
    const item = buildTranscriptItemInput(args());
    expect(item.recall_recording_id).toBeUndefined();
  });

  it("carries the id on re-save too", () => {
    const item = buildTranscriptItemInput(
      args({
        row: row({ recall_recording_id: "rec-9", saved_item_id: "item-1", status: "saved" }),
        isReSave: true,
      }),
    );
    expect(item.id).toBe("item-1");
    expect(item.recall_recording_id).toBe("rec-9");
  });

  it("prefers an explicit title over the stored one", () => {
    expect(buildTranscriptItemInput(args({ title: "New title" })).name).toBe("New title");
    expect(buildTranscriptItemInput(args()).name).toBe("Stored title");
  });

  it("falls back to 'Transcript' when no title exists anywhere", () => {
    expect(buildTranscriptItemInput(args({ row: row({ title: null }) })).name).toBe(
      "Transcript",
    );
  });

  it("omits the id on first save so createItem inserts", () => {
    expect(buildTranscriptItemInput(args()).id).toBeUndefined();
  });

  it("maps the remaining transcript fields", () => {
    const item = buildTranscriptItemInput(args());
    expect(item).toMatchObject({
      transcript_text: "Jörg: hi",
      audio_s3key: "bucket/audio.webm",
      language: "de",
      duration_seconds: 1860,
      rights_mode: "private",
      created_by: 7,
    });
  });
});
