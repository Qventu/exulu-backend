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
  video_s3key: null,
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

  it("carries video_s3key through when a local copy was stored", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ video_s3key: "bucket/recall-videos/job-1.mp4" }) }),
    );
    expect(item.video_s3key).toBe("bucket/recall-videos/job-1.mp4");
  });

  it("omits video_s3key when no local copy was stored", () => {
    const item = buildTranscriptItemInput(args());
    expect(item.video_s3key).toBeUndefined();
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

describe("buildTranscriptItemInput — denormalised list columns", () => {
  it("carries the pipeline source and the job id", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ id: "job-42", source: "recall" }) }),
    );
    expect(item.recording_source).toBe("recall");
    expect(item.job_id).toBe("job-42");
  });

  it("defaults the source to whisper when the row predates the column", () => {
    const item = buildTranscriptItemInput(args({ row: row({ source: null }) }));
    expect(item.recording_source).toBe("whisper");
  });

  it("uses join_at as recorded_at for a scheduled meeting", () => {
    const item = buildTranscriptItemInput(
      args({
        row: row({
          source: "recall",
          join_at: "2026-09-10T07:00:00.000Z",
          createdAt: "2026-09-10T09:31:00.000Z",
        }),
      }),
    );
    expect(item.recorded_at).toBe("2026-09-10T07:00:00.000Z");
  });

  it("falls back to the job's createdAt when there is no join_at", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ join_at: null, createdAt: "2026-09-21T12:00:00.000Z" }) }),
    );
    expect(item.recorded_at).toBe("2026-09-21T12:00:00.000Z");
  });

  it("counts distinct speaker labels, not segments", () => {
    const item = buildTranscriptItemInput(
      args({
        row: row({
          raw_segments: [
            { start: 0, end: 1, text: "a", speaker: "SPEAKER_00" },
            { start: 1, end: 2, text: "b", speaker: "SPEAKER_01" },
            { start: 2, end: 3, text: "c", speaker: "SPEAKER_00" },
          ],
        }),
      }),
    );
    expect(item.speaker_count).toBe(2);
  });

  it("reports zero speakers when there are no segments", () => {
    const item = buildTranscriptItemInput(args({ row: row({ raw_segments: [] }) }));
    expect(item.speaker_count).toBe(0);
  });

  it("carries the project id so the row meta and filter need no join", () => {
    const item = buildTranscriptItemInput(
      args({ row: row({ project_id: "proj-7" }) }),
    );
    expect(item.project_id).toBe("proj-7");
  });
});
