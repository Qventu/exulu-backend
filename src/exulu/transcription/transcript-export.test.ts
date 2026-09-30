import {
  buildTranscriptMarkdown,
  buildTranscriptCsv,
  buildTranscriptSrt,
  type TranscriptExportItem,
} from "./transcript-export";

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

  it("collapses consecutive same-speaker segments and keeps the first start time", () => {
    // Guards toBlocks: a regression that overwrote `start` during the merge,
    // or failed to merge at all, would duplicate speaker headings in every
    // exported document.
    const md = buildTranscriptMarkdown(
      item({
        raw_segments: [
          { start: 60, end: 65, text: "One.", speaker: "SPEAKER_00" },
          { start: 65, end: 70, text: "Two.", speaker: "SPEAKER_00" },
          { start: 71, end: 75, text: "Three.", speaker: "SPEAKER_01" },
        ],
      }),
      all,
    );
    expect(md).toContain("**Anja Keller** [01:00]\n\nOne. Two.");
    expect(md).not.toContain("[01:05]");
    expect(md).toContain("**Marco Schulz** [01:11]\n\nThree.");
  });
});

describe("buildTranscriptCsv", () => {
  it("writes a header row and hh:mm:ss times", () => {
    const lines = buildTranscriptCsv(item(), all).trimEnd().split("\n");
    expect(lines[0]).toBe("start,end,speaker,text");
    expect(lines[1]).toBe(
      '00:21:18,00:21:39,Anja Keller,"Then let\'s fix the dates."',
    );
  });

  it("escapes a quote, a comma and a newline so the row stays four columns", () => {
    // RFC 4180: double the quote, wrap the field. A naive join would turn
    // this one segment into three broken rows.
    const csv = buildTranscriptCsv(
      item({
        raw_segments: [
          {
            start: 0,
            end: 1,
            text: 'He said "yes, absolutely".\nThen he left.',
            speaker: "SPEAKER_00",
          },
        ],
      }),
      all,
    );
    const body = csv.trimEnd().split("\n").slice(1).join("\n");
    expect(body).toBe(
      '00:00:00,00:00:01,Anja Keller,"He said ""yes, absolutely"".\nThen he left."',
    );
  });

  it("drops the time columns when timestamps are off", () => {
    const lines = buildTranscriptCsv(item(), { ...all, timestamps: false })
      .trimEnd()
      .split("\n");
    expect(lines[0]).toBe("speaker,text");
  });

  it("falls back to raw labels when speaker names are off", () => {
    expect(buildTranscriptCsv(item(), { ...all, speakers: false })).toContain("SPEAKER_00");
  });

  it("emits a header-only file for a transcript with no segments", () => {
    const csv = buildTranscriptCsv(item({ raw_segments: [], corrected_segments: null }), all);
    expect(csv).toBe("start,end,speaker,text\n");
  });

  it("quotes a speaker name that itself contains a comma", () => {
    // The speaker cell only escapes conditionally (unlike the text cell,
    // which is always quoted) — an earlier fix touched this exact path with
    // no test guarding it.
    const csv = buildTranscriptCsv(
      item({
        speakers: { SPEAKER_00: "Keller, Anja" },
        raw_segments: [{ start: 0, end: 1, text: "Hi", speaker: "SPEAKER_00" }],
      }),
      all,
    );
    const body = csv.trimEnd().split("\n").slice(1).join("\n");
    expect(body).toBe('00:00:00,00:00:01,"Keller, Anja","Hi"');
  });

  it("doubles a double quote inside a speaker name", () => {
    const csv = buildTranscriptCsv(
      item({
        speakers: { SPEAKER_00: 'Anja "AJ" Keller' },
        raw_segments: [{ start: 0, end: 1, text: "Hi", speaker: "SPEAKER_00" }],
      }),
      all,
    );
    const body = csv.trimEnd().split("\n").slice(1).join("\n");
    expect(body).toBe('00:00:00,00:00:01,"Anja ""AJ"" Keller","Hi"');
  });
});

describe("buildTranscriptSrt", () => {
  it("numbers cues from 1 and uses comma-separated milliseconds", () => {
    expect(buildTranscriptSrt(item(), all)).toBe(
      "1\n00:21:18,000 --> 00:21:39,000\nAnja Keller: Then let's fix the dates.\n\n" +
        "2\n00:21:40,000 --> 00:22:04,000\nMarco Schulz: Week 46 works for us.\n",
    );
  });

  it("keeps fractional seconds as milliseconds", () => {
    const srt = buildTranscriptSrt(
      item({
        raw_segments: [{ start: 1.25, end: 2.5, text: "Hi", speaker: "SPEAKER_00" }],
      }),
      all,
    );
    expect(srt).toContain("00:00:01,250 --> 00:00:02,500");
  });

  it("omits the speaker prefix when speaker names are off and labels are raw", () => {
    const srt = buildTranscriptSrt(item(), { ...all, speakers: false });
    expect(srt).toContain("SPEAKER_00: Then let's fix the dates.");
  });

  it("returns an empty string for a transcript with no segments", () => {
    expect(buildTranscriptSrt(item({ raw_segments: [], corrected_segments: null }), all)).toBe("");
  });

  it("rounds a millisecond value that would otherwise reach 1000 into the next second", () => {
    // 5.9996s's fractional part alone rounds to 1000ms, which is not a valid
    // SRT millisecond field — it must carry into the seconds place instead.
    const srt = buildTranscriptSrt(
      item({
        raw_segments: [{ start: 5.9996, end: 6.1, text: "Hi", speaker: "SPEAKER_00" }],
      }),
      all,
    );
    expect(srt).toContain("00:00:06,000 --> 00:00:06,100");
    expect(srt).not.toContain(",1000");
  });

  it("carries a rounding-boundary millisecond value across a minute boundary", () => {
    const srt = buildTranscriptSrt(
      item({
        raw_segments: [{ start: 59.9999, end: 61, text: "Hi", speaker: "SPEAKER_00" }],
      }),
      all,
    );
    expect(srt).toContain("00:01:00,000 --> 00:01:01,000");
  });
});
