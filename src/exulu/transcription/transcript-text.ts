/**
 * Pure renderer: take whisperx segments + a speaker rename map and produce a
 * human-readable, speaker-labeled transcript string for the main field of a
 * transcriptions context item.
 *
 * Consecutive segments by the same speaker are collapsed into one block.
 * Speakers absent from `speakers` keep their raw label (SPEAKER_NN / "unknown").
 */

export type RawSegment = {
  start: number;
  end: number;
  text: string;
  speaker: string;
};

/**
 * Speaker rename map: { SPEAKER_00: "Daniel", SPEAKER_01: "Alex" }.
 * Keys not present in the map are rendered with the raw label.
 */
export type SpeakerMap = Record<string, string>;

/**
 * The segments a reader should see: the user's corrections when they exist,
 * otherwise the untouched engine output.
 *
 * Returns the corrected array VERBATIM — never merged or zipped with raw.
 * A correction pass may delete, add or reorder blocks, so index-wise
 * merging would resurrect deleted text. An empty corrected array is a
 * deliberate "the user removed everything", not a missing value.
 */
export const effectiveSegments = (
  raw: RawSegment[] | null | undefined,
  corrected: RawSegment[] | null | undefined,
): RawSegment[] => corrected ?? raw ?? [];

/** "mm:ss", or "h:mm:ss" once the recording passes an hour. */
export const formatClock = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export type RenderTranscriptOptions = {
  /**
   * Prefix each block with `[mm:ss]`. Used when the transcript is fed to a
   * post-processing prompt, so a summary can cite passages the reading view
   * turns back into seeks (spec §3.1). Off for the stored transcript_text.
   */
  timestamps?: boolean;
};

/**
 * One speaker's uninterrupted turn: consecutive segments by the same
 * (post-rename) speaker, collapsed, carrying the time span they cover.
 *
 * Shared by `renderTranscript` and the transcript chunker so the stored
 * `transcript_text` and the embedded chunks are built from the same notion of
 * a block — a chunk's text then reads exactly like the passage the reading
 * view shows, and its `end` lets retrieval cite the span, not just its start.
 */
export type TranscriptBlock = {
  /** Display label: the renamed speaker, or the raw one when unmapped. */
  speaker: string;
  start: number;
  end: number;
  text: string;
};

/**
 * Collapse segments into speaker blocks. Empty/whitespace-only segments are
 * skipped entirely, so they never open a block or extend one's time span.
 */
export const transcriptBlocks = (
  segments: RawSegment[] | null | undefined,
  speakers: SpeakerMap,
): TranscriptBlock[] => {
  if (!segments || segments.length === 0) return [];

  const blocks: TranscriptBlock[] = [];
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const label = speakers[seg.speaker] ?? seg.speaker ?? "unknown";
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === label) {
      last.text = `${last.text} ${text}`.trim();
      last.end = seg.end;
    } else {
      blocks.push({ speaker: label, start: seg.start, end: seg.end, text });
    }
  }

  return blocks;
};

export const renderTranscript = (
  segments: RawSegment[],
  speakers: SpeakerMap,
  options: RenderTranscriptOptions = {},
): string =>
  transcriptBlocks(segments, speakers)
    .map((b) =>
      options.timestamps
        ? `${b.speaker} [${formatClock(b.start)}]: ${b.text}`
        : `${b.speaker}: ${b.text}`,
    )
    .join("\n");
