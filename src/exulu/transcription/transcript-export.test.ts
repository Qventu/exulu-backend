import { buildTranscriptMarkdown, type TranscriptExportItem } from "./transcript-export";

const item = (over: Partial<TranscriptExportItem> = {}): TranscriptExportItem => ({
  name: "Kick-off Comfort-Line",
  recording_source: "recall",
  recorded_at: "2026-09-10T09:00:00.000Z",
  duration_seconds: 3494,
  language: "de",
  speakers: { SPEAKER_00: "Anja Keller", SPEAKER_01: "Marco Schulz" },
  raw_segments: [
    { start: 1278, end: 1299, text: "Then let's fix the dates.", speaker: "SPEAKER_00" },
    { start: 1300, end: 1324, text: "Week 46 works for us.", speaker: "SPEAKER_01" },
  ],
  corrected_segments: null,
  post_processing: [
    { prompt_name: "Meeting summary", status: "done", output: "The team agreed the scope." },
  ],
  ...over,
});

const all = { summary: true, timestamps: true, speakers: true };

describe("buildTranscriptMarkdown", () => {
  it("opens with the title as an H1", () => {
    expect(buildTranscriptMarkdown(item(), all)).toMatch(/^# Kick-off Comfort-Line\n/);
  });

  it("includes the summary section when summary is on", () => {
    const md = buildTranscriptMarkdown(item(), all);
    expect(md).toContain("## Meeting summary");
    expect(md).toContain("The team agreed the scope.");
  });

  it("omits the summary section when summary is off", () => {
    const md = buildTranscriptMarkdown(item(), { ...all, summary: false });
    expect(md).not.toContain("Meeting summary");
    expect(md).toContain("Then let's fix the dates.");
  });

  it("skips failed post-processing outputs rather than printing the error", () => {
    const md = buildTranscriptMarkdown(
      item({ post_processing: [{ prompt_name: "Summary", status: "failed", output: null }] }),
      all,
    );
    expect(md).not.toContain("Summary");
  });

  it("renders a block as bold speaker, bracketed time, then text", () => {
    expect(buildTranscriptMarkdown(item(), all)).toContain(
      "**Anja Keller** [21:18]\n\nThen let's fix the dates.",
    );
  });

  it("drops the timestamp when timestamps are off", () => {
    const md = buildTranscriptMarkdown(item(), { ...all, timestamps: false });
    expect(md).toContain("**Anja Keller**\n\nThen let's fix the dates.");
    expect(md).not.toContain("[21:18]");
  });

  it("falls back to raw labels when speaker names are off", () => {
    const md = buildTranscriptMarkdown(item(), { ...all, speakers: false });
    expect(md).toContain("**SPEAKER_00**");
    expect(md).not.toContain("Anja Keller");
  });

  it("prefers corrected segments over raw", () => {
    const md = buildTranscriptMarkdown(
      item({
        corrected_segments: [
          { start: 1278, end: 1299, text: "Then let us fix the dates.", speaker: "SPEAKER_00" },
        ],
      }),
      all,
    );
    expect(md).toContain("Then let us fix the dates.");
    expect(md).not.toContain("Then let's fix the dates.");
  });

  it("produces a valid document for a transcript with no segments and no summary", () => {
    const md = buildTranscriptMarkdown(
      item({ raw_segments: [], corrected_segments: null, post_processing: null }),
      all,
    );
    expect(md).toMatch(/^# Kick-off Comfort-Line\n/);
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("null");
  });

  it("names an untitled transcript rather than emitting an empty heading", () => {
    const md = buildTranscriptMarkdown(item({ name: null }), all);
    expect(md).toMatch(/^# Transcript\n/);
  });
});
