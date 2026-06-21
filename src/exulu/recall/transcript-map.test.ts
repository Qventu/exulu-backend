import { mapRecallTranscript, durationFromSegments } from "./transcript-map";

const word = (text: string, start: number, end: number | null) => ({
  text,
  start_timestamp: { relative: start },
  end_timestamp: end == null ? null : { relative: end },
});

describe("mapRecallTranscript", () => {
  it("returns [] for non-array / empty input", () => {
    expect(mapRecallTranscript(null)).toEqual([]);
    expect(mapRecallTranscript(undefined)).toEqual([]);
    expect(mapRecallTranscript({})).toEqual([]);
    expect(mapRecallTranscript([])).toEqual([]);
  });

  it("maps an utterance to a RawSegment using the participant name", () => {
    const out = mapRecallTranscript([
      {
        participant: { id: 1, name: "Daniel" },
        words: [word("Hello", 0, 0.5), word("there", 0.5, 1)],
      },
    ]);
    expect(out).toEqual([
      { start: 0, end: 1, text: "Hello there", speaker: "Daniel" },
    ]);
  });

  it("falls back to email then Speaker <id> then unknown", () => {
    const out = mapRecallTranscript([
      { participant: { id: 2, email: "a@b.co" }, words: [word("a", 0, 1)] },
      { participant: { id: 3 }, words: [word("b", 1, 2)] },
      { participant: null, words: [word("c", 2, 3)] },
    ]);
    expect(out.map((s) => s.speaker)).toEqual(["a@b.co", "Speaker 3", "unknown"]);
  });

  it("sorts segments chronologically across speakers", () => {
    const out = mapRecallTranscript([
      { participant: { name: "B" }, words: [word("second", 5, 6)] },
      { participant: { name: "A" }, words: [word("first", 0, 1)] },
    ]);
    expect(out.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("skips utterances with no text", () => {
    const out = mapRecallTranscript([
      { participant: { name: "A" }, words: [] },
      { participant: { name: "A" }, words: [word("   ", 0, 1)] },
      { participant: { name: "A" }, words: [word("hi", 1, 2)] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("hi");
  });

  it("handles missing end timestamps by falling back to start", () => {
    const out = mapRecallTranscript([
      { participant: { name: "A" }, words: [word("hi", 3, null)] },
    ]);
    expect(out[0]).toEqual({ start: 3, end: 3, text: "hi", speaker: "A" });
  });

  it("durationFromSegments returns the max end (or null)", () => {
    expect(durationFromSegments([])).toBeNull();
    expect(
      durationFromSegments([
        { start: 0, end: 4, text: "x", speaker: "A" },
        { start: 4, end: 9, text: "y", speaker: "B" },
      ]),
    ).toBe(9);
  });
});
