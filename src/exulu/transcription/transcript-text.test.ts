import { renderTranscript, type RawSegment } from "./transcript-text";

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
