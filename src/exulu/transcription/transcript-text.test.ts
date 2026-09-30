import { effectiveSegments, formatClock, renderTranscript, type RawSegment } from "./transcript-text";

const seg = (start: number, end: number, text: string, speaker: string): RawSegment => ({
  start,
  end,
  text,
  speaker,
});

describe("renderTranscript", () => {
  it("returns an empty string when there are no segments", () => {
    expect(renderTranscript([], {})).toBe("");
  });

  it("labels segments with the rename map", () => {
    const out = renderTranscript(
      [
        seg(0, 1, "Hello", "SPEAKER_00"),
        seg(1, 2, "Hi there", "SPEAKER_01"),
      ],
      { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" },
    );
    expect(out).toBe("Daniel: Hello\nAlex: Hi there");
  });

  it("keeps the raw label when a speaker is not in the rename map", () => {
    const out = renderTranscript(
      [
        seg(0, 1, "Hi", "SPEAKER_00"),
        seg(1, 2, "Hello", "SPEAKER_01"),
      ],
      { SPEAKER_00: "Daniel" },
    );
    expect(out).toBe("Daniel: Hi\nSPEAKER_01: Hello");
  });

  it("collapses consecutive segments by the same (post-rename) speaker", () => {
    const out = renderTranscript(
      [
        seg(0, 1, "Hi.", "SPEAKER_00"),
        seg(1, 2, "How are you?", "SPEAKER_00"),
        seg(2, 3, "Fine.", "SPEAKER_01"),
      ],
      { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" },
    );
    expect(out).toBe("Daniel: Hi. How are you?\nAlex: Fine.");
  });

  it("collapses across rename collisions (two raw speakers renamed to the same name merge)", () => {
    const out = renderTranscript(
      [
        seg(0, 1, "A.", "SPEAKER_00"),
        seg(1, 2, "B.", "SPEAKER_01"),
      ],
      { SPEAKER_00: "Daniel", SPEAKER_01: "Daniel" },
    );
    expect(out).toBe("Daniel: A. B.");
  });

  it("skips empty/whitespace-only segments", () => {
    const out = renderTranscript(
      [
        seg(0, 1, "  ", "SPEAKER_00"),
        seg(1, 2, "Hi", "SPEAKER_00"),
        seg(2, 3, "", "SPEAKER_00"),
      ],
      { SPEAKER_00: "Daniel" },
    );
    expect(out).toBe("Daniel: Hi");
  });

  it("renders unknown speakers when diarization was disabled", () => {
    const out = renderTranscript(
      [
        seg(0, 1, "Hello world.", "unknown"),
        seg(1, 2, "How are you?", "unknown"),
      ],
      {},
    );
    expect(out).toBe("unknown: Hello world. How are you?");
  });

  it("trims surrounding whitespace from segment text", () => {
    const out = renderTranscript(
      [seg(0, 1, "  Hi  ", "SPEAKER_00")],
      { SPEAKER_00: "Daniel" },
    );
    expect(out).toBe("Daniel: Hi");
  });
});

describe("effectiveSegments", () => {
  const raw = [seg(0, 1, "raw one", "SPEAKER_00"), seg(1, 2, "raw two", "SPEAKER_01")];

  it("returns raw when there are no corrections", () => {
    expect(effectiveSegments(raw, null)).toEqual(raw);
    expect(effectiveSegments(raw, undefined)).toEqual(raw);
  });

  it("returns the corrected array verbatim, never zipped with raw", () => {
    // Shorter, longer and reordered corrections must all survive intact:
    // zipping by index would resurrect deleted text or drop added text.
    const shorter = [seg(0, 1, "fixed", "SPEAKER_00")];
    expect(effectiveSegments(raw, shorter)).toEqual(shorter);

    const longer = [...raw, seg(2, 3, "added", "SPEAKER_00")];
    expect(effectiveSegments(raw, longer)).toEqual(longer);

    const reordered = [raw[1], raw[0]];
    expect(effectiveSegments(raw, reordered)).toEqual(reordered);
  });

  it("prefers an empty corrected array over raw — the user deleted everything", () => {
    expect(effectiveSegments(raw, [])).toEqual([]);
  });

  it("returns an empty array when both are absent", () => {
    expect(effectiveSegments(null, null)).toEqual([]);
    expect(effectiveSegments(undefined, undefined)).toEqual([]);
  });
});

describe("formatClock", () => {
  it("renders mm:ss below an hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(9)).toBe("00:09");
    expect(formatClock(1278)).toBe("21:18");
  });

  it("renders h:mm:ss at and past an hour", () => {
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3661)).toBe("1:01:01");
  });

  it("floors fractional seconds and clamps negatives to zero", () => {
    expect(formatClock(9.87)).toBe("00:09");
    expect(formatClock(-5)).toBe("00:00");
  });
});

describe("renderTranscript with timestamps", () => {
  it("prefixes each block with its start time in brackets", () => {
    const out = renderTranscript(
      [seg(1278, 1299, "Then let's fix the dates.", "SPEAKER_00")],
      { SPEAKER_00: "Anja Keller" },
      { timestamps: true },
    );
    expect(out).toBe("Anja Keller [21:18]: Then let's fix the dates.");
  });

  it("uses the FIRST segment's time when consecutive segments collapse", () => {
    const out = renderTranscript(
      [
        seg(60, 65, "One.", "SPEAKER_00"),
        seg(65, 70, "Two.", "SPEAKER_00"),
      ],
      { SPEAKER_00: "Anja" },
      { timestamps: true },
    );
    expect(out).toBe("Anja [01:00]: One. Two.");
  });

  it("is off by default so existing callers are unchanged", () => {
    const out = renderTranscript([seg(1278, 1299, "Hi", "SPEAKER_00")], {});
    expect(out).toBe("SPEAKER_00: Hi");
  });
});
