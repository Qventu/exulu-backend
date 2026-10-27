import {
  renderBlockLines,
  spanForRange,
  transcriptChunker,
} from "./transcript-chunker";
import { buildTranscriptItemInput } from "./build-transcript-item";
import { effectiveSegments, renderTranscript, type RawSegment } from "./transcript-text";

const seg = (start: number, end: number, text: string, speaker: string): RawSegment => ({
  start,
  end,
  text,
  speaker,
});

const utils = {} as any;


/** The item shape buildTranscriptItemInput writes to the transcriptions context. */
const transcriptItem = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "11111111-1111-1111-1111-111111111111",
    name: "Weekly sync",
    transcript_text: "",
    speakers: { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" },
    raw_segments: null,
    corrected_segments: null,
    ...overrides,
  }) as any;

describe("renderBlockLines", () => {
  it("renders one 'Speaker: text' line per block", () => {
    const { text } = renderBlockLines([
      { speaker: "Daniel", start: 0, end: 2, text: "Hello there." },
      { speaker: "Alex", start: 2, end: 4, text: "Hi Daniel." },
    ]);
    expect(text).toBe("Daniel: Hello there.\nAlex: Hi Daniel.");
  });

  it("reports char ranges that index back into the rendered text exactly", () => {
    const blocks = [
      { speaker: "Daniel", start: 0, end: 2, text: "Hello there." },
      { speaker: "Alex", start: 2, end: 4, text: "Hi Daniel." },
      { speaker: "Daniel", start: 4, end: 6, text: "Shall we start?" },
    ];
    const { text, ranges } = renderBlockLines(blocks);

    expect(ranges).toHaveLength(3);
    expect(text.slice(ranges[0]!.start, ranges[0]!.end)).toBe("Daniel: Hello there.");
    expect(text.slice(ranges[1]!.start, ranges[1]!.end)).toBe("Alex: Hi Daniel.");
    expect(text.slice(ranges[2]!.start, ranges[2]!.end)).toBe("Daniel: Shall we start?");
  });

  it("returns empty text for no blocks", () => {
    expect(renderBlockLines([])).toEqual({ text: "", ranges: [] });
  });
});

describe("spanForRange", () => {
  const blocks = [
    { speaker: "Daniel", start: 0, end: 10, text: "Hello there." },
    { speaker: "Alex", start: 10, end: 20, text: "Hi Daniel." },
    { speaker: "Daniel", start: 20, end: 30, text: "Shall we start?" },
  ];
  const { ranges } = renderBlockLines(blocks);

  it("spans the time covered by every overlapping block", () => {
    const span = spanForRange(ranges, 0, ranges[1]!.end);
    expect(span).toEqual({ speakers: ["Daniel", "Alex"], start: 0, end: 20 });
  });

  it("de-duplicates speakers while keeping document order", () => {
    const span = spanForRange(ranges, 0, ranges[2]!.end);
    expect(span?.speakers).toEqual(["Daniel", "Alex"]);
    expect(span).toMatchObject({ start: 0, end: 30 });
  });

  it("attributes a single-block range to that block alone", () => {
    const span = spanForRange(ranges, ranges[1]!.start, ranges[1]!.end);
    expect(span).toEqual({ speakers: ["Alex"], start: 10, end: 20 });
  });

  it("returns null when nothing overlaps", () => {
    expect(spanForRange(ranges, 10_000, 10_001)).toBeNull();
  });
});

describe("transcriptChunker", () => {
  jest.setTimeout(60_000);

  const segments = [
    seg(0, 6.2, "Welcome everybody to the weekly sync.", "SPEAKER_00"),
    seg(6.2, 11.4, "Thanks. Last week we shipped the retrieval hardening work.", "SPEAKER_01"),
    seg(11.4, 16.0, "Great. What is the status of the database migration?", "SPEAKER_00"),
    seg(16.0, 24.8, "It finished on Thursday and we verified the row counts.", "SPEAKER_01"),
  ];

  // Chunked once: building a tokenizer costs a BPE load, and these three
  // assertions read the same result.
  let chunks: Awaited<ReturnType<typeof transcriptChunker>>["chunks"];
  beforeAll(async () => {
    ({ chunks } = await transcriptChunker(
      transcriptItem({ raw_segments: segments }),
      512,
      utils,
    ));
  });

  it("embeds the transcript body, not just the item title", () => {
    expect(chunks.length).toBeGreaterThan(0);
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("retrieval hardening work");
    expect(joined).toContain("verified the row counts");
    expect(joined).not.toBe("Weekly sync");
  });

  it("labels chunk text with the renamed speakers", () => {
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("Daniel: Welcome everybody to the weekly sync.");
    expect(joined).toContain("Alex:");
    expect(joined).not.toContain("SPEAKER_00");
  });

  it("carries the speakers and the time span of each chunk in metadata", () => {
    for (const chunk of chunks) {
      expect(chunk.metadata).toMatchObject({
        speakers: expect.arrayContaining([expect.any(String)]),
        start: expect.any(Number),
        end: expect.any(Number),
      });
      expect((chunk.metadata as any).end).toBeGreaterThanOrEqual((chunk.metadata as any).start);
    }

    // The whole conversation is covered: first chunk opens at the recording
    // start, last chunk closes at the final segment's end.
    expect((chunks[0]!.metadata as any).start).toBe(0);
    expect((chunks[chunks.length - 1]!.metadata as any).end).toBe(24.8);
  });

  it("prefers corrected_segments over raw_segments", async () => {
    const { chunks } = await transcriptChunker(
      transcriptItem({
        raw_segments: segments,
        corrected_segments: [seg(0, 3, "The corrected opening line.", "SPEAKER_00")],
      }),
      512,
      utils,
    );

    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("The corrected opening line.");
    expect(joined).not.toContain("retrieval hardening work");
  });

  it("treats an empty corrected array as a deliberate deletion, not a missing value", async () => {
    const { chunks } = await transcriptChunker(
      transcriptItem({ raw_segments: segments, corrected_segments: [] }),
      512,
      utils,
    );

    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).not.toContain("retrieval hardening work");
  });

  it("parses segments that come back from jsonb as a JSON string", async () => {
    const { chunks } = await transcriptChunker(
      transcriptItem({
        raw_segments: JSON.stringify(segments),
        speakers: JSON.stringify({ SPEAKER_00: "Daniel", SPEAKER_01: "Alex" }),
      }),
      512,
      utils,
    );

    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("Daniel: Welcome everybody to the weekly sync.");
    expect(joined).toContain("verified the row counts");
  });

  it("falls back to transcript_text when an older item has no segments", async () => {
    const { chunks } = await transcriptChunker(
      transcriptItem({
        transcript_text: "Daniel: An older transcript with no stored segments at all.",
      }),
      512,
      utils,
    );

    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("older transcript with no stored segments");
    // No segments means no defensible timestamps — better absent than invented.
    expect(chunks[0]!.metadata).toEqual({});
  });

  it("falls back to the title when there is no transcript at all, so the item stays findable", async () => {
    const { chunks } = await transcriptChunker(transcriptItem(), 512, utils);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("Weekly sync");
  });

  it("splits a long transcript into contiguously indexed chunks", async () => {
    const many: RawSegment[] = Array.from({ length: 120 }, (_, i) =>
      seg(
        i * 5,
        i * 5 + 5,
        `This is turn number ${i} and it carries enough words to push the running token count well past a small per-chunk budget.`,
        i % 2 === 0 ? "SPEAKER_00" : "SPEAKER_01",
      ),
    );

    const { chunks } = await transcriptChunker(
      transcriptItem({ raw_segments: many }),
      128,
      utils,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    // Timestamps advance with the recording rather than repeating.
    const starts = chunks.map((c) => (c.metadata as any).start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect((chunks[chunks.length - 1]!.metadata as any).end).toBe(600);
  });
});

/**
 * The two halves of the bug met here: `buildTranscriptItemInput` wrote the body
 * to `transcript_text`, the chunker read `content`/`description`/`name`, and
 * nothing typechecked the join (tsconfig excludes tests, ts-jest only
 * transpiles). So assert against the REAL builder's output, not a hand-written
 * fixture that could describe a shape no code emits.
 */
describe("transcriptChunker over buildTranscriptItemInput's real output", () => {
  jest.setTimeout(60_000);

  it("chunks the transcript the save path actually produces", async () => {
    const segments = [
      seg(0, 5.5, "Let us review the quarterly retrieval numbers.", "SPEAKER_00"),
      seg(5.5, 12.0, "Recall went up nine points after the reranker change.", "SPEAKER_01"),
    ];
    const speakers = { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" };

    const row = {
      id: "job-1",
      title: "Quarterly review",
      audio_s3key: "audio/job-1.webm",
      language: "en",
      duration_seconds: 12,
      raw_segments: segments,
      corrected_segments: null,
      created_by: 1,
      source: "whisper",
      join_at: null,
      createdAt: new Date("2026-10-20T09:00:00Z"),
    };

    const item = buildTranscriptItemInput({
      row,
      title: row.title,
      speakers,
      transcriptText: renderTranscript(effectiveSegments(segments, null), speakers),
      rightsMode: "private",
      isReSave: false,
      correctedSegments: null,
    });

    const { chunks } = await transcriptChunker({ ...item, id: "item-1" } as any, 512, utils);

    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain("quarterly retrieval numbers");
    expect(joined).toContain("Recall went up nine points");
    expect(joined).not.toBe("Quarterly review");
    expect(chunks[0]!.metadata).toMatchObject({ speakers: ["Daniel", "Alex"], start: 0, end: 12 });
  });
});

describe("transcript rules for ExuluChunkers.recursive", () => {
  jest.setTimeout(60_000);

  // Ten turns of similar length, alternating speakers, each occupying a known
  // ten-second slot so a chunk's mapped start time is checkable against the
  // turn its text opens with.
  const turns: RawSegment[] = Array.from({ length: 10 }, (_, i) =>
    seg(
      i * 10,
      i * 10 + 10,
      `This is turn number ${i}, long enough to matter but still a single sentence.`,
      i % 2 === 0 ? "SPEAKER_00" : "SPEAKER_01",
    ),
  );
  const speakers = { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" };

  let chunks: Awaited<ReturnType<typeof transcriptChunker>>["chunks"];
  beforeAll(async () => {
    ({ chunks } = await transcriptChunker(
      transcriptItem({ raw_segments: turns, speakers }),
      48,
      utils,
    ));
  });

  it("breaks at turn boundaries, so no chunk starts mid-turn", () => {
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/^(Daniel|Alex): /);
    }
  });

  it("maps each chunk's start time to the turn its text opens with", () => {
    for (const chunk of chunks) {
      const openingTurn = turns.findIndex((turn) =>
        chunk.content.startsWith(`${speakers[turn.speaker as keyof typeof speakers]}: ${turn.text}`),
      );
      expect(openingTurn).toBeGreaterThanOrEqual(0);
      expect((chunk.metadata as any).start).toBe(turns[openingTurn]!.start);
    }
  });

  it("still respects the token budget when one turn is a long monologue", async () => {
    const monologue = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i} of an uninterrupted monologue that keeps going well past the budget.`,
    ).join(" ");

    const { chunks } = await transcriptChunker(
      transcriptItem({
        raw_segments: [seg(0, 400, monologue, "SPEAKER_00")],
        speakers,
      }),
      64,
      utils,
    );

    // One turn, so the lower levels had to split inside it rather than overflow.
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.metadata as any)).toMatchObject({ speakers: ["Daniel"], start: 0, end: 400 });
    }
  });
});
